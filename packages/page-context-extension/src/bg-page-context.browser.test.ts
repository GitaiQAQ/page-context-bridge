import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PageContextManifest } from '@page-context/shared-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BG_PAGE_CONTEXT_FILE = resolve(
  process.cwd(),
  'packages/page-context-extension/src/bg-page-context.ts',
);
const BG_PAGE_ACCESS_BACKEND_FILE = resolve(
  process.cwd(),
  'packages/page-context-extension/src/bg-page-access-backend.ts',
);

const FIREFOX_READONLY_METHODS = {
  manifestGet: 'extension.content.context.manifest.get',
  resourceRead: 'extension.content.context.resource.read',
  skillGet: 'extension.content.context.skill.get',
  pageToolsDiscover: 'extension.content.pageTools.discover',
  pageToolExecute: 'extension.content.pageTool.execute',
} as const;

describe('bg-page-context source boundary', () => {
  it('keeps MAIN world executeScript details only in backend file', () => {
    // 这个断言直接卡住架构边界：bg-page-context 不能再出现 MAIN world 注入细节。
    const contextSource = readFileSync(BG_PAGE_CONTEXT_FILE, 'utf8');
    const backendSource = readFileSync(BG_PAGE_ACCESS_BACKEND_FILE, 'utf8');

    const contextMainWorldCalls = contextSource.match(/world:\s*['"]MAIN['"]/g) ?? [];
    const backendMainWorldCalls = backendSource.match(/world:\s*['"]MAIN['"]/g) ?? [];

    expect(contextMainWorldCalls.length).toBe(0);
    expect(backendMainWorldCalls.length).toBeGreaterThan(0);
  });
});

describe('bg-page-context backend delegation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('delegates manifest/resource/skill/discover/execute calls to backend interface', async () => {
    const backendMock = {
      getRawManifest: vi.fn().mockResolvedValue({ version: '1.0.0' }),
      readResource: vi
        .fn()
        .mockResolvedValue({ id: 'r', text: '{}', mimeType: 'application/json' }),
      getSkill: vi.fn().mockResolvedValue({ skill: { id: 's' }, text: 'prompt' }),
      ensureBridgeHost: vi.fn().mockResolvedValue(undefined),
      discoverTools: vi
        .fn()
        .mockResolvedValue([{ namespace: 'page', instanceId: 'default', tools: [] }]),
      executePageTool: vi.fn().mockResolvedValue({ ok: true, result: { ok: 1 } }),
    };

    vi.doMock('./bg-page-access-backend', () => ({
      selectedPageAccessBackend: {
        kind: 'chromium-native-main-world',
        detection: {
          kind: 'chromium-native-main-world',
          reason: 'mocked for delegation test',
        },
        backend: backendMock,
      },
    }));

    const pageContext = await import('./bg-page-context.js');

    // 按真实对外 API 路径逐一调用，确保入口层只做转发。
    await pageContext.getRawPageContextManifest(1);
    await pageContext.readPageContextResource(2, 'resource-1');
    await pageContext.getPageContextSkill(3, 'skill-1', { topic: 'slice-c' });
    await pageContext.discoverPageToolsInTab(4);
    await pageContext.executePageToolInTab(
      5,
      'workspace.page.echo',
      { message: 'hello' },
      'workspace',
    );

    expect(backendMock.getRawManifest).toHaveBeenCalledWith(1);
    expect(backendMock.readResource).toHaveBeenCalledWith(2, 'resource-1');
    expect(backendMock.getSkill).toHaveBeenCalledWith(3, 'skill-1', { topic: 'slice-c' });
    expect(backendMock.ensureBridgeHost).toHaveBeenCalledWith(4);
    expect(backendMock.discoverTools).toHaveBeenCalledWith(4);
    expect(backendMock.executePageTool).toHaveBeenCalledWith(
      5,
      'workspace.page.echo',
      { message: 'hello' },
      'workspace',
      undefined,
    );
  });
});

describe('bg-page-context chromium behavior', () => {
  const originalChrome = globalThis.chrome;
  const originalBrowser = (globalThis as typeof globalThis & { browser?: Record<string, unknown> })
    .browser;

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('./bg-page-access-backend');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreChromeGlobal(originalChrome);
    restoreBrowserGlobal(originalBrowser);
    Reflect.deleteProperty(window as Window & Record<string, unknown>, '__pageContextBridge__');
    Reflect.deleteProperty(window as Window & Record<string, unknown>, '__pageContextTools__');
  });

  it('keeps manifest/resource/skill/discover/execute flow working with MAIN world backend', async () => {
    const executeScript = vi
      .fn()
      .mockImplementation(async (options: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
        const injectedFn = options.func as ((...args: unknown[]) => unknown) | undefined;
        const args = (options.args ?? []) as unknown[];
        return [{ result: await Promise.resolve(injectedFn?.(...args)) }];
      });
    installChromeMock({ executeScript });

    const manifest: PageContextManifest = {
      version: '1.0.0',
      app: 'demo-app',
      route: '/workspace',
      scene: 'workspace',
      namespaces: [
        {
          namespace: 'workspace',
          title: 'Workspace',
          description: 'Workspace tool namespace',
        },
      ],
      resources: [],
      skills: [],
      generatedAt: '2026-05-14T00:00:00.000Z',
    };

    const callTool = vi.fn().mockResolvedValue({ source: 'instance', echoed: 'hello', ok: true });
    (window as Window & Record<string, unknown>).__pageContextBridge__ = {
      version: '1.0.0',
      getManifest: () => manifest,
      readResource: (id: string) => ({
        id,
        mimeType: 'application/json',
        text: '{"ok":true}',
      }),
      getSkill: (id: string, input: Record<string, unknown>) => ({
        skill: {
          id,
          namespace: 'workspace',
          title: 'Workspace Skill',
          description: 'Describe workspace insight',
        },
        text: `skill-input=${JSON.stringify(input)}`,
      }),
      listNamespaces: () => ['workspace'],
      getNamespace: (namespace: string) => {
        if (namespace !== 'workspace') {
          return undefined;
        }
        return {
          listInstances: () => ['default'],
          getInstance: (instanceId: string) => {
            if (instanceId !== 'default') {
              return undefined;
            }
            return {
              listTools: () => [{ name: 'workspace.page.echo', description: 'Echo tool' }],
              callTool,
            };
          },
        };
      },
    } as unknown as Record<string, unknown>;

    const pageContext = await import('./bg-page-context.js');
    const tabId = 21;

    // 覆盖本 slice 要求的关键路径，确保 Chromium 语义不回归。
    await expect(pageContext.getRawPageContextManifest(tabId)).resolves.toEqual(manifest);
    await expect(pageContext.readPageContextResource(tabId, 'resource-1')).resolves.toEqual({
      id: 'resource-1',
      mimeType: 'application/json',
      text: '{"ok":true}',
    });
    await expect(
      pageContext.getPageContextSkill(tabId, 'skill-1', { topic: 'phase-4' }),
    ).resolves.toMatchObject({
      skill: { id: 'skill-1', namespace: 'workspace' },
      text: 'skill-input={"topic":"phase-4"}',
    });
    await expect(pageContext.discoverPageToolsInTab(tabId)).resolves.toEqual([
      {
        namespace: 'workspace',
        namespaceTitle: 'Workspace',
        namespaceDescription: 'Workspace tool namespace',
        instanceId: 'default',
        tools: [{ name: 'workspace.page.echo', description: 'Echo tool' }],
      },
    ]);
    await expect(
      pageContext.executePageToolInTab(
        tabId,
        'workspace.page.echo',
        { message: 'hello' },
        'workspace',
        'default',
      ),
    ).resolves.toEqual({
      ok: true,
      result: { source: 'instance', echoed: 'hello', ok: true },
    });

    expect(callTool).toHaveBeenCalledWith('workspace.page.echo', { message: 'hello' });
    expect(executeScript).toHaveBeenCalledTimes(5);
    for (const [options] of executeScript.mock.calls) {
      expect(options).toMatchObject({
        target: { tabId },
        world: 'MAIN',
      });
    }
  });

  it('keeps legacy single-bridge callTool path available', async () => {
    const executeScript = vi
      .fn()
      .mockImplementation(async (options: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
        const injectedFn = options.func as ((...args: unknown[]) => unknown) | undefined;
        const args = (options.args ?? []) as unknown[];
        return [{ result: await Promise.resolve(injectedFn?.(...args)) }];
      });
    installChromeMock({ executeScript });

    const callTool = vi.fn().mockResolvedValue({ ok: true, source: 'legacy' });
    (window as Window & Record<string, unknown>).__pageContextBridge__ = {
      namespace: 'page',
      instanceId: 'default',
      listTools: () => [{ name: 'page.legacy', description: 'Legacy tool' }],
      callTool,
    } as unknown as Record<string, unknown>;

    const pageContext = await import('./bg-page-context.js');
    await expect(
      pageContext.executePageToolInTab(7, 'page.legacy', { flag: true }, 'page'),
    ).resolves.toEqual({
      ok: true,
      result: { ok: true, source: 'legacy' },
    });
    expect(callTool).toHaveBeenCalledWith('page.legacy', { flag: true });
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7 },
        world: 'MAIN',
      }),
    );
  });
});

