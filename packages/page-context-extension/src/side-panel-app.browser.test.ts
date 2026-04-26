import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_METHODS } from '@page-context/shared-protocol';

// 直接从真实包导入，不再经过 re-export shim
import type { PageToolEntry, PageToolSpec } from '@page-context/tool-visibility';
import {
  buildToolTree,
  setScopeEnabled,
  type PageToolPreferences,
} from '@page-context/tool-visibility';

const sendRuntimeRequestMock = vi.fn();

vi.mock('./runtime-rpc', () => ({
  sendRuntimeRequest: sendRuntimeRequestMock,
}));

describe('side-panel-app tools tree interactions', () => {
  const originalChrome = globalThis.chrome;
  const builtinTools: PageToolSpec[] = [
    { name: 'builtin.get_page_info', description: 'Get page info' },
    { name: 'builtin.navigate', description: 'Navigate tab' },
    {
      name: 'extension.get_runtime_status',
      description: 'Get runtime status',
      _bridgeControlTool: true,
    },
    {
      name: 'feedback.get_snapshot',
      description: 'Get feedback snapshot',
      _bridgeControlTool: true,
    },
  ];
  const tabs = [{ id: 11, title: 'Demo', url: 'https://example.com', active: true }];
  const pageEntries = new Map<number, PageToolEntry[]>([
    [
      11,
      [
        {
          namespace: 'alpha',
          instanceId: 'default',
          tools: [{ name: 'alpha.inspect' }, { name: 'alpha.read' }],
        },
        {
          namespace: 'beta',
          instanceId: 'instA',
          tools: [{ name: 'beta.instA.run' }],
        },
        {
          namespace: 'beta',
          instanceId: 'instB',
          tools: [{ name: 'beta.instB.inspect' }],
        },
      ],
    ],
  ]);

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    installChromeMock();
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(
      1 as unknown as ReturnType<typeof setInterval>,
    );
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    installRuntimeRequestMock({ builtinTools, tabs, pageEntries });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    restoreChromeGlobal(originalChrome);
  });

  it('renders bridge control tools inside unified builtin tree', async () => {
    await import('./side-panel-app');

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      const text = element.shadowRoot?.textContent ?? '';
      expect(text).toContain('extension.get_runtime_status');
      expect(text).toContain('feedback.get_snapshot');
      expect(text).toContain('Built-in Tools');
    });

    // Built-in structure should be rendered as a namespace/instance tree, not a flat list.
    expect(findCheckbox(element, { scope: 'builtin', namespace: 'builtin' })).not.toBeNull();
    expect(
      findCheckbox(element, { scope: 'builtin', namespace: 'builtin', instanceId: 'default' }),
    ).not.toBeNull();
    expect(findCheckbox(element, { scope: 'builtin', namespace: 'extension' })?.disabled).toBe(
      true,
    );
  });

  it('unchecks all descendant tool checkboxes when a namespace is disabled', async () => {
    await import('./side-panel-app');

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      expect(element.shadowRoot?.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThan(
        0,
      );
    });

    const namespaceCheckbox = findCheckbox(element, {
      scope: 'namespace',
      namespace: 'beta',
    });
    expect(namespaceCheckbox).not.toBeNull();
    namespaceCheckbox!.checked = false;
    namespaceCheckbox!.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    await vi.waitFor(() => {
      expect(findCheckbox(element, { scope: 'namespace', namespace: 'beta' })?.checked).toBe(false);
      expect(
        findCheckbox(element, { scope: 'instance', namespace: 'beta', instanceId: 'instA' })
          ?.checked,
      ).toBe(false);
      expect(
        findCheckbox(element, { scope: 'instance', namespace: 'beta', instanceId: 'instB' })
          ?.checked,
      ).toBe(false);
      expect(findCheckbox(element, { scope: 'tool', toolName: 'beta.instA.run' })?.checked).toBe(
        false,
      );
      expect(
        findCheckbox(element, { scope: 'tool', toolName: 'beta.instB.inspect' })?.checked,
      ).toBe(false);
    });

    expect(sendRuntimeRequestMock).toHaveBeenCalledWith(
      BRIDGE_METHODS.extensionPageToolsSetEnabled,
      {
        root: 'page',
        tabId: 11,
        namespace: 'beta',
        instanceId: undefined,
        toolName: undefined,
        enabled: false,
      },
    );
  });

  it('re-checks all descendant tool checkboxes when a namespace is re-enabled', async () => {
    await import('./side-panel-app');

    const disabledPreferences = setScopeEnabled({}, { tabId: 11, namespace: 'beta' }, false, {
      pageEntries: pageEntries.get(11)?.filter((entry) => entry.namespace === 'beta'),
    });
    installRuntimeRequestMock({
      builtinTools,
      tabs,
      pageEntries,
      initialPreferences: disabledPreferences,
    });

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      expect(findCheckbox(element, { scope: 'namespace', namespace: 'beta' })?.checked).toBe(false);
    });

    const namespaceCheckbox = findCheckbox(element, {
      scope: 'namespace',
      namespace: 'beta',
    });
    expect(namespaceCheckbox).not.toBeNull();
    namespaceCheckbox!.checked = true;
    namespaceCheckbox!.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    await vi.waitFor(() => {
      expect(findCheckbox(element, { scope: 'namespace', namespace: 'beta' })?.checked).toBe(true);
      expect(
        findCheckbox(element, { scope: 'instance', namespace: 'beta', instanceId: 'instA' })
          ?.checked,
      ).toBe(true);
      expect(
        findCheckbox(element, { scope: 'instance', namespace: 'beta', instanceId: 'instB' })
          ?.checked,
      ).toBe(true);
      expect(findCheckbox(element, { scope: 'tool', toolName: 'beta.instA.run' })?.checked).toBe(
        true,
      );
      expect(
        findCheckbox(element, { scope: 'tool', toolName: 'beta.instB.inspect' })?.checked,
      ).toBe(true);
    });

    expect(sendRuntimeRequestMock).toHaveBeenCalledWith(
      BRIDGE_METHODS.extensionPageToolsSetEnabled,
      {
        root: 'page',
        tabId: 11,
        namespace: 'beta',
        instanceId: undefined,
        toolName: undefined,
        enabled: true,
      },
    );
  });

  it('unchecks all namespace and tool checkboxes when a tab is disabled', async () => {
    await import('./side-panel-app');

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      expect(element.shadowRoot?.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThan(
        0,
      );
    });

    const tabCheckbox = findCheckbox(element, { scope: 'tab' });
    expect(tabCheckbox).not.toBeNull();
    tabCheckbox!.checked = false;
    tabCheckbox!.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    await vi.waitFor(() => {
      // Tab itself should be unchecked
      expect(findCheckbox(element, { scope: 'tab' })?.checked).toBe(false);
      // All namespaces under this tab should be unchecked
      expect(findCheckbox(element, { scope: 'namespace', namespace: 'alpha' })?.checked).toBe(
        false,
      );
      expect(findCheckbox(element, { scope: 'namespace', namespace: 'beta' })?.checked).toBe(false);
      // All instances should be unchecked
      expect(
        findCheckbox(element, { scope: 'instance', namespace: 'alpha', instanceId: 'default' })
          ?.checked,
      ).toBe(false);
      expect(
        findCheckbox(element, { scope: 'instance', namespace: 'beta', instanceId: 'instA' })
          ?.checked,
      ).toBe(false);
      expect(
        findCheckbox(element, { scope: 'instance', namespace: 'beta', instanceId: 'instB' })
          ?.checked,
      ).toBe(false);
      // All tools should be unchecked
      expect(findCheckbox(element, { scope: 'tool', toolName: 'alpha.inspect' })?.checked).toBe(
        false,
      );
      expect(findCheckbox(element, { scope: 'tool', toolName: 'alpha.read' })?.checked).toBe(false);
      expect(findCheckbox(element, { scope: 'tool', toolName: 'beta.instA.run' })?.checked).toBe(
        false,
      );
      expect(
        findCheckbox(element, { scope: 'tool', toolName: 'beta.instB.inspect' })?.checked,
      ).toBe(false);
    });

    expect(sendRuntimeRequestMock).toHaveBeenCalledWith(
      BRIDGE_METHODS.extensionPageToolsSetEnabled,
      {
        root: 'page',
        tabId: 11,
        namespace: undefined,
        instanceId: undefined,
        toolName: undefined,
        enabled: false,
      },
    );
  });

  it('unchecks all tool checkboxes when an instance is disabled', async () => {
    await import('./side-panel-app');

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      expect(element.shadowRoot?.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThan(
        0,
      );
    });

    const instanceCheckbox = findCheckbox(element, {
      scope: 'instance',
      namespace: 'beta',
      instanceId: 'instA',
    });
    expect(instanceCheckbox).not.toBeNull();
    instanceCheckbox!.checked = false;
    instanceCheckbox!.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    await vi.waitFor(() => {
      // Instance itself should be unchecked
      expect(
        findCheckbox(element, { scope: 'instance', namespace: 'beta', instanceId: 'instA' })
          ?.checked,
      ).toBe(false);
      // Tools under this instance should be unchecked
      expect(findCheckbox(element, { scope: 'tool', toolName: 'beta.instA.run' })?.checked).toBe(
        false,
      );
      // Other instances should remain checked
      expect(
        findCheckbox(element, { scope: 'instance', namespace: 'beta', instanceId: 'instB' })
          ?.checked,
      ).toBe(true);
      expect(
        findCheckbox(element, { scope: 'tool', toolName: 'beta.instB.inspect' })?.checked,
      ).toBe(true);
      // Namespace should become indeterminate (partially checked)
      const namespaceCheckbox = findCheckbox(element, { scope: 'namespace', namespace: 'beta' });
      expect(namespaceCheckbox?.indeterminate).toBe(true);
    });

    expect(sendRuntimeRequestMock).toHaveBeenCalledWith(
      BRIDGE_METHODS.extensionPageToolsSetEnabled,
      {
        root: 'page',
        tabId: 11,
        namespace: 'beta',
        instanceId: 'instA',
        toolName: undefined,
        enabled: false,
      },
    );
  });

  it('unchecks all builtin tool checkboxes when builtins are disabled', async () => {
    await import('./side-panel-app');

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      expect(element.shadowRoot?.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThan(
        0,
      );
    });

    const builtinCheckbox = findCheckbox(element, { scope: 'builtin' });
    expect(builtinCheckbox).not.toBeNull();
    builtinCheckbox!.checked = false;
    builtinCheckbox!.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    await vi.waitFor(() => {
      // Builtin root should be unchecked
      expect(findCheckbox(element, { scope: 'builtin' })?.checked).toBe(false);
      // Regular builtin can be disabled; bridge control builtin remains read-only visible, not participating in toggle.
      expect(
        findCheckbox(element, { scope: 'builtin', toolName: 'builtin.get_page_info' })?.checked,
      ).toBe(false);
      expect(
        findCheckbox(element, { scope: 'builtin', toolName: 'builtin.navigate' })?.checked,
      ).toBe(false);
      expect(
        findCheckbox(element, { scope: 'builtin', toolName: 'extension.get_runtime_status' })
          ?.checked,
      ).toBe(true);
      expect(
        findCheckbox(element, { scope: 'builtin', toolName: 'feedback.get_snapshot' })?.checked,
      ).toBe(true);
    });

    expect(sendRuntimeRequestMock).toHaveBeenCalledWith(
      BRIDGE_METHODS.extensionPageToolsSetEnabled,
      {
        root: 'builtin',
        tabId: undefined,
        namespace: undefined,
        instanceId: undefined,
        toolName: undefined,
        enabled: false,
      },
    );
  });

  it('routes builtin namespace toggle through builtin root semantics', async () => {
    await import('./side-panel-app');

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      expect(
        findCheckbox(element, { root: 'builtin', scope: 'builtin', namespace: 'builtin' }),
      ).not.toBeNull();
    });

    const builtinNamespaceCheckbox = findCheckbox(element, {
      root: 'builtin',
      scope: 'builtin',
      namespace: 'builtin',
    });
    expect(builtinNamespaceCheckbox).not.toBeNull();
    builtinNamespaceCheckbox!.checked = false;
    builtinNamespaceCheckbox!.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    await vi.waitFor(() => {
      expect(
        findCheckbox(element, {
          root: 'builtin',
          scope: 'builtin',
          toolName: 'builtin.get_page_info',
        })?.checked,
      ).toBe(false);
      expect(
        findCheckbox(element, { root: 'builtin', scope: 'builtin', toolName: 'builtin.navigate' })
          ?.checked,
      ).toBe(false);
      expect(
        findCheckbox(element, {
          root: 'builtin',
          scope: 'builtin',
          toolName: 'extension.get_runtime_status',
        })?.checked,
      ).toBe(true);
    });

    expect(sendRuntimeRequestMock).toHaveBeenCalledWith(
      BRIDGE_METHODS.extensionPageToolsSetEnabled,
      {
        root: 'builtin',
        tabId: undefined,
        namespace: 'builtin',
        instanceId: undefined,
        toolName: undefined,
        enabled: false,
      },
    );
  });

  it('does not expose local test actions for bridge control builtins', async () => {
    await import('./side-panel-app');

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      expect(
        element.shadowRoot?.querySelectorAll('button[data-action="test-tool"]').length,
      ).toBeGreaterThan(0);
    });

    const regularBuiltinTestButton = element.shadowRoot?.querySelector<HTMLButtonElement>(
      'button[data-action="test-tool"][data-root="builtin"][data-tool-name="builtin.get_page_info"]',
    );
    const bridgeControlTestButton = element.shadowRoot?.querySelector<HTMLButtonElement>(
      'button[data-action="test-tool"][data-root="builtin"][data-tool-name="extension.get_runtime_status"]',
    );

    expect(regularBuiltinTestButton).not.toBeNull();
    expect(bridgeControlTestButton).toBeNull();
  });
});

