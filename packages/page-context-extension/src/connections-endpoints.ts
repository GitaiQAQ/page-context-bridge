/**
 * Connections 面板的 endpoint 配置读写。
 *
 * 规则：
 * - 新真相源是 `connections.endpoints.v1`
 * - 旧 `opencode.config.v1` 里的 endpoint 只做一次迁移
 * - session 相关历史字段继续留在旧 key，避免把既有恢复逻辑一起打坏
 */

import { storageLocalGet, storageLocalSet } from './extension-api';

export const CONNECTION_ENDPOINTS_STORAGE_KEY = 'connections.endpoints.v1';
export const LEGACY_OPENCODE_CONFIG_STORAGE_KEY = 'opencode.config.v1';

export interface ConnectionEndpointsConfig {
  opencodeBaseUrl: string;
  bridgeBaseUrl: string;
}

interface LegacyOpenCodeConfig {
  opencodeBaseUrl?: string;
  bridgeBaseUrl?: string;
}

export const DEFAULT_CONNECTION_ENDPOINTS: ConnectionEndpointsConfig = {
  opencodeBaseUrl: 'http://localhost:4096',
  bridgeBaseUrl: 'http://localhost:22334',
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
  };
}

/**
 * 首次启动迁移旧 endpoint。
 *
 * 只复制 endpoint 字段；不动 lastSessionId/sessionId，避免改变旧恢复语义。
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
  };

  await storageLocalSet({
    [CONNECTION_ENDPOINTS_STORAGE_KEY]: normalized,
  });
  return normalized;
}
