import type { PageContextManifest } from '@page-context/shared-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendTabRequestMock } = vi.hoisted(() => ({
  sendTabRequestMock: vi.fn(),
}));

const FIREFOX_READONLY_METHODS = {
  manifestGet: 'extension.content.context.manifest.get',
  resourceRead: 'extension.content.context.resource.read',
  skillGet: 'extension.content.context.skill.get',
  pageToolsDiscover: 'extension.content.pageTools.discover',
  pageToolExecute: 'extension.content.pageTool.execute',
} as const;

vi.mock('./runtime-rpc', () => ({
  sendTabRequest: sendTabRequestMock,
}));

import {
  chromiumPageAccessBackend,
  detectPageAccessBackend,
  selectPageAccessBackend,
  type PageAccessBackendDetection,
} from './bg-page-access-backend';

describe('bg-page-access-backend detectPageAccessBackend()', () => {
  it('detects chromium-native-main-world when MAIN world capability exists and no firefox signal', () => {
    const detection = detectPageAccessBackend({
      hasChromeScriptingExecuteScript: true,
      hasBrowserRuntimeGetBrowserInfo: false,
      userAgent: 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36',
      manifest: { manifest_version: 3 },
    });

    expect(detection.kind).toBe('chromium-native-main-world');
  });

  it('prefers firefox-probe when firefox signal exists to avoid misrouting to Chromium backend', () => {
    const detection = detectPageAccessBackend({
      hasChromeScriptingExecuteScript: true,
      hasBrowserRuntimeGetBrowserInfo: false,
      userAgent: 'Mozilla/5.0 Firefox/128.0',
      manifest: {
        manifest_version: 3,
        browser_specific_settings: {
          gecko: { id: 'test@example.com' },
        },
      },
    });

    expect(detection.kind).toBe('firefox-probe');
    expect(detection.reason).toContain('Firefox probe signal');
  });

  it('returns unsupported when neither chromium nor firefox probe signals are available', () => {
    const detection = detectPageAccessBackend({
      hasChromeScriptingExecuteScript: false,
      hasBrowserRuntimeGetBrowserInfo: false,
      userAgent: 'CustomRuntime/1.0',
      manifest: { manifest_version: 3 },
    });

    expect(detection.kind).toBe('unsupported');
  });
});

