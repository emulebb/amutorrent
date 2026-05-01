'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
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
          transfers: [{ hash: 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB', name: 'movie.mkv', size: 100, sizeDone: 25, progress: 0.25, category: 2 }],
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
  });
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

test('eMule BB manager sends explicit search method and file type payloads', async () => {
  await withMockEmulebb(({ method, url, body }) => {
    if (method === 'POST' && url === '/api/v1/searches') {
      if (body.query === 'ubuntu') {
        assert.deepEqual(body, { query: 'ubuntu', method: 'kad', type: 'any', ext: '' });
      } else {
        assert.deepEqual(body, { query: 'photo', method: 'automatic', type: 'image', ext: 'jpg' });
      }
      return { body: { search_id: body.query === 'ubuntu' ? '10' : '11' } };
    }
    if (method === 'GET' && (url === '/api/v1/searches/10' || url === '/api/v1/searches/11')) {
      return {
        body: {
          status: 'complete',
          results: [{ hash: '0123456789abcdef0123456789abcdef', name: 'result.bin', size: 42, sources: 5 }]
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
