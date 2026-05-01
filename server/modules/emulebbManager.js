/**
 * eMule BB REST client manager.
 *
 * Talks to the eMule BB in-process REST API and adapts its ED2K data into the
 * same manager contract used by the rest of aMuTorrent.
 */

'use strict';

const http = require('http');
const https = require('https');
const BaseClientManager = require('../lib/BaseClientManager');
const logger = require('../lib/logger');
const { parseEd2kLink } = require('../lib/torrentUtils');

function normalizeBasePath(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value || value === '/') return '';
  return value.startsWith('/') ? value.replace(/\/+$/, '') : `/${value.replace(/^\/+|\/+$/g, '')}`;
}

function makeEd2kLink(file) {
  if (!file?.hash || !file?.name || !file?.size) return null;
  return `ed2k://|file|${encodeURIComponent(file.name)}|${file.size}|${String(file.hash).toLowerCase()}|/`;
}

function unwrapItems(payload) {
  if (payload && typeof payload === 'object' && Array.isArray(payload.items)) return payload.items;
  return Array.isArray(payload) ? payload : [];
}

function normalizeCategory(category) {
  const id = Number.isInteger(category?.id) ? category.id : Number.parseInt(category?.id, 10);
  const name = String(category?.name || category?.title || (id === 0 ? 'Default' : '')).trim() || `Category ${id}`;
  return {
    id,
    name,
    title: name,
    path: category?.path || '',
    comment: category?.comment || '',
    color: category?.color ?? null,
    priority: category?.priority ?? 0,
    raw: category
  };
}

function buildCategoryMaps(categories) {
  const byId = new Map();
  const byName = new Map();
  for (const category of categories) {
    if (!Number.isInteger(category.id) || category.id < 0) continue;
    byId.set(category.id, category);
    byName.set(category.name.toLowerCase(), category);
  }
  if (!byId.has(0)) {
    const fallback = normalizeCategory({ id: 0, name: 'Default' });
    byId.set(0, fallback);
    byName.set('default', fallback);
  }
  return { byId, byName };
}

function normalizeTransfer(file, instanceId, categoryById = new Map()) {
  const hash = String(file.hash || '').toLowerCase();
  const categoryId = Number.isInteger(file.category) ? file.category : Number.parseInt(file.category, 10);
  const categoryName = file.categoryName || categoryById.get(categoryId)?.name || 'Default';
  return {
    clientType: 'emulebb',
    instanceId,
    hash,
    name: file.name || 'Unknown',
    rawName: file.name || 'Unknown',
    size: file.size || 0,
    downloaded: file.sizeDone || 0,
    category: categoryName,
    categoryId: Number.isInteger(categoryId) ? categoryId : 0,
    categoryName,
    ed2kLink: makeEd2kLink(file),
    progress: file.progress <= 1 ? (file.progress || 0) * 100 : (file.progress || 0),
    speed: file.downloadSpeed || 0,
    status: file.state || 'stalled',
    statusText: file.state || 'stalled',
    priority: file.priority || null,
    sourceCount: file.sources || 0,
    sourceCountXfer: file.sourcesTransferring || 0,
    sourceCountA4AF: 0,
    sourceCountNotCurrent: 0,
    partStatus: null,
    gapStatus: null,
    reqStatus: null,
    lastSeenComplete: 0,
    peers: [],
    eta: file.eta ?? null,
    addedAt: file.addedAt ?? null,
    raw: file
  };
}

function normalizeSharedFile(file, instanceId) {
  const hash = String(file.hash || '').toLowerCase();
  return {
    clientType: 'emulebb',
    instanceId,
    hash,
    name: file.name || 'Unknown',
    rawName: file.name || 'Unknown',
    size: file.size || 0,
    downloaded: file.size || 0,
    progress: 1,
    priority: file.uploadPriority || null,
    ed2kLink: makeEd2kLink(file),
    comment: null,
    rating: null,
    path: file.path || null,
    directory: file.directory || null,
    requests: file.requests || 0,
    requestsTotal: file.allTimeRequests || 0,
    acceptedCount: file.accepts || 0,
    acceptedCountTotal: file.allTimeAccepts || 0,
    transferred: file.transferred || 0,
    transferredTotal: file.allTimeTransferred || 0,
    peers: [],
    raw: file
  };
}

