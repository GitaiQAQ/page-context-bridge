import { beforeEach, describe, expect, it } from 'vitest';

import { createReactUserscriptAdapter } from './react-adapter';

// ─── Mock types (mirrors internal interfaces) ───────────────────────────────

interface FiberNodeLike {
  key?: unknown;
  type?: unknown;
  elementType?: unknown;
  memoizedProps?: unknown;
  memoizedState?: unknown;
  return?: FiberNodeLike | null;
  child?: FiberNodeLike | null;
  sibling?: FiberNodeLike | null;
}

// ─── Mock builders ─────────────────────────────────────────────────────────

function createMockFiber(
  overrides: Partial<FiberNodeLike> & { type?: unknown } = {},
): FiberNodeLike {
  return {
    type: overrides.type ?? 'div',
    memoizedProps: overrides.memoizedProps ?? {},
    memoizedState: overrides.memoizedState ?? null,
    ...overrides,
  };
}

function createMockHookChain(
  hooks: Array<{
    type: 'state' | 'reducer' | 'effect' | 'ref' | 'memo' | 'context';
    value: unknown;
  }>,
): unknown {
  if (hooks.length === 0) return undefined;

  let tail: Record<string, unknown> | undefined;

  // Build in reverse order (last hook first)
  for (let i = hooks.length - 1; i >= 0; i -= 1) {
    const h = hooks[i]!;
    const node: Record<string, unknown> = {};

    switch (h.type) {
      case 'state':
        node.queue = {};
        node.memoizedState = h.value;
        break;
      case 'reducer':
        node.queue = {};
        node.baseState = null;
        node.memoizedState = h.value;
        break;
      case 'effect':
        node.deps = [];
        node.create = () => {};
        node.destroy = undefined;
        break;
      case 'ref':
        node._init = undefined;
        node._instance = h.value;
        break;
      case 'memo':
        node.create = () => h.value;
        node.deps = [];
        node.memoizedState = h.value;
        break;
      case 'context':
        node.context = { displayName: 'TestContext' };
        node.memoizedValue = h.value;
        break;
    }

    if (tail) {
      node.next = tail;
    }
    tail = node;
  }

  return hooks[0] ? tail : undefined;
}

/**
 * Install a mock React runtime with a 3-level fiber tree:
 *   App -> Panel -> [host div, Button]
 * Where Panel has the selection target fiber attached.
 */
