import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const discoverPageToolsInTabMock = vi.fn();
const queueNotificationMock = vi.fn();
const ensureMainWorldBridgeHostOnTabMock = vi.fn().mockResolvedValue(undefined);
const getBuiltinToolDefinitionsMock = vi.fn(() => []);
const collectBridgeControlToolSpecsMock = vi.fn(() => []);

vi.mock('@page-context/agentation', () => ({
  ensureMainWorldBridgeHostOnTab: ensureMainWorldBridgeHostOnTabMock,
}));

vi.mock('./bg-ws-connection', () => ({
  log: vi.fn(),
  queueNotification: queueNotificationMock,
}));

vi.mock('./extension-api', () => ({
  storageLocalGet: vi.fn(async (defaults?: Record<string, unknown>) => defaults ?? {}),
  storageLocalSet: vi.fn(async () => undefined),
  tabsQuery: vi.fn(async () => []),
}));

vi.mock('@page-context/tool-executor', () => ({
  getBuiltinToolDefinitions: getBuiltinToolDefinitionsMock,
}));

vi.mock('@page-context/builtin-tools', () => ({
  collectBridgeControlToolSpecs: collectBridgeControlToolSpecsMock,
}));

vi.mock('@page-context/tool-visibility', () => ({
  buildToolTree: vi.fn(async () => ({ tabs: [] })),
  flattenPageTools: vi.fn((entries?: Array<{ tools?: unknown[] }>) =>
    (entries ?? []).flatMap((entry) => entry.tools ?? []),
  ),
  getEnabledBuiltinTools: vi.fn((tools: unknown[]) => tools),
  getEnabledToolsForTab: vi.fn((entries?: Array<{ tools?: unknown[] }>) =>
    (entries ?? []).flatMap((entry) => entry.tools ?? []),
  ),
  isToolEnabled: vi.fn(() => true),
  normalizePageToolEntries: vi.fn((entries: unknown[]) => entries ?? []),
  setScopeEnabled: vi.fn((current: Record<string, unknown>) => current),
}));