function installRuntimeRequestMock(input: {
  builtinTools: PageToolSpec[];
  tabs: Array<{ id: number; title: string; url: string; active: boolean }>;
  pageEntries: Map<number, PageToolEntry[]>;
  initialPreferences?: PageToolPreferences;
}): void {
  let preferences: PageToolPreferences = input.initialPreferences ?? {};

  sendRuntimeRequestMock.mockImplementation(async (method: string, params?: unknown) => {
    switch (method) {
      case BRIDGE_METHODS.extensionStatusGet:
        return { connected: true };
      case BRIDGE_METHODS.extensionPageToolsTreeGet:
        return buildToolTree(input.tabs, input.pageEntries, input.builtinTools, preferences);
      case BRIDGE_METHODS.extensionPageToolsSetEnabled: {
        const payload = params as {
          root?: 'builtin' | 'page';
          tabId?: number;
          namespace?: string;
          instanceId?: string;
          toolName?: string;
          enabled: boolean;
        };
        const scopedEntries =
          payload.root === 'builtin' || payload.tabId == null
            ? undefined
            : (input.pageEntries.get(payload.tabId) ?? []).filter((entry) => {
                if (payload.namespace && entry.namespace !== payload.namespace) {
                  return false;
                }
                if (payload.instanceId && entry.instanceId !== payload.instanceId) {
                  return false;
                }
                return true;
              });

        preferences = setScopeEnabled(preferences, payload, payload.enabled, {
          builtinTools: payload.root === 'builtin' ? input.builtinTools : undefined,
          pageEntries: scopedEntries,
        });
        return buildToolTree(input.tabs, input.pageEntries, input.builtinTools, preferences);
      }
      default:
        return null;
    }
  });
}