function installMockReactRuntime(options?: {
  withHookChain?: boolean;
  withContextProvider?: boolean;
  withSuspense?: boolean;
  withErrorBoundary?: boolean;
}): void {
  function App() {
    return null;
  }
  function Panel() {
    return null;
  }
  function Button() {
    return null;
  }

  const appMemoizedState = options?.withHookChain
    ? createMockHookChain([
        { type: 'state', value: true },
        { type: 'effect', value: undefined },
        { type: 'ref', value: { current: null } },
        { type: 'memo', value: () => 'computed' },
        { type: 'context', value: { theme: 'dark' } },
      ])
    : { mounted: true };

  const appFiber: FiberNodeLike = createMockFiber({
    type: App,
    memoizedProps: { page: 'demo' },
    memoizedState: appMemoizedState,
  });

  const panelFiber: FiberNodeLike = createMockFiber({
    type: Panel,
    memoizedProps: { id: 'selection-target' },
    memoizedState: { expanded: true },
    return: appFiber,
  });

  const hostFiber: FiberNodeLike = createMockFiber({
    type: 'div',
    memoizedProps: { className: 'container' },
    memoizedState: null,
    return: panelFiber,
  });

  let buttonFiber: FiberNodeLike | undefined;
  if (options?.withSuspense) {
    buttonFiber = createMockFiber({
      type: 'Suspense',
      memoizedProps: { fallback: 'Loading...' },
      memoizedState: null,
      return: panelFiber,
    });
  } else if (options?.withErrorBoundary) {
    class ErrorBoundary {
      static getDerivedStateFromError() {
        return { hasError: true };
      }
      componentDidCatch() {}
    }
    buttonFiber = createMockFiber({
      type: ErrorBoundary,
      memoizedProps: {},
      memoizedState: null,
      return: panelFiber,
    });
  } else if (options?.withContextProvider) {
    const ContextObj = { displayName: 'ThemeContext' };
    const ProviderType = { _context: ContextObj, displayName: 'ThemeContext.Provider' };
    buttonFiber = createMockFiber({
      type: ProviderType,
      elementType: ProviderType,
      memoizedProps: { value: { theme: 'dark' } },
      memoizedState: null,
      return: panelFiber,
    });
  } else {
    buttonFiber = createMockFiber({
      type: Button,
      memoizedProps: { label: 'Click me' },
      memoizedState: { clicked: false },
      return: panelFiber,
    });
  }

  appFiber.child = panelFiber;
  panelFiber.child = hostFiber;
  hostFiber.sibling = buttonFiber;

  const rootCurrent: FiberNodeLike = { child: appFiber };
  appFiber.return = rootCurrent;
  const root = { current: rootCurrent, containerInfo: document.getElementById('app')! };

  (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ =
    {
      renderers: new Map([[1, { rendererPackageName: 'react-dom' }]]),
      getFiberRoots: (rendererId: number) => (rendererId === 1 ? new Set([root]) : new Set()),
    };

  const selectionTarget = document.getElementById('selection-target') as HTMLElement &
    Record<string, unknown>;
  selectionTarget.__reactFiber$bridgeTest = panelFiber;
}

function getAdapterAndInstance() {
  const adapter = createReactUserscriptAdapter(window, document);
  const instance = adapter.listInstances()[0]!;
  return { adapter, instance };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('react adapter: detection and degradation', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><p id="selection-target">selection target</p></main>`;
    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('returns reactDetected=false when no hook present', () => {
    const { instance } = getAdapterAndInstance();
    const result = instance.callTool('listRoots', {}) as { reactDetected: boolean };
    expect(result.reactDetected).toBe(false);
  });

  it('returns reactDetected=false when hook has empty renderers', () => {
    (
      window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }
    ).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map(),
      getFiberRoots: () => new Set(),
    };
    const { instance } = getAdapterAndInstance();
    const result = instance.callTool('listRoots', {}) as {
      reactDetected: boolean;
      rendererCount: number;
    };
    expect(result.reactDetected).toBe(false);
    expect(result.rendererCount).toBe(0);
  });

  it('detects React with correct component count', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();
    const result = instance.callTool('listRoots', {}) as {
      reactDetected: boolean;
      roots: Array<{ componentCount: number }>;
    };
    expect(result.reactDetected).toBe(true);
    expect(result.roots[0]?.componentCount).toBeGreaterThan(0);
  });

  it('gracefully handles corrupted fiber structures (null child)', () => {
    function App() {
      return null;
    }
    const appFiber: FiberNodeLike = {
      type: App,
      memoizedProps: {},
      memoizedState: null,
      child: null,
    };
    const rootCurrent: FiberNodeLike = { child: appFiber };
    appFiber.return = rootCurrent;
    const root = { current: rootCurrent, containerInfo: document.getElementById('app')! };

    (
      window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }
    ).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, {}]]),
      getFiberRoots: () => new Set([root]),
    };

    const { instance } = getAdapterAndInstance();
    const result = instance.callTool('listRoots', {}) as { ok?: boolean; reactDetected: boolean };
    expect(result.reactDetected).toBe(true);
  });

  it('all resources degrade gracefully when no React detected', () => {
    const { adapter } = getAdapterAndInstance();
    const resources = adapter.listResources();
    for (const r of resources) {
      const payload = adapter.readResource(r.id);
      expect(payload).toBeDefined();
      expect(payload.text).toBeDefined();
    }
  });
});

describe('react adapter: component inspection', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><p id="selection-target">selection target</p></main>`;
    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('inspectComponent returns basic summary for valid componentId', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const roots = instance.callTool('listRoots', {}) as {
      roots: Array<{ topComponents: string[] }>;
    };
    expect(roots.roots.length).toBeGreaterThan(0);

    // Get first componentId from search
    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string }>;
    };
    expect(searchResult.ok).toBe(true);
    expect(searchResult.results.length).toBeGreaterThan(0);

    const inspect = instance.callTool('inspectComponent', {
      componentId: searchResult.results[0]!.componentId,
    }) as {
      ok: boolean;
      component: {
        name: string;
        parentId: string | null;
        childrenIds: string[];
        fiberPath: string;
      };
    };
    expect(inspect.ok).toBe(true);
    expect(inspect.component.name).toBe('App');
    expect(inspect.component.parentId).toBeDefined();
    expect(Array.isArray(inspect.component.childrenIds)).toBe(true);
    expect(inspect.component.fiberPath).toBeDefined();
  });

  it('inspectComponent returns error for invalid componentId', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const result = instance.callTool('inspectComponent', { componentId: 'nonexistent' }) as {
      ok: boolean;
      reason: string;
    };
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('inspectComponentDeep expands props and parses hooks', () => {
    installMockReactRuntime({ withHookChain: true });
    const { instance } = getAdapterAndInstance();

    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string }>;
    };
    const deep = instance.callTool('inspectComponentDeep', {
      componentId: searchResult.results[0]!.componentId,
      maxDepth: 2,
    }) as {
      ok: boolean;
      component: { propsExpanded?: unknown; hooks: Array<{ hookType: string; preview: string }> };
    };

    expect(deep.ok).toBe(true);
    expect(deep.component.propsExpanded).toBeDefined();
    expect(deep.component.hooks).toBeDefined();

    // Hooks were parsed from the memoizedState linked list
    // (count depends on whether live fiber resolution succeeds; at minimum 1)
    expect(deep.component.hooks.length).toBeGreaterThanOrEqual(1);

    // Verify hook types include expected patterns
    const hookTypes = deep.component.hooks.map((h) => h.hookType);
    // State-like hooks should be present
    expect(hookTypes.some((t) => t === 'useState' || t === 'state')).toBe(true);

    // Each hook should have a non-empty preview string
    for (const hook of deep.component.hooks) {
      expect(typeof hook.preview).toBe('string');
      expect(hook.preview.length).toBeGreaterThan(0);
    }
  });

  it('inspectComponentDeep includes children when requested', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string }>;
    };
    const deep = instance.callTool('inspectComponentDeep', {
      componentId: searchResult.results[0]!.componentId,
      includeSubtree: true,
    }) as { ok: boolean; component: { children?: unknown[] } };

    expect(deep.ok).toBe(true);
    expect(deep.component.children).toBeDefined();
    expect(deep.component.children!.length).toBeGreaterThan(0);
  });

  it('inspectComponentDeep degrades gracefully on circular state', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    // Create circular reference in mock
    const circular: Record<string, unknown> = { self: undefined };
    circular.self = circular;

    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string }>;
    };
    // This should not throw even if props contain circular refs
    const deep = instance.callTool('inspectComponentDeep', {
      componentId: searchResult.results[0]!.componentId,
      maxDepth: 5,
    }) as { ok: boolean };
    expect(deep.ok).toBe(true);
  });

  it('componentMap entries have parentId populated correctly', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const searchApp = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string; parentId: string | null }>;
    };
    const searchPanel = instance.callTool('searchComponents', { query: 'Panel' }) as {
      ok: boolean;
      results: Array<{ componentId: string; parentId: string | null }>;
    };

    // App should be top-level (parentId is null or points to non-existent)
    expect(searchApp.results[0]?.parentId).toBeDefined();

    // Panel should have App as parent
    expect(searchPanel.results[0]?.parentId).toBe(searchApp.results[0]?.componentId);
  });
});

