/**
 * ED2K manager selection helpers.
 *
 * Keeps legacy aMule config keys compatible while letting callers choose
 * whether to accept every ED2K backend or only a narrower compatibility set.
 */

'use strict';

const clientMeta = require('./clientMeta');

/**
 * Read the configured compatibility/ED2K instance ID from runtime config.
 * @param {Object} configModule - Configuration module singleton
 * @returns {string|null} Configured instance ID, or null for automatic selection
 */
function getConfiguredEd2kInstanceId(configModule) {
  if (typeof configModule.getConfiguredEd2kInstanceId === 'function') {
    return configModule.getConfiguredEd2kInstanceId();
  }
  return configModule.getConfig()?.integrations?.amuleInstanceId || null;
}

/**
 * Check whether a manager belongs to the ED2K network family.
 * @param {Object|null} manager - Runtime manager instance
 * @returns {boolean} True when the manager is an ED2K-family client
 */
function isEd2kManager(manager) {
  if (!manager?.clientType) return false;
  return clientMeta.getNetworkType(manager.clientType) === 'ed2k';
}

/**
 * Resolve the configured or first available ED2K manager.
 * @param {Object} options
 * @param {Object} options.registry - ClientRegistry singleton
 * @param {Object} options.config - Configuration module singleton
 * @param {string[]} [options.allowedClientTypes] - Optional type allow-list
 * @param {boolean} [options.requireConnected=true] - Require connected managers
 * @param {Object} [options.logger] - Optional logger with warn()
 * @param {string} [options.logPrefix='ED2K'] - Warning prefix
 * @param {string} [options.configuredLabel='ED2K instance'] - Human label for fallback warnings
 * @returns {Object|null} Resolved manager, or null when none is available
 */
function resolveEd2kManager({
  registry,
  config,
  allowedClientTypes = null,
  requireConnected = true,
  logger = null,
  logPrefix = 'ED2K',
  configuredLabel = 'ED2K instance'
}) {
  const allowed = allowedClientTypes ? new Set(allowedClientTypes) : null;
  const accepts = manager => {
    if (!isEd2kManager(manager)) return false;
    if (allowed && !allowed.has(manager.clientType)) return false;
    if (requireConnected && (typeof manager.isConnected !== 'function' || !manager.isConnected())) return false;
    return true;
  };

  const configuredId = getConfiguredEd2kInstanceId(config);
  if (configuredId) {
    const configured = registry.get(configuredId);
    if (accepts(configured)) return configured;
  }

  const fallback = registry.getByNetworkType('ed2k').find(accepts) || null;
  if (configuredId && fallback && logger?.warn) {
    logger.warn(`⚠️ [${logPrefix}] Configured ${configuredLabel} "${configuredId}" not available, falling back to "${fallback.instanceId}"`);
  }
  return fallback;
}

module.exports = {
  getConfiguredEd2kInstanceId,
  isEd2kManager,
  resolveEd2kManager
};
