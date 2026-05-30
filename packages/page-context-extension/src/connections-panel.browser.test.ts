import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const performActionMock = vi.fn();
const refreshMock = vi.fn();
const loadConnectionEndpointsMock = vi.fn();
const saveConnectionEndpointsMock = vi.fn();

vi.mock('./connection-status-badge', () => ({}));

vi.mock('./connections-controller', () => ({
  ConnectionsController: class {
    descriptors = [];

    constructor(_host: unknown) {}
  },
  getConnectionsStore: () => ({
    performAction: performActionMock,
    refresh: refreshMock,
  }),
}));

vi.mock('./connections-endpoints', () => ({
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
    });
    saveConnectionEndpointsMock.mockImplementation(async (endpoints) => endpoints);
    refreshMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('保存 endpoint 时兼容旧 background 缺少 connections.action', async () => {
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
      };
    };

    const changedEvents: Array<{ opencodeBaseUrl: string; bridgeBaseUrl: string }> = [];
    element.addEventListener('connections-endpoints-changed', (event) => {
      changedEvents.push(
        (event as CustomEvent<{ opencodeBaseUrl: string; bridgeBaseUrl: string }>).detail,
      );
    });

    document.body.appendChild(element);
    await element.updateComplete;

    element.endpoints = {
      opencodeBaseUrl: 'http://127.0.0.1:4096',
      bridgeBaseUrl: 'http://127.0.0.1:22334',
    };

    await (element as unknown as { handleSaveEndpoints(): Promise<void> }).handleSaveEndpoints();
    await element.updateComplete;

    expect(saveConnectionEndpointsMock).toHaveBeenCalledWith({
      opencodeBaseUrl: 'http://127.0.0.1:4096',
      bridgeBaseUrl: 'http://127.0.0.1:22334',
    });
    expect(performActionMock).toHaveBeenCalledWith('opencode-http', 'reconnect');
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(element.message).toBe('Endpoints saved');
    expect(changedEvents).toEqual([
      {
        opencodeBaseUrl: 'http://127.0.0.1:4096',
        bridgeBaseUrl: 'http://127.0.0.1:22334',
      },
    ]);
  });
});
