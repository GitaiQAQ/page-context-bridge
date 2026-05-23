import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildExtWsUrl,
  buildIframeUrl,
  buildMcpUrl,
  ensureMcpRegistered,
  type OpenCodeConfig,
} from './sidepanel-opencode';

describe('sidepanel-opencode', () => {
  const originalFetch = globalThis.fetch;
  const cfg: OpenCodeConfig = {
    opencodeBaseUrl: 'http://localhost:4096/',
    bridgeBaseUrl: 'http://localhost:22335/',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('builds websocket urls and rewrites http/https protocols', () => {
    expect(buildExtWsUrl(cfg, 'session-1')).toBe('ws://localhost:22335/session-1/ext');
    expect(
      buildExtWsUrl(
        {
          opencodeBaseUrl: 'https://opencode.example.com/',
          bridgeBaseUrl: 'https://bridge.example.com/',
        },
        'session-2',
      ),
    ).toBe('wss://bridge.example.com/session-2/ext');
  });

  it('builds iframe and mcp urls without double trailing slashes', () => {
    expect(buildMcpUrl(cfg, 'session-1')).toBe('http://localhost:22335/session-1/mcp');
    expect(buildIframeUrl(cfg, 'session 1')).toBe('http://localhost:4096/?session=session%201');
  });

  it('treats an already-connected entry as idempotent (single POST roundtrip)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          'page-context-session-1': { status: 'connected' },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(ensureMcpRegistered(cfg, 'session-1')).resolves.toEqual({
      created: true,
      mcpName: 'page-context-session-1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4096/mcp',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'page-context-session-1',
          config: {
            type: 'remote',
            url: 'http://localhost:22335/session-1/mcp',
            enabled: true,
          },
        }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('throws when opencode reports a failed mcp entry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          'page-context-session-2': {
            status: 'failed',
            error: 'SSE error: Non-200 status code (500)',
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(ensureMcpRegistered(cfg, 'session-2')).rejects.toThrow(/SSE error/);
  });

  it('registers a remote mcp entry when opencode returns a connected status', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          other: { status: 'connected' },
          'page-context-session-2': { status: 'connected' },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(ensureMcpRegistered(cfg, 'session-2')).resolves.toEqual({
      created: true,
      mcpName: 'page-context-session-2',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:4096/mcp',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'page-context-session-2',
          config: {
            type: 'remote',
            url: 'http://localhost:22335/session-2/mcp',
            enabled: true,
          },
        }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }),
    );
  });
});