describe('bg-page-access-backend selectPageAccessBackend()', () => {
  beforeEach(() => {
    sendTabRequestMock.mockReset();
  });

  it('routes firefox readonly operations through tab RPC requests', async () => {
    const detection: PageAccessBackendDetection = {
      kind: 'firefox-probe',
      reason: 'test firefox probe',
    };
    const selection = selectPageAccessBackend(detection);
    const backend = selection.backend;
    const tabId = 31;
    const manifest: PageContextManifest = {
      version: '1.0.0',
      app: 'demo',
      route: '/workspace',
      scene: 'workspace',
      namespaces: [],
      resources: [],
      skills: [],
      generatedAt: '2026-05-14T00:00:00.000Z',
    };

    // Dispatch mock responses by method so tests do not depend on call order.
    sendTabRequestMock.mockImplementation(
      async (_tabId: number, method: string, params?: unknown) => {
        if (method === FIREFOX_READONLY_METHODS.manifestGet) {
          return manifest;
        }
        if (method === FIREFOX_READONLY_METHODS.resourceRead) {
          return {
            id: (params as { resourceId: string }).resourceId,
            mimeType: 'application/json',
            text: '{"ok":true}',
          };
        }
        if (method === FIREFOX_READONLY_METHODS.skillGet) {
          return {
            skill: {
              id: (params as { skillId: string }).skillId,
              namespace: 'workspace',
              title: 'Workspace skill',
              description: 'Demo',
            },
            text: JSON.stringify((params as { input: Record<string, unknown> }).input ?? {}),
          };
        }
        if (method === FIREFOX_READONLY_METHODS.pageToolsDiscover) {
          return [
            {
              namespace: 'workspace',
              namespaceTitle: 'Workspace',
              namespaceDescription: 'Workspace tools',
              instanceId: 'default',
              tools: [{ name: 'workspace.page.echo', description: 'Echo tool' }],
            },
          ];
        }
        if (method === FIREFOX_READONLY_METHODS.pageToolExecute) {
          return {
            ok: true,
            result: {
              tool: (params as { pageToolName: string }).pageToolName,
              args: (params as { args: Record<string, unknown> }).args,
            },
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    );

    expect(selection.kind).toBe('firefox-probe');
    await expect(backend.getRawManifest(tabId)).resolves.toEqual(manifest);
    await expect(backend.readResource(tabId, 'r-1')).resolves.toEqual({
      id: 'r-1',
      mimeType: 'application/json',
      text: '{"ok":true}',
    });
    await expect(backend.getSkill(tabId, 's-1', { topic: 'phase-6' })).resolves.toEqual({
      skill: {
        id: 's-1',
        namespace: 'workspace',
        title: 'Workspace skill',
        description: 'Demo',
      },
      text: '{"topic":"phase-6"}',
    });
    await expect(backend.discoverTools(tabId)).resolves.toEqual([
      {
        namespace: 'workspace',
        namespaceTitle: 'Workspace',
        namespaceDescription: 'Workspace tools',
        instanceId: 'default',
        tools: [{ name: 'workspace.page.echo', description: 'Echo tool' }],
      },
    ]);
    await expect(
      backend.executePageTool(
        tabId,
        'workspace.page.echo',
        { message: 'hello' },
        'workspace',
        'default',
      ),
    ).resolves.toEqual({
      ok: true,
      result: {
        tool: 'workspace.page.echo',
        args: { message: 'hello' },
      },
    });

    expect(sendTabRequestMock).toHaveBeenCalledWith(tabId, FIREFOX_READONLY_METHODS.manifestGet);
    expect(sendTabRequestMock).toHaveBeenCalledWith(tabId, FIREFOX_READONLY_METHODS.resourceRead, {
      resourceId: 'r-1',
    });
    expect(sendTabRequestMock).toHaveBeenCalledWith(tabId, FIREFOX_READONLY_METHODS.skillGet, {
      skillId: 's-1',
      input: { topic: 'phase-6' },
    });
    expect(sendTabRequestMock).toHaveBeenCalledWith(
      tabId,
      FIREFOX_READONLY_METHODS.pageToolsDiscover,
    );
    expect(sendTabRequestMock).toHaveBeenCalledWith(
      tabId,
      FIREFOX_READONLY_METHODS.pageToolExecute,
      {
        pageToolName: 'workspace.page.echo',
        args: { message: 'hello' },
        namespace: 'workspace',
        instanceId: 'default',
      },
    );
  });

  it('routes firefox execute through tab RPC requests', async () => {
    const detection: PageAccessBackendDetection = {
      kind: 'firefox-probe',
      reason: 'test firefox probe',
    };
    const backend = selectPageAccessBackend(detection).backend;
    const tabId = 3;
    sendTabRequestMock.mockResolvedValue({ ok: true, result: { echoed: 'hi' } });

    await expect(
      backend.executePageTool(tabId, 'page.echo', { text: 'hi' }, 'page', 'default'),
    ).resolves.toEqual({
      ok: true,
      result: { echoed: 'hi' },
    });
    expect(sendTabRequestMock).toHaveBeenCalledWith(
      tabId,
      FIREFOX_READONLY_METHODS.pageToolExecute,
      {
        pageToolName: 'page.echo',
        args: { text: 'hi' },
        namespace: 'page',
        instanceId: 'default',
      },
    );
  });
});

describe('bg-page-access-backend chromium executePageTool()', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    sendTabRequestMock.mockReset();
  });

  afterEach(() => {
    if (originalChrome) {
      Object.defineProperty(globalThis, 'chrome', {
        value: originalChrome,
        configurable: true,
      });
      return;
    }
    Reflect.deleteProperty(globalThis, 'chrome');
  });

  it('serializes default instance as null for chrome.scripting.executeScript', async () => {
    const executeScriptMock = vi.fn().mockResolvedValue([
      {
        result: {
          ok: true,
          result: { title: 'Page Context Bridge - Test Page' },
        },
      },
    ]);

    Object.defineProperty(globalThis, 'chrome', {
      value: {
        scripting: {
          executeScript: executeScriptMock,
        },
      },
      configurable: true,
    });

    await expect(
      chromiumPageAccessBackend.executePageTool(7, 'getPageInfo', {}, 'page'),
    ).resolves.toEqual({
      ok: true,
      result: { title: 'Page Context Bridge - Test Page' },
    });

    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7 },
        world: 'MAIN',
        args: ['getPageInfo', {}, 'page', null],
      }),
    );
  });
});
