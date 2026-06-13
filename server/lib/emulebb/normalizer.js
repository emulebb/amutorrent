'use strict';

/**
 * Normalize eMuleBB REST payloads into the aMuTorrent manager contract.
 *
 * eMuleBB completion must follow native state, not byte equality. The REST
 * `completedBytes` field comes from verified local completion, but the manager
 * contract expects an explicit `isComplete` flag so downstream history and
 * notification code never guesses from display progress.
 */

function makeEd2kLink(file) {
  const size = file?.sizeBytes ?? file?.size;
  if (!file?.hash || !file?.name || !size) return null;
  return `ed2k://|file|${encodeURIComponent(file.name)}|${size}|${String(file.hash).toLowerCase()}|/`;
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
  const state = String(file.state || 'queued').toLowerCase();
  return {
    clientType: 'emulebb',
    instanceId,
    hash,
    name: file.name || 'Unknown',
    rawName: file.name || 'Unknown',
    size,
    downloaded: completed,
    isComplete: state === 'completed',
    category: categoryName,
    categoryId: Number.isInteger(categoryId) ? categoryId : 0,
    categoryName,
    renameSupported: true,
    ed2kLink: makeEd2kLink(file),
    progress: normalizeProgressPercent(file.progress),
    speed: kibPerSecondToBytesPerSecond(file.downloadSpeedKiBps ?? file.downloadSpeed),
    status: state,
    statusText: state,
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
    isComplete: true,
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

/**
 * eMuleBB reports upload part-progress as the obtained/total ED2K part counts
 * for the requested file. Convert to a 0–100 percent for the peer row, or null
 * when the counts can't produce a meaningful value.
 */
function computeUploadPartsPercent(obtained, total) {
  const t = Number(total);
  const o = Number(obtained);
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(o) || o < 0) return null;
  return Math.min(100, Math.round((o * 100) / t));
}

/**
 * Normalize one eMuleBB upload row into the unified peer-entry contract consumed
 * by unifiedItemBuilder.buildPeer (role/address/uploadRate/software/...), so an
 * active upload renders as an upload peer on its file's item. This is a distinct
 * shape from normalizeUpload, which targets the legacy standalone uploads array.
 */
function normalizeUploadPeer(client) {
  const software = [client.clientSoftware, client.clientMod]
    .map(part => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
  return {
    role: 'upload',
    clientType: 'emulebb',
    id: client.userHash || client.clientId || `${client.address || client.ip || ''}:${client.port || 0}`,
    userName: client.userName || '',
    fileName: client.requestedFileName || '',
    address: client.address || client.ip || '',
    port: client.port || 0,
    software: software || 'Unknown',
    uploadRate: kibPerSecondToBytesPerSecond(client.uploadSpeedKiBps ?? client.uploadSpeed),
    downloadRate: 0,
    uploadTotal: 0,
    uploadSession: client.uploadedBytes ?? client.sessionUploaded ?? null,
    uploadState: client.uploadState || 'uploading',
    completedPercent: computeUploadPartsPercent(client.requestedPartsObtained, client.requestedPartsTotal),
    isEncrypted: false,
    isIncoming: false
  };
}

/**
 * Build a shared-file-shaped item for a file that is being uploaded but is not
 * present in the snapshot frame. eMuleBB shares tens of thousands of files while
 * the snapshot carries only a bounded page, so an uploaded file is almost never
 * in the frame; the self-describing upload rows let us reconstruct the item from
 * the requested-file fields and carry its upload peers and aggregated speed.
 *
 * @param {Object} group - { hash, name, size, peers, uploadSpeed }
 */
function normalizeUploadFile(group, instanceId) {
  const item = normalizeSharedFile(
    { hash: group.hash, name: group.name, sizeBytes: group.size },
    instanceId
  );
  item.peers = group.peers;
  item.uploadSpeed = group.uploadSpeed;
  item.syntheticUploadFile = true;
  return item;
}

/**
 * Normalize an eMuleBB REST server row into the EC-compatible shape the
 * aMuTorrent servers view consumes. The frontend was built around aMule's EC
 * field names (`EC_TAG_SERVER_*`, `_value`), so the eMuleBB-native fields
 * (`name`/`description`/`ip`/`port`/...) must be mapped onto that contract or
 * the table renders empty rows. `_value` is the `ip:port` identifier used by the
 * connect/remove/priority row actions.
 */
function normalizeServer(row) {
  const ip = row?.ip || row?.address || '';
  const port = row?.port || 0;
  return {
    _value: ip ? `${ip}:${port}` : '',
    EC_TAG_SERVER_NAME: row?.name || row?.description || ip || 'Unknown',
    EC_TAG_SERVER_DESC: row?.description || '',
    EC_TAG_SERVER_USERS: parseFiniteNumber(row?.users, 0),
    EC_TAG_SERVER_USERS_MAX: parseFiniteNumber(row?.maxUsers, 0),
    EC_TAG_SERVER_FILES: parseFiniteNumber(row?.files, 0),
    EC_TAG_SERVER_PING: parseFiniteNumber(row?.ping, 0),
    EC_TAG_SERVER_VERSION: row?.version || '',
    connected: row?.connected === true,
    current: row?.current === true,
    raw: row
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

module.exports = {
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
};
