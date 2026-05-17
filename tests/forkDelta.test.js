'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'fork-delta.json');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

test('fork delta manifest tracks existing owned and shared seam files', () => {
  const manifest = readManifest();

  assert.equal(manifest.schemaVersion, 'amutorrent-fork-delta/v1');
  assert.equal(manifest.upstream.remote, 'upstream');
  assert.equal(manifest.upstream.branch, 'main');

  for (const entry of [...manifest.forkOwned, ...manifest.sharedSeams]) {
    assert.equal(fs.existsSync(path.join(ROOT, entry.path)), true, `${entry.path} must exist`);
    assert.ok(entry.reason, `${entry.path} must explain the fork reason`);
    assert.ok(Array.isArray(entry.guards) && entry.guards.length > 0, `${entry.path} must list guard tests`);
    for (const guardPath of entry.guards) {
      assert.equal(fs.existsSync(path.join(ROOT, guardPath)), true, `${entry.path} guard ${guardPath} must exist`);
    }
  }
});

test('fork delta manifest protects the eMule BB client seam', () => {
  const clientMeta = read('server/lib/clientMeta.js');
  const server = read('server/server.js');
  const setupWizard = read('static/components/views/SetupWizardView.js');

  assert.match(clientMeta, /emulebb:\s*{/);
  assert.match(clientMeta, /networkType:\s*'ed2k'/);
  assert.match(clientMeta, /displayName:\s*'eMule BB'/);
  assert.match(clientMeta, /categoriesRead:\s*true/);
  assert.match(server, /emulebb:\s*require\('\.\/modules\/emulebbManager'\)\.EmulebbManager/);
  assert.match(setupWizard, /formData\.emulebb/);
  assert.match(setupWizard, /eMule BB/);
});

test('fork delta manifest protects package-local runtime and Node policy', () => {
  const manifest = readManifest();
  const config = read('server/modules/config.js');
  const installer = read(manifest.runtimePolicy.windowsInstaller);
  const serverPackage = JSON.parse(read('server/package.json'));

  assert.equal(manifest.runtimePolicy.minimumNodeMajor, 24);
  assert.equal(manifest.runtimePolicy.portableDataEnvironmentVariable, 'AMUTORRENT_DATA_DIR');
  assert.match(config, /AMUTORRENT_DATA_DIR/);
  assert.match(installer, /\$MinimumNodeMajor = 24/);
  assert.match(installer, /\$env:AMUTORRENT_DATA_DIR = \$DataRoot/);
  assert.match(installer, /PackageRoot -match "\\s"/);
  assert.equal(serverPackage.dependencies['better-sqlite3'], '^12.10.0');
});

test('fork delta manifest records root CSS build-tooling policy', () => {
  const manifest = readManifest();
  const packageJson = JSON.parse(read('package.json'));
  const buildCss = read(manifest.buildTooling.tailwindCssWrapper);

  assert.equal(manifest.buildTooling.tailwindCssWrapper, 'scripts/build-css.cjs');
  assert.match(manifest.buildTooling.browserslistPolicy, /Tailwind 3 bundles Browserslist/);
  assert.equal(packageJson.scripts['build:css'], 'node scripts/build-css.cjs');
  assert.match(buildCss, /BROWSERSLIST_IGNORE_OLD_DATA/);
  assert.match(buildCss, /tailwindcss/);
});

test('fork delta manifest records rebase acceptance commands', () => {
  const manifest = readManifest();
  const workflow = manifest.rebaseWorkflow.join('\n');
  const acceptance = manifest.acceptance.join('\n');

  assert.match(workflow, /git fetch upstream/);
  assert.match(workflow, /git rebase upstream\/main/);
  assert.match(workflow, /npm audit --prefix website/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm run test:emulebb/);
  assert.match(acceptance, /Critical fork-owned paths exist/);
  assert.match(acceptance, /qBittorrent compatibility APIs do not proxy through eMule BB/);
});
