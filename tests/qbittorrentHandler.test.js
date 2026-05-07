'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const QBittorrentHandler = require('../server/lib/qbittorrent/QBittorrentHandler');
const { convertEd2kToMagnet } = require('../server/lib/linkConverter');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    }
  };
}

function createHandler(manager) {
  const handler = new QBittorrentHandler();
  const mappings = [];
  handler.setDependencies({
    getEd2kManager: () => manager,
    getAmuleClient: () => null,
    getAmuleInstanceId: () => 'emulebb-test',
    hashStore: {
      getEd2kHash: hash => hash,
      removeMapping: () => {},
      setMapping: (...args) => mappings.push(args)
    },
    config: { getAuthEnabled: () => false },
    registry: null,
    isFirstRun: async () => false,
    userManager: null
  });
  return { handler, mappings };
}

test('qBittorrent categories use the shared ED2K manager contract', async () => {
  const createCalls = [];
  const manager = {
    isConnected: () => true,
    getCategories: async () => [{ id: 7, title: 'Movies', path: 'D:\\Downloads\\Movies' }],
    createCategory: async (category) => {
      createCalls.push(category);
      return { success: true, categoryId: 8 };
    }
  };
  const { handler } = createHandler(manager);

  const listResponse = createResponse();
  await handler.getCategories({}, listResponse);

  assert.equal(listResponse.statusCode, 200);
  assert.deepEqual(listResponse.body, {
    Movies: { name: 'Movies', savePath: 'D:\\Downloads\\Movies' }
  });

  const createResponseResult = createResponse();
  await handler.createCategory({ body: { category: 'Music', savePath: 'D:\\Downloads\\Music' } }, createResponseResult);

  assert.equal(createResponseResult.statusCode, 200);
  assert.equal(createResponseResult.body, 'Ok.');
  assert.deepEqual(createCalls, [
    { name: 'Music', path: 'D:\\Downloads\\Music', comment: '', color: 0, priority: 0 }
  ]);
});

test('qBittorrent add uses the shared ED2K manager contract', async () => {
  const added = [];
  const manager = {
    isConnected: () => true,
    getCategories: async () => [{ id: 3, title: 'Linux', path: '' }],
    addEd2kLink: async (link, categoryId) => {
      added.push({ link, categoryId });
      return true;
    }
  };
  const { handler, mappings } = createHandler(manager);
  const { magnetLink } = convertEd2kToMagnet('0123456789abcdef0123456789abcdef', 'test.iso', 1234);
  const response = createResponse();

  await handler.addTorrent({ body: { urls: magnetLink, category: 'Linux' }, apiUser: null }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'Ok.');
  assert.deepEqual(added, [
    {
      link: 'ed2k://|file|test.iso|1234|0123456789abcdef0123456789abcdef|/',
      categoryId: 3
    }
  ]);
  assert.equal(mappings.length, 1);
});
test('qBittorrent category init waits for eMuleBB-only registry', () => {
  const handler = new QBittorrentHandler();
  handler.setDependencies({
    getEd2kManager: () => null,
    getAmuleClient: () => null,
    getAmuleInstanceId: () => null,
    hashStore: null,
    config: { getAuthEnabled: () => false },
    registry: {
      getByType: type => (type === 'emulebb' ? [{ isConnected: () => true }] : [])
    },
    isFirstRun: async () => false,
    userManager: null
  });

  assert.equal(handler.categoryCacheInitialized, false);
});
