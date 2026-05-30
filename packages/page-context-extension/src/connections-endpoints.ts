/**
 * Endpoint config reads/writes for the Connections panel.
 *
 * Rules:
 * - The new source of truth is `connections.endpoints.v1`.
 * - Migrate endpoints from old `opencode.config.v1` only once.
 * - Keep historical session fields in the old key to avoid breaking restore logic.
 */

import { storageLocalGet, storageLocalSet } from './extension-api';

export const CONNECTION_ENDPOINTS_STORAGE_KEY = 'connections.endpoints.v1';
export const LEGACY_OPENCODE_CONFIG_STORAGE_KEY = 'opencode.config.v1';

export interface ConnectionEndpointsConfig {
  opencodeBaseUrl: string;
  bridgeBaseUrl: string;
  bridgeWsUrl: string;
}

interface LegacyOpenCodeConfig {
  opencodeBaseUrl?: string;
  bridgeBaseUrl?: string;
  bridgeWsUrl?: string;
}

export const DEFAULT_CONNECTION_ENDPOINTS: ConnectionEndpointsConfig = {
  opencodeBaseUrl: 'http://localhost:4096',
  bridgeBaseUrl: 'http://localhost:22334',
  bridgeWsUrl: 'ws://127.0.0.1:22335/default',
};

function normalizeEndpoint(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export async function loadConnectionEndpoints(): Promise<ConnectionEndpointsConfig> {
  const stored = await storageLocalGet<{
    [CONNECTION_ENDPOINTS_STORAGE_KEY]?: Partial<ConnectionEndpointsConfig>;
  }>({
    [CONNECTION_ENDPOINTS_STORAGE_KEY]: DEFAULT_CONNECTION_ENDPOINTS,
  });
  const current = stored[CONNECTION_ENDPOINTS_STORAGE_KEY];

  return {
    opencodeBaseUrl: normalizeEndpoint(
      current?.opencodeBaseUrl,
      DEFAULT_CONNECTION_ENDPOINTS.opencodeBaseUrl,
    ),
    bridgeBaseUrl: normalizeEndpoint(
      current?.bridgeBaseUrl,
      DEFAULT_CONNECTION_ENDPOINTS.bridgeBaseUrl,
    ),
    bridgeWsUrl: normalizeEndpoint(current?.bridgeWsUrl, DEFAULT_CONNECTION_ENDPOINTS.bridgeWsUrl),
  };
}

/**
 * Migrate legacy endpoints on first startup.
 *
 * Copy only endpoint fields; leave lastSessionId/sessionId untouched to preserve legacy restore semantics.
 */
export async function migrateLegacyConnectionEndpoints(): Promise<ConnectionEndpointsConfig> {
  const current = await storageLocalGet<{
    [CONNECTION_ENDPOINTS_STORAGE_KEY]?: Partial<ConnectionEndpointsConfig>;
    [LEGACY_OPENCODE_CONFIG_STORAGE_KEY]?: LegacyOpenCodeConfig;
  }>({
    [CONNECTION_ENDPOINTS_STORAGE_KEY]: undefined,
    [LEGACY_OPENCODE_CONFIG_STORAGE_KEY]: undefined,
  });

  if (current[CONNECTION_ENDPOINTS_STORAGE_KEY]) {
    return await loadConnectionEndpoints();
  }

  const legacy = current[LEGACY_OPENCODE_CONFIG_STORAGE_KEY];
  const migrated: ConnectionEndpointsConfig = {
    opencodeBaseUrl: normalizeEndpoint(
      legacy?.opencodeBaseUrl,
      DEFAULT_CONNECTION_ENDPOINTS.opencodeBaseUrl,
    ),
    bridgeBaseUrl: normalizeEndpoint(
      legacy?.bridgeBaseUrl,
      DEFAULT_CONNECTION_ENDPOINTS.bridgeBaseUrl,
    ),
    bridgeWsUrl: normalizeEndpoint(legacy?.bridgeWsUrl, DEFAULT_CONNECTION_ENDPOINTS.bridgeWsUrl),
  };

  await storageLocalSet({
    [CONNECTION_ENDPOINTS_STORAGE_KEY]: migrated,
  });
  return migrated;
}

export async function saveConnectionEndpoints(
  endpoints: ConnectionEndpointsConfig,
): Promise<ConnectionEndpointsConfig> {
  const normalized: ConnectionEndpointsConfig = {
    opencodeBaseUrl: normalizeEndpoint(
      endpoints.opencodeBaseUrl,
      DEFAULT_CONNECTION_ENDPOINTS.opencodeBaseUrl,
    ),
    bridgeBaseUrl: normalizeEndpoint(
      endpoints.bridgeBaseUrl,
      DEFAULT_CONNECTION_ENDPOINTS.bridgeBaseUrl,
    ),
    bridgeWsUrl: normalizeEndpoint(endpoints.bridgeWsUrl, DEFAULT_CONNECTION_ENDPOINTS.bridgeWsUrl),
  };

  await storageLocalSet({
    [CONNECTION_ENDPOINTS_STORAGE_KEY]: normalized,
  });
  return normalized;
}
