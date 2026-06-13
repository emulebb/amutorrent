'use strict';

// Drives aMuTorrent's real eMuleBB controller adapter (EmulebbManager) against a
// live emulebb-rust REST endpoint, proving aMuTorrent manages the Rust client
// through the canonical /api/v1 contract with no private adapters, aliases, or
// shims. Connection details come from --host/--port/--api-key (or EMULEBB_RUST_*).
//
// Emits a single JSON line: {"ok":true,...} on success, {"ok":false,"error":...}
// on failure (exit code 1).

const { EmulebbManager } = require('../server/modules/emulebbManager');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(value => value.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const envKey = `EMULEBB_RUST_${name.toUpperCase().replace(/-/g, '_')}`;
  return process.env[envKey] !== undefined ? process.env[envKey] : fallback;
}

async function main() {
  const host = arg('host', '127.0.0.1');
  const port = parseInt(arg('port', '4711'), 10);
  const apiKey = arg('api-key', '');
  const query = arg('query', 'scenario');

  const manager = new EmulebbManager();
  manager.instanceId = 'emulebb-rust-controller-check';
  manager.setClientConfig({ enabled: true, host, port, apiKey });

  const out = { host, port };

  const connected = await manager.initClient();
  if (!connected || !manager.isConnected()) {
    throw new Error('initClient failed (eMuleBB /api/v1/app or categories rejected the adapter)');
  }
  out.connected = true;
  out.version = (manager.client && manager.client.version && manager.client.version.version) || null;
  out.categories = Array.isArray(manager._categories) ? manager._categories.length : 0;

  const data = await manager.fetchData();
  if (!data || !Array.isArray(data.downloads) || !Array.isArray(data.sharedFiles) || !Array.isArray(data.uploads)) {
    throw new Error(`fetchData returned an unexpected shape: ${JSON.stringify(data).slice(0, 300)}`);
  }
  out.downloads = data.downloads.length;
  out.sharedFiles = data.sharedFiles.length;
  out.uploads = data.uploads.length;

  // Exercise search through the controller surface. Empty type -> automatic
  // (local index) method, which sends the contract's optional `extension` field.
  const search = await manager.search(query, '', '');
  out.searchId = manager.lastSearchId || null;
  out.searchStatus = (search && search.status) || (manager.lastSearchMeta && manager.lastSearchMeta.status) || null;
  out.searchResults = search
    ? (search.resultsLength != null ? search.resultsLength : (Array.isArray(search.results) ? search.results.length : 0))
    : 0;

  console.log(JSON.stringify({ ok: true, ...out }));
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  process.exit(1);
});