describe('bg-page-context firefox probe behavior', () => {
  const originalChrome = globalThis.chrome;
  const originalBrowser = (globalThis as typeof globalThis & { browser?: Record<string, unknown> })
    .browser;

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('./bg-page-access-backend');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreChromeGlobal(originalChrome);
    restoreBrowserGlobal(originalBrowser);
  });

  it('detects firefox probe and serves readonly/execute RPC via content-script', async () => {
    const sendMessage = vi.fn(
      async (_tabId: number, message: { method?: string; params?: unknown }) => {
        switch (message.method) {
          case FIREFOX_READONLY_METHODS.manifestGet:
            return {
              jsonrpc: '2.0',
              id: '1',
              result: {
                version: '1.0.0',
                app: 'firefox-demo',
                route: '/firefox',
                scene: 'firefox',
                namespaces: [],
                resources: [],
                skills: [],
                generatedAt: '2026-05-14T00:00:00.000Z',
              },
            };
          case FIREFOX_READONLY_METHODS.resourceRead:
            return {
              jsonrpc: '2.0',
              id: '2',
              result: {
                id: (message.params as { resourceId: string }).resourceId,
                mimeType: 'application/json',
                text: '{"source":"firefox"}',
              },
            };
          case FIREFOX_READONLY_METHODS.skillGet:
            return {
              jsonrpc: '2.0',
              id: '3',
              result: {
                skill: {
                  id: (message.params as { skillId: string }).skillId,
                  namespace: 'firefox',
                  title: 'Firefox skill',
                  description: 'Readonly skill from content script',
                },
                text: 'firefox skill prompt',
              },
            };
          case FIREFOX_READONLY_METHODS.pageToolsDiscover:
            return {
              jsonrpc: '2.0',
              id: '4',
              result: [
                {
                  namespace: 'firefox',
                  namespaceTitle: 'Firefox',
                  namespaceDescription: 'Firefox discover namespace',
                  instanceId: 'default',
                  tools: [{ name: 'firefox.page.inspect', description: 'Inspect via Firefox' }],
                },
              ],
            };
          case FIREFOX_READONLY_METHODS.pageToolExecute:
            return {
              jsonrpc: '2.0',
              id: '5',
              result:
                (message.params as { pageToolName: string }).pageToolName === 'page.fail'
                  ? { ok: false, error: 'page tool failed' }
                  : { ok: true, result: { source: 'firefox', echoed: message.params } },
            };
          default:
            throw new Error(`Unexpected RPC method: ${String(message.method)}`);
        }
      },
    );
    const executeScript = vi.fn();
    installChromeMock({ executeScript, sendMessage });
    installBrowserMock({
      runtime: {
        getBrowserInfo: vi.fn().mockResolvedValue({ name: 'Firefox' }),
      },
    });

    const pageContext = await import('./bg-page-context.js');

    expect(pageContext.pageAccessBackendKind).toBe('firefox-probe');
    await expect(pageContext.getRawPageContextManifest(11)).resolves.toEqual({
      version: '1.0.0',
      app: 'firefox-demo',
      route: '/firefox',
      scene: 'firefox',
      namespaces: [],
      resources: [],
      skills: [],
      generatedAt: '2026-05-14T00:00:00.000Z',
    });
    await expect(pageContext.readPageContextResource(11, 'res-firefox')).resolves.toEqual({
      id: 'res-firefox',
      mimeType: 'application/json',
      text: '{"source":"firefox"}',
    });
    await expect(
      pageContext.getPageContextSkill(11, 'skill-firefox', { phase: 6 }),
    ).resolves.toEqual({
      skill: {
        id: 'skill-firefox',
        namespace: 'firefox',
        title: 'Firefox skill',
        description: 'Readonly skill from content script',
      },
      text: 'firefox skill prompt',
    });
    await expect(pageContext.discoverPageToolsInTab(11)).resolves.toEqual([
      {
        namespace: 'firefox',
        namespaceTitle: 'Firefox',
        namespaceDescription: 'Firefox discover namespace',
        instanceId: 'default',
        tools: [{ name: 'firefox.page.inspect', description: 'Inspect via Firefox' }],
      },
    ]);
    await expect(
      pageContext.executePageToolInTab(11, 'page.echo', { text: 'hello' }, 'page'),
    ).resolves.toEqual({
      ok: true,
      result: {
        source: 'firefox',
        echoed: {
          pageToolName: 'page.echo',
          args: { text: 'hello' },
          namespace: 'page',
          instanceId: undefined,
        },
      },
    });
    await expect(
      pageContext.executePageToolInTab(11, 'page.fail', { text: 'hello' }, 'page'),
    ).resolves.toEqual({
      ok: false,
      error: 'page tool failed',
    });

    expect(executeScript).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        method: FIREFOX_READONLY_METHODS.manifestGet,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        method: FIREFOX_READONLY_METHODS.resourceRead,
        params: { resourceId: 'res-firefox' },
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        method: FIREFOX_READONLY_METHODS.skillGet,
        params: { skillId: 'skill-firefox', input: { phase: 6 } },
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        method: FIREFOX_READONLY_METHODS.pageToolsDiscover,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        method: FIREFOX_READONLY_METHODS.pageToolExecute,
        params: {
          pageToolName: 'page.echo',
          args: { text: 'hello' },
          namespace: 'page',
          instanceId: undefined,
        },
      }),
    );
  });
});

