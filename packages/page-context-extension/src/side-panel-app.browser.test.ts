import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BRIDGE_METHODS,
  CONNECTION_METHODS,
  type ContextResourcePayload,
  type ContextSkillPrompt,
  type PageContextManifest,
} from '@page-context/shared-protocol';
import type { ContextManifestFilterDebug } from './context-manifest-filter-debug';

// Import directly from real package, not through re-export shim
import type { PageToolEntry, PageToolSpec } from '@page-context/tool-visibility';
import {
  buildToolTree,
  setScopeEnabled,
  type PageToolPreferences,
} from '@page-context/tool-visibility';

const sendRuntimeRequestMock = vi.fn();
const createOpenCodeSessionMock = vi.fn();
const deleteOpenCodeSessionMock = vi.fn();
const ensureMcpRegisteredMock = vi.fn();
const listOpenCodeSessionsMock = vi.fn();
const opencodeProjectDirectory = '/home/user/project';
const opencodeProjectSegment = encodeOpenCodeRouteSegment(opencodeProjectDirectory);

function encodeOpenCodeRouteSegment(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeDefaultConnectionDescriptor() {
  return {
    id: 'bridge-default-ws',
    kind: 'bridge-default-ws' as const,
    label: 'Bridge Default WS',
    endpoint: 'ws://127.0.0.1:22335/default',
    status: 'connected' as const,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeScopedConnectionDescriptor(sessionId: string, wsUrl: string) {
  return {
    id: `opencode-bridge-ws:${sessionId}`,
    kind: 'opencode-bridge-ws' as const,
    label: `OpenCode Bridge WS · ${sessionId}`,
    endpoint: wsUrl,
    status: 'connected' as const,
    updatedAt: '2026-01-01T00:00:00.000Z',
    meta: {
      tenantId: sessionId,
      bridgeSessionId: `bridge-${sessionId}`,
    },
  };
}

vi.mock('./runtime-rpc', () => ({
  sendRuntimeRequest: sendRuntimeRequestMock,
}));

vi.mock('./sidepanel-opencode', async () => {
  const actual =
    await vi.importActual<typeof import('./sidepanel-opencode')>('./sidepanel-opencode');
  return {
    ...actual,
    createSession: createOpenCodeSessionMock,
    deleteSession: deleteOpenCodeSessionMock,
    ensureMcpRegistered: ensureMcpRegisteredMock,
    listSessions: listOpenCodeSessionsMock,
  };
});

describe('side-panel-app tools tree interactions', () => {
  const originalChrome = globalThis.chrome;
  const builtinTools: PageToolSpec[] = [
    { name: 'builtin.page.get_page_info', description: 'Get page info' },
    { name: 'builtin.page.navigate', description: 'Navigate tab' },
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
  const contextManifest: PageContextManifest = {
    version: '0.1.0',
    app: 'example',
    route: '/fixtures/catalog',
    scene: 'example-fixture',
    generatedAt: '2026-01-01T00:00:00.000Z',
    namespaces: [
      {
        namespace: 'catalog',
        title: 'Catalog',
        description: 'Catalog manipulation and seed fixtures',
        tags: ['mutation', 'items'],
      },
      {
        namespace: 'qa',
        title: 'QA',
        description: 'Smoke suite and fixture reset workflows',
        tags: ['macro', 'qa'],
      },
    ],
    resources: [
      {
        id: 'catalog.items',
        namespace: 'catalog',
        title: 'Catalog Items',
        description: 'Current item list and counts for the catalog fixture',
        mimeType: 'application/json',
        kind: 'json',
        tags: ['items'],
      },
    ],
    skills: [
      {
        id: 'catalog.manage-items',
        namespace: 'catalog',
        title: 'Manage Catalog Items',
        description:
          'Inspect, add, remove, or seed catalog fixture items using instance-specific tools.',
        intentTags: ['catalog', 'items', 'mutation'],
        resourceIds: ['catalog.items'],
        toolNames: [
          'catalog.primary.getItems',
          'catalog.primary.addItem',
          'catalog.primary.removeItem',
        ],
        mode: 'mutation',
      },
    ],
  };
  const rawContextManifest: PageContextManifest = {
    ...contextManifest,
    namespaces: [
      ...contextManifest.namespaces,
      {
        namespace: 'metrics',
        title: 'Metrics',
        description: 'Read-only dashboard and recent logs',
        tags: ['readonly', 'logs'],
      },
    ],
    resources: [
      ...contextManifest.resources,
      {
        id: 'metrics.logs',
        namespace: 'metrics',
        title: 'Recent Logs',
        description: 'Most recent action logs emitted by the page',
        mimeType: 'application/json',
        kind: 'json',
        tags: ['logs'],
      },
    ],
    skills: [
      ...contextManifest.skills,
      {
        id: 'qa.run-smoke-suite',
        namespace: 'qa',
        title: 'Run Smoke Suite',
        description: 'Execute the example smoke suite and interpret its results.',
        intentTags: ['qa', 'smoke', 'verify'],
        resourceIds: ['metrics.logs'],
        toolNames: ['qa.smoke.runSuite', 'get_console_logs'],
        mode: 'macro',
      },
    ],
  };
  const contextDebug: ContextManifestFilterDebug = {
    hiddenNamespaces: [{ id: 'metrics', reason: 'namespace_disabled' }],
    hiddenResources: [{ id: 'metrics.logs', reason: 'namespace_disabled' }],
    hiddenSkills: [{ id: 'qa.run-smoke-suite', reason: 'page_tool_disabled' }],
    trimmedSkillTools: [
      {
        skillId: 'catalog.manage-items',
        removedTools: [{ id: 'catalog.primary.removeItem', reason: 'page_tool_disabled' }],
      },
    ],
  };
  const contextResourcePayloads = new Map<string, ContextResourcePayload>([
    [
      'catalog.items',
      {
        id: 'catalog.items',
        mimeType: 'application/json',
        text: JSON.stringify(
          { items: [{ id: 'A-1', name: 'Fixture Item' }], itemCount: 1 },
          null,
          2,
        ),
      },
    ],
  ]);
  const contextSkillPrompts = new Map<string, ContextSkillPrompt>([
    [
      'catalog.manage-items',
      {
        skill: contextManifest.skills[0]!,
        text: 'Use catalog resources before mutating the fixture.',
      },
    ],
  ]);

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/');
    installChromeMock();
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(
      1 as unknown as ReturnType<typeof setInterval>,
    );
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    installRuntimeRequestMock({
      builtinTools,
      tabs,
      pageEntries,
      contextManifest,
      rawContextManifest,
      contextDebug,
      contextResourcePayloads,
      contextSkillPrompts,
    });
    createOpenCodeSessionMock.mockImplementation(async (cfg?: { opencodeBaseUrl?: string }) => ({
      id: 'session-created',
      directory: opencodeProjectDirectory,
      opencodeBaseUrl: cfg?.opencodeBaseUrl,
    }));
    deleteOpenCodeSessionMock.mockResolvedValue(undefined);
    ensureMcpRegisteredMock.mockResolvedValue({
      created: true,
      mcpName: 'page-context-session-created',
    });
    listOpenCodeSessionsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/');
    restoreChromeGlobal(originalChrome);
  });

  test('renders bridge control tools inside unified builtin tree', async () => {
    await import('./side-panel-app');

    const element = document.createElement('side-panel-app');
    element.setAttribute('data-build-time', '2026-04-28T10:11:12.000Z');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      const text = element.shadowRoot?.textContent ?? '';
      expect(text).toContain('extension.get_runtime_status');
      expect(text).toContain('feedback.get_snapshot');
      expect(text).toContain('Built-in Tools');
      expect(
        element.shadowRoot?.querySelector('[data-testid="build-time-label"]')?.textContent ?? '',
      ).toContain('Build time:');
    });

    // Built-in structure should be rendered as a namespace/instance tree, not a flat list.
    expect(findCheckbox(element, { scope: 'builtin', namespace: 'page' })).not.toBeNull();
    expect(
      findCheckbox(element, { scope: 'builtin', namespace: 'page', instanceId: 'default' }),
    ).not.toBeNull();
    expect(findCheckbox(element, { scope: 'builtin', namespace: 'extension' })?.disabled).toBe(
      true,
    );
  });

  test('renders a build time label in the side panel header', async () => {
    await import('./side-panel-app');

    const element = document.createElement('side-panel-app');
    element.setAttribute('data-build-time', '2026-04-28T10:11:12.000Z');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      expect(
        element.shadowRoot?.querySelector('[data-testid="build-time-label"]')?.textContent ?? '',
      ).toContain('Build time: 2026-04-28T10:11:12Z');
    });
  });

  test('unchecks all descendant tool checkboxes when a namespace is disabled', async () => {
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

  test('re-checks all descendant tool checkboxes when a namespace is re-enabled', async () => {
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

  test('unchecks all namespace and tool checkboxes when a tab is disabled', async () => {
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

  test('unchecks all tool checkboxes when an instance is disabled', async () => {
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

  test('unchecks all builtin tool checkboxes when builtins are disabled', async () => {
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
        findCheckbox(element, { scope: 'builtin', toolName: 'builtin.page.get_page_info' })
          ?.checked,
      ).toBe(false);
      expect(
        findCheckbox(element, { scope: 'builtin', toolName: 'builtin.page.navigate' })?.checked,
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

  test('routes builtin namespace toggle through builtin root semantics', async () => {
    await import('./side-panel-app');

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      expect(
        findCheckbox(element, { root: 'builtin', scope: 'builtin', namespace: 'page' }),
      ).not.toBeNull();
    });

    const builtinNamespaceCheckbox = findCheckbox(element, {
      root: 'builtin',
      scope: 'builtin',
      namespace: 'page',
    });
    expect(builtinNamespaceCheckbox).not.toBeNull();
    builtinNamespaceCheckbox!.checked = false;
    builtinNamespaceCheckbox!.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    await vi.waitFor(() => {
      expect(
        findCheckbox(element, {
          root: 'builtin',
          scope: 'builtin',
          toolName: 'builtin.page.get_page_info',
        })?.checked,
      ).toBe(false);
      expect(
        findCheckbox(element, {
          root: 'builtin',
          scope: 'builtin',
          toolName: 'builtin.page.navigate',
        })?.checked,
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
        namespace: 'page',
        instanceId: undefined,
        toolName: undefined,
        enabled: false,
      },
    );
  });

  test('does not expose local test actions for bridge control builtins', async () => {
    await import('./side-panel-app');

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      expect(
        element.shadowRoot?.querySelectorAll('button[data-action="test-tool"]').length,
      ).toBeGreaterThan(0);
    });

    const regularBuiltinTestButton = element.shadowRoot?.querySelector<HTMLButtonElement>(
      'button[data-action="test-tool"][data-root="builtin"][data-tool-name="builtin.page.get_page_info"]',
    );
    const bridgeControlTestButton = element.shadowRoot?.querySelector<HTMLButtonElement>(
      'button[data-action="test-tool"][data-root="builtin"][data-tool-name="extension.get_runtime_status"]',
    );

    expect(regularBuiltinTestButton).not.toBeNull();
    expect(bridgeControlTestButton).toBeNull();
  });

  test('renders the redesigned context tab and loads resource and skill previews', async () => {
    await import('./side-panel-app');

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      expect(
        element.shadowRoot?.querySelector('button[role="tab"][title="Context"]'),
      ).not.toBeNull();
    });

    const contextTabButton = element.shadowRoot?.querySelector<HTMLButtonElement>(
      'button[role="tab"][title="Context"]',
    );
    contextTabButton!.click();

    await vi.waitFor(() => {
      const text = element.shadowRoot?.textContent ?? '';
      expect(text).toContain('Page Capabilities');
      expect(text).toContain('Agent Briefing');
      expect(text).toContain('Business Domains');
      expect(text).toContain(
        'Bridge sees 1 data resource and 1 runnable skill across 2 namespaces.',
      );
      expect(text).toContain('Catalog');
      expect(text).toContain('Catalog Items');
      expect(text).toContain('Manage Catalog Items');
      expect(text).toContain('Capability Filters');
      expect(text).toContain('catalog.primary.removeItem');
    });

    const resourceButton = element.shadowRoot?.querySelector<HTMLButtonElement>(
      'button[data-action="read-resource"][data-resource-id="catalog.items"]',
    );
    expect(resourceButton).not.toBeNull();
    resourceButton!.click();

    await vi.waitFor(() => {
      expect(element.shadowRoot?.textContent ?? '').toContain('Fixture Item');
    });

    const skillButton = element.shadowRoot?.querySelector<HTMLButtonElement>(
      'button[data-action="preview-skill"][data-skill-id="catalog.manage-items"]',
    );
    expect(skillButton).not.toBeNull();
    skillButton!.click();

    await vi.waitFor(() => {
      const text = element.shadowRoot?.textContent ?? '';
      expect(text).toContain('Use catalog resources before mutating the fixture.');
    });

    expect(sendRuntimeRequestMock).toHaveBeenCalledWith(
      BRIDGE_METHODS.extensionContextManifestGet,
      {
        tabId: 11,
      },
    );
    expect(sendRuntimeRequestMock).toHaveBeenCalledWith(
      BRIDGE_METHODS.extensionContextResourceRead,
      { tabId: 11, resourceId: 'catalog.items' },
    );
    expect(sendRuntimeRequestMock).toHaveBeenCalledWith(BRIDGE_METHODS.extensionContextSkillGet, {
      tabId: 11,
      skillId: 'catalog.manage-items',
      input: { goal: 'Explain how the agent should use this business skill safely.' },
    });
  });

  test('prefers boundTabId from URL for context and feedback flows', async () => {
    await import('./side-panel-app');

    window.history.replaceState({}, '', '/sidepanel.html?boundTabId=22&windowId=9');
    const tabsQueryMock = chrome.tabs.query as unknown as ReturnType<typeof vi.fn>;
    tabsQueryMock.mockResolvedValue([{ id: 11 }]);

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      expect(sendRuntimeRequestMock).toHaveBeenCalledWith(CONNECTION_METHODS.subscribe);
      expect(sendRuntimeRequestMock).toHaveBeenCalledWith(BRIDGE_METHODS.extensionPageToolsTreeGet);
    });

    expect(tabsQueryMock).not.toHaveBeenCalled();

    const contextTabButton = element.shadowRoot?.querySelector<HTMLButtonElement>(
      'button[role="tab"][title="Context"]',
    );
    contextTabButton!.click();

    await vi.waitFor(() => {
      expect(sendRuntimeRequestMock).toHaveBeenCalledWith(
        BRIDGE_METHODS.extensionContextManifestGet,
        {
          tabId: 22,
        },
      );
    });

    const feedbackTabButton = element.shadowRoot?.querySelector<HTMLButtonElement>(
      'button[role="tab"][title="Feedback"]',
    );
    feedbackTabButton!.click();

    await vi.waitFor(() => {
      expect(sendRuntimeRequestMock).toHaveBeenCalledWith(
        BRIDGE_METHODS.extensionFeedbackStateSnapshot,
        {
          tabId: 22,
          windowId: 9,
        },
      );
    });

    const feedbackBody = element.shadowRoot?.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="Describe the problem, expected behavior, reproduction steps"]',
    );
    expect(feedbackBody).not.toBeNull();
    feedbackBody!.value = 'Bound tab feedback';
    feedbackBody!.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

    const submitButton = [
      ...(element.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? []),
    ].find((button) => button.textContent?.trim() === 'Submit');
    expect(submitButton).not.toBeNull();
    submitButton!.click();

    await vi.waitFor(() => {
      expect(sendRuntimeRequestMock).toHaveBeenCalledWith(
        BRIDGE_METHODS.extensionFeedbackAnnotationCreate,
        {
          body: 'Bound tab feedback',
          priority: 'normal',
          tabId: 22,
          windowId: 9,
        },
      );
    });

    expect(tabsQueryMock).not.toHaveBeenCalled();
  });

  test('consumes launch URL from devtools surface-specific storage key', async () => {
    await import('./side-panel-app');

    window.history.replaceState({}, '', '/sidepanel.html?surface=devtools');
    const storageGetMock = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;
    const storageRemoveMock = chrome.storage.local.remove as unknown as ReturnType<typeof vi.fn>;
    storageGetMock.mockImplementation(
      async (keyOrDefaults: string | string[] | Record<string, unknown>) => {
        if (Array.isArray(keyOrDefaults)) {
          return {
            'sidePanelUrl:devtools': 'http://127.0.0.1:22336/',
          };
        }
        if (typeof keyOrDefaults === 'string') {
          return {};
        }
        return keyOrDefaults;
      },
    );

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      expect(
        storageGetMock.mock.calls.some(
          ([arg]) =>
            Array.isArray(arg) && arg[0] === 'sidePanelUrl:devtools' && arg[1] === 'sidePanelUrl',
        ),
      ).toBe(true);
    });
    expect(element.shadowRoot?.querySelector('iframe')).toBeNull();
    expect(element.shadowRoot?.querySelector('[title="Diagnosis"]')).toBeNull();
    expect(storageRemoveMock.mock.calls[0]?.[0]).toBe('sidePanelUrl:devtools');
  });

  test('renders product journey shortcuts from real user workflows', async () => {
    await import('./side-panel-app');

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      const text = element.shadowRoot?.textContent ?? '';
      expect(text).toContain('Product paths');
      expect(text).toContain('Use the real connection chain');
      expect(text).toContain('Check endpoint config');
      expect(text).toContain('Manage OpenCode');
      expect(text).toContain('Inspect tools');
      expect(text).toContain('Review feedback');
      expect(text).not.toContain('Delete session on disconnect');
    });

    findButtonByText(element, 'Endpoint config')?.click();
    await vi.waitFor(() => {
      expect(element.shadowRoot?.textContent ?? '').toContain('Connection Cockpit');
    });
  });

  test('re-discovers page tools when current tab is missing from initial tree', async () => {
    const latePageEntries = new Map<number, PageToolEntry[]>();
    installRuntimeRequestMock({
      builtinTools,
      tabs,
      pageEntries: latePageEntries,
    });
    await import('./side-panel-app');

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);

    await vi.waitFor(() => {
      expect(sendRuntimeRequestMock).toHaveBeenCalledWith(
        BRIDGE_METHODS.extensionPageToolsDiscover,
        {
          tabId: 11,
        },
      );
    });

    expect(sendRuntimeRequestMock).toHaveBeenCalledWith(BRIDGE_METHODS.extensionPageToolsTreeGet);
    await vi.waitFor(() => {
      const text = element.shadowRoot?.textContent ?? '';
      expect(text).toContain('late.inspect');
    });
  });

  test('connects opencode session by wiring scoped ws before MCP registration', async () => {
    const storageGetMock = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;
    storageGetMock.mockImplementation(async (keyOrDefaults: string | Record<string, unknown>) => {
      if (keyOrDefaults === 'page-context.bridge-install-id.v1') {
        return { 'page-context.bridge-install-id.v1': 'install-test' };
      }
      if (typeof keyOrDefaults === 'string') {
        return {};
      }
      return keyOrDefaults;
    });
    await import('./side-panel-app');

    const sessionAlphaDirectory = `${opencodeProjectDirectory}/session-alpha`;
    createOpenCodeSessionMock.mockResolvedValueOnce({
      id: 'session-alpha',
      directory: sessionAlphaDirectory,
      opencodeBaseUrl: 'http://127.0.0.1:4101',
    });
    sendRuntimeRequestMock.mockImplementation(async (method: string, params?: unknown) => {
      switch (method) {
        case CONNECTION_METHODS.subscribe:
        case CONNECTION_METHODS.list:
          return {
            descriptors: [
              {
                ...makeDefaultConnectionDescriptor(),
                endpoint: 'ws://10.37.9.81:22335/wangwenxiao.gitai-firefox',
              },
              makeScopedConnectionDescriptor(
                'install-test',
                'ws://10.37.9.81:22335/wangwenxiao.gitai-firefox?tenantId=install-test',
              ),
            ],
          };
        case BRIDGE_METHODS.extensionReconnect:
          return { ok: true };
        case BRIDGE_METHODS.extensionPageToolsTreeGet:
          return buildToolTree(tabs, pageEntries, builtinTools, {});
        default:
          return null;
      }
    });

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);
    await openOpencodeTab(element);

    await vi.waitFor(() => {
      const text = getOpenCodeTabText(element);
      expect(text).toContain('OpenCode panel no longer provides configuration editing');
      expect(text).not.toContain('OpenCode Base URL');
      expect(text).not.toContain('Bridge Base URL');
      expect(text).not.toContain('Delete session on disconnect');
    });

    findButtonByText(element, 'Connect')?.click();

    await vi.waitFor(() => {
      expect(ensureMcpRegisteredMock).toHaveBeenCalledWith(
        {
          opencodeBaseUrl: 'http://127.0.0.1:4101',
          bridgeBaseUrl: 'http://localhost:22334',
        },
        'session-alpha',
      );
    });
    expect(createOpenCodeSessionMock).toHaveBeenCalledWith({
      opencodeBaseUrl: 'http://localhost:4096',
      bridgeBaseUrl: 'http://localhost:22334',
    });

    const reconnectCall = sendRuntimeRequestMock.mock.calls.find(
      ([method]) => method === BRIDGE_METHODS.extensionReconnect,
    );
    expect(reconnectCall).toEqual([
      BRIDGE_METHODS.extensionReconnect,
      {
        sessionId: 'install-test',
        wsUrl: 'ws://10.37.9.81:22335/wangwenxiao.gitai-firefox?tenantId=install-test',
      },
    ]);
    expect(sendRuntimeRequestMock.mock.invocationCallOrder[1]).toBeLessThan(
      ensureMcpRegisteredMock.mock.invocationCallOrder[0]!,
    );

    await vi.waitFor(() => {
      const text = element.shadowRoot?.textContent ?? '';
      expect(text).toContain('OpenCode sidebar iframe');
    });
    const iframe = element.shadowRoot?.querySelector<HTMLIFrameElement>(
      'iframe[data-session-id="session-alpha"]',
    );
    expect(iframe).not.toBeNull();
    expect(iframe?.src).toBe(
      `http://127.0.0.1:4101/${encodeOpenCodeRouteSegment(sessionAlphaDirectory)}/session/session-alpha`,
    );

    closeOpenCodeIframe(element);
    await vi.waitFor(() => {
      expect(
        element.shadowRoot?.querySelector('iframe[data-session-id="session-alpha"]'),
      ).toBeNull();
      expect(element.shadowRoot?.textContent ?? '').toContain('Open in sidebar');
    });
  });

  test('creates a second opencode session while reusing the install bridge channel', async () => {
    const storageGetMock = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;
    storageGetMock.mockImplementation(async (keyOrDefaults: string | Record<string, unknown>) => {
      if (keyOrDefaults === 'page-context.bridge-install-id.v1') {
        return { 'page-context.bridge-install-id.v1': 'install-test' };
      }
      if (typeof keyOrDefaults === 'string') {
        return {};
      }
      return keyOrDefaults;
    });
    await import('./side-panel-app');

    const sessionAlphaDirectory = `${opencodeProjectDirectory}/session-alpha`;
    const sessionBetaDirectory = `${opencodeProjectDirectory}/session-beta`;
    createOpenCodeSessionMock
      .mockResolvedValueOnce({
        id: 'session-alpha',
        directory: sessionAlphaDirectory,
        opencodeBaseUrl: 'http://127.0.0.1:4101',
      })
      .mockResolvedValueOnce({
        id: 'session-beta',
        directory: sessionBetaDirectory,
        opencodeBaseUrl: 'http://127.0.0.1:4102',
      });
    ensureMcpRegisteredMock.mockResolvedValue({
      created: true,
      mcpName: 'page-context-session',
    });

    const connectedSessions = new Map<string, string>();
    sendRuntimeRequestMock.mockImplementation(async (method: string, params?: unknown) => {
      switch (method) {
        case BRIDGE_METHODS.extensionReconnect: {
          const payload = params as { sessionId?: string; wsUrl?: string; disconnect?: boolean };
          if (payload.sessionId && payload.wsUrl && !payload.disconnect) {
            connectedSessions.set(payload.sessionId, payload.wsUrl);
          }
          if (payload.sessionId && payload.disconnect) {
            connectedSessions.delete(payload.sessionId);
          }
          return { ok: true };
        }
        case CONNECTION_METHODS.subscribe:
        case CONNECTION_METHODS.list:
          return {
            descriptors: [
              makeDefaultConnectionDescriptor(),
              ...Array.from(connectedSessions.entries()).map(([tenantId, wsUrl]) =>
                makeScopedConnectionDescriptor(tenantId, wsUrl),
              ),
            ],
          };
        case BRIDGE_METHODS.extensionPageToolsTreeGet:
          return buildToolTree(tabs, pageEntries, builtinTools, {});
        default:
          return null;
      }
    });

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);
    await openOpencodeTab(element);

    findButtonByText(element, 'Connect')?.click();
    await vi.waitFor(() => {
      expect(element.shadowRoot?.textContent ?? '').toContain('session-alpha');
    });
    closeOpenCodeIframe(element);
    await vi.waitFor(() => {
      expect(findButtonByText(element, 'New Session')).not.toBeNull();
    });

    findButtonByText(element, 'New Session')?.click();

    await vi.waitFor(() => {
      expect(element.shadowRoot?.textContent ?? '').toContain('session-beta');
    });
    closeOpenCodeIframe(element);
    await vi.waitFor(() => {
      expect(findButtonByText(element, 'New Session')).not.toBeNull();
    });

    expect(
      sendRuntimeRequestMock.mock.calls.filter(
        ([method, params]) =>
          method === BRIDGE_METHODS.extensionReconnect &&
          Boolean((params as { disconnect?: boolean } | undefined)?.disconnect) === false,
      ),
    ).toHaveLength(2);
    expect(connectedSessions.size).toBe(1);
    expect(connectedSessions.get('install-test')).toBe(
      'ws://127.0.0.1:22335/default?tenantId=install-test',
    );
    expect(createOpenCodeSessionMock).toHaveBeenNthCalledWith(1, {
      opencodeBaseUrl: 'http://localhost:4096',
      bridgeBaseUrl: 'http://localhost:22334',
    });
    expect(createOpenCodeSessionMock).toHaveBeenNthCalledWith(2, {
      opencodeBaseUrl: 'http://localhost:4096',
      bridgeBaseUrl: 'http://localhost:22334',
    });

    const sessionButtons = [
      ...(element.shadowRoot?.querySelectorAll('button[title^="ws://"]') ?? []),
    ].map((button) => button.textContent?.trim());
    expect(sessionButtons).toContain('session-alpha');
    expect(sessionButtons).toContain('session-beta');

    expect(findButtonByText(element, 'Copy')).not.toBeNull();
    expect(findButtonByText(element, 'Open')).not.toBeNull();
    expect(findButtonByText(element, 'Delete')).not.toBeNull();
    expect(element.shadowRoot?.querySelector('iframe[data-session-id="session-beta"]')).toBeNull();
    const openInSidebarButtons = [
      ...(element.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? []),
    ].filter((button) => button.textContent?.trim() === 'Open in sidebar');
    openInSidebarButtons.at(-1)?.click();
    await vi.waitFor(() => {
      expect(
        element.shadowRoot?.querySelector('iframe[data-session-id="session-beta"]'),
      ).not.toBeNull();
    });
  });

  test('restores last live session without re-registering MCP', async () => {
    const storageGetMock = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;
    storageGetMock.mockImplementation(async (keyOrDefaults: string | Record<string, unknown>) => {
      if (keyOrDefaults === 'page-context.bridge-install-id.v1') {
        return { 'page-context.bridge-install-id.v1': 'install-restored' };
      }
      if (typeof keyOrDefaults === 'string') {
        return {
          'opencode.config.v1': {
            lastSessionId: 'session-restored',
            sessions: [
              {
                sessionId: 'session-restored',
                directory: opencodeProjectDirectory,
                opencodeBaseUrl: 'http://127.0.0.1:4109',
              },
            ],
          },
        };
      }
      if (
        keyOrDefaults &&
        typeof keyOrDefaults === 'object' &&
        'connections.endpoints.v1' in keyOrDefaults
      ) {
        return {
          ...keyOrDefaults,
          'connections.endpoints.v1': {
            opencodeBaseUrl: 'http://localhost:4096',
            bridgeBaseUrl: 'http://localhost:22334',
          },
        };
      }
      return keyOrDefaults;
    });
    listOpenCodeSessionsMock.mockResolvedValueOnce([
      {
        id: 'session-restored',
        directory: opencodeProjectDirectory,
        opencodeBaseUrl: 'http://127.0.0.1:4109',
      },
    ]);

    await import('./side-panel-app');

    sendRuntimeRequestMock.mockImplementation(async (method: string, params?: unknown) => {
      switch (method) {
        case CONNECTION_METHODS.subscribe:
        case CONNECTION_METHODS.list:
          return {
            descriptors: [
              makeDefaultConnectionDescriptor(),
              {
                ...makeScopedConnectionDescriptor(
                  'install-restored',
                  'ws://localhost:22335/?tenantId=install-restored',
                ),
                meta: {
                  tenantId: 'install-restored',
                  bridgeSessionId: 'bridge-restored',
                },
              },
            ],
          };
        case BRIDGE_METHODS.extensionPageToolsTreeGet:
          return buildToolTree(tabs, pageEntries, builtinTools, {});
        default:
          return null;
      }
    });

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);
    await openOpencodeTab(element);

    await vi.waitFor(() => {
      const text = element.shadowRoot?.textContent ?? '';
      expect(text).toContain('session-restored');
      expect(text).toContain(`${opencodeProjectSegment}/session/session-restored`);
    });
    expect(listOpenCodeSessionsMock).toHaveBeenCalledWith({
      opencodeBaseUrl: 'http://127.0.0.1:4109',
      bridgeBaseUrl: 'http://localhost:22334',
    });
    expect(
      element.shadowRoot?.querySelector('iframe[data-session-id="session-restored"]'),
    ).toBeNull();
    findButtonByText(element, 'Open in sidebar')?.click();
    await vi.waitFor(() => {
      expect(
        element.shadowRoot?.querySelector('iframe[data-session-id="session-restored"]'),
      ).not.toBeNull();
    });

    expect(ensureMcpRegisteredMock).not.toHaveBeenCalled();
    expect(
      sendRuntimeRequestMock.mock.calls.some(
        ([method]) => method === BRIDGE_METHODS.extensionReconnect,
      ),
    ).toBe(false);
  });

  test('clears stale last session when opencode no longer has it', async () => {
    const storageGetMock = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;
    const storageRemoveMock = chrome.storage.local.remove as unknown as ReturnType<typeof vi.fn>;
    storageGetMock.mockImplementation(async (keyOrDefaults: string | Record<string, unknown>) => {
      if (keyOrDefaults === 'page-context.bridge-install-id.v1') {
        return { 'page-context.bridge-install-id.v1': 'install-dead' };
      }
      if (typeof keyOrDefaults === 'string') {
        return {
          'opencode.config.v1': {
            lastSessionId: 'session-dead',
          },
        };
      }
      if (
        keyOrDefaults &&
        typeof keyOrDefaults === 'object' &&
        'connections.endpoints.v1' in keyOrDefaults
      ) {
        return {
          ...keyOrDefaults,
          'connections.endpoints.v1': {
            opencodeBaseUrl: 'http://localhost:4096',
            bridgeBaseUrl: 'http://localhost:22334',
          },
        };
      }
      return keyOrDefaults;
    });
    listOpenCodeSessionsMock.mockResolvedValueOnce([]);

    sendRuntimeRequestMock.mockImplementation(async (method: string) => {
      switch (method) {
        case CONNECTION_METHODS.subscribe:
        case CONNECTION_METHODS.list:
          return {
            descriptors: [
              makeDefaultConnectionDescriptor(),
              {
                ...makeScopedConnectionDescriptor(
                  'install-dead',
                  'ws://localhost:22335/?tenantId=install-dead',
                ),
                meta: {
                  tenantId: 'install-dead',
                  bridgeSessionId: 'bridge-dead',
                },
              },
            ],
          };
        case BRIDGE_METHODS.extensionReconnect:
          return { ok: true };
        case BRIDGE_METHODS.extensionPageToolsTreeGet:
          return buildToolTree(tabs, pageEntries, builtinTools, {});
        default:
          return null;
      }
    });

    await import('./side-panel-app');

    const element = document.createElement('side-panel-app');
    document.body.appendChild(element);
    await openOpencodeTab(element);

    await vi.waitFor(() => {
      const text = element.shadowRoot?.textContent ?? '';
      expect(text).toContain('Cleared saved state');
    });

    expect(storageRemoveMock.mock.calls[0]?.[0]).toBe('opencode.config.v1');
    expect(sendRuntimeRequestMock).toHaveBeenCalledWith(BRIDGE_METHODS.extensionReconnect, {
      sessionId: 'install-dead',
      disconnect: true,
    });
    expect(element.shadowRoot?.querySelector('iframe[data-session-id]')).toBeNull();
  });
});

