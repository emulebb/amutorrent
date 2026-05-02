'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { assembleUnifiedItems } = require('../server/lib/unifiedItemBuilder');
const { EmulebbManager } = require('../server/modules/emulebbManager');

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

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    return await run({ port, requests });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function createManager(port) {
  const manager = new EmulebbManager();
  manager.instanceId = 'emulebb-test';
  manager.setClientConfig({
    enabled: true,
    host: '127.0.0.1',
    port,
    apiKey: 'test-key'
  });
  return manager;
}

test('eMule BB manager initializes, caches categories, and normalizes transfers', async () => {
  await withMockEmulebb(({ method, url }) => {
    if (method === 'GET' && url === '/api/v1/app') {
      return { body: { version: '0.72a', capabilities: { categoriesRead: true } } };
    }
    if (method === 'GET' && url === '/api/v1/categories') {
      return { body: { items: [{ id: 0, name: 'Default' }, { id: 2, name: 'Movies' }] } };
    }
    if (method === 'GET' && url === '/api/v1/snapshot?limit=100') {
      return {
        body: {
          transfers: [{ hash: 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB', name: 'movie.mkv', sizeBytes: 100, completedBytes: 25, progress: 0.25, categoryId: 2 }],
          sharedFiles: [],
          uploads: []
        }
      };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    assert.equal(await manager.initClient(), true);

    const data = await manager.fetchData();
    assert.equal(data.downloads.length, 1);
    assert.equal(data.downloads[0].hash, 'abcdefabcdefabcdefabcdefabcdefab');
    assert.equal(data.downloads[0].category, 'Movies');
    assert.equal(data.downloads[0].categoryId, 2);
    assert.equal(data.downloads[0].progress, 25);
    assert.equal(data.downloads[0].renameSupported, true);
  });
});

test('eMule BB manager unwraps native v1 success and error envelopes', async () => {
  await withMockEmulebb(({ method, url }) => {
    if (method === 'GET' && url === '/api/v1/app') {
      return { body: { data: { version: '0.72a' }, meta: { apiVersion: 'v1' } } };
    }
    return { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'missing or invalid X-API-Key' } } };
  }, async ({ port }) => {
    const manager = createManager(port);

    assert.deepEqual(await manager._request('GET', '/api/v1/app'), { version: '0.72a' });
    await assert.rejects(
      manager._request('GET', '/api/v1/status'),
      /eMule BB UNAUTHORIZED: missing or invalid X-API-Key/
    );
  });
});

test('eMule BB manager hydrates transfer sources from REST', async () => {
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
    manager.client = { version: {} };

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

test('eMule BB manager keeps transfers when source hydration fails', async () => {
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

test('eMule BB hydrated sources are preserved through unified item assembly', () => {
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

test('eMule BB manager normalizes shared metadata and updates rating/comment', async () => {
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

    assert.deepEqual(
      await manager.setFileRatingComment('abcdefabcdefabcdefabcdefabcdefab', 'better', 5),
      { success: true }
    );
  });
});

test('eMule BB manager renames incomplete transfers through REST', async () => {
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

test('eMule BB manager reports REST rename failures without throwing', async () => {
  await withMockEmulebb(() => ({
    status: 409,
    body: { error: 'INVALID_STATE', message: 'completed transfers cannot be renamed through this endpoint' }
  }), async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };

    const result = await manager.renameFile('abcdefabcdefabcdefabcdefabcdefab', 'renamed.bin');
    assert.equal(result.success, false);
    assert.match(result.error, /eMule BB INVALID_STATE: completed transfers cannot be renamed/);
  });
});

test('eMule BB rename support is preserved through unified item assembly', () => {
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

test('eMule BB manager assigns categories by existing name and handles delete shapes', async () => {
  await withMockEmulebb(({ method, url, body }) => {
    if (method === 'GET' && url === '/api/v1/categories') {
      return { body: { items: [{ id: 0, name: 'Default' }, { id: 3, name: 'Linux' }] } };
    }
    if (method === 'PATCH' && url === '/api/v1/transfers/hash1') {
      assert.deepEqual(body, { categoryName: 'Linux' });
      return { body: { ok: true } };
    }
    if (method === 'DELETE' && url === '/api/v1/transfers/hash1') {
      return { body: { ok: true } };
    }
    if (method === 'DELETE' && url === '/api/v1/transfers/hash2') {
      return { body: { results: [{ hash: 'hash2', ok: true }] } };
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'missing' } };
  }, async ({ port }) => {
    const manager = createManager(port);
    manager.client = { version: {} };
    await manager.getCategories();

    assert.deepEqual(await manager.setCategoryOrLabel('hash1', { categoryName: 'Linux' }), { success: true });
    assert.deepEqual(await manager.deleteItem('hash1'), { success: true, pathsToDelete: [] });
    assert.deepEqual(await manager.deleteItem('hash2'), { success: true, pathsToDelete: [] });
  });
});

test('eMule BB manager creates, edits, and deletes categories through REST', async () => {
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

test('eMule BB manager downloads native search results with selected category', async () => {
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

test('eMule BB manager uses final operation routes for common controls', async () => {
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
      assert.deepEqual(body, { deleteFiles: false });
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
  });
});

test('eMule BB manager sends explicit search method and file type payloads', async () => {
  await withMockEmulebb(({ method, url, body }) => {
    if (method === 'POST' && url === '/api/v1/searches') {
      if (body.query === 'ubuntu') {
        assert.deepEqual(body, { query: 'ubuntu', method: 'kad', type: 'any', extension: '' });
      } else {
        assert.deepEqual(body, { query: 'photo', method: 'automatic', type: 'image', extension: 'jpg' });
      }
      return { body: { id: body.query === 'ubuntu' ? '10' : '11', status: 'running', results: [] } };
    }
    if (method === 'GET' && (url === '/api/v1/searches/10' || url === '/api/v1/searches/11')) {
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

    const typed = await manager.search('photo', 'image', 'jpg');
    assert.equal(typed.resultsLength, 1);
  });
});

test('eMule BB manager maps native shared-directory REST operations', async () => {
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

test('eMule BB manager includes REST error codes in request failures', async () => {
  await withMockEmulebb(() => ({
    status: 401,
    body: { error: 'UNAUTHORIZED', message: 'missing or invalid X-API-Key' }
  }), async ({ port }) => {
    const manager = createManager(port);
    await assert.rejects(
      manager._request('GET', '/api/v1/app'),
      /eMule BB UNAUTHORIZED: missing or invalid X-API-Key/
    );
  });
});