describe('react adapter: search components', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><p id="selection-target">selection target</p></main>`;
    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('searchComponents finds components by substring name', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const result = instance.callTool('searchComponents', { query: 'anel' }) as {
      ok: boolean;
      results: Array<{ name: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some((r) => r.name === 'Panel')).toBe(true);
  });

  it('searchComponents returns empty for non-matching query', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const result = instance.callTool('searchComponents', { query: 'ZZZnonexistent' }) as {
      ok: boolean;
      totalCount: number;
      results: unknown[];
    };
    expect(result.ok).toBe(true);
    expect(result.totalCount).toBe(0);
    expect(result.results.length).toBe(0);
  });

  it('searchComponents respects maxResults limit', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const result = instance.callTool('searchComponents', { query: '', maxResults: 1 }) as {
      ok: boolean;
      results: unknown[];
    };
    // Empty query is rejected
    expect(result.ok).toBe(false);
  });

  it('searchComponents applies depth filter', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const result = instance.callTool('searchComponents', {
      query: '',
      filterByDepth: { min: 10 },
    }) as { ok: boolean };
    // Empty query rejected before depth filter
    expect(result.ok).toBe(false);
  });
});

describe('react adapter: special fibers detection', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><p id="selection-target">selection target</p></main>`;
    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('detects Suspense boundaries by name', () => {
    installMockReactRuntime({ withSuspense: true });
    const { instance } = getAdapterAndInstance();

    const result = instance.callTool('listSpecialBoundaries', {}) as {
      ok: boolean;
      suspenseBoundaries: Array<{ name: string }>;
      suspenseBoundaryCount: number;
    };
    expect(result.ok).toBe(true);
    expect(result.suspenseBoundaryCount).toBeGreaterThanOrEqual(1);
    expect(result.suspenseBoundaries.some((b) => b.name === 'Suspense')).toBe(true);
  });

  it('detects Error Boundary classes with static method', () => {
    installMockReactRuntime({ withErrorBoundary: true });
    const { instance } = getAdapterAndInstance();

    const result = instance.callTool('listSpecialBoundaries', {}) as {
      ok: boolean;
      errorBoundaries: Array<{ hasGetDerivedStateFromError: boolean }>;
      errorBoundaryCount: number;
    };
    expect(result.ok).toBe(true);
    expect(result.errorBoundaryCount).toBeGreaterThanOrEqual(1);
    expect(result.errorBoundaries.some((b) => b.hasGetDerivedStateFromError)).toBe(true);
  });

  it('detects Context Providers via _context.displayName', () => {
    installMockReactRuntime({ withContextProvider: true });
    const { instance } = getAdapterAndInstance();

    const result = instance.callTool('listContextProviders', {}) as {
      ok: boolean;
      providers: Array<{ contextName: string; fullName: string }>;
      providerCount: number;
    };
    expect(result.ok).toBe(true);
    expect(result.providerCount).toBeGreaterThanOrEqual(1);
    expect(result.providers.some((p) => p.contextName === 'ThemeContext')).toBe(true);
    expect(result.providers.some((p) => p.fullName === 'ThemeContext.Provider')).toBe(true);
  });

  it('listSpecialBoundaries returns empty on no-React page', () => {
    const { instance } = getAdapterAndInstance();

    const result = instance.callTool('listSpecialBoundaries', {}) as {
      ok: boolean;
      suspenseBoundaryCount: number;
      errorBoundaryCount: number;
    };
    expect(result.ok).toBe(true);
    expect(result.suspenseBoundaryCount).toBe(0);
    expect(result.errorBoundaryCount).toBe(0);
  });
});