function findCheckbox(
  element: Element,
  expected: Partial<Record<'root' | 'scope' | 'namespace' | 'instanceId' | 'toolName', string>>,
): HTMLInputElement | null {
  const checkboxes = [
    ...(element.shadowRoot?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []),
  ];
  return (
    checkboxes.find((checkbox) => {
      return Object.entries(expected).every(
        ([key, value]) => checkbox.dataset[key as keyof DOMStringMap] === value,
      );
    }) ?? null
  );
}

function installChromeMock(): void {
  const chromeMock = {
    runtime: {
      getURL: vi.fn((path?: string) => `chrome-extension://test/${path ?? ''}`),
      onMessage: {
        addListener: vi.fn(),
      },
      onInstalled: {
        addListener: vi.fn(),
      },
      onStartup: {
        addListener: vi.fn(),
      },
    },
    tabs: {
      query: vi.fn(async () => [{ id: 11 }]),
      create: vi.fn(async () => undefined),
      onActivated: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      onUpdated: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      onRemoved: {
        addListener: vi.fn(),
      },
    },
    storage: {
      local: {
        get: vi.fn(async (keyOrDefaults: string | Record<string, unknown>) => {
          if (typeof keyOrDefaults === 'string') {
            return {};
          }
          return keyOrDefaults;
        }),
        remove: vi.fn(async () => undefined),
      },
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
