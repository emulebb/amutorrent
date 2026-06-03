'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { assembleUnifiedItems } = require('../server/lib/unifiedItemBuilder');
const { EmulebbManager } = require('../server/modules/emulebbManager');

function localTestHost() {
  return process.env.X_LOCAL_IP || '127.0.0.1';
}

async function withMockEmulebb(handler, run) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      try {
        const response = await handler({ method: req.method, url: req.url, body });
        res.writeHead(response.status || 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(response.body ?? {}));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'TEST_ERROR', message: err.message }));
      }
    });
  });

  const host = localTestHost();
  await new Promise(resolve => server.listen(0, host, resolve));
  try {
    const { port } = server.address();
    return await run({ host, port, requests });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function createManager(port, host = localTestHost()) {
  const manager = new EmulebbManager();
  manager.instanceId = 'emulebb-test';
  manager.setClientConfig({
    enabled: true,
    host,
    port,
    apiKey: 'test-key'
  });
  return manager;
}

test('eMuleBB manager initializes, caches categories, and normalizes transfers', async () => {
  await withMockEmulebb(({ method, url }) => {
    if (method === 'GET' && url === '/api/v1/app') {
      return { body: { version: '0.7.3', lifecycle: { state: 'running', startupComplete: true, coreReady: true, sharedFilesReady: true, acceptingRest: true, acceptingMutations: true, shutdownInProgress: false }, capabilities: { categoriesRead: true } } };
    }
    if (method === 'GET' && url === '/api/v1/categories') {
      return { body: { items: [{ id: 0, name: 'Default' }, { id: 2, name: 'Movies' }] } };
    }
    if (method === 'GET' && url === '/api/v1/snapshot?limit=100') {
      return {
        body: {
          transfers: [{ hash: 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB', name: 'movie.mkv', sizeBytes: 100, completedBytes: 25, progress: 0.3333333333333333, categoryId: 2 }],
          sharedFiles: [],
          uploads: []
        }
      };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    assert.equal(await manager.initClient(), true);
    assert.equal(manager.client.lifecycle.state, 'running');

    const data = await manager.fetchData();
    assert.equal(data.downloads.length, 1);
    assert.equal(data.downloads[0].hash, 'abcdefabcdefabcdefabcdefabcdefab');
    assert.equal(data.downloads[0].category, 'Movies');
    assert.equal(data.downloads[0].categoryId, 2);
    assert.equal(data.downloads[0].progress, 33.33);
    assert.equal(data.downloads[0].renameSupported, true);
  });
});

test('eMuleBB manager preserves shared files while native startup cache warms', async () => {
  let snapshotCount = 0;
  await withMockEmulebb(({ method, url }) => {
    if (method === 'GET' && url === '/api/v1/app') {
      return { body: { version: '0.7.3', capabilities: { categoriesRead: true } } };
    }
    if (method === 'GET' && url === '/api/v1/categories') {
      return { body: { items: [{ id: 0, name: 'Default' }] } };
    }
    if (method === 'GET' && url === '/api/v1/snapshot?limit=100') {
      snapshotCount += 1;
      if (snapshotCount === 1) {
        return {
          body: {
            status: { lifecycle: { state: 'running', startupComplete: true, coreReady: true, sharedFilesReady: true, acceptingRest: true, acceptingMutations: true, shutdownInProgress: false }, stats: { sharedFilesReady: true, sharedHashingActive: false, sharedHashingCount: 0 }, sharedStartupCache: { loaded: true, ready: true } },
            transfers: [],
            sharedFiles: [{ hash: 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB', name: 'seed.bin', sizeBytes: 42 }],
            uploads: []
          }
        };
      }
      return {
        body: {
          status: { lifecycle: { state: 'starting', startupComplete: false, coreReady: false, sharedFilesReady: false, acceptingRest: true, acceptingMutations: false, shutdownInProgress: false }, stats: { sharedFilesReady: false, sharedHashingActive: true, sharedHashingCount: 2 }, sharedStartupCache: { loaded: false, ready: false, rejected: false } },
          transfers: [],
          sharedFiles: [],
          uploads: []
        }
      };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    assert.equal(await manager.initClient(), true);

    const warm = await manager.fetchData();
    assert.equal(warm.sharedFiles.length, 1);
    assert.equal(warm.nativeStatus.sharedFilesReady, true);

    const warming = await manager.fetchData();
    assert.equal(warming.sharedFiles.length, 1);
    assert.equal(warming.sharedFiles[0].hash, 'abcdefabcdefabcdefabcdefabcdefab');
    assert.equal(warming.nativeStatus.sharedFilesReady, false);
    assert.equal(warming.nativeStatus.lifecycle.state, 'starting');
    assert.equal(warming.nativeStatus.lifecycle.acceptingMutations, false);
    assert.equal(warming.nativeStatus.sharedHashingActive, true);
    assert.equal(warming.nativeStatus.sharedHashingCount, 2);
  });
});

test('eMuleBB manager treats legacy SERVICE_BUSY shared hashing as warmup', async () => {
  await withMockEmulebb(({ method, url }) => {
    if (method === 'GET' && url === '/api/v1/app') {
      return { body: { version: '0.7.3', capabilities: { categoriesRead: true } } };
    }
    if (method === 'GET' && url === '/api/v1/categories') {
      return { body: { items: [{ id: 0, name: 'Default' }] } };
    }
    if (method === 'GET' && url === '/api/v1/snapshot?limit=100') {
      return {
        status: 503,
        body: { error: { code: 'SERVICE_BUSY', message: 'shared file hashing is active (2 files pending)' } }
      };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.lastSharedFiles = [{ hash: 'cached', name: 'cached.bin' }];
    assert.equal(await manager.initClient(), true);

    const data = await manager.fetchData();
    assert.equal(data.sharedFiles.length, 1);
    assert.equal(data.sharedFiles[0].hash, 'cached');
    assert.equal(data.nativeStatus.sharedFilesReady, false);
    assert.equal(data.nativeStatus.sharedHashingActive, true);
  });
});

test('eMuleBB manager avoids native mutations while lifecycle is not accepting them', async () => {
  await withMockEmulebb(({ method, url }) => {
    if (method === 'GET' && url === '/api/v1/app') {
      return {
        body: {
          version: '0.7.3',
          lifecycle: {
            state: 'starting',
            startupComplete: false,
            coreReady: false,
            sharedFilesReady: false,
            acceptingRest: true,
            acceptingMutations: false,
            shutdownInProgress: false
          },
          capabilities: { categoriesRead: true }
        }
      };
    }
    if (method === 'GET' && url === '/api/v1/categories') {
      return { body: { items: [{ id: 0, name: 'Default' }] } };
    }
    if (method === 'POST') {
      throw new Error('mutation should not be sent');
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port, requests }) => {
    const manager = createManager(port);
    assert.equal(await manager.initClient(), true);

    await assert.rejects(
      manager.pause('abcdefabcdefabcdefabcdefabcdefab'),
      /lifecycle starting is not accepting mutations/
    );
    assert.equal(requests.some(request => request.method === 'POST'), false);
  });
});

test('eMuleBB manager normalizes native REST network status', () => {
  const manager = new EmulebbManager();
  const status = manager.getNetworkStatus({
    server: {
      connected: true,
      active: { name: 'Peerates', address: '1.2.3.4', port: 4661 }
    },
    kad: {
      running: true,
      connected: true,
      firewalled: false
    }
  });

  assert.deepEqual(status.ed2k, {
    status: 'green',
    text: 'Connected',
    connected: true,
    serverName: 'Peerates',
    serverPing: null,
    serverAddress: '1.2.3.4'
  });
  assert.deepEqual(status.kad, {
    status: 'green',
    text: 'OK',
    connected: true
  });
});

test('eMuleBB manager adapts REST status into stats tree contract', async () => {
  await withMockEmulebb(({ method, url }) => {
    if (method === 'GET' && url === '/api/v1/status') {
      return {
        body: {
          stats: {
            ed2kConnected: true,
            ed2kHighId: true,
            kadConnected: false,
            kadRunning: true,
            kadFirewalled: true,
            downloadSpeedKiBps: 12.25,
            uploadSpeedKiBps: 3.5,
            sessionDownloadedBytes: 2097152,
            sessionUploadedBytes: 1048576,
            downloadCount: 4,
            activeUploads: 2,
            waitingUploads: 7,
            sharedHashingActive: false,
            sharedHashingCount: 1
          },
          lifecycle: {
            state: 'running',
            startupComplete: true,
            coreReady: true,
            sharedFilesReady: true,
            acceptingRest: true,
            acceptingMutations: true,
            shutdownInProgress: false
          },
          servers: {
            connected: true,
            active: { name: 'Peerates', address: '1.2.3.4:4661' }
          },
          kad: {
            running: true,
            connected: false,
            firewalled: true
          }
        }
      };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };

    const tree = await manager.getStatsTree();
    const root = tree.EC_TAG_STATTREE_NODE;
    assert.equal(root._value, 'eMuleBB');
    assert.equal(root.EC_TAG_STATTREE_NODE[0]._value, 'Connection');
    assert.deepEqual(root.EC_TAG_STATTREE_NODE[0].EC_TAG_STATTREE_NODE[0], {
      _value: 'Lifecycle: %s',
      EC_TAG_STAT_NODE_VALUE: 'running'
    });
    assert.deepEqual(root.EC_TAG_STATTREE_NODE[0].EC_TAG_STATTREE_NODE[1], {
      _value: 'ED2K: %s',
      EC_TAG_STAT_NODE_VALUE: 'Connected'
    });
    assert.deepEqual(root.EC_TAG_STATTREE_NODE[1].EC_TAG_STATTREE_NODE[0], {
      _value: 'Download: %s',
      EC_TAG_STAT_NODE_VALUE: '12.3 KiB/s'
    });
    assert.deepEqual(root.EC_TAG_STATTREE_NODE[2].EC_TAG_STATTREE_NODE[0], {
      _value: 'Downloaded: %s',
      EC_TAG_STAT_NODE_VALUE: '2.0 MiB'
    });
  });
});

test('eMuleBB manager unwraps native v1 success and error envelopes', async () => {
  await withMockEmulebb(({ method, url }) => {
    if (method === 'GET' && url === '/api/v1/app') {
      return { body: { data: { version: '0.7.3' }, meta: { apiVersion: 'v1' } } };
    }
    return { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'missing or invalid X-API-Key' } } };
  }, async ({ port }) => {
    const manager = createManager(port);

    assert.deepEqual(await manager._request('GET', '/api/v1/app'), { version: '0.7.3' });
    await assert.rejects(
      manager._request('GET', '/api/v1/status'),
      /eMuleBB UNAUTHORIZED: missing or invalid X-API-Key/
    );
  });
});

test('eMuleBB manager retries transient safe GET transport resets', async () => {
  const requests = [];
  let first = true;
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (first) {
      first = false;
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ data: { version: '0.7.3' }, meta: { apiVersion: 'v1' } }));
  });

  const host = localTestHost();
  await new Promise(resolve => server.listen(0, host, resolve));
  try {
    const { port } = server.address();
    const manager = createManager(port);
    const result = await manager._request('GET', '/api/v1/app');

    assert.deepEqual(result, { version: '0.7.3' });
    assert.equal(requests.length, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('eMuleBB manager serializes native REST requests for single accepted-client server', async () => {
  const requests = [];
  let active = 0;
  let maxActive = 0;
  const server = http.createServer(async (req, res) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    requests.push(req.url);
    try {
      await new Promise(resolve => setTimeout(resolve, 25));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data: { path: req.url } }));
    } finally {
      active -= 1;
    }
  });

  const host = localTestHost();
  await new Promise(resolve => server.listen(0, host, resolve));
  try {
    const { port } = server.address();
    const manager = createManager(port);
    const results = await Promise.all([
      manager._request('GET', '/api/v1/app'),
      manager._request('GET', '/api/v1/status'),
      manager._request('GET', '/api/v1/categories')
    ]);

    assert.deepEqual(results, [
      { path: '/api/v1/app' },
      { path: '/api/v1/status' },
      { path: '/api/v1/categories' }
    ]);
    assert.deepEqual(requests, ['/api/v1/app', '/api/v1/status', '/api/v1/categories']);
    assert.equal(maxActive, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('eMuleBB manager hydrates transfer sources from REST', async () => {
  await withMockEmulebb(({ method, url }) => {
    if (method === 'GET' && url === '/api/v1/categories') {
      return { body: { items: [{ id: 0, name: 'Default' }] } };
    }
    if (method === 'GET' && url === '/api/v1/snapshot?limit=100') {
      return {
        body: {
          transfers: [{
            hash: 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB',
            name: 'movie.mkv',
            sizeBytes: 97280000,
            completedBytes: 24320000,
            progress: 0.25,
            sources: 1,
            sourcesTransferring: 1
          }],
          sharedFiles: [],
          uploads: []
        }
      };
    }
    if (method === 'GET' && url === '/api/v1/transfers/abcdefabcdefabcdefabcdefabcdefab/details') {
      return {
        body: {
          parts: [
            { index: 0, start: 0, end: 99, size: 100, completedBytes: 50, gapBytes: 50, complete: false, requested: true, availableSources: 2 }
          ],
          sources: [{
            userName: 'remote-user',
            userHash: 'FEDCBA9876543210FEDCBA9876543210',
            clientSoftware: 'eMule 0.70a',
            downloadState: 'Downloading',
            downloadSpeedKiBps: 1.205078125,
            availableParts: 3,
            partCount: 10,
            address: '1.2.3.4',
            port: 4662,
            serverIp: '5.6.7.8',
            serverPort: 4661,
            lowId: false,
            queueRank: 42,
            viewSharedFiles: true,
            sharedFilesRequestPending: false
          }]
        }
      };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port, requests }) => {
    const manager = createManager(port);
    manager.client = { version: { capabilities: { transferDetails: true } } };

    const data = await manager.fetchData();
    assert.equal(data.downloads.length, 1);
    assert.equal(data.downloads[0].peers.length, 1);

    const [source] = data.downloads[0].peers;
    assert.equal(source.role, 'download');
    assert.equal(source.clientType, 'emulebb');
    assert.equal(source.userHash, 'fedcba9876543210fedcba9876543210');
    assert.equal(source.userName, 'remote-user');
    assert.equal(source.address, '1.2.3.4');
    assert.equal(source.port, 4662);
    assert.equal(source.software, 'eMule 0.70a');
    assert.equal(source.downloadState, 'Downloading');
    assert.equal(source.downloadRate, 1234);
    assert.equal(source.remoteQueueRank, 42);
    assert.equal(source.completedPercent, 30);
    assert.equal(source.viewSharedFiles, true);
    assert.equal(source.serverIp, '5.6.7.8');
    assert.equal(source.serverPort, 4661);
    assert.equal(data.downloads[0].partStatus.length, 1);
    assert.equal(data.downloads[0].gapStatus.length, 1);
    assert.equal(data.downloads[0].reqStatus.length, 1);
    assert.ok(requests.some(request => request.url === '/api/v1/transfers/abcdefabcdefabcdefabcdefabcdefab/details'));
  });
});

test('eMuleBB manager falls back to source hydration without transfer detail capability', async () => {
  await withMockEmulebb(({ method, url }) => {
    if (method === 'GET' && url === '/api/v1/categories') {
      return { body: { items: [{ id: 0, name: 'Default' }] } };
    }
    if (method === 'GET' && url === '/api/v1/snapshot?limit=100') {
      return {
        body: {
          transfers: [{
            hash: 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB',
            name: 'movie.mkv',
            sizeBytes: 100,
            completedBytes: 25,
            progress: 0.25,
            sources: 1,
            sourcesTransferring: 1
          }],
          sharedFiles: [],
          uploads: []
        }
      };
    }
    if (method === 'GET' && url === '/api/v1/transfers/abcdefabcdefabcdefabcdefabcdefab/sources') {
      return {
        body: {
          items: [{
            userName: 'fallback-user',
            userHash: 'FEDCBA9876543210FEDCBA9876543210',
            address: '1.2.3.4',
            port: 4662
          }]
        }
      };
    }
    if (method === 'GET' && url === '/api/v1/transfers/abcdefabcdefabcdefabcdefabcdefab/details') {
      throw new Error('details endpoint should not be called without transferDetails capability');
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port, requests }) => {
    const manager = createManager(port);
    manager.client = { version: { capabilities: {} } };

    const data = await manager.fetchData();
    assert.equal(data.downloads.length, 1);
    assert.equal(data.downloads[0].peers.length, 1);
    assert.equal(data.downloads[0].peers[0].userName, 'fallback-user');
    assert.ok(requests.some(request => request.url === '/api/v1/transfers/abcdefabcdefabcdefabcdefabcdefab/sources'));
    assert.ok(!requests.some(request => request.url === '/api/v1/transfers/abcdefabcdefabcdefabcdefabcdefab/details'));
  });
});

test('eMuleBB manager keeps transfers when source hydration fails', async () => {
  await withMockEmulebb(({ method, url }) => {
    if (method === 'GET' && url === '/api/v1/categories') {
      return { body: { items: [{ id: 0, name: 'Default' }] } };
    }
    if (method === 'GET' && url === '/api/v1/snapshot?limit=100') {
      return {
        body: {
          transfers: [{
            hash: 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB',
            name: 'movie.mkv',
            sizeBytes: 100,
            completedBytes: 25,
            progress: 0.25,
            sources: 1
          }],
          sharedFiles: [],
          uploads: []
        }
      };
    }
    if (method === 'GET' && url === '/api/v1/transfers/abcdefabcdefabcdefabcdefabcdefab/sources') {
      return { status: 503, body: { error: 'BUSY', message: 'source list temporarily unavailable' } };
    }
    if (method === 'GET' && url === '/api/v1/transfers/abcdefabcdefabcdefabcdefabcdefab/details') {
      return { status: 503, body: { error: { code: 'BUSY', message: 'detail temporarily unavailable' } } };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };

    const data = await manager.fetchData();
    assert.equal(data.downloads.length, 1);
    assert.deepEqual(data.downloads[0].peers, []);
  });
});

test('eMuleBB hydrated sources are preserved through unified item assembly', () => {
  const [item] = assembleUnifiedItems(
    [{
      clientType: 'emulebb',
      instanceId: 'emulebb-test',
      hash: 'abcdefabcdefabcdefabcdefabcdefab',
      name: 'active.bin',
      size: 100,
      downloaded: 25,
      progress: 25,
      peers: [{
        role: 'download',
        clientType: 'emulebb',
        id: 'fedcba9876543210fedcba9876543210',
        userName: 'remote-user',
        address: '1.2.3.4',
        port: 4662,
        software: 'eMule 0.70a',
        downloadRate: 1234,
        downloadState: 'Downloading',
        remoteQueueRank: 42,
        completedPercent: 30
      }]
    }],
    [],
    null
  );

  assert.equal(item.peers.length, 1);
  assert.equal(item.peers[0].role, 'download');
  assert.equal(item.peers[0].address, '1.2.3.4');
  assert.equal(item.peers[0].downloadState, 'Downloading');
  assert.equal(item.peers[0].remoteQueueRank, 42);
  assert.equal(item.peers[0].completedPercent, 30);
});

test('eMuleBB manager normalizes shared metadata and updates rating/comment', async () => {
  await withMockEmulebb(({ method, url, body }) => {
    if (method === 'GET' && url === '/api/v1/snapshot?limit=100') {
      return {
        body: {
          transfers: [],
          sharedFiles: [{
            hash: 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB',
            name: 'shared.avi',
            sizeBytes: 100,
            comment: 'verified',
            rating: 4,
            hasComment: true,
            userRating: 4
          }],
          uploads: []
        }
      };
    }
    if (method === 'GET' && url === '/api/v1/categories') {
      return { body: { items: [{ id: 0, name: 'Default' }] } };
    }
    if (method === 'PATCH' && url === '/api/v1/shared-files/abcdefabcdefabcdefabcdefabcdefab') {
      assert.deepEqual(body, { comment: 'better', rating: 5 });
      return { body: { ok: true } };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };

    const data = await manager.fetchData();
    assert.equal(data.sharedFiles.length, 1);
    assert.equal(data.sharedFiles[0].comment, 'verified');
    assert.equal(data.sharedFiles[0].rating, 4);
    assert.equal(data.sharedFiles[0].hasComment, true);
    assert.equal(data.sharedFiles[0].renameSupported, false);
    assert.equal(data.sharedFiles[0].progress, 100);
    assert.equal(data.sharedFiles[0].status, 'completed');

    assert.deepEqual(
      await manager.setFileRatingComment('abcdefabcdefabcdefabcdefabcdefab', 'better', 5),
      { success: true }
    );
  });
});

test('eMuleBB manager renames incomplete transfers through REST', async () => {
  await withMockEmulebb(({ method, url, body }) => {
    if (method === 'PATCH' && url === '/api/v1/transfers/abcdefabcdefabcdefabcdefabcdefab') {
      assert.deepEqual(body, { name: 'renamed.bin' });
      return { body: { hash: 'abcdefabcdefabcdefabcdefabcdefab', name: 'renamed.bin' } };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };

    assert.deepEqual(
      await manager.renameFile('abcdefabcdefabcdefabcdefabcdefab', ' renamed.bin '),
      { success: true }
    );
  });
});

test('eMuleBB manager reports REST rename failures without throwing', async () => {
  await withMockEmulebb(() => ({
    status: 409,
    body: { error: 'INVALID_STATE', message: 'completed transfers cannot be renamed through this endpoint' }
  }), async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };

    const result = await manager.renameFile('abcdefabcdefabcdefabcdefabcdefab', 'renamed.bin');
    assert.equal(result.success, false);
    assert.match(result.error, /eMuleBB INVALID_STATE: completed transfers cannot be renamed/);
  });
});

test('eMuleBB rename support is preserved through unified item assembly', () => {
  const [downloadItem] = assembleUnifiedItems(
    [{
      clientType: 'emulebb',
      instanceId: 'emulebb-test',
      hash: 'abcdefabcdefabcdefabcdefabcdefab',
      name: 'active.bin',
      size: 100,
      downloaded: 25,
      progress: 25,
      state: 'downloading',
      renameSupported: true
    }],
    [],
    null
  );
  assert.equal(downloadItem.renameSupported, true);

  const [sharedItem] = assembleUnifiedItems(
    [],
    [{
      clientType: 'emulebb',
      instanceId: 'emulebb-test',
      hash: 'fedcbafedcbafedcbafedcbafedcbafe',
      name: 'complete.bin',
      size: 100,
      renameSupported: false
    }],
    null
  );
  assert.equal(sharedItem.renameSupported, false);
});

test('eMuleBB manager assigns categories by existing name and handles delete shapes', async () => {
  await withMockEmulebb(({ method, url, body }) => {
    if (method === 'GET' && url === '/api/v1/categories') {
      return { body: { items: [{ id: 0, name: 'Default' }, { id: 3, name: 'Linux' }] } };
    }
    if (method === 'PATCH' && url === '/api/v1/transfers/hash1') {
      assert.deepEqual(body, { categoryName: 'Linux' });
      return { body: { ok: true } };
    }
    if (method === 'DELETE' && url === '/api/v1/transfers/hash1') {
      assert.equal(body, null);
      return { body: { ok: true } };
    }
    if (method === 'DELETE' && url === '/api/v1/transfers/hash2') {
      return { body: { results: [{ hash: 'hash2', ok: true }] } };
    }
    if (method === 'DELETE' && url === '/api/v1/transfers/hash3') {
      return { body: { success: true } };
    }
    if (method === 'DELETE' && url === '/api/v1/transfers/hash4') {
      return { body: { status: 'deleted' } };
    }
    if (method === 'DELETE' && url === '/api/v1/transfers/hash5') {
      return { body: { items: [{ hash: 'hash5', success: true }] } };
    }
    if (method === 'DELETE' && url === '/api/v1/transfers/hash6') {
      return { body: { results: [{ hash: 'hash6', error: 'blocked' }] } };
    }
    if (method === 'DELETE' && url === '/api/v1/transfers/hash7') {
      return { body: {} };
    }
    if (method === 'DELETE' && url === '/api/v1/transfers/hash8') {
      return { body: { hash: 'hash8' } };
    }
    if (method === 'DELETE' && url === '/api/v1/transfers/hash9') {
      assert.equal(body, null);
      return { body: { ok: true } };
    }
    if (method === 'DELETE' && url === '/api/v1/transfers/hash10/files?confirm=true') {
      assert.equal(body, null);
      return { body: { ok: true } };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };
    await manager.getCategories();

    assert.deepEqual(await manager.setCategoryOrLabel('hash1', { categoryName: 'Linux' }), { success: true });
    assert.deepEqual(await manager.deleteItem('hash1'), { success: true, pathsToDelete: [] });
    assert.deepEqual(await manager.deleteItem('hash2'), { success: true, pathsToDelete: [] });
    assert.deepEqual(await manager.deleteItem('hash3'), { success: true, pathsToDelete: [] });
    assert.deepEqual(await manager.deleteItem('hash4'), { success: true, pathsToDelete: [] });
    assert.deepEqual(await manager.deleteItem('hash5'), { success: true, pathsToDelete: [] });
    assert.deepEqual(await manager.deleteItem('hash6'), { success: false, error: 'blocked' });
    assert.deepEqual(await manager.deleteItem('hash7'), { success: true, pathsToDelete: [] });
    assert.deepEqual(await manager.deleteItem('hash8'), { success: true, pathsToDelete: [] });
    assert.deepEqual(await manager.deleteItem('hash9', { deleteFiles: false }), { success: true, pathsToDelete: [] });
    assert.deepEqual(await manager.deleteItem('hash10', { deleteFiles: true }), { success: true, pathsToDelete: [] });
  });
});

test('eMuleBB manager accepts native transfer add operation envelopes', async () => {
  await withMockEmulebb(({ method, url, body }) => {
    if (method === 'POST' && url === '/api/v1/transfers') {
      assert.deepEqual(body, {
        link: 'ed2k://|file|test.iso|1024|fedcba98765432100123456789abcdef|/'
      });
      return {
        body: {
          items: [{
            ok: true,
            hash: 'fedcba98765432100123456789abcdef',
            name: 'test.iso'
          }]
        }
      };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };

    assert.equal(
      await manager.addEd2kLink('ed2k://|file|test.iso|1024|fedcba98765432100123456789abcdef|/'),
      true
    );
  });
});

test('eMuleBB manager recovers ED2K add after transient reset when transfer materializes', async () => {
  const requests = [];
  let resetPost = true;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url });
      if (req.method === 'POST' && req.url === '/api/v1/transfers' && resetPost) {
        resetPost = false;
        req.socket.destroy();
        return;
      }
      if (req.method === 'GET' && req.url === '/api/v1/transfers?limit=100') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          data: {
            items: [{
              hash: 'fedcba98765432100123456789abcdef',
              name: 'test.iso',
              size: 1024
            }]
          },
          meta: { apiVersion: 'v1' }
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'missing' }));
    });
  });

  const host = localTestHost();
  await new Promise(resolve => server.listen(0, host, resolve));
  try {
    const { port } = server.address();
    const manager = createManager(port, host);
    manager.client = { version: {} };

    assert.equal(
      await manager.addEd2kLink('ed2k://|file|test.iso|1024|fedcba98765432100123456789abcdef|/'),
      true
    );
    assert.deepEqual(requests, [
      { method: 'POST', url: '/api/v1/transfers' },
      { method: 'GET', url: '/api/v1/transfers?limit=100' }
    ]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('eMuleBB manager keeps retrying ED2K add when transient resets repeat before materialization', async () => {
  const requests = [];
  let resetPosts = 5;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url });
      if (req.method === 'POST' && req.url === '/api/v1/transfers' && resetPosts > 0) {
        resetPosts -= 1;
        req.socket.destroy();
        return;
      }
      if (req.method === 'GET' && req.url === '/api/v1/transfers?limit=100') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: { items: [] }, meta: { apiVersion: 'v1' } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/v1/transfers') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          status: 'success',
          hash: 'fedcba98765432100123456789abcdef',
          name: 'test.iso',
          size: 1024
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'missing' }));
    });
  });

  const host = localTestHost();
  await new Promise(resolve => server.listen(0, host, resolve));
  try {
    const { port } = server.address();
    const manager = createManager(port, host);
    manager.client = { version: {} };

    assert.equal(
      await manager.addEd2kLink('ed2k://|file|test.iso|1024|fedcba98765432100123456789abcdef|/'),
      true
    );
    assert.deepEqual(requests, [
      { method: 'POST', url: '/api/v1/transfers' },
      { method: 'GET', url: '/api/v1/transfers?limit=100' },
      { method: 'POST', url: '/api/v1/transfers' },
      { method: 'GET', url: '/api/v1/transfers?limit=100' },
      { method: 'POST', url: '/api/v1/transfers' },
      { method: 'GET', url: '/api/v1/transfers?limit=100' },
      { method: 'POST', url: '/api/v1/transfers' },
      { method: 'GET', url: '/api/v1/transfers?limit=100' },
      { method: 'POST', url: '/api/v1/transfers' },
      { method: 'GET', url: '/api/v1/transfers?limit=100' },
      { method: 'POST', url: '/api/v1/transfers' }
    ]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('eMuleBB manager retries delete after transient reset when transfer remains', async () => {
  const requests = [];
  let resetDelete = true;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url });
      if (req.method === 'DELETE' && req.url === '/api/v1/transfers/fedcba98765432100123456789abcdef' && resetDelete) {
        resetDelete = false;
        req.socket.destroy();
        return;
      }
      if (req.method === 'GET' && req.url === '/api/v1/transfers?limit=100') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          data: {
            items: [{
              hash: 'fedcba98765432100123456789abcdef',
              name: 'test.iso',
              size: 1024
            }]
          },
          meta: { apiVersion: 'v1' }
        }));
        return;
      }
      if (req.method === 'DELETE' && req.url === '/api/v1/transfers/fedcba98765432100123456789abcdef') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'deleted', hash: 'fedcba98765432100123456789abcdef' }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'missing' }));
    });
  });

  const host = localTestHost();
  await new Promise(resolve => server.listen(0, host, resolve));
  try {
    const { port } = server.address();
    const manager = createManager(port, host);
    manager.client = { version: {} };

    assert.deepEqual(
      await manager.deleteItem('fedcba98765432100123456789abcdef'),
      { success: true, pathsToDelete: [] }
    );
    assert.deepEqual(requests, [
      { method: 'DELETE', url: '/api/v1/transfers/fedcba98765432100123456789abcdef' },
      { method: 'GET', url: '/api/v1/transfers?limit=100' },
      { method: 'DELETE', url: '/api/v1/transfers/fedcba98765432100123456789abcdef' }
    ]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('eMuleBB manager keeps retrying delete when transient resets repeat while transfer remains', async () => {
  const requests = [];
  let resetDeletes = 2;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url });
      if (req.method === 'DELETE' && req.url === '/api/v1/transfers/fedcba98765432100123456789abcdef' && resetDeletes > 0) {
        resetDeletes -= 1;
        req.socket.destroy();
        return;
      }
      if (req.method === 'GET' && req.url === '/api/v1/transfers?limit=100') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          data: {
            items: [{
              hash: 'fedcba98765432100123456789abcdef',
              name: 'test.iso',
              size: 1024
            }]
          },
          meta: { apiVersion: 'v1' }
        }));
        return;
      }
      if (req.method === 'DELETE' && req.url === '/api/v1/transfers/fedcba98765432100123456789abcdef') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'deleted', hash: 'fedcba98765432100123456789abcdef' }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'missing' }));
    });
  });

  const host = localTestHost();
  await new Promise(resolve => server.listen(0, host, resolve));
  try {
    const { port } = server.address();
    const manager = createManager(port, host);
    manager.client = { version: {} };

    assert.deepEqual(
      await manager.deleteItem('fedcba98765432100123456789abcdef'),
      { success: true, pathsToDelete: [] }
    );
    assert.deepEqual(requests, [
      { method: 'DELETE', url: '/api/v1/transfers/fedcba98765432100123456789abcdef' },
      { method: 'GET', url: '/api/v1/transfers?limit=100' },
      { method: 'DELETE', url: '/api/v1/transfers/fedcba98765432100123456789abcdef' },
      { method: 'GET', url: '/api/v1/transfers?limit=100' },
      { method: 'DELETE', url: '/api/v1/transfers/fedcba98765432100123456789abcdef' }
    ]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('eMuleBB manager creates, edits, and deletes categories through REST', async () => {
  const categories = [{ id: 0, name: 'Default' }];
  await withMockEmulebb(({ method, url, body }) => {
    if (method === 'GET' && url === '/api/v1/categories') {
      return { body: { items: categories } };
    }
    if (method === 'POST' && url === '/api/v1/categories') {
      assert.deepEqual(body, { name: 'Linux', path: null, comment: 'distros', priority: 1, color: 65280 });
      categories.push({ id: 4, name: 'Linux', path: '', comment: 'distros', priority: 1, color: 65280 });
      return { body: categories[1] };
    }
    if (method === 'PATCH' && url === '/api/v1/categories/4') {
      assert.deepEqual(body, { name: 'ISOs', path: null, comment: 'images', priority: 2 });
      categories[1] = { id: 4, name: 'ISOs', path: '', comment: 'images', priority: 2, color: 65280 };
      return { body: categories[1] };
    }
    if (method === 'DELETE' && url === '/api/v1/categories/4') {
      categories.splice(1, 1);
      return { body: { ok: true } };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };

    assert.deepEqual(
      await manager.createCategory({ name: 'Linux', comment: 'distros', color: 0x00ff00, priority: 1 }),
      { success: true, categoryId: 4 }
    );
    assert.deepEqual(
      await manager.editCategory({ id: 4, name: 'ISOs', comment: 'images', priority: 2 }),
      { success: true, verified: true, mismatches: [] }
    );
    assert.deepEqual(await manager.ensureCategoryExists({ name: 'ISOs' }), { amuleId: 4 });
    await manager.deleteCategory({ id: 4 });
    assert.equal((await manager.getCategories()).some(category => category.name === 'ISOs'), false);
  });
});

test('eMuleBB manager publishes default category path on connect sync', async () => {
  await withMockEmulebb(({ method, url }) => {
    if (method === 'GET' && url === '/api/v1/categories') {
      return { body: { items: [{ id: 0, name: 'Default', path: 'Z:\\Downloads\\Incoming' }] } };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    const observed = [];
    manager.client = { version: {} };
    await manager.onConnectSync({
      setClientDefaultPath(instanceId, defaultPath) {
        observed.push({ instanceId, defaultPath });
      }
    });

    assert.deepEqual(observed, [{ instanceId: 'emulebb-test', defaultPath: 'Z:\\Downloads\\Incoming' }]);
  });
});

test('eMuleBB manager downloads native search results with selected category', async () => {
  await withMockEmulebb(({ method, url, body }) => {
    if (method === 'GET' && url === '/api/v1/categories') {
      return { body: { items: [{ id: 0, name: 'Default' }, { id: 3, name: 'Linux' }] } };
    }
    if (method === 'POST' && url === '/api/v1/searches/99/results/0123456789abcdef0123456789abcdef/operations/download') {
      assert.deepEqual(body, { categoryId: 3 });
      return { body: { ok: true } };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };
    await manager.getCategories();
    manager.lastSearchId = '99';
    manager.lastSearchResults = [{
      fileHash: '0123456789abcdef0123456789abcdef',
      fileName: 'result.bin',
      fileSize: 42,
      ed2kLink: 'ed2k://|file|result.bin|42|0123456789abcdef0123456789abcdef|/'
    }];

    assert.equal(await manager.addSearchResult('0123456789abcdef0123456789abcdef', 3), true);
  });
});

test('eMuleBB manager uses final operation routes for common controls', async () => {
  await withMockEmulebb(({ method, url, body }) => {
    if (method === 'POST' && url === '/api/v1/transfers/abcdefabcdefabcdefabcdefabcdefab/operations/pause') {
      assert.deepEqual(body, {});
      return { body: { ok: true } };
    }
    if (method === 'POST' && url === '/api/v1/servers/1.2.3.4%3A4661/operations/connect') {
      assert.deepEqual(body, {});
      return { body: { ok: true } };
    }
    if (method === 'POST' && url === '/api/v1/servers/operations/disconnect') {
      assert.deepEqual(body, {});
      return { body: { ok: true } };
    }
    if (method === 'POST' && url === '/api/v1/shared-directories/operations/reload') {
      assert.deepEqual(body, {});
      return { body: { ok: true } };
    }
    if (method === 'DELETE' && url === '/api/v1/shared-files/fedcbafedcbafedcbafedcbafedcbafe') {
      assert.equal(body, null);
      return { body: { ok: true } };
    }
    if (method === 'DELETE' && url === '/api/v1/shared-files/deletefiledeletefiledeletefilede/file?confirm=true') {
      assert.equal(body, null);
      return { body: { ok: true } };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };

    assert.equal(await manager.pause('abcdefabcdefabcdefabcdefabcdefab'), true);
    assert.equal(await manager.connectServer('1.2.3.4', 4661), true);
    assert.equal(await manager.disconnectServer(), true);
    assert.equal(await manager.refreshSharedFiles(), true);
    assert.deepEqual(
      await manager.deleteItem('fedcbafedcbafedcbafedcbafedcbafe', { isShared: true, deleteFiles: false }),
      { success: true, pathsToDelete: [] }
    );
    assert.deepEqual(
      await manager.deleteItem('deletefiledeletefiledeletefilede', { isShared: true, deleteFiles: true }),
      { success: true, pathsToDelete: [] }
    );
  });
});

test('eMuleBB manager sends explicit search method and file type payloads', async () => {
  await withMockEmulebb(({ method, url, body }) => {
    if (method === 'POST' && url === '/api/v1/searches') {
      if (body.query === 'ubuntu') {
        assert.deepEqual(body, { query: 'ubuntu', method: 'kad', type: '', extension: '' });
      } else if (body.query === 'debian') {
        assert.deepEqual(body, { query: 'debian', method: 'server', type: '', extension: '' });
      } else if (body.query === 'fedora') {
        assert.deepEqual(body, { query: 'fedora', method: 'server', type: '', extension: '' });
      } else {
        assert.deepEqual(body, { query: 'photo', method: 'automatic', type: 'image', extension: 'jpg' });
      }
      const ids = { ubuntu: '10', photo: '11', debian: '12', fedora: '13' };
      return { body: { id: ids[body.query], status: 'running', results: [] } };
    }
    if (method === 'GET' && (url === '/api/v1/searches/10' || url === '/api/v1/searches/11' || url === '/api/v1/searches/12' || url === '/api/v1/searches/13')) {
      return {
        body: {
          status: 'complete',
          results: [{ hash: '0123456789abcdef0123456789abcdef', name: 'result.bin', sizeBytes: 42, sources: 5 }]
        }
      };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };

    const kad = await manager.search('ubuntu', 'kad');
    assert.equal(kad.resultsLength, 1);
    assert.equal(kad.results[0].sourceCount, 5);
    assert.equal(kad.searchMethod, 'kad');

    const typed = await manager.search('photo', 'image', 'jpg');
    assert.equal(typed.resultsLength, 1);

    const server = await manager.search('debian', 'server');
    assert.equal(server.resultsLength, 1);
    assert.equal(server.searchMethod, 'server');

    const legacyGlobal = await manager.search('fedora', 'global');
    assert.equal(legacyGlobal.resultsLength, 1);
  });
});

test('eMuleBB manager keeps cached search results scoped to the requested method', async () => {
  await withMockEmulebb(({ method, url, body }) => {
    if (method === 'POST' && url === '/api/v1/searches') {
      if (body.method === 'kad') return { body: { id: '20', status: 'running' } };
      if (body.method === 'server') return { body: { id: '21', status: 'running' } };
    }
    if (method === 'GET' && url === '/api/v1/searches/20') {
      return {
        body: {
          status: 'complete',
          results: [{ hash: '0123456789abcdef0123456789abcdef', name: 'kad.bin', sizeBytes: 42, sources: 5 }]
        }
      };
    }
    if (method === 'GET' && url === '/api/v1/searches/21') {
      return { body: { status: 'complete', results: [] } };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };

    const kad = await manager.search('rocco', 'kad');
    assert.equal(kad.resultsLength, 1);
    assert.equal(manager.getCachedSearchResults({ type: 'kad' }).resultsLength, 1);

    const server = await manager.search('rocco', 'server');
    assert.equal(server.resultsLength, 0);
    assert.equal(server.searchMethod, 'server');
    assert.equal(manager.getCachedSearchResults().resultsLength, 0);
    assert.equal(manager.getCachedSearchResults({ type: 'server' }).resultsLength, 0);
    assert.equal(manager.getCachedSearchResults({ type: 'kad' }).resultsLength, 0);
  });
});

test('eMuleBB manager ignores native search payloads for the wrong method', async () => {
  await withMockEmulebb(({ method, url, body }) => {
    if (method === 'POST' && url === '/api/v1/searches') {
      assert.equal(body.method, 'server');
      return { body: { id: '30', status: 'running', method: 'server' } };
    }
    if (method === 'GET' && url === '/api/v1/searches/30') {
      return {
        body: {
          id: '30',
          status: 'complete',
          method: 'kad',
          results: [{ hash: '0123456789abcdef0123456789abcdef', name: 'kad.bin', sizeBytes: 42, sources: 5, method: 'kad' }]
        }
      };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };

    const result = await manager.search('rocco', 'server');
    assert.equal(result.searchMethod, 'server');
    assert.equal(result.resultsLength, 0);
    assert.deepEqual(manager.lastSearchResults, []);
  });
});

test('eMuleBB manager accepts automatic searches with resolved native methods', async () => {
  await withMockEmulebb(({ method, url, body }) => {
    if (method === 'POST' && url === '/api/v1/searches') {
      assert.equal(body.method, 'automatic');
      return { body: { id: '31', status: 'running', method: 'automatic' } };
    }
    if (method === 'GET' && url === '/api/v1/searches/31') {
      return {
        body: {
          id: '31',
          status: 'complete',
          method: 'server',
          results: [{ hash: '0123456789abcdef0123456789abcdef', name: 'server.bin', sizeBytes: 42, sources: 5, method: 'server' }]
        }
      };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };

    const result = await manager.search('rocco', 'automatic');
    assert.equal(result.searchMethod, 'automatic');
    assert.equal(result.resultsLength, 1);
    assert.equal(result.results[0].fileName, 'server.bin');
  });
});

test('eMuleBB manager maps native shared-directory REST operations', async () => {
  await withMockEmulebb(({ method, url, body }) => {
    if (method === 'GET' && url === '/api/v1/shared-directories') {
      return {
        body: {
          roots: [
            { path: 'C:\\share\\', recursive: true, accessible: true },
            { path: 'D:\\missing\\', recursive: true, accessible: false }
          ],
          items: [
            { path: 'C:\\share\\', recursive: true, accessible: true },
            { path: 'C:\\share\\sub\\', recursive: false, accessible: true, monitorOwned: true }
          ]
        }
      };
    }
    if (method === 'PATCH' && url === '/api/v1/shared-directories') {
      assert.deepEqual(body, {
        roots: [
          { path: 'C:\\share', recursive: true },
          { path: 'D:\\media', recursive: true }
        ]
      });
      return {
        body: {
          roots: [
            { path: 'C:\\share\\', recursive: true, accessible: true },
            { path: 'D:\\media\\', recursive: true, accessible: true }
          ],
          items: [
            { path: 'C:\\share\\', recursive: true, accessible: true },
            { path: 'D:\\media\\', recursive: true, accessible: true },
            { path: 'D:\\media\\isos\\', recursive: false, accessible: true, monitorOwned: true }
          ]
        }
      };
    }
    if (method === 'POST' && url === '/api/v1/shared-directories/operations/reload') {
      assert.deepEqual(body, {});
      return { body: { ok: true } };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };

    const current = await manager.getSharedDirectories();
    assert.equal(current.configured, true);
    assert.deepEqual(current.roots, ['C:\\share\\', 'D:\\missing\\']);
    assert.deepEqual(current.inaccessibleRoots, ['D:\\missing\\']);
    assert.equal(current.items.length, 2);

    assert.deepEqual(
      await manager.saveSharedDirectories([' C:\\share ', '', 'D:\\media']),
      { success: true, roots: 2, totalDirs: 3 }
    );
    assert.equal(await manager.refreshSharedFiles(), true);
  });
});

test('eMuleBB manager includes REST error codes in request failures', async () => {
  await withMockEmulebb(() => ({
    status: 401,
    body: { error: 'UNAUTHORIZED', message: 'missing or invalid X-API-Key' }
  }), async ({ port }) => {
    const manager = createManager(port);
    await assert.rejects(
      manager._request('GET', '/api/v1/app'),
      /eMuleBB UNAUTHORIZED: missing or invalid X-API-Key/
    );
  });
});
