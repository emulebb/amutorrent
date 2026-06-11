'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('eMuleBB full UI E2E hooks are present on stable controls', () => {
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
    ['static/components/modals/AddDownloadModal.js', "'data-selected-ed2k-instance'"],
    ['static/components/modals/AddDownloadModal.js', "'emulebb-add-download-links'"],
    ['static/components/modals/AddDownloadModal.js', "'emulebb-add-download-submit'"],
    ['static/components/common/Ed2kInstanceSelector.js', "'ed2k-instance-selector'"],
    ['static/components/common/Ed2kInstanceSelector.js', '`ed2k-instance-${inst.id}`'],
    ['static/components/common/Ed2kInstanceSelector.js', "'data-instance-id'"],
    ['static/components/common/Ed2kInstanceSelector.js', "'data-selected'"],
    ['static/components/common/Ed2kInstanceSelector.js', "'aria-pressed'"],
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
    ['static/contexts/WebSocketContext.js', 'normalizeList(data.data?.EC_TAG_SERVER)'],
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

test('major eMuleBB integration views expose stable view hooks', () => {
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

test('Add Download modal forwards selected ED2K instance to actions', () => {
  const source = read('static/components/AppContent.js');

  assert.match(source, /onAddEd2kLinks:\s*\(links,\s*categoryName,\s*isServerList,\s*instanceId\)/);
  assert.match(source, /actions\.search\.addEd2kLinks\(links\.join\('\\n'\),\s*categoryName,\s*isServerList,\s*instanceId\)/);
});

test('ED2K aggregate labels do not imply aMule-only metrics', () => {
  const homeView = read('static/components/views/HomeView.js');
  const statisticsView = read('static/components/views/StatisticsView.js');
  const mobileSpeedWidget = read('static/components/dashboard/MobileSpeedWidget.js');
  const clientIcon = read('static/components/common/ClientIcon.js');

  assert.match(homeView, /'ED2K Speed \(24h\)'/);
  assert.doesNotMatch(homeView, /'aMule Speed \(24h\)'/);

  assert.match(statisticsView, /chartTitle\('ED2K Speed', 'ed2k'\)/);
  assert.match(statisticsView, /chartTitle\('ED2K Data Transferred', 'ed2k'\)/);
  assert.doesNotMatch(statisticsView, /chartTitle\('aMule (Speed|Data Transferred)', 'ed2k'\)/);

  assert.match(mobileSpeedWidget, /title: 'Show ED2K'/);
  assert.doesNotMatch(mobileSpeedWidget, /title: 'Show aMule'/);

  assert.match(clientIcon, /clientValue === 'amule'[\s\S]*defaultTitle = 'ED2K \(aMule\)'/);
  assert.match(clientIcon, /clientValue === 'ed2k'[\s\S]*defaultTitle = 'ED2K'/);
});

test('single ED2K chart labels use concrete client names only for one enabled backend', () => {
  const chartConfig = read('static/hooks/useClientChartConfig.js');

  assert.match(chartConfig, /export const getSingleNetworkDisplayName/);
  assert.match(chartConfig, /enabledEd2kInstances\.length !== 1/);
  assert.match(chartConfig, /return NETWORK_TYPE_LABELS\.ed2k/);
  assert.match(chartConfig, /return CLIENT_NAMES\[inst\.type\]\?\.name \|\| NETWORK_TYPE_LABELS\.ed2k/);
  assert.doesNotMatch(chartConfig, /showSingleAmule/);
  assert.doesNotMatch(chartConfig, /singleNetworkName = .*'aMule'/);
});
