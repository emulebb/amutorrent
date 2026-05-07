'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const registry = require('../server/lib/ClientRegistry');
const webSocketHandlers = require('../server/modules/webSocketHandlers');

function createContext() {
  const sent = [];
  return {
    sent,
    log() {},
    error() {},
    send(payload) {
      sent.push(payload);
    }
  };
}

test('refresh shared files targets connected eMule BB managers', async () => {
  registry.clear();
  const calls = [];
  registry.register('emulebb-127.0.0.1-4711', 'emulebb', {
    isConnected: () => true,
    async refreshSharedFiles() {
      calls.push('refresh');
    }
  });
  const originalBroadcastItemsUpdate = webSocketHandlers.broadcastItemsUpdate;
  webSocketHandlers.broadcastItemsUpdate = async () => {};

  try {
    const context = createContext();

    await webSocketHandlers.handleRefreshSharedFiles({ instanceId: 'emulebb-127.0.0.1-4711' }, context);

    assert.deepEqual(calls, ['refresh']);
    assert.deepEqual(context.sent[0], {
      type: 'shared-files-refreshed',
      message: 'Shared files reloaded successfully'
    });
  } finally {
    webSocketHandlers.broadcastItemsUpdate = originalBroadcastItemsUpdate;
    registry.clear();
  }
});
