/**
 * useEd2kInstanceSelector Hook
 *
 * Provides state and helpers for selecting which ED2K instance to use for
 * ED2K operations (search, add downloads, servers, stats).
 *
 * Instance-aware: builds list from connected instances metadata.
 * Shows selection UI when 2+ ED2K instances are connected.
 */

import { useState, useMemo, useCallback } from 'https://esm.sh/react@18.2.0';
import { useStaticData } from '../contexts/StaticDataContext.js';

/**
 * Hook for ED2K instance selection
 * @param {Object} [options]
 * @param {string} [options.selectedId] - Externally controlled selected ID (overrides internal state)
 * @param {Function} [options.onSelect] - External selection handler (overrides internal state)
 * @returns {Object} Instance selection state and helpers
 */
export function useEd2kInstanceSelector(options = {}) {
  const { instances } = useStaticData();
  const allowedTypes = options.clientTypes ? new Set(options.clientTypes) : null;

  // Build list of connected ED2K instances (sorted by config order)
  const connectedInstances = useMemo(() => {
    return Object.entries(instances || {})
      .filter(([, inst]) => inst.connected && inst.networkType === 'ed2k' && (!allowedTypes || allowedTypes.has(inst.type)))
      .map(([id, inst]) => ({
        id,
        type: inst.type,
        name: inst.name || (inst.type === 'emulebb' ? 'eMuleBB' : 'aMule'),
        color: inst.color,
        order: inst.order
      }))
      .sort((a, b) => a.order - b.order);
  }, [instances, options.clientTypes]);

  // Whether to show instance selector (2+ instances connected)
  const showSelector = connectedInstances.length >= 2;

  // Internal selection state (used when not externally controlled)
  const [internalSelectedId, setInternalSelectedId] = useState(null);

  // Use external or internal state
  const selectedId = options.selectedId !== undefined ? options.selectedId : internalSelectedId;
  const setSelectedId = options.onSelect || setInternalSelectedId;

  // Validate selection against connected instances, fall back to first
  const effectiveId = useMemo(() => {
    if (selectedId && connectedInstances.some(c => c.id === selectedId)) {
      return selectedId;
    }
    return connectedInstances[0]?.id || null;
  }, [selectedId, connectedInstances]);

  // Get the selected instance object
  const selectedInstance = useMemo(() => {
    return connectedInstances.find(c => c.id === effectiveId) || null;
  }, [connectedInstances, effectiveId]);

  // Handler to change selected instance
  const selectInstance = useCallback((id) => {
    setSelectedId(id);
  }, [setSelectedId]);

  return {
    connectedInstances,
    showSelector,
    selectedId: effectiveId,
    selectedInstance,
    selectInstance
  };
}

export default useEd2kInstanceSelector;
