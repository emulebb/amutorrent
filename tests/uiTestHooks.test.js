'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('eMule BB full UI E2E hooks are present on stable controls', () => {
  const checks = [
    ['static/components/common/NavButton.js', '`nav-${view}`'],
    ['static/components/layout/Sidebar.js', '`nav-${view}`'],
    ['static/components/dashboard/QuickSearchWidget.js', "'emulebb-search-form'"],
    ['static/components/dashboard/QuickSearchWidget.js', "'emulebb-search-query'"],
    ['static/components/dashboard/QuickSearchWidget.js', "'emulebb-search-submit'"],
    ['static/components/common/SearchResultsSection.js', "'emulebb-search-results'"],
    ['static/components/common/SearchResultsSection.js', "'emulebb-search-download-selected'"],
    ['static/components/common/SearchResultsList.js', "'emulebb-search-result-checkbox'"],
    ['static/components/views/DownloadsView.js', "'view-downloads'"],
    ['static/components/views/DownloadsView.js', "'emulebb-downloads-add'"],
    ['static/components/modals/AddDownloadModal.js', "'emulebb-add-download-modal'"],
    ['static/components/modals/AddDownloadModal.js', "'emulebb-add-download-links'"],
    ['static/components/modals/AddDownloadModal.js', "'emulebb-add-download-submit'"],
    ['static/components/settings/ClientInstanceCard.js', '`client-card-${client.type}`'],
    ['static/components/settings/ClientInstanceCard.js', '`client-card-test-${client.type}`'],
  ];

  for (const [relativePath, expected] of checks) {
    assert.match(read(relativePath), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('major eMule BB integration views expose stable view hooks', () => {
  const viewHooks = {
    'static/components/views/HomeView.js': "'view-home'",
    'static/components/views/SearchView.js': "'view-search'",
    'static/components/views/SharedView.js': "'view-shared'",
    'static/components/views/UploadsView.js': "'view-uploads'",
    'static/components/views/ServersView.js': "'view-servers'",
    'static/components/views/StatisticsView.js': "'view-statistics'",
    'static/components/views/LogsView.js': "'view-logs'",
    'static/components/views/HistoryView.js': "'view-history'",
    'static/components/views/SettingsView.js': "'view-settings'",
  };

  for (const [relativePath, expected] of Object.entries(viewHooks)) {
    assert.match(read(relativePath), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
