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
    ['static/components/views/DownloadsView.js', "'emulebb-downloads-select-mode'"],
    ['static/components/views/DownloadsView.js', "'emulebb-downloads-select-checkbox'"],
    ['static/components/views/DownloadsView.js', "'emulebb-downloads-pause-selected'"],
    ['static/components/views/DownloadsView.js', "'emulebb-downloads-resume-selected'"],
    ['static/components/views/DownloadsView.js', "'emulebb-downloads-stop-selected'"],
    ['static/components/views/DownloadsView.js', "'emulebb-downloads-category-selected'"],
    ['static/components/views/DownloadsView.js', "'emulebb-downloads-delete-selected'"],
    ['static/components/common/Table.js', "'data-file-hash'"],
    ['static/utils/columnBuilders.js', "'item-file-name'"],
    ['static/components/common/SelectionCheckbox.js', '...props'],
    ['static/components/modals/AddDownloadModal.js', "'emulebb-add-download-modal'"],
    ['static/components/modals/AddDownloadModal.js', "'emulebb-add-download-links'"],
    ['static/components/modals/AddDownloadModal.js', "'emulebb-add-download-submit'"],
    ['static/components/common/DeleteModal.js', "'delete-confirm-modal'"],
    ['static/components/common/DeleteModal.js', "'delete-confirm-submit'"],
    ['static/components/modals/FileCategoryModal.js', "'file-category-modal'"],
    ['static/components/modals/FileCategoryModal.js', "'file-category-select'"],
    ['static/components/modals/FileCategoryModal.js', "'file-category-custom-input'"],
    ['static/components/modals/FileInfoModal.js', "'file-info-modal'"],
    ['static/components/modals/FileInfoModal.js', "'file-info-close'"],
    ['static/components/views/SharedView.js', "'shared-dirs-open'"],
    ['static/components/modals/SharedDirsModal.js', "'shared-dirs-modal'"],
    ['static/components/modals/SharedDirsModal.js', "'shared-dirs-rescan'"],
    ['static/components/views/ServersView.js', "'emulebb-servers-refresh'"],
    ['static/components/views/ServersView.js', "'emulebb-server-connect'"],
    ['static/components/views/StatisticsView.js', "'stats-tree-open'"],
    ['static/components/modals/StatsTreeModal.js', "'stats-tree-modal'"],
    ['static/components/views/LogsView.js', "'app-logs-section'"],
    ['static/components/views/LogsView.js', '`client-log-section-${sectionId}`'],
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
