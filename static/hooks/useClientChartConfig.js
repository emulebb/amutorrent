/**
 * useClientChartConfig Hook
 *
 * Provides client connection state and chart display configuration
 * Used by HomeView and StatisticsView to determine which charts to show
 *
 * Charts display by network type:
 * - ED2K (aMule/eMuleBB)
 * - BitTorrent (rtorrent + qBittorrent combined)
 */

import React from 'https://esm.sh/react@18.2.0';
import { useClientFilter } from '../contexts/ClientFilterContext.js';
import { useLiveData } from '../contexts/LiveDataContext.js';
import { useStaticData } from '../contexts/StaticDataContext.js';
import { CLIENT_NAMES, NETWORK_TYPE_LABELS } from '../utils/constants.js';

const { useState, useEffect } = React;

export const getSingleNetworkDisplayName = (networkType, instances, disabledInstances) => {
  if (networkType !== 'ed2k') return NETWORK_TYPE_LABELS[networkType] || networkType;

  const enabledEd2kInstances = Object.entries(instances || {})
    .filter(([id, inst]) => inst.networkType === 'ed2k' && inst.connected && !disabledInstances.has(id))
    .map(([, inst]) => inst);

  if (enabledEd2kInstances.length !== 1) return NETWORK_TYPE_LABELS.ed2k;

  const [inst] = enabledEd2kInstances;
  return CLIENT_NAMES[inst.type]?.name || NETWORK_TYPE_LABELS.ed2k;
};

/**
 * Hook that computes chart display configuration based on client connection
 * state and filter settings
 *
 * @returns {object} Chart configuration object with:
 *   - ed2kConnected: boolean - whether ED2K network client is connected
 *   - bittorrentConnected: boolean - whether any BitTorrent client is connected
 *   - isEd2kEnabled: boolean - whether ED2K network is enabled in filter
 *   - isBittorrentEnabled: boolean - whether BitTorrent is enabled in filter
 *   - showBothCharts: boolean - show side-by-side charts for both network types
 *   - showSingleClient: boolean - show single network type charts (full width)
 *   - singleNetworkType: 'ed2k' | 'bittorrent' - which network to show when single
 *   - singleNetworkName: string - display name for single network
 *   - shouldRenderCharts: boolean - deferred rendering state for performance
 */
export const useClientChartConfig = () => {
  const { isEd2kEnabled, isBittorrentEnabled, ed2kConnected, bittorrentConnected, disabledInstances } = useClientFilter();
  const { dataStats } = useLiveData();
  const { instances } = useStaticData();

  // Check if we're still waiting for WebSocket data
  const isLoading = !dataStats;

  // Determine chart display mode (isXEnabled includes connection check)
  const showBothCharts = isEd2kEnabled && isBittorrentEnabled;
  const showSingleEd2k = isEd2kEnabled && !isBittorrentEnabled;
  const showSingleBittorrent = isBittorrentEnabled && !isEd2kEnabled;
  const showSingleClient = showSingleEd2k || showSingleBittorrent;
  // Network type for chart data keys (e.g. 'ed2kUploadSpeed', 'bittorrentUploadSpeed')
  const singleNetworkType = showSingleEd2k ? 'ed2k' : 'bittorrent';
  const singleNetworkName = getSingleNetworkDisplayName(singleNetworkType, instances, disabledInstances);

  // Defer chart rendering until after initial paint for better performance
  const [shouldRenderCharts, setShouldRenderCharts] = useState(false);
  useEffect(() => {
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => setShouldRenderCharts(true));
    } else {
      setTimeout(() => setShouldRenderCharts(true), 0);
    }
  }, []);

  return {
    isLoading,
    ed2kConnected,
    bittorrentConnected,
    isEd2kEnabled,
    isBittorrentEnabled,
    showBothCharts,
    showSingleClient,
    singleNetworkType,
    singleNetworkName,
    shouldRenderCharts
  };
};
