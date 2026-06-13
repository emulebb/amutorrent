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
const {
  buildCategoryMaps,
  formatBoolean,
  formatBytes,
  formatLifecycleState,
  formatRateKiBps,
  hasCapability,
  kibPerSecondToBytesPerSecond,
  makeEd2kLink,
  normalizeCategory,
  normalizeLifecycle,
  normalizeServer,
  normalizeSharedDirectoryRoot,
  normalizeSharedFile,
  normalizeTransfer,
  normalizeTransferPart,
  normalizeTransferSource,
  normalizeUpload,
  normalizeUploadFile,
  normalizeUploadPeer,
  parseFiniteNumber
} = require('../lib/emulebb/normalizer');

function normalizeBasePath(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value || value === '/') return '';
  return value.startsWith('/') ? value.replace(/\/+$/, '') : `/${value.replace(/^\/+|\/+$/g, '')}`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const SAFE_GET_RETRY_ATTEMPTS = 8;
const SAFE_GET_RETRY_BASE_DELAY_MS = 100;
// Shared files are fetched via the paginated REST endpoint (not the snapshot
// page) on a slower cadence than the 3s poll, then cached and reused between
// refreshes. The set is CAPPED: every exposed shared file flows through the live
// unified-items/delta pipeline each cycle, so an uncapped large library (tens of
// thousands) burns CPU and memory. The cap bounds that cost; raise
// EMULEBB_SHARED_MAX_ITEMS to surface more. History tracking of these shared
// files is disabled separately (clientMeta historyFromShared=false) so they do
// not flood the download-history DB.
const EMULEBB_SHARED_REFRESH_MS = 30000;
const EMULEBB_SHARED_MAX_ITEMS = Math.max(1, Number(process.env.EMULEBB_SHARED_MAX_ITEMS) || 2000);
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
  // eMuleBB serves one web worker and sheds load with HTTP 503 (SERVICE_BUSY)
  // when the UI thread or REST worker is saturated; safe GET reads should ride
  // that out rather than dropping the frame.
  if (err && (err.statusCode === 503 || err.code === 'SERVICE_BUSY')) return true;
  const message = String(err?.message || err || '');
  return RETRYABLE_TRANSPORT_ERROR_FRAGMENTS.some(fragment => message.includes(fragment));
}

