import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { PageContextManifest } from '@page-context/shared-protocol';
import { BRIDGE_METHODS } from '@page-context/shared-protocol';

import {
  getContextManifestDebugFromExtension,
  getContextManifestFromExtension,
} from './extension-session.js';
import type { TenantManager } from './tenant-manager.js';

function createManagerWithRequestMock(requestMock: ReturnType<typeof vi.fn>): TenantManager {
  const slot = {
    ws: { readyState: WebSocket.OPEN } as unknown as WebSocket,
    peer: { request: requestMock },
    ready: true,
    sessionId: 'session-test',
    lastHeartbeatAt: Date.now(),
  };

  return {
    get: vi.fn(() => ({
      extension: slot,
    })),
  } as unknown as TenantManager;
}

function createManifest(scene: string): PageContextManifest {
  return {
    version: '1',
    app: 'crm',
    route: '/lead/1',
    scene,
    namespaces: [],
    resources: [],
    skills: [],
    generatedAt: '2026-04-23T00:00:00.000Z',
  };
}

describe('extension-session context manifest debug rpc', () => {
  it('keeps raw/debug fields when extension returns full payload', async () => {
    const requestMock = vi.fn(async () => ({
      manifest: createManifest('effective'),
      rawManifest: createManifest('raw'),
      debug: { droppedNamespaces: ['lead'] },
    }));
    const manager = createManagerWithRequestMock(requestMock);

    const payload = await getContextManifestDebugFromExtension('tenant-a', manager, 9);

    expect(payload.manifest?.scene).toBe('effective');
    expect(payload.rawManifest?.scene).toBe('raw');
    expect(payload.debug).toEqual({ droppedNamespaces: ['lead'] });
    expect(requestMock).toHaveBeenCalledWith(
      BRIDGE_METHODS.extensionContextManifestGet,
      { tabId: 9 },
      expect.any(Object),
    );
  });

  it('falls back to legacy manifest-only payload without changing rpc method', async () => {
    const requestMock = vi.fn(async () => createManifest('legacy'));
    const manager = createManagerWithRequestMock(requestMock);

    const payload = await getContextManifestDebugFromExtension('tenant-a', manager, 11);

    // Compatible with old extensions: when only manifest is returned, bridge automatically fills in raw/debug.
    expect(payload.manifest?.scene).toBe('legacy');
    expect(payload.rawManifest?.scene).toBe('legacy');
    expect(payload.debug).toBeNull();
    expect(requestMock.mock.calls[0]?.[0]).toBe(BRIDGE_METHODS.extensionContextManifestGet);
  });

  it('getContextManifestFromExtension returns only effective manifest', async () => {
    const requestMock = vi.fn(async () => ({
      manifest: createManifest('effective'),
      rawManifest: createManifest('raw'),
      debug: { droppedNamespaces: [] },
    }));
    const manager = createManagerWithRequestMock(requestMock);

    const manifest = await getContextManifestFromExtension('tenant-a', manager, 17);

    expect(manifest?.scene).toBe('effective');
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