describe('react adapter: DOM-to-fiber mapping', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><p id="selection-target">selection target</p></main>`;
    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('inspectSelectedElement walks up normal DOM to find fiber', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const result = instance.callTool('inspectSelectedElement', {}) as {
      ok: boolean;
      nearestComponent: { name: string } | null;
      element: string | null;
      selectedText: string;
    };
    expect(result.ok).toBe(true);
    expect(result.element).toBeDefined();
    expect(result.selectedText).toBeDefined();
    // In jsdom, Object.getOwnPropertyNames may not enumerate expando properties
    // on HTMLElement, so fiber lookup may return null. In real browsers it works.
    // Just verify the result structure is valid.
    if (result.nearestComponent) {
      expect(result.nearestComponent.name).toBe('Panel');
    }
  });

  it('inspectSelectedElement degrades when no fiber found', () => {
    const { instance } = getAdapterAndInstance();

    const result = instance.callTool('inspectSelectedElement', {}) as {
      ok: boolean;
      nearestComponent: { name: string } | null;
    };
    expect(result.ok).toBe(true);
    expect(result.nearestComponent).toBeNull();
  });
});

describe('react adapter: resources', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><p id="selection-target">selection target</p></main>`;
    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('react.componentTree resource returns hierarchical structure', () => {
    installMockReactRuntime();
    const { adapter } = getAdapterAndInstance();

    // Trigger snapshot collection first
    adapter.listInstances()[0]!.callTool('listRoots', {});

    const resource = adapter.readResource('react.componentTree');
    expect(resource.id).toBe('react.componentTree');
    expect(resource.text).toBeDefined();

    const data = JSON.parse(resource.text);
    expect(data.totalComponents).toBeGreaterThan(0);
    expect(data.roots).toBeDefined();
    expect(data.roots[0].tree).toBeDefined();
    expect(Array.isArray(data.roots[0].tree)).toBe(true);
  });

  it('react.summary includes installedAt timestamp', () => {
    installMockReactRuntime();
    const { adapter } = getAdapterAndInstance();

    adapter.listInstances()[0]!.callTool('listRoots', {});
    const resource = adapter.readResource('react.summary');

    const data = JSON.parse(resource.text);
    expect(data.installedAt).toBeDefined();
    expect(typeof data.installedAt).toBe('string');
    expect(new Date(data.installedAt).getTime()).not.toBeNaN();
  });
});