function normalizeUpload(client, instanceId) {
  return {
    clientType: 'emulebb',
    instanceId,
    userName: client.userName || '',
    userHash: client.userHash || null,
    clientSoftware: client.clientSoftware || '',
    clientMod: client.clientMod || '',
    uploadState: client.uploadState || 'idle',
    uploadSpeed: client.uploadSpeed || 0,
    uploaded: client.sessionUploaded || 0,
    queueUploaded: client.queueSessionUploaded || 0,
    waitTime: client.waitTimeMs || 0,
    score: client.score || 0,
    ip: client.ip || '',
    port: client.port || 0,
    lowId: !!client.lowId,
    friendSlot: !!client.friendSlot,
    requestedFileHash: client.requestedFileHash || null,
    requestedFileName: client.requestedFileName || null,
    requestedFileSize: client.requestedFileSize || null,
    raw: client
  };
}

class EmulebbManager extends BaseClientManager {
  constructor() {
    super();
    this.lastSnapshot = null;
    this.lastSearchId = null;
    this.lastSearchResults = [];
    this.searchInProgress = false;
    this._categories = [normalizeCategory({ id: 0, name: 'Default' })];
    const maps = buildCategoryMaps(this._categories);
    this._categoryById = maps.byId;
    this._categoryByName = maps.byName;
  }

  _baseUrl() {
    const cfg = this._clientConfig || {};
    const protocol = cfg.useSsl ? 'https' : 'http';
    const host = cfg.host || '127.0.0.1';
    const port = cfg.port || 4711;
    return `${protocol}://${host}:${port}${normalizeBasePath(cfg.path)}`;
  }

  async _request(method, path, body = null) {
    const cfg = this._clientConfig || {};
    const url = new URL(`${this._baseUrl()}${path}`);
    const transport = url.protocol === 'https:' ? https : http;
    const data = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');

    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: {
        'Accept': 'application/json',
        'X-API-Key': cfg.apiKey || ''
      },
      timeout: 15000
    };
    if (data) {
      options.headers['Content-Type'] = 'application/json; charset=utf-8';
      options.headers['Content-Length'] = data.length;
    }

