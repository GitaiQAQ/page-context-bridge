import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const performActionMock = vi.fn();
const refreshMock = vi.fn();
const loadConnectionEndpointsMock = vi.fn();
const saveConnectionEndpointsMock = vi.fn();
let mockDescriptors: unknown[] = [];

vi.mock('./connection-status-badge', () => ({}));

vi.mock('./connections-controller', () => ({
  ConnectionsController: class {
    get descriptors() {
      return mockDescriptors;
    }

    constructor(_host: unknown) {}
  },
  getConnectionsStore: () => ({
    performAction: performActionMock,
    refresh: refreshMock,
  }),
}));

vi.mock('./connections-endpoints', () => ({
  DEFAULT_CONNECTION_ENDPOINTS: {
    opencodeBaseUrl: 'http://127.0.0.1:4096',
    bridgeBaseUrl: 'http://127.0.0.1:22334',
    bridgeWsUrl: 'ws://127.0.0.1:22335/default',
  },
  loadConnectionEndpoints: loadConnectionEndpointsMock,
  saveConnectionEndpoints: saveConnectionEndpointsMock,
}));

describe('connections-panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    loadConnectionEndpointsMock.mockResolvedValue({
      opencodeBaseUrl: 'http://localhost:4096',
      bridgeBaseUrl: 'http://localhost:22334',
      bridgeWsUrl: 'ws://127.0.0.1:22335/default',
    });
    saveConnectionEndpointsMock.mockImplementation(async (endpoints) => endpoints);
    refreshMock.mockResolvedValue(undefined);
    mockDescriptors = [];
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('saves endpoint with legacy background missing connections.action', async () => {
    performActionMock.mockRejectedValueOnce(
      new Error('Unhandled runtime method: connections.action'),
    );

    await import('./connections-panel');

    const element = document.createElement('connections-panel') as HTMLElement & {
      updateComplete: Promise<void>;
      message?: string;
      endpoints?: {
        opencodeBaseUrl: string;
        bridgeBaseUrl: string;
        bridgeWsUrl: string;
      };
    };

    const changedEvents: Array<{
      opencodeBaseUrl: string;
      bridgeBaseUrl: string;
      bridgeWsUrl: string;
    }> = [];
    element.addEventListener('connections-endpoints-changed', (event) => {
      changedEvents.push(
        (
          event as CustomEvent<{
            opencodeBaseUrl: string;
            bridgeBaseUrl: string;
            bridgeWsUrl: string;
          }>
        ).detail,
      );
    });

    document.body.appendChild(element);
    await element.updateComplete;

    element.endpoints = {
      opencodeBaseUrl: 'http://127.0.0.1:4096',
      bridgeBaseUrl: 'http://127.0.0.1:22334',
      bridgeWsUrl: 'ws://10.37.9.81:22335/project-route',
    };

    await (element as unknown as { handleSaveEndpoints(): Promise<void> }).handleSaveEndpoints();
    await element.updateComplete;

    expect(saveConnectionEndpointsMock).toHaveBeenCalledWith({
      opencodeBaseUrl: 'http://127.0.0.1:4096',
      bridgeBaseUrl: 'http://127.0.0.1:22334',
      bridgeWsUrl: 'ws://10.37.9.81:22335/project-route',
    });
    expect(performActionMock).toHaveBeenCalledWith('opencode-http', 'reconnect');
    expect(performActionMock).toHaveBeenCalledWith('bridge-default-ws', 'reconnect');
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(element.message).toBe('Endpoints saved');
    expect(changedEvents).toEqual([
      {
        opencodeBaseUrl: 'http://127.0.0.1:4096',
        bridgeBaseUrl: 'http://127.0.0.1:22334',
        bridgeWsUrl: 'ws://10.37.9.81:22335/project-route',
      },
    ]);
  });

  test('renders product cockpit, journey step, and attention summary', async () => {
    mockDescriptors = [
      {
        id: 'bridge-default-ws',
        kind: 'bridge-default-ws',
        label: 'Bridge Default WS',
        endpoint: 'ws://127.0.0.1:22335/?tenantId=default',
        status: 'connected',
        updatedAt: new Date().toISOString(),
        capabilities: { reconnect: true },
      },
      {
        id: 'opencode-http',
        kind: 'opencode-http',
        label: 'OpenCode HTTP',
        endpoint: 'http://127.0.0.1:4096',
        status: 'unreachable',
        statusReason: 'ECONNREFUSED',
        updatedAt: new Date().toISOString(),
        capabilities: { reconnect: true },
      },
    ];

    await import('./connections-panel');

    const element = document.createElement('connections-panel') as HTMLElement & {
      updateComplete: Promise<void>;
    };
    document.body.appendChild(element);
    await element.updateComplete;

    const text = element.textContent ?? '';
    expect(text).toContain('Setup & troubleshooting');
    expect(text).toContain('Needs attention');
    expect(text).toContain('Endpoint configuration');
    expect(text).toContain('Edit endpoints only when local ports or remote bridge routes change');
    expect(text).toContain('OpenCode Base URL');
    expect(text).toContain('Bridge Base URL');
    expect(text).toContain('Bridge Default WS URL');
    expect(text).toContain('OpenCode control plane');
    expect(text).toContain('Session MCP transport');
    expect(text).toContain('Browser bridge control link');
    expect(text).toContain('1 attention');
    expect(text).toContain('ECONNREFUSED');

    await (element as unknown as { handleRunDiagnosis(): Promise<void> }).handleRunDiagnosis();
    await element.updateComplete;

    expect(refreshMock).toHaveBeenCalled();
    expect(element.textContent ?? '').toContain('Page Context Bridge connection diagnosis');
    expect(element.textContent ?? '').toContain(
      'Bridge Default WS URL: ws://127.0.0.1:22335/default',
    );
    expect(element.textContent ?? '').toContain('Summary: 1 healthy / 1 attention');
  });

  test('diagnostic report flags default bridge and session-scoped extension WS route mismatch', async () => {
    mockDescriptors = [
      {
        id: 'bridge-default-ws',
        kind: 'bridge-default-ws',
        label: 'Bridge Default WS',
        endpoint: 'ws://10.37.9.81:22335/wangwenxiao.gitai-firefox',
        status: 'connected',
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'opencode-bridge-ws:session-1',
        kind: 'opencode-bridge-ws',
        label: 'OpenCode Bridge WS · session-1',
        endpoint: 'ws://localhost:22335/?tenantId=session-1',
        status: 'error',
        statusReason: 'closed-before-reconnect:1006',
        updatedAt: new Date().toISOString(),
        meta: { tenantId: 'session-1' },
      },
    ];

    await import('./connections-panel');

    const element = document.createElement('connections-panel') as HTMLElement & {
      updateComplete: Promise<void>;
    };
    document.body.appendChild(element);
    await element.updateComplete;

    await (element as unknown as { handleRunDiagnosis(): Promise<void> }).handleRunDiagnosis();
    await element.updateComplete;

    const text = element.textContent ?? '';
    expect(text).toContain('Warning: 1 session-scoped extension WS endpoint');
    expect(text).toContain('ws://10.37.9.81:22335/wangwenxiao.gitai-firefox');
  });
});