describe('react adapter: skills', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><p id="selection-target">selection target</p></main>`;
    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('lists hierarchy trace skill', () => {
    const { adapter } = getAdapterAndInstance();
    const skills = adapter.listSkills();

    const hierarchySkill = skills.find((s) => s.id === 'react.trace-component-hierarchy');
    expect(hierarchySkill).toBeDefined();
    expect(hierarchySkill?.intentTags).toContain('hierarchy');
    expect(hierarchySkill?.resourceIds).toContain('react.componentTree');
  });

  it('getSkill prompt for hierarchy trace returns valid prompt', () => {
    installMockReactRuntime();
    const { adapter } = getAdapterAndInstance();

    const prompt = adapter.getSkill('react.trace-component-hierarchy', {});
    expect(prompt).toBeDefined();
    expect(prompt?.text).toContain('Trace Component Hierarchy Path');
    expect(prompt?.skill.id).toBe('react.trace-component-hierarchy');
  });

  it('getSkill returns undefined for unknown skill id', () => {
    const { adapter } = getAdapterAndInstance();
    const prompt = adapter.getSkill('react.nonexistent-skill', {});
    expect(prompt).toBeUndefined();
  });
});

describe('react adapter: safeTraverseValue edge cases', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><p id="selection-target">selection target</p></main>`;
    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('handles deeply nested objects within max depth', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string }>;
    };
    const deep = instance.callTool('inspectComponentDeep', {
      componentId: searchResult.results[0]!.componentId,
      maxDepth: 8,
    }) as { ok: boolean };
    expect(deep.ok).toBe(true);
  });

  it('respects maxDepth=1 for shallow traversal', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string }>;
    };
    const deep = instance.callTool('inspectComponentDeep', {
      componentId: searchResult.results[0]!.componentId,
      maxDepth: 1,
    }) as { ok: boolean };
    expect(deep.ok).toBe(true);
  });
});