function installChromeMock({
  executeScript,
  sendMessage,
}: {
  executeScript: ReturnType<typeof vi.fn>;
  sendMessage?: ReturnType<typeof vi.fn>;
}): void {
  const chromeMock = {
    scripting: {
      executeScript,
    },
    tabs: {
      sendMessage: sendMessage ?? vi.fn(),
    },
  } as unknown as typeof chrome;

  Object.defineProperty(globalThis, 'chrome', {
    value: chromeMock,
    configurable: true,
    writable: true,
  });
}

function restoreChromeGlobal(originalChrome: typeof chrome | undefined): void {
  if (originalChrome) {
    Object.defineProperty(globalThis, 'chrome', {
      value: originalChrome,
      configurable: true,
      writable: true,
    });
    return;
  }
  Reflect.deleteProperty(globalThis, 'chrome');
}

function installBrowserMock(browserMock: Record<string, unknown>): void {
  Object.defineProperty(globalThis, 'browser', {
    value: {
      tabs: {
        sendMessage: globalThis.chrome?.tabs?.sendMessage,
      },
      ...browserMock,
    },
    configurable: true,
    writable: true,
  });
}

function restoreBrowserGlobal(originalBrowser: Record<string, unknown> | undefined): void {
  if (originalBrowser) {
    Object.defineProperty(globalThis, 'browser', {
      value: originalBrowser,
      configurable: true,
      writable: true,
    });
    return;
  }
  Reflect.deleteProperty(globalThis, 'browser');
}
