import { beforeEach, describe, expect, it, vi } from 'vitest';

function installChromeMock() {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: '0.0.0' }),
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      query: vi.fn(async (queryInfo?: { active?: boolean; currentWindow?: boolean }) => {
        if (queryInfo?.active) {
          return [{ id: 7, active: true, title: 'Active', url: 'https://example.com' }];
        }
        return [{ id: 7, active: true, title: 'Active', url: 'https://example.com' }];
      }),
      get: vi.fn(async (tabId: number) => ({ id: tabId, status: 'complete' })),
      captureVisibleTab: vi.fn(),
      update: vi.fn(),
      reload: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
    },
    debugger: {
      onDetach: { addListener: vi.fn() },
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(),
    },
  };
}

describe('executeToolCall builtin alias support', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installChromeMock();
  });

  it('executes bare builtin suffix aliases through the canonical service-worker tool', async () => {
    const { executeToolCall } = await import('./executor.js');

    const result = (await executeToolCall('list_tabs', {})) as {
      tabs: Array<{ id?: number; title?: string; url?: string; active?: boolean }>;
    };

    expect(result.tabs).toEqual([
      { id: 7, active: true, title: 'Active', url: 'https://example.com' },
    ]);
  });

  it('executes page-context-prefixed aliases through the canonical content-script tool', async () => {
    const sendTabRequest = vi.fn(async () => ({
      title: 'Example Page',
      url: 'https://example.com',
    }));
    const { executeToolCall } = await import('./executor.js');

    const result = await executeToolCall('page-context_get_page_info', {}, 99, {
      sendTabRequest,
    });

    expect(result).toEqual({ title: 'Example Page', url: 'https://example.com' });
    expect(sendTabRequest).toHaveBeenCalledWith(99, 'extension.tool.execute', {
      tool: 'builtin.page.get_page_info',
      args: {},
      _providerId: 'builtin',
    });
  });
});