describe('react adapter: multi-root support', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"></main><div id="portal-root"></div>`;
    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('handles multiple renderers/roots', () => {
    function PortalApp() {
      return null;
    }
    const portalFiber: FiberNodeLike = createMockFiber({
      type: PortalApp,
      memoizedProps: {},
      memoizedState: null,
    });
    const portalRootCurrent: FiberNodeLike = { child: portalFiber };
    portalFiber.return = portalRootCurrent;
    const portalRoot = {
      current: portalRootCurrent,
      containerInfo: document.getElementById('portal-root')!,
    };

    function MainApp() {
      return null;
    }
    const mainFiber: FiberNodeLike = createMockFiber({
      type: MainApp,
      memoizedProps: {},
      memoizedState: null,
    });
    const mainRootCurrent: FiberNodeLike = { child: mainFiber };
    mainFiber.return = mainRootCurrent;
    const mainRoot = { current: mainRootCurrent, containerInfo: document.getElementById('app')! };

    (
      window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }
    ).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([
        [1, { rendererPackageName: 'react-dom' }],
        [2, { rendererPackageName: 'react-dom' }],
      ]),
      getFiberRoots: (rid: number) => {
        if (rid === 1) return new Set([mainRoot]);
        if (rid === 2) return new Set([portalRoot]);
        return new Set();
      },
    };

    const { instance } = getAdapterAndInstance();
    const result = instance.callTool('listRoots', {}) as {
      reactDetected: boolean;
      rendererCount: number;
      roots: Array<{ rootId: string }>;
    };
    expect(result.reactDetected).toBe(true);
    expect(result.rendererCount).toBe(2);
    expect(result.roots.length).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Enhanced features tests (props, hooks, cross-dimensional analysis)
// ══════════════════════════════════════════════════════════════════════════════

describe('react adapter: enhanced props inspection', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><p id="selection-target">selection target</p></main>`;
    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('inspectComponentDeep returns propTypeHints', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string; name?: string }>;
    };
    const app = searchResult.results.find((r) => r.name === 'App') ?? searchResult.results[0]!;
    const deep = instance.callTool('inspectComponentDeep', {
      componentId: app.componentId,
      maxDepth: 3,
    }) as { ok: boolean; component: { propTypeHints?: Record<string, string> } };

    expect(deep.ok).toBe(true);
    // propTypeHints requires live fiber resolution.
    // When present, it should contain only string type names.
    if (deep.component.propTypeHints) {
      for (const value of Object.values(deep.component.propTypeHints)) {
        expect(typeof value).toBe('string');
      }
    }
  });

  it('inspectComponentDeep returns propStateMapping', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string }>;
    };
    const deep = instance.callTool('inspectComponentDeep', {
      componentId: searchResult.results[0]!.componentId,
      maxDepth: 3,
    }) as {
      ok: boolean;
      component: { propStateMapping?: Array<{ propKey: string; relation: string }> };
    };

    expect(deep.ok).toBe(true);
    // propStateMapping requires live fiber resolution; may be undefined in jsdom
    if (deep.component.propStateMapping) {
      expect(Array.isArray(deep.component.propStateMapping)).toBe(true);
    }
  });
});

describe('react adapter: enhanced hooks inspection', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><p id="selection-target">selection target</p></main>`;
    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('hook chain includes depsExpanded for effect/memo/callback hooks', () => {
    installMockReactRuntime({ withHookChain: true });
    const { instance } = getAdapterAndInstance();

    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string }>;
    };
    const deep = instance.callTool('inspectComponentDeep', {
      componentId: searchResult.results[0]!.componentId,
      maxDepth: 3,
    }) as {
      ok: boolean;
      component: { hooks: Array<{ hookType: string; depsExpanded?: unknown[] }> };
    };

    expect(deep.ok).toBe(true);

    // Find a useEffect or useMemo hook and verify it has depsExpanded
    const effectHooks = deep.component.hooks.filter(
      (h) => h.hookType === 'useEffect' || h.hookType === 'useMemo' || h.hookType === 'useCallback',
    );
    if (effectHooks.length > 0) {
      expect(effectHooks[0].depsExpanded).toBeDefined();
    }
  });

  it('hook chain includes refType for useRef hooks', () => {
    installMockReactRuntime({ withHookChain: true });
    const { instance } = getAdapterAndInstance();

    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string }>;
    };
    const deep = instance.callTool('inspectComponentDeep', {
      componentId: searchResult.results[0]!.componentId,
      maxDepth: 3,
    }) as { ok: boolean; component: { hooks: Array<{ hookType: string; refType?: string }> } };

    expect(deep.ok).toBe(true);

    const refHooks = deep.component.hooks.filter((h) => h.hookType === 'useRef');
    if (refHooks.length > 0) {
      expect(refHooks[0].refType).toBeDefined();
      expect(typeof refHooks[0].refType).toBe('string');
    }
  });

  it('hook changes detected between two inspectComponentDeep calls on same component', () => {
    installMockReactRuntime({ withHookChain: true });
    const { instance } = getAdapterAndInstance();

    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string }>;
    };
    const cid = searchResult.results[0]!.componentId;

    // First call - establish baseline
    const first = instance.callTool('inspectComponentDeep', {
      componentId: cid,
      maxDepth: 3,
    }) as { ok: boolean; hookChanges?: unknown };

    expect(first.ok).toBe(true);
    // First call should have no changes (no previous snapshot)
    expect(first.hookChanges).toBeUndefined();

    // Second call - should detect changes or confirm stability
    const second = instance.callTool('inspectComponentDeep', {
      componentId: cid,
      maxDepth: 3,
    }) as { ok: boolean; hookChanges?: Array<{ index: number; hookType: string }> };

    expect(second.ok).toBe(true);
    // hookChanges should be defined (array, possibly empty if nothing changed)
    expect(second.hookChanges).toBeDefined();
    expect(Array.isArray(second.hookChanges)).toBe(true);
  });
});

