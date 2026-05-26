'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getCpuUsage, _readCpuTimesFromOsCpus } = require('../server/lib/cpuUsage');
const { getDiskSpace } = require('../server/lib/diskSpace');

test('CPU usage falls back to Node OS counters when /proc is unavailable', () => {
  const sample = [
    { times: { user: 10, nice: 1, sys: 5, idle: 84, irq: 0 } },
    { times: { user: 20, nice: 0, sys: 10, idle: 70, irq: 1 } }
  ];

  assert.deepEqual(_readCpuTimesFromOsCpus(sample), {
    idleTime: 154,
    totalTime: 201
  });
});

test('CPU usage reports a bounded percentage on the host platform', async () => {
  const usage = await getCpuUsage();

  assert.equal(typeof usage.percent, 'number');
  assert.ok(usage.percent >= 0);
  assert.ok(usage.percent <= 100);
});

test('disk space reports usable values for a regular data directory', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amutorrent-disk-'));

  try {
    const diskSpace = await getDiskSpace(dataDir);

    assert.equal(diskSpace.error, undefined);
    assert.ok(diskSpace.total > 0);
    assert.ok(diskSpace.free >= 0);
    assert.ok(diskSpace.used >= 0);
    assert.ok(diskSpace.percentUsed >= 0);
    assert.ok(diskSpace.percentUsed <= 100);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
