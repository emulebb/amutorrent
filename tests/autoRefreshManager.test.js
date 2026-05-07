'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const autoRefreshManager = require('../server/modules/autoRefreshManager');

test('auto refresh cache can replace items after mutation refresh', () => {
  autoRefreshManager._cachedBatchUpdate = {
    type: 'batch-update',
    data: {
      stats: { connected: true },
      items: [{ hash: 'old' }],
      categories: [{ name: 'Default' }],
      clientDefaultPaths: {},
      hasPathWarnings: false
    }
  };

  try {
    const updated = autoRefreshManager.updateCachedBatchItems(
      [{ hash: 'new' }],
      {
        categories: [{ name: 'Linux' }],
        clientDefaultPaths: { emulebb: 'C:\\Incoming' },
        hasPathWarnings: true
      }
    );

    assert.equal(updated, true);
    assert.deepEqual(autoRefreshManager._cachedBatchUpdate.data.items, [{ hash: 'new' }]);
    assert.deepEqual(autoRefreshManager._cachedBatchUpdate.data.categories, [{ name: 'Linux' }]);
    assert.deepEqual(autoRefreshManager._cachedBatchUpdate.data.clientDefaultPaths, { emulebb: 'C:\\Incoming' });
    assert.equal(autoRefreshManager._cachedBatchUpdate.data.hasPathWarnings, true);
    assert.deepEqual(autoRefreshManager._cachedBatchUpdate.data.stats, { connected: true });
  } finally {
    autoRefreshManager._cachedBatchUpdate = null;
  }
});

test('auto refresh cache update is a no-op before first snapshot cache exists', () => {
  autoRefreshManager._cachedBatchUpdate = null;

  assert.equal(autoRefreshManager.updateCachedBatchItems([{ hash: 'new' }]), false);
});