function normalizeComparablePath(rawPath) {
  return String(rawPath || '').trim().replace(/[\\/]+$/g, '').toLowerCase();
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

function firstOperationItem(payload) {
  return payload?.items?.[0] ?? payload?.results?.[0] ?? payload;
}

function hashMatches(file, hash) {
  const candidate = String(file?.hash || file?.fileHash || '').toLowerCase();
  return Boolean(hash) && candidate === String(hash).toLowerCase();
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

class EmulebbManager extends BaseClientManager {
  constructor() {
    super();
    this.lastSnapshot = null;
    this.lastSharedFiles = [];
    this._sharedFilesFetchedAt = 0;
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
          let parseError = null;
          if (text) {
            try {
              payload = JSON.parse(text);
            } catch (err) {
              parseError = err;
            }
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // WHY: eMuleBB returns plain-text backpressure bodies on overload
            // (HTTP 503 "eMuleBB web API is busy") that are not JSON. Parsing
            // first surfaced these as a misleading "Invalid JSON" error and
            // skipped the retry path. Build the error from the JSON payload when
            // it parsed, otherwise from the status + raw text, and tag 503 as a
            // retryable SERVICE_BUSY so GET polling rides out transient busy
            // windows instead of dropping the frame.
            let code;
            let message;
            if (payload != null && parseError === null) {
              ({ code, message } = normalizeErrorPayload(payload, res.statusCode, text));
            } else {
              code = res.statusCode === 503 ? 'SERVICE_BUSY' : `HTTP_${res.statusCode}`;
              message = (text || '').trim() || `eMuleBB returned HTTP ${res.statusCode}`;
            }
            const err = new Error(`eMuleBB ${code}: ${message}`);
            err.code = code;
            err.statusCode = res.statusCode;
            if (code === 'EMULE_UNAVAILABLE') this._markLifecycleUnavailable();
            return reject(err);
          }
          if (parseError !== null) {
            return reject(new Error(`Invalid JSON from eMuleBB: ${parseError.message}`));
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
    // Shared files: enumerate the full set via the paginated endpoint rather than
    // the snapshot's bounded page (which capped the Shared Files view at ~100 of
    // a large library). Throttled to EMULEBB_SHARED_REFRESH_MS and cached between
    // refreshes; while shared hashing/startup is still warming, reuse the cache.
    const sharedFilesReady = stats.sharedFilesReady !== false && stats.sharedHashingActive !== true;
    let sharedFiles;
    if (!sharedFilesReady) {
      sharedFiles = this.lastSharedFiles.slice();
    } else {
      const now = Date.now();
      const stale = this.lastSharedFiles.length === 0 || (now - this._sharedFilesFetchedAt) >= EMULEBB_SHARED_REFRESH_MS;
      if (stale) {
        try {
          const rows = await this._fetchAllPages('/api/v1/shared-files', { pageLimit: 1000, maxItems: EMULEBB_SHARED_MAX_ITEMS });
          sharedFiles = rows.map(item => normalizeSharedFile(item, this.instanceId));
          this.lastSharedFiles = sharedFiles.slice();
          this._sharedFilesFetchedAt = now;
        } catch (err) {
          this.warn(`Failed to page eMuleBB shared files, falling back to snapshot page: ${logger.errorDetail(err)}`);
          if (this.lastSharedFiles.length > 0) {
            sharedFiles = this.lastSharedFiles.slice();
          } else {
            // No cache yet: degrade to the snapshot's bounded shared page so the
            // view is not empty. Leave _sharedFilesFetchedAt unset so the next
            // ready cycle retries the full paginated walk.
            sharedFiles = unwrapItems(snapshot.sharedFiles).map(item => normalizeSharedFile(item, this.instanceId));
            this.lastSharedFiles = sharedFiles.slice();
          }
        }
      } else {
        sharedFiles = this.lastSharedFiles.slice();
      }
    }
    // Transfers via the dedicated paginated endpoint so the downloads list is
    // not capped at the snapshot page size; fall back to the snapshot page if
    // the paged read fails so a transient error doesn't blank the list.
    let transferRows;
    try {
      transferRows = await this._fetchAllPages('/api/v1/transfers', { pageLimit: 1000 });
    } catch (err) {
      this.warn(`Failed to page eMuleBB transfers, using snapshot page: ${logger.errorDetail(err)}`);
      transferRows = unwrapItems(snapshot.transfers);
    }
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
    // Surface active uploads. aMuTorrent has no standalone uploads collection —
    // the uploads view is driven by upload peers embedded on each file's item
    // (see amuleManager). eMuleBB shares tens of thousands of files but the
    // snapshot only carries a bounded page of them, so an uploaded file is
    // almost never in this frame. Active uploads are bounded by upload slots and
    // each row is self-describing, so attach upload peers to the matching frame
    // item when present and otherwise synthesize a file item from the upload's
    // own fields. Bounded by slots, not by total shared-file count.
    const uploadRows = unwrapItems(snapshot.uploads);
    const frameByHash = new Map();
    for (const download of downloads) {
      if (download.hash) frameByHash.set(String(download.hash).toLowerCase(), download);
    }
    // Shared files win over downloads on a hash collision (a partfile shared
    // while downloading): both merge into one unified item, so attaching to a
    // single frame entry avoids duplicating the upload peers on that item.
    for (const sharedFile of sharedFiles) {
      if (sharedFile.hash) frameByHash.set(String(sharedFile.hash).toLowerCase(), sharedFile);
    }
    const uploadGroups = new Map();
    for (const row of uploadRows) {
      const hash = String(row.requestedFileHash || '').toLowerCase();
      if (!hash) continue;
      const peer = normalizeUploadPeer(row);
      let group = uploadGroups.get(hash);
      if (!group) {
        group = {
          hash,
          name: row.requestedFileName || 'Unknown',
          size: row.requestedFileSizeBytes ?? row.requestedFileSize ?? 0,
          peers: [],
          uploadSpeed: 0
        };
        uploadGroups.set(hash, group);
      }
      group.peers.push(peer);
      group.uploadSpeed += peer.uploadRate || 0;
    }
    for (const group of uploadGroups.values()) {
      const item = frameByHash.get(group.hash);
      if (item) {
        // File is already in the frame (small library, or a partfile also being
        // shared). Attach peers without altering completion state.
        if (!Array.isArray(item.peers)) item.peers = [];
        item.peers.push(...group.peers);
        item.uploadSpeed = (item.uploadSpeed || 0) + group.uploadSpeed;
      } else {
        sharedFiles.push(normalizeUploadFile(group, this.instanceId));
      }
    }

    return {
      downloads,
      sharedFiles,
      uploads: uploadRows.map(item => normalizeUpload(item, this.instanceId)),
      nativeStatus: {
        lifecycle,
        sharedFilesReady,
        sharedHashingActive: stats.sharedHashingActive === true,
        sharedHashingCount: Number.isFinite(Number(stats.sharedHashingCount)) ? Number(stats.sharedHashingCount) : null,
        sharedStartupCache: status.sharedStartupCache || null
      }
    };
  }

  /**
   * Walk a paginated eMuleBB list endpoint ({ items, total, limit, offset }) and
   * return every row, bounded by maxItems. The snapshot caps each collection at
   * its page size; this lets the adapter surface the full transfers and shared
   * sets. Pages go through the serialized request queue (eMuleBB runs one web
   * worker) and transient SERVICE_BUSY 503s are absorbed by the GET retry.
   */
  async _fetchAllPages(path, { pageLimit = 1000, maxItems = Infinity } = {}) {
    const rows = [];
    let offset = 0;
    for (;;) {
      const sep = path.includes('?') ? '&' : '?';
      const payload = await this._request('GET', `${path}${sep}limit=${pageLimit}&offset=${offset}`);
      const items = unwrapItems(payload);
      if (items.length === 0) break;
      for (const item of items) {
        rows.push(item);
        if (rows.length >= maxItems) return rows;
      }
      offset += items.length;
      const total = Number(unwrapPayload(payload)?.total);
      if (Number.isFinite(total)) {
        if (offset >= total) break;
      } else if (items.length < pageLimit) {
        break;
      }
    }
    return rows;
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

  /**
   * Extract per-item history metadata for the download-history tracker.
   *
   * autoRefreshManager calls this on every connected manager (each ED2K/torrent
   * adapter implements it); eMuleBB previously lacked it, which threw on every
   * refresh cycle. Mirrors the aMule contract using eMuleBB's normalized fields:
   * shared files report `downloaded = size`, and upload totals come from the
   * shared-file transfer counters.
   */
  extractHistoryMetadata(item) {
    const size = item.size || 0;
    const uploaded = item.transferredTotal ?? item.transferred ?? item.uploadTotal ?? 0;
    const downloaded = item.downloaded != null ? item.downloaded : size;
    const ratio = downloaded > 0 ? uploaded / downloaded : 0;
    return {
      hash: item.hash ? String(item.hash).toLowerCase() : undefined,
      instanceId: item.instanceId,
      size,
      name: item.name,
      downloaded,
      uploaded,
      ratio,
      trackerDomain: null,
      directory: item.path || item.directory || null,
      multiFile: false,
      category: null // filled from unified items categoryByKey lookup
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
    // WHY: the core runs pause/resume/stop through its bulk-mutation handler, which
    // reports a refusal ("transfer cannot be <action>") as HTTP 200 with
    // items[].ok=false rather than a non-2xx status. Returning unconditionally would
    // report success for an action the core refused, so verify the per-item result
    // and surface the core's reason (consistent with deleteItem/addEd2kLink).
    const payload = await this._request('POST', `/api/v1/transfers/${encodeURIComponent(hash)}/operations/${encodeURIComponent(action)}`, {});
    if (!isOperationSuccess(payload, { allowEmpty: true, expectedHash: hash })) {
      throw new Error(operationErrorMessage(payload, `eMuleBB rejected the ${action} request`));
    }
    return true;
  }

  async pause(hash) { return await this._transferAction(hash, 'pause'); }
  async resume(hash) { return await this._transferAction(hash, 'resume'); }
  async stop(hash) { return await this._transferAction(hash, 'stop'); }

  async addEd2kLink(link, categoryId = 0, username = null) {
    const parsed = parseEd2kLink(link);
    let payload;
    for (let attempt = 1; attempt <= SAFE_GET_RETRY_ATTEMPTS; attempt += 1) {
      try {
        payload = await this._request('POST', '/api/v1/transfers', { link });
        break;
      } catch (err) {
        if (!parsed.hash || !isRetryableTransportError(err) || attempt >= SAFE_GET_RETRY_ATTEMPTS) throw err;
        // WHY: Windows VM smoke runs can briefly reset the native REST socket while
        // eMuleBB is accepting mutations; reconcile before another add to avoid duplicates.
        await delay(SAFE_GET_RETRY_BASE_DELAY_MS * attempt);
        const existing = await this._findTransferByHash(parsed.hash);
        if (existing) {
          await this._finishAddedEd2kTransfer(parsed.hash, existing, parsed, categoryId, username);
          return true;
        }
      }
    }
    const result = firstOperationItem(payload);
    const hash = result?.hash || result?.fileHash;
    if (hash && isOperationSuccess(payload, { expectedHash: hash })) {
      await this._finishAddedEd2kTransfer(hash, result, parsed, categoryId, username);
      return true;
    }
    return false;
  }

  async _findTransferByHash(hash) {
    const payload = await this._request('GET', '/api/v1/transfers?limit=100');
    return unwrapItems(payload).find(file => hashMatches(file, hash)) || null;
  }

  async _deleteTransferByHash(hash, deleteFiles, isComplete) {
    // WHY: eMuleBB core rejects removing a partial (incomplete) transfer without
    // ?confirm=true — a .part has no finished file to "keep", so removal must
    // delete the part data. aMuTorrent declares the eMuleBB cancelDeletesFiles
    // capability (the delete modal promises temp files are auto-deleted and shows
    // no checkbox), so honor that by confirming whenever the transfer is incomplete.
    // Complete transfers keep the default (deleteFiles) so a finished file is not
    // destroyed on a remove-only request.
    const removeFiles = deleteFiles === true || isComplete === false;
    const suffix = removeFiles ? '/files?confirm=true' : '';
    return await this._request('DELETE', `/api/v1/transfers/${encodeURIComponent(hash)}${suffix}`);
  }

  async _finishAddedEd2kTransfer(hash, result, parsed, categoryId, username) {
    const numericCategoryId = Number.isInteger(categoryId) ? categoryId : Number.parseInt(categoryId, 10);
    if (Number.isInteger(numericCategoryId) && numericCategoryId > 0) {
      await this.setCategoryOrLabel(hash, { categoryId: numericCategoryId });
    }
    const categoryName = this._categoryById.get(numericCategoryId)?.name || 'Default';
    this.trackDownload(hash, parsed.filename || result?.name || 'Unknown', parsed.size || result?.size || null, username, categoryName);
  }

  async deleteItem(hash, { deleteFiles, isShared, isComplete } = {}) {
    if (isShared) {
      const suffix = deleteFiles === true ? '/file?confirm=true' : '';
      const payload = await this._request('DELETE', `/api/v1/shared-files/${encodeURIComponent(hash)}${suffix}`);
      if (isOperationSuccess(payload, { allowEmpty: true, expectedHash: hash })) return { success: true, pathsToDelete: [] };
      return { success: false, error: operationErrorMessage(payload, 'eMuleBB rejected the shared-file delete request') };
    }

    let payload;
    for (let attempt = 1; attempt <= SAFE_GET_RETRY_ATTEMPTS; attempt += 1) {
      try {
        payload = await this._deleteTransferByHash(hash, deleteFiles, isComplete);
        break;
      } catch (err) {
        if (!isRetryableTransportError(err) || attempt >= SAFE_GET_RETRY_ATTEMPTS) throw err;
        // WHY: eMuleBB may reset the REST socket around shutdown/restart windows.
        // Reconcile before retrying so a completed delete is not surfaced as a stuck UI item.
        await delay(SAFE_GET_RETRY_BASE_DELAY_MS * attempt);
        const existing = await this._findTransferByHash(hash);
        if (!existing) {
          this.trackDeletion(hash);
          return { success: true, pathsToDelete: [] };
        }
      }
    }
    // WHY: belt-and-suspenders — if a remove-only request still hit the core's
    // partial-deletion guard (the transfer was incomplete but no isComplete hint
    // reached us, e.g. stale cache), retry once with confirm=true. Deleting the
    // .part is the only valid outcome for a partial, so this cannot destroy a
    // finished file that a remove-only request meant to keep.
    const alreadyConfirmed = deleteFiles === true || isComplete === false;
    if (!alreadyConfirmed
        && !isOperationSuccess(payload, { allowEmpty: true, expectedHash: hash })
        && /confirm=true/i.test(operationErrorMessage(payload, ''))) {
      payload = await this._deleteTransferByHash(hash, true, false);
    }
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

    if (!categoryManager.getCategoriesSnapshot || !categoryManager.importCategory) return;

    const { amuleColorToHex } = require('../lib/CategoryManager');
    const snapshot = categoryManager.getCategoriesSnapshot();
    let imported = 0, linked = 0;

    for (const category of categories) {
      const categoryId = Number(category.id);
      if (!Number.isInteger(categoryId) || categoryId < 0) continue;

      if (categoryId === 0) {
        if (!snapshot.getByAmuleId?.(this.instanceId, 0)) {
          categoryManager.linkAmuleId?.('Default', this.instanceId, 0);
          linked++;
        }
        continue;
      }

      const name = category.name || category.title || `Category ${categoryId}`;
      if (snapshot.getByAmuleId?.(this.instanceId, categoryId)) continue;

      const existing = snapshot.getByName?.(name);
      if (existing) {
        if (existing.amuleIds?.[this.instanceId] == null) {
          categoryManager.linkAmuleId?.(name, this.instanceId, categoryId);
          linked++;
        }
        continue;
      }

      categoryManager.importCategory({
        name,
        color: category.color == null ? undefined : amuleColorToHex(category.color),
        path: category.path || null,
        comment: category.comment || 'Imported from eMuleBB',
        priority: category.priority ?? 0,
        amuleIds: { [this.instanceId]: categoryId }
      });
      imported++;
    }

    if (imported > 0 || linked > 0) await categoryManager.save?.();
    this.log(`📊 eMuleBB sync complete: ${imported} imported, ${linked} linked`);

    await categoryManager.propagateToOtherClients?.(this.instanceId);
    await categoryManager.validateAllPaths?.();
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
    const id = encodeURIComponent(this.lastSearchId);
    const pageLimit = 1000;
    // WHY: search results are paged ({ items, total, offset, limit }); walk every
    // page so the UI sees the full result set instead of just the first page.
    const firstPage = await this._request('GET', `/api/v1/searches/${id}?limit=${pageLimit}&offset=0`);
    const backendMethod = firstPage.method ? String(firstPage.method).toLowerCase() : null;
    if (!searchMethodMatches(this.lastSearchMeta?.method, backendMethod)) {
      this.warn(`Ignoring eMuleBB search results for method "${backendMethod}" while "${this.lastSearchMeta.method}" was requested`);
      this.lastSearchResults = [];
      this.lastSearchMeta = {
        ...(this.lastSearchMeta || {}),
        id: this.lastSearchId,
        status: firstPage.status || this.lastSearchMeta?.status || 'unknown'
      };
      return this.getCachedSearchResults();
    }
    // eMuleBB returns search results under "results" (the master's
    // search/results contract), not "items" like other collections.
    const pageResults = page => (Array.isArray(page.results) ? page.results : []);
    const rawItems = [...pageResults(firstPage)];
    const total = Number(firstPage.total);
    let offset = rawItems.length;
    while (Number.isFinite(total) && offset < total) {
      const page = await this._request('GET', `/api/v1/searches/${id}?limit=${pageLimit}&offset=${offset}`);
      const items = pageResults(page);
      if (items.length === 0) break;
      rawItems.push(...items);
      offset += items.length;
    }
    const expectedMethod = backendMethod || this.lastSearchMeta?.method || null;
    const results = rawItems
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
      status: firstPage.status || this.lastSearchMeta?.status || 'unknown'
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
    // Match the aMule EC contract the servers view consumes: an object keyed by
    // EC_TAG_SERVER holding the list, not a bare array (WebSocketContext reads
    // `data.data.EC_TAG_SERVER`). Each row is mapped onto the EC field shape.
    const servers = unwrapItems(await this._request('GET', '/api/v1/servers')).map(normalizeServer);
    return { EC_TAG_SERVER: servers };
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
