export interface OpenCodeConfig {
  opencodeBaseUrl: string;
  bridgeBaseUrl: string;
}

export interface OpenCodeSession {
  id: string;
  directory?: string;
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
 * 统一按 URL API 组装地址，避免字符串拼接把 path/query 搅在一起。
 * 这里只做“在已有 base 后追加路径”这一件事，调用方再决定协议与端口。
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
  // opencode web 真实路由使用 base64url(worktree) 作为第一段 path。
  // 这里单独封装编码，避免各处手写替换规则时把 + / = 漏掉。
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

  // 兼容旧数据：如果暂时拿不到 directory，先回退旧 query 形式，
  // 至少不要把现有调用方直接打崩。真实联通路径则必须带 directory。
  if (!sessionDirectory) {
    return `${appendPath(normalized.opencodeBaseUrl, '/').toString()}?session=${encodeURIComponent(sessionId)}`;
  }

  const directorySegment = encodeOpencodeRouteSegment(sessionDirectory);
  return appendPath(
    normalized.opencodeBaseUrl,
    `/${directorySegment}/session/${encodeURIComponent(sessionId)}`,
  ).toString();
}

export function buildExtWsUrl(cfg: OpenCodeConfig, sessionId: string): string {
  const normalized = getNormalizedConfig(cfg);
  const parsed = new URL(normalized.bridgeBaseUrl);

  if (parsed.protocol === 'http:') {
    parsed.protocol = 'ws:';
  } else if (parsed.protocol === 'https:') {
    parsed.protocol = 'wss:';
  } else {
    throw new Error('Bridge base URL must use http:// or https://');
  }

  // 约定：sidepanel 填的是 MCP HTTP base。
  // 如果用户显式给了端口，则默认 ws 走“相邻端口 +1”，对齐 bridge 默认 22334/22335。
  // 没有显式端口时不擅自猜测，让反向代理/同端口部署继续成立。
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
  parsed.searchParams.set('tenantId', sessionId);
  return parsed.toString();
}

export function buildMcpUrl(cfg: OpenCodeConfig, sessionId: string): string {
  const normalized = getNormalizedConfig(cfg);
  return appendPath(normalized.bridgeBaseUrl, `/${encodeURIComponent(sessionId)}/mcp`).toString();
}