async function openOpencodeTab(element: Element): Promise<void> {
  await vi.waitFor(() => {
    expect(element.shadowRoot?.querySelector('[title="OpenCode"]')).not.toBeNull();
  });
  (element.shadowRoot?.querySelector('[title="OpenCode"]') as HTMLButtonElement | null)?.click();
  await vi.waitFor(() => {
    expect(element.shadowRoot?.textContent ?? '').toContain('Session ID (optional)');
  });
}

function findButtonByText(element: Element, text: string): HTMLButtonElement | null {
  return (
    [...(element.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

function closeOpenCodeIframe(element: Element): void {
  const closeButton = element.shadowRoot?.querySelector<HTMLButtonElement>(
    'button[aria-label="Close OpenCode iframe"]',
  );
  if (!closeButton) {
    throw new Error('Missing OpenCode iframe close button');
  }
  closeButton.click();
}

function getOpenCodeTabText(element: Element): string {
  const activeTabContents = [
    ...(element.shadowRoot?.querySelectorAll<HTMLElement>('.tab-content.active') ?? []),
  ];
  return (
    activeTabContents.find((content) => content.textContent?.includes('Session ID (optional)'))
      ?.textContent ?? ''
  );
}

function installRuntimeRequestMock(input: {
  builtinTools: PageToolSpec[];
  tabs: Array<{ id: number; title: string; url: string; active: boolean }>;
  pageEntries: Map<number, PageToolEntry[]>;
  initialPreferences?: PageToolPreferences;
  contextManifest?: PageContextManifest | null;
  rawContextManifest?: PageContextManifest | null;
  contextDebug?: ContextManifestFilterDebug | null;
  contextResourcePayloads?: Map<string, ContextResourcePayload>;
  contextSkillPrompts?: Map<string, ContextSkillPrompt>;
}): void {
  let preferences: PageToolPreferences = input.initialPreferences ?? {};

  sendRuntimeRequestMock.mockImplementation(async (method: string, params?: unknown) => {
    switch (method) {
      case CONNECTION_METHODS.subscribe:
      case CONNECTION_METHODS.list:
        return {
          descriptors: [
            {
              id: 'bridge-default-ws',
              kind: 'bridge-default-ws',
              label: 'Bridge Default WS',
              endpoint: 'ws://127.0.0.1:22335/default',
              status: 'connected',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        };
      case BRIDGE_METHODS.extensionPageToolsTreeGet:
        return buildToolTree(input.tabs, input.pageEntries, input.builtinTools, preferences);
      case BRIDGE_METHODS.extensionPageToolsDiscover: {
        const payload = params as { tabId?: number } | undefined;
        if (payload?.tabId != null && !input.pageEntries.has(payload.tabId)) {
          input.pageEntries.set(payload.tabId, [
            {
              namespace: 'late',
              instanceId: 'default',
              tools: [{ name: 'late.inspect', description: 'Late discovered tool' }],
            },
          ]);
        }
        return {
          tools:
            payload?.tabId != null
              ? (input.pageEntries.get(payload.tabId) ?? []).flatMap((entry) => entry.tools)
              : [],
        };
      }
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
      case BRIDGE_METHODS.extensionContextManifestGet:
        return {
          manifest: input.contextManifest ?? null,
          rawManifest: input.rawContextManifest ?? input.contextManifest ?? null,
          debug: input.contextDebug ?? null,
        };
      case BRIDGE_METHODS.extensionContextResourceRead: {
        const payload = params as { resourceId: string };
        return (
          input.contextResourcePayloads?.get(payload.resourceId) ?? {
            id: payload.resourceId,
            text: JSON.stringify({ error: 'missing test payload' }, null, 2),
          }
        );
      }
      case BRIDGE_METHODS.extensionContextSkillGet: {
        const payload = params as { skillId: string };
        return {
          prompt: input.contextSkillPrompts?.get(payload.skillId),
        };
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
        set: vi.fn(async () => undefined),
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