    return await new Promise((resolve, reject) => {
      const req = transport.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let payload = null;
          try {
            payload = text ? JSON.parse(text) : null;
          } catch (err) {
            return reject(new Error(`Invalid JSON from eMule BB: ${err.message}`));
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const code = payload?.error || `HTTP ${res.statusCode}`;
            const message = payload?.message || text || `HTTP ${res.statusCode}`;
            return reject(new Error(`eMule BB ${code}: ${message}`));
          }
          if (payload == null) {
            return reject(new Error('eMule BB returned an empty JSON response'));
          }
          resolve(payload);
        });
      });
      req.on('error', err => reject(new Error(`eMule BB request failed: ${err.message}`)));
      req.on('timeout', () => req.destroy(new Error('eMule BB request timed out')));
      if (data) req.write(data);
      req.end();
    });
  }

  async initClient() {
    if (!this.isEnabled()) return false;
    if (this.connectionInProgress) return false;
    this.connectionInProgress = true;
    try {
      const version = await this._request('GET', '/api/v1/app');
      this.client = { version };
      await this._refreshCategories().catch(err => {
        this.warn(`Failed to fetch eMule BB categories: ${logger.errorDetail(err)}`);
      });
      this._clearConnectionError();
      this.clearReconnect();
      this.log(`Connected to eMule BB ${version?.version || ''}`.trim());
      this._onConnectCallbacks.forEach(cb => cb());
      return true;
    } catch (err) {
      this.client = null;
      this._setConnectionError(err);
      this.error('Failed to connect to eMule BB:', logger.errorDetail(err));
      return false;
    } finally {
      this.connectionInProgress = false;
    }
  }

  async startConnection() {
    if (!this.isEnabled()) return;
    if (!(await this.initClient())) this.scheduleReconnect(10000);
  }

  isConnected() {
    return !!this.client;
  }

  async fetchData() {
    if (!this.client) return { downloads: [], sharedFiles: [], uploads: [] };
    await this._refreshCategories().catch(err => {
      this.warn(`Failed to refresh eMule BB categories: ${logger.errorDetail(err)}`);
    });
    const snapshot = await this._request('GET', '/api/v1/snapshot?limit=100');
    this.lastSnapshot = snapshot;
    return {
      downloads: unwrapItems(snapshot.transfers).map(item => normalizeTransfer(item, this.instanceId, this._categoryById)),
      sharedFiles: unwrapItems(snapshot.sharedFiles).map(item => normalizeSharedFile(item, this.instanceId)),
      uploads: unwrapItems(snapshot.uploads).map(item => normalizeUpload(item, this.instanceId))
    };
  }

  async getStats() {
    if (!this.client) return {};
    const status = await this._request('GET', '/api/v1/status');
    return status || {};
  }

  extractMetrics(rawStats) {
    const stats = rawStats?.stats || rawStats || {};
    return {
      uploadSpeed: stats.uploadSpeed || 0,
      downloadSpeed: stats.downloadSpeed || 0,
      uploadTotal: stats.sessionUploaded || 0,
      downloadTotal: stats.sessionDownloaded || 0
    };
  }

  getNetworkStatus(rawStats) {
    const stats = rawStats?.stats || {};
    const servers = rawStats?.servers || {};
    const kadStatus = rawStats?.kad || {};
    const ed2k = servers.connected
      ? {
          status: stats.ed2kHighId ? 'green' : 'yellow',
          text: stats.ed2kHighId ? 'High ID' : 'Low ID',
          connected: true,
          serverName: servers.currentServer?.name || null,
          serverPing: servers.currentServer?.ping || null,
          serverAddress: servers.currentServer?.address || null
        }
      : { status: 'red', text: 'Disconnected', connected: false, serverName: null, serverPing: null, serverAddress: null };
    const kad = kadStatus.connected
      ? { status: kadStatus.firewalled ? 'yellow' : 'green', text: kadStatus.firewalled ? 'Firewalled' : 'OK', connected: true }
      : { status: kadStatus.running ? 'yellow' : 'red', text: kadStatus.running ? 'Starting' : 'Disconnected', connected: false };
    return { ed2k, kad };
  }

  async _transferAction(hash, action) {
    await this._request('PATCH', `/api/v1/transfers/${encodeURIComponent(hash)}`, { action });
    return true;
  }

  async pause(hash) { return await this._transferAction(hash, 'pause'); }
  async resume(hash) { return await this._transferAction(hash, 'resume'); }
  async stop(hash) { return await this._transferAction(hash, 'stop'); }

  async addEd2kLink(link, categoryId = 0, username = null) {
    const result = await this._request('POST', '/api/v1/transfers', { link });
    if (result?.hash) {
      const numericCategoryId = Number.isInteger(categoryId) ? categoryId : Number.parseInt(categoryId, 10);
      if (Number.isInteger(numericCategoryId) && numericCategoryId > 0) {
        await this.setCategoryOrLabel(result.hash, { categoryId: numericCategoryId });
      }
      const parsed = parseEd2kLink(link);
      const categoryName = this._categoryById.get(numericCategoryId)?.name || 'Default';
      this.trackDownload(result.hash, parsed.filename || result.name || 'Unknown', parsed.size || null, username, categoryName);
      return true;
    }
    return false;
  }

  async deleteItem(hash, { deleteFiles } = {}) {
    const payload = await this._request('DELETE', `/api/v1/transfers/${encodeURIComponent(hash)}`, {
      delete_files: deleteFiles !== false
    });
    const first = payload?.results?.[0];
    if (payload?.ok === true || first?.ok) {
      this.trackDeletion(hash);
      return { success: true, pathsToDelete: [] };
    }
    return { success: false, error: first?.error || 'eMule BB rejected the delete request' };
  }

  async _refreshCategories() {
    const categories = unwrapItems(await this._request('GET', '/api/v1/categories')).map(normalizeCategory);
    const maps = buildCategoryMaps(categories);
    this._categories = categories.length > 0 ? categories : [normalizeCategory({ id: 0, name: 'Default' })];
    this._categoryById = maps.byId;
    this._categoryByName = maps.byName;
    return this._categories;
  }

  async getCategories() {
    if (!this.client) return null;
    return await this._refreshCategories();
  }

  async ensureAmuleCategoryId(categoryName) {
    if (!this.client) return null;
    const name = String(categoryName || '').trim();
    if (!name) return 0;
    if (!this._categoryByName.has(name.toLowerCase())) {
      await this._refreshCategories();
    }
    return this._categoryByName.get(name.toLowerCase())?.id ?? null;
  }

  async setCategoryOrLabel(hash, { categoryId, categoryName } = {}) {
    const numericCategoryId = Number.isInteger(categoryId) ? categoryId : Number.parseInt(categoryId, 10);
    if (Number.isInteger(numericCategoryId) && numericCategoryId >= 0) {
      await this._request('PATCH', `/api/v1/transfers/${encodeURIComponent(hash)}`, { category: numericCategoryId });
      return { success: true };
    }

    const name = String(categoryName || '').trim();
    if (!name) {
      return { success: false, error: 'eMule BB category assignment requires categoryId or categoryName' };
    }

    if (!this._categoryByName.has(name.toLowerCase())) {
      await this._refreshCategories();
    }
    if (!this._categoryByName.has(name.toLowerCase())) {
      return { success: false, error: `Unknown eMule BB category: ${name}` };
    }

    await this._request('PATCH', `/api/v1/transfers/${encodeURIComponent(hash)}`, { categoryName: name });
    return { success: true };
  }

  async search(query, type, extension) {
    const normalizedType = String(type || '').toLowerCase();
    const allowedMethods = new Set(['automatic', 'server', 'global', 'kad']);
    const method = allowedMethods.has(normalizedType) ? normalizedType : 'automatic';
    const fileType = allowedMethods.has(normalizedType) || !normalizedType ? 'any' : normalizedType;
    const start = await this._request('POST', '/api/v1/searches', {
      query,
      method,
      type: fileType,
      ext: extension || ''
    });
    this.lastSearchId = start.search_id;
    return await this.getSearchResults();
  }

  async getSearchResults() {
    if (!this.lastSearchId) return { results: [], resultsLength: 0 };
    const payload = await this._request('GET', `/api/v1/searches/${encodeURIComponent(this.lastSearchId)}`);
    const results = (payload.results || []).map(item => ({
      fileHash: item.hash,
      fileName: item.name,
      fileSize: item.size,
      sourceCount: item.sources || 0,
      completeSourceCount: item.completeSources || 0,
      ed2kLink: makeEd2kLink(item),
      raw: item
    }));
    this.lastSearchResults = results;
    return { results, resultsLength: results.length, status: payload.status };
  }

  async addSearchResult(fileHash, _categoryId = 0, username = null, fileInfoCallback = null) {
    const file = this.lastSearchResults.find(item => item.fileHash?.toLowerCase() === fileHash.toLowerCase());
    if (!file?.ed2kLink) return false;
    const success = await this.addEd2kLink(file.ed2kLink, 0, username);
    if (success && fileInfoCallback) await fileInfoCallback(fileHash).catch(() => null);
    return success;
  }

  async getServerList() {
    return unwrapItems(await this._request('GET', '/api/v1/servers'));
  }

  async connectServer(ip, port) {
    await this._request('PATCH', `/api/v1/servers/${encodeURIComponent(`${ip}:${port}`)}`, { action: 'connect' });
    return true;
  }

  async disconnectServer() {
    await this._request('PATCH', '/api/v1/servers/current:1', { action: 'disconnect' });
    return true;
  }

  async removeServer(ip, port) {
    await this._request('DELETE', `/api/v1/servers/${encodeURIComponent(`${ip}:${port}`)}`, {});
    return true;
  }

  async getServerInfo() {
    const status = await this._request('GET', '/api/v1/status');
    return status?.servers || {};
  }

  async getLog() {
    return unwrapItems(await this._request('GET', '/api/v1/logs?limit=500'));
  }

  acquireSearchLock() {
    if (this.searchInProgress) return false;
    this.searchInProgress = true;
    return true;
  }

  releaseSearchLock() {
    this.searchInProgress = false;
  }

  async shutdown() {
    this.clearReconnect();
    this.client = null;
  }
}

module.exports = { EmulebbManager };