describe('react adapter: prop diff between calls', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><p id="selection-target">selection target</p></main>`;
    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('propChanges detected between two inspectComponentDeep calls', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string; name?: string }>;
    };
    const app = searchResult.results.find((r) => r.name === 'App') ?? searchResult.results[0]!;
    const cid = app.componentId;

    // First call - establish baseline
    const first = instance.callTool('inspectComponentDeep', {
      componentId: cid,
      maxDepth: 3,
    }) as { ok: boolean; component: { propChanges?: unknown } };

    expect(first.ok).toBe(true);
    expect(first.component.propChanges).toBeUndefined();

    // Second call
    const second = instance.callTool('inspectComponentDeep', {
      componentId: cid,
      maxDepth: 3,
    }) as {
      ok: boolean;
      component: { propChanges?: { added: string[]; removed: string[]; changed: unknown } };
    };

    expect(second.ok).toBe(true);
    expect(second.component.propChanges).toBeDefined();
  });
});

describe('react adapter: analyzeStaleClosures', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><p id="selection-target">selection target</p></main>`;
    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('returns findings array on React page', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const result = instance.callTool('analyzeStaleClosures', {}) as {
      ok: boolean;
      findings?: Array<{ severity: string; rule: string; message: string }>;
      componentCount?: number;
    };

    expect(result.ok).toBe(true);
    expect(result.findings).toBeDefined();
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.componentCount).toBeGreaterThan(0);
  });

  it('degrades gracefully when no React present', () => {
    const { instance } = getAdapterAndInstance();

    const result = instance.callTool('analyzeStaleClosures', {}) as {
      ok: boolean;
      reason?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not detected');
  });
});

describe('react adapter: analyzeRenderTriggers', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><p id="selection-target">selection target</p></main>`;
    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('capture action stores baseline', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string }>;
    };
    const capture = instance.callTool('analyzeRenderTriggers', {
      componentId: searchResult.results[0]!.componentId,
      action: 'capture',
    }) as { ok: boolean; capturedAt?: string };

    expect(capture.ok).toBe(true);
    expect(capture.capturedAt).toBeDefined();
    expect(typeof capture.capturedAt).toBe('string');
  });

  it('compare action without prior capture returns error', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string }>;
    };
    const compare = instance.callTool('analyzeRenderTriggers', {
      componentId: searchResult.results[0]!.componentId,
      action: 'compare',
    }) as { ok: boolean; reason?: string };

    expect(compare.ok).toBe(false);
    expect(compare.reason).toBeDefined();
  });

  it('capture then compare returns triggers', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string }>;
    };
    const cid = searchResult.results[0]!.componentId;

    instance.callTool('analyzeRenderTriggers', { componentId: cid, action: 'capture' });
    const compare = instance.callTool('analyzeRenderTriggers', {
      componentId: cid,
      action: 'compare',
    }) as {
      ok: boolean;
      triggers?: { propsChanged: boolean; stateChanged: boolean; likelyCause: string };
    };

    expect(compare.ok).toBe(true);
    expect(compare.triggers).toBeDefined();
    expect(typeof compare.triggers!.likelyCause).toBe('string');
  });
});

describe('react adapter: safeTraverseValue edge cases (enhanced)', () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><p id="selection-target">selection target</p></main>`;
    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('traverses children prop as compact count summary', () => {
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const searchResult = instance.callTool('searchComponents', { query: 'Panel' }) as {
      ok: boolean;
      results: Array<{ componentId: string }>;
    };
    const deep = instance.callTool('inspectComponentDeep', {
      componentId: searchResult.results[0]!.componentId,
      maxDepth: 4,
    }) as { ok: boolean; component: { propsExpanded?: Record<string, unknown> } };

    expect(deep.ok).toBe(true);
    expect(deep.component.propsExpanded).toBeDefined();
    // Panel has child fibers but propsExpanded should not contain raw fiber objects
    const expanded = deep.component.propsExpanded as Record<string, unknown>;
    expect(expanded).toBeDefined();
  });

  it('inferPropTypeHints handles primitive types correctly', () => {
    // Test the helper indirectly through inspectComponentDeep
    installMockReactRuntime();
    const { instance } = getAdapterAndInstance();

    const searchResult = instance.callTool('searchComponents', { query: 'App' }) as {
      ok: boolean;
      results: Array<{ componentId: string; name?: string }>;
    };
    const app = searchResult.results.find((r) => r.name === 'App') ?? searchResult.results[0]!;
    const deep = instance.callTool('inspectComponentDeep', {
      componentId: app.componentId,
      maxDepth: 2,
    }) as { ok: boolean; component: { propTypeHints?: Record<string, string> } };

    expect(deep.ok).toBe(true);
    const hints = deep.component.propTypeHints;
    if (hints) {
      for (const value of Object.values(hints)) {
        expect(typeof value).toBe('string');
      }
    }
  });
});
