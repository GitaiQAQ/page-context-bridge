export interface OpenCodeConfig {
  opencodeBaseUrl: string;
  bridgeBaseUrl: string;
}

export interface OpenCodeSession {
  id: string;
  directory?: string;
  opencodeBaseUrl?: string;
}

interface OpenCodeMcpEntry {
  status?: string;
  error?: string;
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

/**
 * Build addresses through the URL API so string concatenation does not mix path/query.
 * This only appends a path to an existing base; callers still decide protocol and port.
 */
function appendPath(baseUrl: string, pathSuffix: string): URL {
  const parsed = new URL(baseUrl);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}${pathSuffix}`;
  parsed.search = '';
  parsed.hash = '';
  return parsed;
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
 * Note: opencode `GET /mcp` only returns static MCP entries from the config file and omits runtime adds.
 * The `POST /mcp` response body is the current full MCP set, including dynamic entries.
 * Use the POST response to decide whether the target is already connected before registering again.
 */
export async function ensureMcpRegistered(
  cfg: OpenCodeConfig,
  sessionId: string,
  channelId: string,
): Promise<{ created: boolean; mcpName: string }> {
  const normalized = getNormalizedConfig(cfg);
  const mcpName = `page-context-${sessionId}`;

  const status = await requestJson<Record<string, OpenCodeMcpEntry>>(getMcpApiUrl(normalized), {
    method: 'POST',
    bodyJson: {
      name: mcpName,
      config: {
        type: 'remote',
        url: buildMcpUrl(normalized, channelId),
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
      `opencode failed to connect MCP "${mcpName}": ${entry.error ?? 'unknown error'}`,
    );
  }
  if (entry.status !== 'connected') {
    throw new Error(
      `opencode MCP "${mcpName}" is not connected yet (status=${entry.status ?? 'unknown'})`,
    );
  }

  return { created: true, mcpName };
}

function encodeOpencodeRouteSegment(value: string): string {
  // The real opencode web route uses base64url(worktree) as the first path segment.
  // Keep encoding in one helper so replacements for + / = are not missed.
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function buildIframeUrl(cfg: OpenCodeConfig, session: OpenCodeSession | string): string {
  const normalized = getNormalizedConfig(cfg);
  const sessionId = typeof session === 'string' ? session : session.id;
  const sessionDirectory = typeof session === 'string' ? '' : (session.directory?.trim() ?? '');

  // Legacy-data compatibility: if directory is temporarily unavailable, fall back to the old query form
  // so existing callers do not break immediately. Real connected paths must include directory.
  if (!sessionDirectory) {
    return `${appendPath(normalized.opencodeBaseUrl, '/').toString()}?session=${encodeURIComponent(sessionId)}`;
  }

  const directorySegment = encodeOpencodeRouteSegment(sessionDirectory);
  return appendPath(
    normalized.opencodeBaseUrl,
    `/${directorySegment}/session/${encodeURIComponent(sessionId)}`,
  ).toString();
}

export function buildExtWsUrl(cfg: OpenCodeConfig, channelId: string): string {
  const normalized = getNormalizedConfig(cfg);
  const parsed = new URL(normalized.bridgeBaseUrl);

  if (parsed.protocol === 'http:') {
    parsed.protocol = 'ws:';
  } else if (parsed.protocol === 'https:') {
    parsed.protocol = 'wss:';
  } else {
    throw new Error('Bridge base URL must use http:// or https://');
  }

  // Convention: the sidepanel stores the MCP HTTP base.
  // If the user explicitly provides a port, default ws uses the adjacent port +1 to match bridge defaults 22334/22335.
  // Without an explicit port, do not guess so reverse-proxy or same-port deployments keep working.
  if (parsed.port) {
    const httpPort = Number(parsed.port);
    if (!Number.isFinite(httpPort) || httpPort <= 0) {
      throw new Error('Bridge base URL port is invalid');
    }
    parsed.port = String(httpPort + 1);
  }

  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  parsed.searchParams.set('tenantId', channelId);
  return parsed.toString();
}

export function buildExtWsUrlFromDefaultBridgeWs(defaultWsUrl: string, channelId: string): string {
  const parsed = new URL(defaultWsUrl);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('Bridge default WS URL must use ws:// or wss://');
  }
  parsed.search = '';
  parsed.hash = '';
  parsed.searchParams.set('tenantId', channelId);
  return parsed.toString();
}

export function buildMcpUrl(cfg: OpenCodeConfig, channelId: string): string {
  const normalized = getNormalizedConfig(cfg);
  return appendPath(normalized.bridgeBaseUrl, `/${encodeURIComponent(channelId)}/mcp`).toString();
}
