'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CONFIG_MODULE_PATH = require.resolve('../server/modules/config');

function reloadConfigWithEnv(env) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  delete require.cache[CONFIG_MODULE_PATH];
  const config = require(CONFIG_MODULE_PATH);
  return {
    config,
    restore() {
      delete require.cache[CONFIG_MODULE_PATH];
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  };
}

test('AMUTORRENT_DATA_DIR isolates config and runtime data paths', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amutorrent-config-test-'));
  const { config, restore } = reloadConfigWithEnv({
    AMUTORRENT_DATA_DIR: dataDir,
    PORT: '51987',
    BIND_ADDRESS: '127.0.0.1'
  });

  try {
    assert.equal(config.dataDir, path.resolve(dataDir));

    const runtimeConfig = await config.loadConfig();

    assert.equal(runtimeConfig.directories.data, dataDir);
    assert.equal(config.getDataDir(), path.resolve(dataDir));
    assert.equal(config.PORT, 51987);
    assert.equal(config.HOST, '127.0.0.1');
  } finally {
    restore();
  }
});

test('configuration accepts aMule and eMule BB as separate ED2K backends', () => {
  const { config, restore } = reloadConfigWithEnv({});
  const clientMeta = require('../server/lib/clientMeta');

  try {
    const runtimeConfig = config.getDefaults();
    runtimeConfig.clients = [
      {
        type: 'amule',
        name: 'aMule parity backend',
        host: '127.0.0.1',
        port: 4712,
        password: 'amule-secret'
      },
      {
        type: 'emulebb',
        name: 'eMule BB native backend',
        host: '127.0.0.1',
        port: 4711,
        apiKey: 'emulebb-key',
        useSsl: false
      }
    ];

    const validation = config.validateConfig(runtimeConfig);
    assert.deepEqual(validation, { valid: true, errors: [] });

    const clients = config._normalizeClientsArray(runtimeConfig.clients);
    assert.equal(clients.length, 2);
    assert.equal(clients[0].type, 'amule');
    assert.equal(clients[1].type, 'emulebb');
    assert.notEqual(clients[0].id, clients[1].id);
    assert.equal(clientMeta.get(clients[0].type).networkType, 'ed2k');
    assert.equal(clientMeta.get(clients[1].type).networkType, 'ed2k');
  } finally {
    restore();
  }
});