describe('discoverPageToolsForTab', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getBuiltinToolDefinitionsMock.mockReturnValue([]);
    collectBridgeControlToolSpecsMock.mockReturnValue([]);
  });

  afterEach(() => {
    vi.doUnmock('./bg-page-context');
  });

  it('preserves previously registered Firefox tools when rediscovery is transiently empty', async () => {
    discoverPageToolsInTabMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    vi.doMock('./bg-page-context', () => ({
      discoverPageToolsInTab: discoverPageToolsInTabMock,
      pageAccessBackendKind: 'firefox-probe',
      sleep: vi.fn(async () => undefined),
    }));

    const { createPageToolState, discoverPageToolsForTab } = await import('./bg-page-tools.js');
    const state = createPageToolState();
    const existingEntries = [
      {
        namespace: 'e2e',
        instanceId: 'default',
        tools: [{ name: 'e2e-tool-1', description: 'E2E test tool' }],
      },
    ];
    state.pageToolsByTab.set(88, existingEntries as never);

    const result = await discoverPageToolsForTab(
      state,
      88,
      ensureMainWorldBridgeHostOnTabMock as never,
      true,
      true,
    );

    expect(result).toEqual(existingEntries);
    expect(state.pageToolsByTab.get(88)).toEqual(existingEntries);
    expect(discoverPageToolsInTabMock).toHaveBeenCalledTimes(4);
  });

  it('preserves Firefox tools that are registered while rediscovery is already in flight', async () => {
    let injected = false;
    let stateRef: ReturnType<(typeof import('./bg-page-tools.js'))['createPageToolState']> | null =
      null;
    discoverPageToolsInTabMock.mockImplementation(async () => {
      if (!injected && stateRef) {
        injected = true;
        stateRef.pageToolsByTab.set(66, [
          {
            namespace: 'e2e',
            instanceId: 'test',
            tools: [{ name: 'e2e.test.e2e-tool-1', description: 'E2E test tool' }],
          },
        ] as never);
      }
      return [];
    });

    vi.doMock('./bg-page-context', () => ({
      discoverPageToolsInTab: discoverPageToolsInTabMock,
      pageAccessBackendKind: 'firefox-probe',
      sleep: vi.fn(async () => undefined),
    }));

    const { createPageToolState, discoverPageToolsForTab } = await import('./bg-page-tools.js');
    const state = createPageToolState();
    stateRef = state;

    const result = await discoverPageToolsForTab(
      state,
      66,
      ensureMainWorldBridgeHostOnTabMock as never,
      true,
      true,
    );

    expect(result).toEqual([
      {
        namespace: 'e2e',
        instanceId: 'test',
        tools: [{ name: 'e2e.test.e2e-tool-1', description: 'E2E test tool' }],
      },
    ]);
    expect(state.pageToolsByTab.get(66)).toEqual(result);
    expect(discoverPageToolsInTabMock).toHaveBeenCalledTimes(4);
  });

  it('clears stale Chromium tools when rediscovery stays empty', async () => {
    discoverPageToolsInTabMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    vi.doMock('./bg-page-context', () => ({
      discoverPageToolsInTab: discoverPageToolsInTabMock,
      pageAccessBackendKind: 'chromium-native-main-world',
      sleep: vi.fn(async () => undefined),
    }));

    const { createPageToolState, discoverPageToolsForTab } = await import('./bg-page-tools.js');
    const state = createPageToolState();
    state.pageToolsByTab.set(21, [
      {
        namespace: 'page',
        instanceId: 'default',
        tools: [{ name: 'page.stale', description: 'stale tool' }],
      },
    ] as never);

    const result = await discoverPageToolsForTab(
      state,
      21,
      ensureMainWorldBridgeHostOnTabMock as never,
      true,
      true,
    );

    expect(result).toEqual([]);
    expect(state.pageToolsByTab.has(21)).toBe(false);
    expect(discoverPageToolsInTabMock).toHaveBeenCalledTimes(4);
  });

  it('publishes all builtin tools even when preferences would disable them', async () => {
    getBuiltinToolDefinitionsMock.mockReturnValue([
      { name: 'builtin.tabs.list_tabs', description: 'List tabs' },
      { name: 'builtin.page.navigate', description: 'Navigate page' },
    ]);

    const { createPageToolState, publishBuiltinTools } = await import('./bg-page-tools.js');
    const state = createPageToolState();
    state.pageToolPreferences = {
      builtins: {
        enabled: false,
        tools: {
          'builtin.tabs.list_tabs': false,
          'builtin.page.navigate': false,
        },
      },
    };
    state.pageToolPreferencesReady = Promise.resolve();

    publishBuiltinTools(state);
    await Promise.resolve();

    expect(queueNotificationMock).toHaveBeenCalledWith(
      'bridge.builtinTools.updated',
      expect.objectContaining({
        tools: [
          expect.objectContaining({ name: 'builtin.tabs.list_tabs' }),
          expect.objectContaining({ name: 'builtin.page.navigate' }),
        ],
      }),
    );
  });

  it('publishes all discovered page tools for a tab even when preferences disable them', async () => {
    const { createPageToolState, publishPageToolsForTab } = await import('./bg-page-tools.js');
    const state = createPageToolState();
    state.pageToolPreferences = {
      tabs: {
        '88': {
          namespaces: {
            crm: {
              instances: {
                default: {
                  tools: {
                    'crm.inspect': false,
                  },
                },
              },
            },
          },
        },
      },
    };
    state.pageToolPreferencesReady = Promise.resolve();
    state.pageToolsByTab.set(88, [
      {
        namespace: 'crm',
        instanceId: 'default',
        tools: [{ name: 'crm.inspect', description: 'Inspect CRM lead' }],
      },
    ] as never);

    publishPageToolsForTab(state, 88);
    await Promise.resolve();

    expect(queueNotificationMock).toHaveBeenCalledWith(
      'bridge.pageTools.registered',
      expect.objectContaining({
        tabId: 88,
        tools: [expect.objectContaining({ name: 'crm.inspect' })],
      }),
    );
  });
});
