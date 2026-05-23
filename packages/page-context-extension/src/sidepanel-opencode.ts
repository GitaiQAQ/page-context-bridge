export interface OpenCodeConfig {
  opencodeBaseUrl: string;
  bridgeBaseUrl: string;
}

export interface OpenCodeSession {
  id: string;
}

interface OpenCodeMcpEntry {
  status?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeBaseUrl(value: string, fieldName: string): string {
  const normalized = trimTrailingSlashes(value.trim());
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function getNormalizedConfig(cfg: OpenCodeConfig): OpenCodeConfig {
  return {
    opencodeBaseUrl: normalizeBaseUrl(cfg.opencodeBaseUrl, 'OpenCode base URL'),
    bridgeBaseUrl: normalizeBaseUrl(cfg.bridgeBaseUrl, 'Bridge base URL'),
  };
}

async function requestJson<T>(
  url: string,
  init: RequestInit & { bodyJson?: unknown } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      body: init.bodyJson === undefined ? init.body : JSON.stringify(init.bodyJson),
      signal: controller.signal,
    });

    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      throw new Error(`${response.status} ${message || response.statusText}`.trim());
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function getSessionApiUrl(cfg: OpenCodeConfig): string {
  return `${getNormalizedConfig(cfg).opencodeBaseUrl}/session`;
}

function getMcpApiUrl(cfg: OpenCodeConfig): string {
  return `${getNormalizedConfig(cfg).opencodeBaseUrl}/mcp`;
}

export async function listSessions(cfg: OpenCodeConfig): Promise<OpenCodeSession[]> {
  return requestJson<OpenCodeSession[]>(getSessionApiUrl(cfg), { method: 'GET' });
}

export async function createSession(cfg: OpenCodeConfig): Promise<OpenCodeSession> {
  return requestJson<OpenCodeSession>(getSessionApiUrl(cfg), {
    method: 'POST',
    bodyJson: {},
  });
}

export async function deleteSession(cfg: OpenCodeConfig, id: string): Promise<void> {
  await requestJson<void>(`${getSessionApiUrl(cfg)}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/**
 * 注意：opencode `GET /mcp` 只返回 config 文件里的静态 MCP，不会列出运行时动态 add 的；
 * 而 `POST /mcp` 的响应 body 是当前 MCP 全集（含动态项）。
 * 所以这里直接用 POST 的返回值判断目标是否已 connected，再决定是否需要再次注册。
 */
export async function ensureMcpRegistered(
  cfg: OpenCodeConfig,
  sessionId: string,
): Promise<{ created: boolean; mcpName: string }> {
  const normalized = getNormalizedConfig(cfg);
  const mcpName = `page-context-${sessionId}`;

  const status = await requestJson<Record<string, OpenCodeMcpEntry>>(getMcpApiUrl(normalized), {
    method: 'POST',
    bodyJson: {
      name: mcpName,
      config: {
        type: 'remote',
        url: buildMcpUrl(normalized, sessionId),
        enabled: true,
      },
    },
  });

  const entry = status?.[mcpName];
  if (!entry) {
    throw new Error(`opencode did not register MCP entry "${mcpName}"`);
  }
  if (entry.status === 'failed') {
    throw new Error(
      `opencode failed to connect MCP "${mcpName}": ${(entry as { error?: string }).error ?? 'unknown error'}`,
    );
  }

  return { created: true, mcpName };
}

export function buildIframeUrl(cfg: OpenCodeConfig, sessionId: string): string {
  const normalized = getNormalizedConfig(cfg);
  return `${normalized.opencodeBaseUrl}/?session=${encodeURIComponent(sessionId)}`;
}

export function buildExtWsUrl(cfg: OpenCodeConfig, sessionId: string): string {
  const parsed = new URL(buildMcpUrl(cfg, sessionId).replace(/\/mcp$/, '/ext'));
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'ws:';
  } else if (parsed.protocol === 'https:') {
    parsed.protocol = 'wss:';
  } else {
    throw new Error('Bridge base URL must use http:// or https://');
  }
  return parsed.toString();
}

export function buildMcpUrl(cfg: OpenCodeConfig, sessionId: string): string {
  const normalized = getNormalizedConfig(cfg);
  return `${normalized.bridgeBaseUrl}/${encodeURIComponent(sessionId)}/mcp`;
}
