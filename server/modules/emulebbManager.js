/**
 * eMuleBB REST client manager.
 *
 * Talks to the eMuleBB in-process REST API and adapts its ED2K data into the
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const SAFE_GET_RETRY_ATTEMPTS = 4;
const SAFE_GET_RETRY_BASE_DELAY_MS = 100;
const RETRYABLE_TRANSPORT_ERROR_FRAGMENTS = [
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'socket hang up',
  'request timed out',
  'connection reset'
];

function isRetryableTransportError(err) {
  const message = String(err?.message || err || '');
  return RETRYABLE_TRANSPORT_ERROR_FRAGMENTS.some(fragment => message.includes(fragment));
}

function normalizeComparablePath(rawPath) {
  return String(rawPath || '').trim().replace(/[\\/]+$/g, '').toLowerCase();
}

function makeEd2kLink(file) {
  const size = file?.sizeBytes ?? file?.size;
  if (!file?.hash || !file?.name || !size) return null;
  return `ed2k://|file|${encodeURIComponent(file.name)}|${size}|${String(file.hash).toLowerCase()}|/`;
}

function unwrapItems(payload) {
  if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return unwrapItems(payload.data);
  }
  if (payload && typeof payload === 'object' && Array.isArray(payload.items)) return payload.items;
  return Array.isArray(payload) ? payload : [];
}

function unwrapPayload(payload) {
  if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return payload.data;
  }
  return payload;
}

function normalizeSearchRequest(type) {
  const normalizedType = String(type || '').toLowerCase();
  const methodAliases = {
    automatic: 'automatic',
    global: 'server',
    server: 'server',
    kad: 'kad'
  };
  const method = methodAliases[normalizedType] || 'automatic';
  const fileType = Object.prototype.hasOwnProperty.call(methodAliases, normalizedType) || !normalizedType ? '' : normalizedType;
  return {
    requestedType: normalizedType || 'automatic',
    method,
    fileType
  };
}

function searchMethodMatches(requestedMethod, actualMethod) {
  if (!requestedMethod || !actualMethod) return true;
  const requested = String(requestedMethod).toLowerCase();
  const actual = String(actualMethod).toLowerCase();
  return requested === 'automatic' || actual === 'automatic' || requested === actual;
}

function hashMatches(payload, expectedHash) {
  if (!expectedHash) return false;
  const expected = String(expectedHash).toLowerCase();
  const actual = String(payload.hash || payload.fileHash || payload.id || '').toLowerCase();
  return actual === expected;
}

function isOperationSuccess(payload, { allowEmpty = false, expectedHash = null } = {}) {
  if (payload === true) return true;
  if (!payload || typeof payload !== 'object') return false;
  if (allowEmpty && Object.keys(payload).length === 0) return true;

  const status = String(payload.status || '').toLowerCase();
  if (payload.ok === false || payload.success === false || payload.deleted === false) return false;
  if (payload.error) return false;
  if (status && !['ok', 'success', 'deleted', 'removed'].includes(status)) return false;
  if (payload.ok === true || payload.success === true || payload.deleted === true || payload.result === true) return true;
  if (payload.deletedCount > 0 || payload.removedCount > 0) return true;
  if (['ok', 'success', 'deleted', 'removed'].includes(status)) return true;
  if (hashMatches(payload, expectedHash)) return true;

  const first = payload.items?.[0] ?? payload.results?.[0];
  return first ? isOperationSuccess(first, { allowEmpty, expectedHash }) : false;
}

function operationErrorMessage(payload, fallback) {
  const first = payload?.items?.[0] ?? payload?.results?.[0];
  return first?.error || payload?.error || payload?.message || fallback;
}

function normalizeErrorPayload(payload, statusCode, text) {
  if (payload?.error && typeof payload.error === 'object') {
    return {
      code: payload.error.code || `HTTP ${statusCode}`,
      message: payload.error.message || text || `HTTP ${statusCode}`
    };
  }
  return {
    code: payload?.error || `HTTP ${statusCode}`,
    message: payload?.message || text || `HTTP ${statusCode}`
  };
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

function parseFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseOptionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function kibPerSecondToBytesPerSecond(value) {
  return Math.round(parseFiniteNumber(value, 0) * 1024);
}

function formatBoolean(value, trueLabel = 'Yes', falseLabel = 'No', unknownLabel = 'Unknown') {
  if (value === true) return trueLabel;
  if (value === false) return falseLabel;
  return unknownLabel;
}

function normalizeLifecycle(lifecycle) {
  if (!lifecycle || typeof lifecycle !== 'object') return null;
  const state = String(lifecycle.state || '').toLowerCase();
  if (!state) return null;
  return {
    state,
    startupComplete: lifecycle.startupComplete === true,
    coreReady: lifecycle.coreReady === true,
    sharedFilesReady: lifecycle.sharedFilesReady === true,
    acceptingRest: lifecycle.acceptingRest !== false,
    acceptingMutations: lifecycle.acceptingMutations === true,
    shutdownInProgress: lifecycle.shutdownInProgress === true
  };
}

function formatLifecycleState(lifecycle) {
  const state = normalizeLifecycle(lifecycle)?.state || 'unknown';
  return state === 'shuttingdown' ? 'shutting down' : state;
}

function formatRateKiBps(value) {
  return `${parseFiniteNumber(value, 0).toFixed(1)} KiB/s`;
}

function formatBytes(value) {
  const bytes = parseFiniteNumber(value, 0);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = bytes;
  let unitIndex = 0;
  while (Math.abs(amount) >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
}

function statsTreeLeaf(label, value) {
  return {
    _value: `${label}: %s`,
    EC_TAG_STAT_NODE_VALUE: value
  };
}

function statsTreeBranch(label, children) {
  return {
    _value: label,
    EC_TAG_STATTREE_NODE: children.filter(Boolean)
  };
}

function computePartCompletion(availableParts, partCount) {
  if (availableParts == null || partCount == null || partCount <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((availableParts * 100) / partCount)));
}

function normalizeProgressPercent(value) {
  const raw = parseFiniteNumber(value, 0);
  const percent = raw <= 1 ? raw * 100 : raw;
  return Math.max(0, Math.min(100, Math.round(percent * 100) / 100));
}

function normalizeTransfer(file, instanceId, categoryById = new Map()) {
  const hash = String(file.hash || '').toLowerCase();
  const categoryId = Number.isInteger(file.categoryId) ? file.categoryId : Number.parseInt(file.categoryId, 10);
  const categoryName = file.categoryName || categoryById.get(categoryId)?.name || 'Default';
  const size = file.sizeBytes ?? file.size ?? 0;
  const completed = file.completedBytes ?? file.sizeDone ?? 0;
  return {
    clientType: 'emulebb',
    instanceId,
    hash,
    name: file.name || 'Unknown',
    rawName: file.name || 'Unknown',
    size,
    downloaded: completed,
    category: categoryName,
    categoryId: Number.isInteger(categoryId) ? categoryId : 0,
    categoryName,
    renameSupported: true,
    ed2kLink: makeEd2kLink(file),
    progress: normalizeProgressPercent(file.progress),
    speed: kibPerSecondToBytesPerSecond(file.downloadSpeedKiBps ?? file.downloadSpeed),
    status: file.state || 'queued',
    statusText: file.state || 'queued',
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

function normalizeTransferSource(source, transfer) {
  const address = source.address || source.ip || '';
  const port = parseFiniteNumber(source.port, 0);
  const availableParts = parseOptionalNumber(source.availableParts);
  const partCount = parseOptionalNumber(source.partCount);
  const userHash = source.userHash ? String(source.userHash).toLowerCase() : '';
  return {
    role: 'download',
    clientType: 'emulebb',
    id: source.clientId ? String(source.clientId).toLowerCase() : (userHash || `${address}:${port}`),
    userHash: userHash || null,
    userName: source.userName || '',
    fileName: transfer?.name || '',
    address,
    port,
    software: source.clientSoftware || 'Unknown',
    softwareId: null,
    downloadRate: kibPerSecondToBytesPerSecond(source.downloadSpeedKiBps ?? source.downloadRate),
    uploadRate: 0,
    downloadTotal: 0,
    uploadTotal: 0,
    downloadState: source.downloadState ?? null,
    sourceFrom: null,
    remoteQueueRank: parseOptionalNumber(source.queueRank ?? source.remoteQueueRank),
    completedPercent: computePartCompletion(availableParts, partCount),
    availableParts,
    partCount,
    lowId: !!source.lowId,
    viewSharedFiles: source.viewSharedFiles !== false,
    sharedFilesRequestPending: !!source.sharedFilesRequestPending,
    serverIp: source.serverIp || '',
    serverPort: parseFiniteNumber(source.serverPort, 0),
    isEncrypted: false,
    isIncoming: false,
    raw: source
  };
}

function normalizeTransferPart(part) {
  return {
    index: parseFiniteNumber(part.index, 0),
    start: parseFiniteNumber(part.start, 0),
    end: parseFiniteNumber(part.end, 0),
    size: parseFiniteNumber(part.size, 0),
    completedBytes: parseFiniteNumber(part.completedBytes, 0),
    gapBytes: parseFiniteNumber(part.gapBytes, 0),
    complete: !!part.complete,
    requested: !!part.requested,
    corrupted: !!part.corrupted,
    availableSources: parseFiniteNumber(part.availableSources, 0),
    raw: part
  };
}

function hasCapability(version, capability) {
  return version?.capabilities?.[capability] === true;
}

function normalizeSharedFile(file, instanceId) {
  const hash = String(file.hash || '').toLowerCase();
  const size = file.sizeBytes ?? file.size ?? 0;
  return {
    clientType: 'emulebb',
    instanceId,
    hash,
    name: file.name || 'Unknown',
    rawName: file.name || 'Unknown',
    size,
    downloaded: size,
    progress: 100,
    status: 'completed',
    statusText: 'completed',
    priority: file.priority || file.uploadPriority || null,
    ed2kLink: makeEd2kLink(file),
    renameSupported: false,
    comment: file.comment ?? '',
    rating: file.rating ?? file.userRating ?? 0,
    hasComment: !!file.hasComment,
    userRating: file.userRating ?? file.rating ?? 0,
    path: file.path || null,
    directory: file.directory || null,
    requests: file.requests || 0,
    requestsTotal: file.allTimeRequests || 0,
    acceptedCount: file.acceptedRequests ?? file.accepts ?? 0,
    acceptedCountTotal: file.allTimeAccepts || 0,
    transferred: file.transferredBytes ?? file.transferred ?? 0,
    transferredTotal: file.allTimeTransferred || 0,
    peers: [],
    raw: file
  };
}

function normalizeUpload(client, instanceId) {
  return {
    clientType: 'emulebb',
    instanceId,
    clientId: client.clientId || client.userHash || null,
    userName: client.userName || '',
    userHash: client.userHash || null,
    clientSoftware: client.clientSoftware || '',
    clientMod: client.clientMod || '',
    uploadState: client.uploadState || 'idle',
    uploadSpeed: kibPerSecondToBytesPerSecond(client.uploadSpeedKiBps ?? client.uploadSpeed),
    uploaded: client.uploadedBytes ?? client.sessionUploaded ?? 0,
    queueUploaded: client.queueSessionUploaded || 0,
    waitTime: client.waitTimeMs || 0,
    score: client.score || 0,
    ip: client.address || client.ip || '',
    address: client.address || client.ip || '',
    port: client.port || 0,
    lowId: !!client.lowId,
    friendSlot: !!client.friendSlot,
    requestedFileHash: client.requestedFileHash || null,
    requestedFileName: client.requestedFileName || null,
    requestedFileSize: client.requestedFileSizeBytes ?? client.requestedFileSize ?? null,
    raw: client
  };
}

function normalizeSharedDirectoryRoot(row) {
  return {
    path: row?.path || '',
    recursive: row?.recursive !== false,
    accessible: row?.accessible !== false,
    raw: row
  };
}

class EmulebbManager extends BaseClientManager {
  constructor() {
    super();
    this.lastSnapshot = null;
    this.lastSharedFiles = [];
    this.lastSearchId = null;
    this.lastSearchResults = [];
    this.lastSearchMeta = null;
    this.searchInProgress = false;
    this._categories = [normalizeCategory({ id: 0, name: 'Default' })];
    const maps = buildCategoryMaps(this._categories);
    this._categoryById = maps.byId;
    this._categoryByName = maps.byName;
    this._requestQueue = Promise.resolve();
  }

  _baseUrl() {
    const cfg = this._clientConfig || {};
    const protocol = cfg.useSsl ? 'https' : 'http';
    const host = cfg.host || '127.0.0.1';
    const port = cfg.port || 4711;
    return `${protocol}://${host}:${port}${normalizeBasePath(cfg.path)}`;
  }

  async _request(method, path, body = null) {
    return this._enqueueRequest(() => this._requestWithRetry(method, path, body));
  }

  /**
   * Serialize native eMuleBB REST calls for this manager instance.
   *
   * eMuleBB intentionally accepts one web client thread today because request
   * handling still shares CWebServer state. aMuTorrent can issue overlapping
   * UI, category, search, and detail-hydration calls, so the adapter queues
   * requests here instead of forcing every caller to know that server limit.
   */
  async _enqueueRequest(run) {
    const previous = this._requestQueue;
    let release;
    this._requestQueue = new Promise(resolve => {
      release = resolve;
    });

    await previous.catch(() => {});
    try {
      return await run();
    } finally {
      release();
    }
  }

  async _requestWithRetry(method, path, body = null) {
    const normalizedMethod = String(method || '').toUpperCase();
    this._ensureLifecycleAllowsMutation(normalizedMethod);
    const maxAttempts = normalizedMethod === 'GET' ? SAFE_GET_RETRY_ATTEMPTS : 1;

    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this._requestOnce(method, path, body);
      } catch (err) {
        lastError = err;
        if (attempt >= maxAttempts || !isRetryableTransportError(err)) throw err;
        await delay(SAFE_GET_RETRY_BASE_DELAY_MS * attempt);
      }
    }
    throw lastError;
  }

  async _requestOnce(method, path, body = null) {
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
            return reject(new Error(`Invalid JSON from eMuleBB: ${err.message}`));
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const { code, message } = normalizeErrorPayload(payload, res.statusCode, text);
            const err = new Error(`eMuleBB ${code}: ${message}`);
            err.code = code;
            err.statusCode = res.statusCode;
            if (code === 'EMULE_UNAVAILABLE') this._markLifecycleUnavailable();
            return reject(err);
          }
          if (payload == null) {
            return reject(new Error('eMuleBB returned an empty JSON response'));
          }
          resolve(unwrapPayload(payload));
        });
      });
      req.on('error', err => reject(new Error(`eMuleBB request failed: ${err.message}`)));
      req.on('timeout', () => req.destroy(new Error('eMuleBB request timed out')));
      if (data) req.write(data);
      req.end();
    });
  }

  _ensureLifecycleAllowsMutation(method) {
    if (!['POST', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase())) return;
    const lifecycle = normalizeLifecycle(this.client?.lifecycle || this.client?.version?.lifecycle);
    if (!lifecycle || lifecycle.acceptingMutations) return;
    const err = new Error(`eMuleBB lifecycle ${formatLifecycleState(lifecycle)} is not accepting mutations`);
    err.code = 'EMULE_UNAVAILABLE';
    throw err;
  }

  _markLifecycleUnavailable() {
    if (!this.client) return;
    const lifecycle = {
      state: 'shuttingdown',
      startupComplete: true,
      coreReady: false,
      sharedFilesReady: false,
      acceptingRest: false,
      acceptingMutations: false,
      shutdownInProgress: true
    };
    this.client.lifecycle = lifecycle;
    if (this.client.version && typeof this.client.version === 'object') {
      this.client.version.lifecycle = lifecycle;
    }
  }

  async initClient() {
    if (!this.isEnabled()) return false;
    if (this.connectionInProgress) return false;
    this.connectionInProgress = true;
    try {
      const version = await this._request('GET', '/api/v1/app');
      this.client = { version, lifecycle: normalizeLifecycle(version?.lifecycle) };
      await this._refreshCategories().catch(err => {
        this.warn(`Failed to fetch eMuleBB categories: ${logger.errorDetail(err)}`);
      });
      this._clearConnectionError();
      this.clearReconnect();
      this.log(`Connected to eMuleBB ${version?.version || ''}`.trim());
      this._onConnectCallbacks.forEach(cb => cb());
      return true;
    } catch (err) {
      this.client = null;
      this._setConnectionError(err);
      this.error('Failed to connect to eMuleBB:', logger.errorDetail(err));
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
      this.warn(`Failed to refresh eMuleBB categories: ${logger.errorDetail(err)}`);
    });
    let snapshot = null;
    try {
      snapshot = await this._request('GET', '/api/v1/snapshot?limit=100');
    } catch (err) {
      if (/SERVICE_BUSY/i.test(err.message || '') && /shared file hashing/i.test(err.message || '')) {
        this.warn(`eMuleBB shared files are still warming: ${logger.errorDetail(err)}`);
        return {
          downloads: [],
          sharedFiles: this.lastSharedFiles.slice(),
          uploads: [],
          nativeStatus: {
            lifecycle: normalizeLifecycle(this.client?.lifecycle || this.client?.version?.lifecycle),
            sharedFilesReady: false,
            sharedHashingActive: true,
            sharedHashingCount: null,
            sharedStartupCache: null
          }
        };
      }
      throw err;
    }
    this.lastSnapshot = snapshot;
    const status = snapshot?.status || {};
    const stats = status?.stats || {};
    const lifecycle = normalizeLifecycle(status.lifecycle || snapshot?.app?.lifecycle || this.client?.lifecycle || this.client?.version?.lifecycle);
    if (lifecycle && this.client) {
      this.client.lifecycle = lifecycle;
    }
    const sharedRows = unwrapItems(snapshot.sharedFiles);
    const sharedFilesReady = stats.sharedFilesReady !== false && stats.sharedHashingActive !== true;
    const sharedFiles = !sharedFilesReady && sharedRows.length === 0
      ? this.lastSharedFiles.slice()
      : sharedRows.map(item => normalizeSharedFile(item, this.instanceId));
    if (sharedFilesReady || sharedRows.length > 0) {
      this.lastSharedFiles = sharedFiles.slice();
    }
    const transferRows = unwrapItems(snapshot.transfers);
    const downloads = transferRows.map(item => normalizeTransfer(item, this.instanceId, this._categoryById));
    await Promise.all(downloads.map(async (download, index) => {
      const sourceCount = parseFiniteNumber(transferRows[index]?.sources ?? download.sourceCount, 0);
      const transferringCount = parseFiniteNumber(transferRows[index]?.sourcesTransferring ?? download.sourceCountXfer, 0);
      if (!download.hash) return;
      try {
        if (hasCapability(this.client?.version, 'transferDetails')) {
          const details = await this._getTransferDetails(download.hash, download);
          download.peers = details.sources;
          download.partStatus = details.parts;
          download.gapStatus = details.gaps;
          download.reqStatus = details.requests;
        } else if (sourceCount > 0 || transferringCount > 0) {
          download.peers = await this._getTransferSources(download.hash, download);
        }
      } catch (err) {
        if (sourceCount > 0 || transferringCount > 0) {
          try {
            download.peers = await this._getTransferSources(download.hash, download);
          } catch (sourceErr) {
            this.warn(`Failed to fetch eMuleBB sources for ${download.hash}: ${logger.errorDetail(sourceErr)}`);
          }
        } else {
          this.debug?.(`No eMuleBB transfer details for ${download.hash}: ${logger.errorDetail(err)}`);
        }
      }
    }));
    return {
      downloads,
      sharedFiles,
      uploads: unwrapItems(snapshot.uploads).map(item => normalizeUpload(item, this.instanceId)),
      nativeStatus: {
        lifecycle,
        sharedFilesReady,
        sharedHashingActive: stats.sharedHashingActive === true,
        sharedHashingCount: Number.isFinite(Number(stats.sharedHashingCount)) ? Number(stats.sharedHashingCount) : null,
        sharedStartupCache: status.sharedStartupCache || null
      }
    };
  }

  async _getTransferSources(hash, transfer) {
    const payload = await this._request('GET', `/api/v1/transfers/${encodeURIComponent(hash)}/sources`);
    return unwrapItems(payload).map(source => normalizeTransferSource(source, transfer));
  }

  async _getTransferDetails(hash, transfer) {
    const payload = await this._request('GET', `/api/v1/transfers/${encodeURIComponent(hash)}/details`);
    const parts = unwrapItems(payload?.parts).map(normalizeTransferPart);
    return {
      sources: unwrapItems(payload?.sources).map(source => normalizeTransferSource(source, transfer)),
      parts,
      gaps: parts.filter(part => part.gapBytes > 0),
      requests: parts.filter(part => part.requested)
    };
  }

  async getStats() {
    if (!this.client) return {};
    const status = await this._request('GET', '/api/v1/status');
    return status || {};
  }

  /**
   * Build a statistics tree compatible with the aMule EC stats-tree renderer.
   *
   * eMuleBB exposes structured REST status fields rather than an EC tree, so
   * this adapter keeps the public aMuTorrent endpoint useful for both ED2K
   * backends while preserving the existing UI data contract.
   *
   * @returns {Promise<Object>} aMuTorrent statistics tree payload
   */
  async getStatsTree() {
    if (!this.client) throw new Error('eMuleBB not connected');
    const status = await this.getStats();
    const stats = status?.stats || {};
    const lifecycle = normalizeLifecycle(status?.lifecycle || this.client?.lifecycle || this.client?.version?.lifecycle);
    const servers = status?.servers || status?.server || {};
    const activeServer = servers.active || servers.currentServer || {};
    const kad = status?.kad || {};

    return {
      EC_TAG_STATTREE_NODE: statsTreeBranch('eMuleBB', [
        statsTreeBranch('Connection', [
          statsTreeLeaf('Lifecycle', formatLifecycleState(lifecycle)),
          statsTreeLeaf('ED2K', formatBoolean(stats.ed2kConnected ?? servers.connected ?? activeServer.connected, 'Connected', 'Disconnected')),
          statsTreeLeaf('ED2K ID', formatBoolean(stats.ed2kHighId ?? status.ed2kHighId, 'High ID', 'Low ID')),
          statsTreeLeaf('Server', activeServer.name || activeServer.address || 'None'),
          statsTreeLeaf('Server address', activeServer.address || 'Unknown'),
          statsTreeLeaf('Kad', formatBoolean(stats.kadConnected ?? kad.connected, 'Connected', 'Disconnected')),
          statsTreeLeaf('Kad firewalled', formatBoolean(stats.kadFirewalled ?? kad.firewalled)),
          statsTreeLeaf('Kad running', formatBoolean(stats.kadRunning ?? kad.running))
        ]),
        statsTreeBranch('Transfer rates', [
          statsTreeLeaf('Download', formatRateKiBps(stats.downloadSpeedKiBps ?? stats.downloadSpeed)),
          statsTreeLeaf('Upload', formatRateKiBps(stats.uploadSpeedKiBps ?? stats.uploadSpeed))
        ]),
        statsTreeBranch('Session totals', [
          statsTreeLeaf('Downloaded', formatBytes(stats.sessionDownloadedBytes ?? stats.sessionDownloaded)),
          statsTreeLeaf('Uploaded', formatBytes(stats.sessionUploadedBytes ?? stats.sessionUploaded))
        ]),
        statsTreeBranch('Queues', [
          statsTreeLeaf('Downloads', parseFiniteNumber(stats.downloadCount, 0)),
          statsTreeLeaf('Active uploads', parseFiniteNumber(stats.activeUploads, 0)),
          statsTreeLeaf('Waiting uploads', parseFiniteNumber(stats.waitingUploads, 0)),
          statsTreeLeaf('Shared hashing active', formatBoolean(stats.sharedHashingActive)),
          statsTreeLeaf('Shared hashing queue', parseFiniteNumber(stats.sharedHashingCount, 0)),
          statsTreeLeaf('Shared files ready', formatBoolean(stats.sharedFilesReady)),
          statsTreeLeaf('Startup cache', formatBoolean(status.sharedStartupCache?.loaded, 'Loaded', status.sharedStartupCache?.rejected ? 'Rejected' : 'Not loaded'))
        ])
      ])
    };
  }

  extractMetrics(rawStats) {
    const stats = rawStats?.stats || rawStats || {};
    return {
      uploadSpeed: kibPerSecondToBytesPerSecond(stats.uploadSpeedKiBps ?? stats.uploadSpeed),
      downloadSpeed: kibPerSecondToBytesPerSecond(stats.downloadSpeedKiBps ?? stats.downloadSpeed),
      uploadTotal: stats.sessionUploadedBytes ?? stats.sessionUploaded ?? 0,
      downloadTotal: stats.sessionDownloadedBytes ?? stats.sessionDownloaded ?? 0
    };
  }

  getNetworkStatus(rawStats) {
    const stats = rawStats?.stats || {};
    const serverStatus = rawStats?.server || rawStats?.servers || {};
    const activeServer = serverStatus.active || serverStatus.currentServer || {};
    const kadStatus = rawStats?.kad || {};
    const serverConnected = serverStatus.connected === true || activeServer.connected === true;
    const highId = rawStats?.ed2kHighId ?? stats.ed2kHighId;
    const ed2k = serverConnected
      ? {
          status: highId === false ? 'yellow' : 'green',
          text: highId === true ? 'High ID' : highId === false ? 'Low ID' : 'Connected',
          connected: true,
          serverName: activeServer.name || null,
          serverPing: activeServer.ping || null,
          serverAddress: activeServer.address || null
        }
      : { status: 'red', text: 'Disconnected', connected: false, serverName: null, serverPing: null, serverAddress: null };
    const kad = kadStatus.connected
      ? { status: kadStatus.firewalled ? 'yellow' : 'green', text: kadStatus.firewalled ? 'Firewalled' : 'OK', connected: true }
      : { status: kadStatus.running ? 'yellow' : 'red', text: kadStatus.running ? 'Starting' : 'Disconnected', connected: false };
    return { ed2k, kad };
  }

  async _transferAction(hash, action) {
    await this._request('POST', `/api/v1/transfers/${encodeURIComponent(hash)}/operations/${encodeURIComponent(action)}`, {});
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

  async deleteItem(hash, { deleteFiles, isShared } = {}) {
    if (isShared) {
      const suffix = deleteFiles === true ? '/file?confirm=true' : '';
      const payload = await this._request('DELETE', `/api/v1/shared-files/${encodeURIComponent(hash)}${suffix}`);
      if (isOperationSuccess(payload, { allowEmpty: true, expectedHash: hash })) return { success: true, pathsToDelete: [] };
      return { success: false, error: operationErrorMessage(payload, 'eMuleBB rejected the shared-file delete request') };
    }

    const suffix = deleteFiles === true ? '/files?confirm=true' : '';
    const payload = await this._request('DELETE', `/api/v1/transfers/${encodeURIComponent(hash)}${suffix}`);
    if (isOperationSuccess(payload, { allowEmpty: true, expectedHash: hash })) {
      this.trackDeletion(hash);
      return { success: true, pathsToDelete: [] };
    }
    return { success: false, error: operationErrorMessage(payload, 'eMuleBB rejected the delete request') };
  }

  /**
   * Rename an incomplete transfer.
   * @param {string} hash - File hash
   * @param {string} newName - New display filename
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async renameFile(hash, newName) {
    try {
      await this._request('PATCH', `/api/v1/transfers/${encodeURIComponent(hash)}`, {
        name: String(newName || '').trim()
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Set rating and comment on a completed shared file.
   * @param {string} hash - File hash
   * @param {string} comment - Comment text, empty string clears it
   * @param {number} rating - Rating from 0 to 5
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async setFileRatingComment(hash, comment, rating) {
    try {
      await this._request('PATCH', `/api/v1/shared-files/${encodeURIComponent(hash)}`, {
        comment: String(comment ?? ''),
        rating
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
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

  async onConnectSync(categoryManager) {
    const categories = await this.getCategories();
    if (!categories) return;

    const defaultCategory = categories.find(category => Number(category.id) === 0);
    if (defaultCategory?.path) {
      categoryManager.setClientDefaultPath(this.instanceId, defaultCategory.path);
    }
  }

  async createCategory({ name, path = '', comment = '', color = null, priority = 0 } = {}) {
    if (!this.client) throw new Error('eMuleBB not connected');
    const payload = {
      name: String(name || '').trim(),
      path: path || null,
      comment: String(comment || ''),
      priority
    };
    if (color != null) payload.color = color;
    const result = await this._request('POST', '/api/v1/categories', payload);
    await this._refreshCategories();
    return { success: true, categoryId: result?.id ?? null };
  }

  async editCategory({ id, name, path = '', comment = '', color = null, priority = 0 } = {}) {
    if (!this.client) throw new Error('eMuleBB not connected');
    if (id == null) return { success: false, verified: false, mismatches: ['No eMuleBB category ID'] };
    const payload = {
      name: String(name || '').trim(),
      path: path || null,
      comment: String(comment || ''),
      priority
    };
    if (color != null) payload.color = color;
    await this._request('PATCH', `/api/v1/categories/${encodeURIComponent(id)}`, payload);
    const categories = await this._refreshCategories();
    const saved = categories.find(category => category.id === Number(id));
    if (!saved) return { success: true, verified: false, mismatches: ['Category not found after update'] };
    const mismatches = [];
    if (saved.name !== payload.name) mismatches.push(`name: expected "${payload.name}", got "${saved.name}"`);
    if (normalizeComparablePath(saved.path) !== normalizeComparablePath(path)) mismatches.push(`path: expected "${path || ''}", got "${saved.path || ''}"`);
    if ((saved.comment || '') !== payload.comment) mismatches.push(`comment: expected "${payload.comment}", got "${saved.comment || ''}"`);
    if ((saved.priority ?? 0) !== priority) mismatches.push(`priority: expected ${priority}, got ${saved.priority ?? 0}`);
    return { success: true, verified: mismatches.length === 0, mismatches };
  }

  async deleteCategory({ id } = {}) {
    if (!this.client) throw new Error('eMuleBB not connected');
    if (id == null) return;
    await this._request('DELETE', `/api/v1/categories/${encodeURIComponent(id)}`, {});
    await this._refreshCategories();
  }

  async renameCategory({ id, newName, path = '', comment = '', color = null, priority = 0 } = {}) {
    return await this.editCategory({ id, name: newName, path, comment, color, priority });
  }

  async ensureCategoryExists({ name, path = '', color = null, comment = '', priority = 0 } = {}) {
    if (!this.client) throw new Error('eMuleBB not connected');
    await this._refreshCategories();
    const trimmedName = String(name || '').trim();
    const existing = this._categoryByName.get(trimmedName.toLowerCase());
    if (existing?.id != null) return { amuleId: existing.id };
    const result = await this.createCategory({ name: trimmedName, path, color, comment, priority });
    return { amuleId: result.categoryId };
  }

  async ensureCategoriesBatch(categories) {
    if (!this.client || !categories?.length) return [];
    await this._refreshCategories();
    const results = [];
    for (const category of categories) {
      const name = String(category?.name || '').trim();
      if (!name) continue;
      const existing = this._categoryByName.get(name.toLowerCase());
      if (existing?.id != null) {
        results.push({ name, amuleId: existing.id });
        continue;
      }
      try {
        const created = await this.createCategory(category);
        if (created.categoryId != null) results.push({ name, amuleId: created.categoryId });
      } catch (err) {
        this.warn(`Failed to create eMuleBB category "${name}": ${logger.errorDetail(err)}`);
      }
    }
    return results;
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
      await this._request('PATCH', `/api/v1/transfers/${encodeURIComponent(hash)}`, { categoryId: numericCategoryId });
      return { success: true };
    }

    const name = String(categoryName || '').trim();
    if (!name) {
      return { success: false, error: 'eMuleBB category assignment requires categoryId or categoryName' };
    }

    if (!this._categoryByName.has(name.toLowerCase())) {
      await this._refreshCategories();
    }
    if (!this._categoryByName.has(name.toLowerCase())) {
      return { success: false, error: `Unknown eMuleBB category: ${name}` };
    }

    await this._request('PATCH', `/api/v1/transfers/${encodeURIComponent(hash)}`, { categoryName: name });
    return { success: true };
  }

  async search(query, type, extension) {
    const { requestedType, method, fileType } = normalizeSearchRequest(type);
    this.lastSearchId = null;
    this.lastSearchResults = [];
    this.lastSearchMeta = {
      id: null,
      query: String(query || ''),
      requestedType,
      method,
      fileType,
      status: 'starting'
    };
    const start = await this._request('POST', '/api/v1/searches', {
      query,
      method,
      type: fileType,
      extension: extension || ''
    });
    this.lastSearchId = start.id || start.searchId;
    this.lastSearchMeta = {
      ...this.lastSearchMeta,
      id: this.lastSearchId,
      status: start.status || 'running'
    };
    if (!this.lastSearchId) return this.getCachedSearchResults();
    return await this._pollSearchResults();
  }

  async _pollSearchResults({ maxAttempts = 5, intervalMs = 1000 } = {}) {
    let latest = { results: [], resultsLength: 0, status: 'running' };
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      latest = await this.getSearchResults();
      if (latest.resultsLength > 0 || latest.status === 'complete') return latest;
      if (attempt + 1 < maxAttempts) await delay(intervalMs);
    }
    return latest;
  }

  async getSearchResults() {
    if (!this.lastSearchId) return this.getCachedSearchResults();
    const payload = await this._request('GET', `/api/v1/searches/${encodeURIComponent(this.lastSearchId)}`);
    const backendMethod = payload.method ? String(payload.method).toLowerCase() : null;
    if (!searchMethodMatches(this.lastSearchMeta?.method, backendMethod)) {
      this.warn(`Ignoring eMuleBB search results for method "${backendMethod}" while "${this.lastSearchMeta.method}" was requested`);
      this.lastSearchResults = [];
      this.lastSearchMeta = {
        ...(this.lastSearchMeta || {}),
        id: this.lastSearchId,
        status: payload.status || this.lastSearchMeta?.status || 'unknown'
      };
      return this.getCachedSearchResults();
    }
    const expectedMethod = backendMethod || this.lastSearchMeta?.method || null;
    const results = (payload.results || [])
      .filter(item => searchMethodMatches(expectedMethod, item.method))
      .map(item => ({
      fileHash: item.hash,
      fileName: item.name,
      fileSize: item.sizeBytes ?? item.size,
      sourceCount: item.sources || 0,
      completeSourceCount: item.completeSources || 0,
      ed2kLink: makeEd2kLink(item),
      raw: item
    }));
    this.lastSearchResults = results;
    this.lastSearchMeta = {
      ...(this.lastSearchMeta || {}),
      id: this.lastSearchId,
      status: payload.status || this.lastSearchMeta?.status || 'unknown'
    };
    return this.getCachedSearchResults();
  }

  getCachedSearchResults({ type } = {}) {
    const meta = this.lastSearchMeta || {};
    if (type) {
      const requested = normalizeSearchRequest(type);
      if (meta.method && requested.method !== meta.method) {
        return {
          results: [],
          resultsLength: 0,
          status: meta.status || 'unknown',
          searchId: meta.id || null,
          searchMethod: meta.method || null,
          searchType: meta.requestedType || null,
          query: meta.query || null
        };
      }
    }
    const results = this.lastSearchResults || [];
    return {
      results,
      resultsLength: results.length,
      status: meta.status || 'unknown',
      searchId: meta.id || null,
      searchMethod: meta.method || null,
      searchType: meta.requestedType || null,
      query: meta.query || null
    };
  }

  async addSearchResult(fileHash, categoryId = 0, username = null, fileInfoCallback = null) {
    const file = this.lastSearchResults.find(item => item.fileHash?.toLowerCase() === fileHash.toLowerCase());
    if (!file?.ed2kLink) return false;
    const numericCategoryId = Number.isInteger(categoryId) ? categoryId : Number.parseInt(categoryId, 10);
    if (this.lastSearchId) {
      const payload = {};
      if (Number.isInteger(numericCategoryId) && numericCategoryId >= 0) payload.categoryId = numericCategoryId;
      await this._request(
        'POST',
        `/api/v1/searches/${encodeURIComponent(this.lastSearchId)}/results/${encodeURIComponent(fileHash)}/operations/download`,
        payload
      );
      if (fileInfoCallback) await fileInfoCallback(fileHash).catch(() => null);
      this.trackDownload(fileHash, file.fileName || 'Unknown', file.fileSize || null, username, this._categoryById.get(numericCategoryId)?.name || 'Default');
      return true;
    }
    const success = await this.addEd2kLink(file.ed2kLink, categoryId, username);
    if (success && fileInfoCallback) await fileInfoCallback(fileHash).catch(() => null);
    return success;
  }

  async getServerList() {
    return unwrapItems(await this._request('GET', '/api/v1/servers'));
  }

  async connectServer(ip, port) {
    await this._request('POST', `/api/v1/servers/${encodeURIComponent(`${ip}:${port}`)}/operations/connect`, {});
    return true;
  }

  async disconnectServer() {
    await this._request('POST', '/api/v1/servers/operations/disconnect', {});
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

  async getSharedDirectories() {
    const payload = await this._request('GET', '/api/v1/shared-directories');
    const roots = unwrapItems(payload.roots || []).map(normalizeSharedDirectoryRoot).filter(row => row.path);
    const items = unwrapItems(payload.items || []).map(normalizeSharedDirectoryRoot).filter(row => row.path);
    const inaccessibleRoots = roots.filter(row => !row.accessible).map(row => row.path);
    return {
      configured: true,
      path: null,
      exists: true,
      canWrite: true,
      roots: roots.map(row => row.path),
      inaccessibleRoots,
      items,
      raw: payload
    };
  }

  async saveSharedDirectories(directories) {
    const roots = (Array.isArray(directories) ? directories : [])
      .map(path => String(path || '').trim())
      .filter(Boolean)
      .map(path => ({ path, recursive: true }));
    const payload = await this._request('PATCH', '/api/v1/shared-directories', { roots });
    const model = payload || {};
    const totalDirs = Array.isArray(model.items) ? model.items.length : roots.length;
    const inaccessibleRoots = Array.isArray(model.roots)
      ? model.roots.filter(row => row?.accessible === false).map(row => row.path).filter(Boolean)
      : [];
    const result = { success: true, roots: roots.length, totalDirs };
    if (inaccessibleRoots.length > 0) {
      result.warnings = inaccessibleRoots.map(path => `Cannot access ${path}`);
    }
    return result;
  }

  async refreshSharedFiles() {
    await this._request('POST', '/api/v1/shared-directories/operations/reload', {});
    return true;
  }

  acquireSearchLock() {
    if (this.searchInProgress) return false;
    this.searchInProgress = true;
    return true;
  }

  releaseSearchLock() {
    this.searchInProgress = false;
  }

  isSearchInProgress() {
    return this.searchInProgress;
  }

  async shutdown() {
    this.clearReconnect();
    this.client = null;
  }
}

module.exports = { EmulebbManager };
