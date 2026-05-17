'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'installer/windows/amutorrent.ps1');

function readInstallerScript() {
  return fs.readFileSync(SCRIPT_PATH, 'utf8');
}

test('Windows installer script declares the approved runtime and package-local roots', () => {
  const script = readInstallerScript();

  assert.match(script, /^#Requires -Version 5\.1/m);
  assert.match(script, /\$MinimumNodeMajor = 24/);
  assert.match(script, /\$NodeVersion = "v24\.15\.0"/);
  assert.match(script, /node-v24\.15\.0-win-x64\.zip/);
  assert.match(script, /node-v24\.15\.0-win-arm64\.zip/);
  assert.match(script, /cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62/);
  assert.match(script, /c9eb7402eda26e2ba7e44b6727fc85a8de56c5095b1f71ebd3062892211aa116/);
  assert.match(script, /\$DataRoot = Join-Path \$PackageRoot "data"/);
  assert.match(script, /\$LogsRoot = Join-Path \$PackageRoot "logs"/);
  assert.match(script, /\$RuntimeRoot = Join-Path \$PackageRoot "runtime"/);
});

test('Windows installer script rejects spaced package paths and avoids appdata defaults', () => {
  const script = readInstallerScript();

  assert.match(script, /PackageRoot -match "\\s"/);
  assert.match(script, /Move it to a path without spaces/);
  assert.doesNotMatch(script, /LOCALAPPDATA/i);
  assert.doesNotMatch(script, /AppData/i);
  assert.match(script, /\$env:AMUTORRENT_DATA_DIR = \$DataRoot/);
});

test('Windows installer script keeps PM2 installation explicit', () => {
  const script = readInstallerScript();

  assert.match(script, /Install-Pm2/);
  assert.match(script, /StartPersistent/);
  assert.match(script, /PM2 is not available/);
  assert.match(script, /npmPath install --prefix \$Pm2Prefix pm2/);
});
