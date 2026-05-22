'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const registry = require('../server/lib/ClientRegistry');
const config = require('../server/modules/config');
const qbittorrentAPI = require('../server/modules/qbittorrentAPI');

function refreshHandler() {
  qbittorrentAPI.setHashStore({
    getEd2kHash: hash => hash,
    removeMapping() {},
    setMapping() {}
  });
}

function registerManager(instanceId, clientType) {
  return registry.register(instanceId, clientType, {
    isConnected: () => true
  });
}

test('qBittorrent compatibility API does not proxy through eMuleBB managers', () => {
  const originalRuntimeConfig = config.runtimeConfig;
  registry.clear();
  config.runtimeConfig = { integrations: {} };

  try {
    registerManager('emulebb-127.0.0.1-4711', 'emulebb');
    refreshHandler();

    assert.equal(qbittorrentAPI.handler.getEd2kManager(), null);
    assert.equal(qbittorrentAPI.handler.getAmuleInstanceId(), null);

    const amuleManager = registerManager('amule-127.0.0.1-4712', 'amule');
    refreshHandler();

    assert.equal(qbittorrentAPI.handler.getEd2kManager(), amuleManager);
    assert.equal(qbittorrentAPI.handler.getAmuleInstanceId(), 'amule-127.0.0.1-4712');

    config.runtimeConfig.integrations.amuleInstanceId = 'emulebb-127.0.0.1-4711';
    refreshHandler();

    assert.equal(qbittorrentAPI.handler.getEd2kManager(), amuleManager);
  } finally {
    config.runtimeConfig = originalRuntimeConfig;
    registry.clear();
  }
});
