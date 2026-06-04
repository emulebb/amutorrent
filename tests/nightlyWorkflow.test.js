'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/nightly-upstream.yml');

function readWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

test('nightly upstream workflow rebases only through the automation branch', () => {
  const workflow = readWorkflow();

  assert.match(workflow, /cron: '41 2 \* \* \*'/);
  assert.match(workflow, /git remote add upstream https:\/\/github\.com\/got3nks\/amutorrent\.git/);
  assert.match(workflow, /git checkout -B automation\/upstream-nightly origin\/main/);
  assert.match(workflow, /git rebase upstream\/main/);
  assert.match(workflow, /git push origin HEAD:refs\/heads\/automation\/upstream-nightly --force-with-lease/);
});

test('nightly upstream workflow gates main updates on the package build', () => {
  const workflow = readWorkflow();

  assert.match(workflow, /needs:\s*\n\s*- prepare\s*\n\s*- build\s*\n\s*if: needs\.prepare\.outputs\.changed == 'true'\s*\n\s*runs-on: ubuntu-24\.04\s*\n\s*steps:\s*\n\s*- uses: actions\/checkout@v6[\s\S]*Update main after green build/);
  assert.match(workflow, /--force-with-lease="refs\/heads\/main:\$\{\{ needs\.prepare\.outputs\.origin_main_sha \}\}"/);
  assert.match(workflow, /uses: emulebb\/emulebb-build\/\.github\/workflows\/reusable-workspace-command\.yml@main/);
  assert.match(workflow, /python -m emule_workspace package-amutorrent/);
  assert.match(workflow, /--release-version \$packageVersion/);
  assert.doesNotMatch(workflow, /Create CI workspace manifest/);
  assert.doesNotMatch(workflow, /Set-Content[\s\S]*deps\.json/);
});

test('nightly upstream workflow publishes one retained prerelease stream', () => {
  const workflow = readWorkflow();

  assert.match(workflow, /nightly_tag="amutorrent-nightly-\$\{release_date\}-\$\{short_upstream\}"/);
  assert.match(workflow, /package_version="\$\{AMUTORRENT_NIGHTLY_BASE_VERSION\}-nightly\.\$\{release_date\}\.\$\{short_upstream\}"/);
  assert.match(workflow, /release:\s*\n\s*name: Publish nightly prerelease[\s\S]*steps:\s*\n\s*- uses: actions\/checkout@v6[\s\S]*ref: \$\{\{ needs\.prepare\.outputs\.build_ref \}\}[\s\S]*Download package assets/);
  assert.match(workflow, /gh release create "\$\{TAG\}"/);
  assert.match(workflow, /NIGHTLY_TAG_PREFIX: amutorrent-nightly-/);
  assert.match(workflow, /gh release delete "\$\{tag\}"[\s\S]*--cleanup-tag[\s\S]*--yes/);
});
