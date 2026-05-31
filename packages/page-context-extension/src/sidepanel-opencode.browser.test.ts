import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildExtWsUrl,
  buildIframeUrl,
  buildMcpUrl,
  buildMcpName,
  ensureMcpRegistered,
  type OpenCodeConfig,
} from './sidepanel-opencode';

describe('sidepanel-opencode', () => {
  const originalFetch = globalThis.fetch;
  const cfg: OpenCodeConfig = {
    opencodeBaseUrl: 'http://localhost:4096/',
    bridgeBaseUrl: 'http://localhost:22334/',
  };
  const projectDirectory = '/home/user/project';
  const projectSegment = 'L2hvbWUvdXNlci9wcm9qZWN0';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('builds websocket urls and rewrites http/https protocols', () => {
    expect(buildExtWsUrl(cfg, 'session-1')).toBe('ws://localhost:22335/?tenantId=session-1');
    expect(
      buildExtWsUrl(
        {
          opencodeBaseUrl: 'https://opencode.example.com/',
          bridgeBaseUrl: 'https://bridge.example.com/',
        },
        'session-2',
      ),
    ).toBe('wss://bridge.example.com/?tenantId=session-2');
  });

  it('builds iframe and mcp urls without double trailing slashes', () => {
    expect(buildMcpUrl(cfg, 'session-1')).toBe('http://localhost:22334/session-1/mcp');
    expect(buildMcpName('install-test')).toBe('page-context-install-test');
    expect(buildIframeUrl(cfg, 'session 1')).toBe('http://localhost:4096/?session=session%201');
    expect(
      buildIframeUrl(cfg, {
        id: 'session-1',
        directory: projectDirectory,
      }),
    ).toBe(`http://localhost:4096/${projectSegment}/session/session-1`);
  });

  it('treats an already-connected entry as idempotent (single POST roundtrip)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          'page-context-install-test': { status: 'connected' },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(ensureMcpRegistered(cfg, 'session-1', 'install-test')).resolves.toEqual({
      created: true,
      mcpName: 'page-context-install-test',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4096/mcp',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'page-context-install-test',
          config: {
            type: 'remote',
            url: 'http://localhost:22334/install-test/mcp',
            enabled: true,
          },
        }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('reuses one MCP entry for multiple OpenCode sessions on the same bridge channel', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            'page-context-install-test': { status: 'connected' },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await ensureMcpRegistered(cfg, 'session-alpha', 'install-test');
    await ensureMcpRegistered(cfg, 'session-beta', 'install-test');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:4096/mcp',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"name":"page-context-install-test"'),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:4096/mcp',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"name":"page-context-install-test"'),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: expect.stringContaining('page-context-session-alpha') }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: expect.stringContaining('page-context-session-beta') }),
    );
  });

  it('throws when opencode reports a failed mcp entry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          'page-context-install-test': {
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

    await expect(ensureMcpRegistered(cfg, 'session-2', 'install-test')).rejects.toThrow(
      /SSE error/,
    );
  });

  it('registers a remote mcp entry when opencode returns a connected status', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          other: { status: 'connected' },
          'page-context-install-test': { status: 'connected' },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(ensureMcpRegistered(cfg, 'session-2', 'install-test')).resolves.toEqual({
      created: true,
      mcpName: 'page-context-install-test',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:4096/mcp',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'page-context-install-test',
          config: {
            type: 'remote',
            url: 'http://localhost:22334/install-test/mcp',
            enabled: true,
          },
        }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('throws when opencode returns a non-connected entry state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          'page-context-install-test': { status: 'connecting' },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(ensureMcpRegistered(cfg, 'session-3', 'install-test')).rejects.toThrow(
      /not connected yet/,
    );
  });
});
