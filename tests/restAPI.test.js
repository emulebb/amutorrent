'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const restAPI = require('../server/modules/restAPI');

function createRequest(body = {}, query = {}) {
  return {
    body,
    query,
    session: null,
    ip: '127.0.0.1'
  };
}

test('nonblocking REST bridge probe captures immediate search errors', async () => {
  restAPI.setHandlers({
    async handleSearch(data, context) {
      context.send({ type: 'error', message: `Search failed: ${data.type} unavailable` });
    }
  });

  const capture = await restAPI._test.probeNonBlockingBridge(
    'handleSearch',
    createRequest({ query: 'ubuntu', type: 'kad' }),
    25
  );

  assert.notEqual(capture, null);
  assert.equal(capture.statusCode, 200);
  assert.deepEqual(capture.payload, { type: 'error', message: 'Search failed: kad unavailable' });
  assert.equal(restAPI._test.isErrorPayload(capture.payload), true);
});

test('nonblocking REST bridge probe returns null for running searches', async () => {
  restAPI.setHandlers({
    async handleSearch(_data, context) {
      await new Promise(resolve => setTimeout(resolve, 50));
      context.broadcast({ type: 'search-results', data: [] });
    }
  });

  const capture = await restAPI._test.probeNonBlockingBridge(
    'handleSearch',
    createRequest({ query: 'ubuntu', type: 'server' }),
    5
  );

  assert.equal(capture, null);
});
