import type {
  ContextNamespaceDescriptor,
  ContextResourceDescriptor,
  ContextSkillDescriptor,
  ToolSpec,
} from '@page-context/shared-protocol';

import type { PageToolInstance, ToolInput, UserscriptBridgeAdapter } from '../types';
import {
  buildSkillPrompt,
  listToolNames,
  normalizeSkillInput,
  previewValue,
  READONLY_ANNOTATION,
  toErrorMessage,
  toJsonResource,
  isObjectRecord,
} from '../utils';

interface ReactDevtoolsHookLike {
  renderers?: Map<unknown, unknown>;
  getFiberRoots?: (rendererId: number) => Set<unknown> | undefined;
}

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

interface FiberRootLike {
  current?: FiberNodeLike;
  containerInfo?: unknown;
}

interface RootSummary {
  rootId: string;
  rendererId: number;
  componentCount: number;
  fiberCount: number;
  container: string | null;
  topComponents: string[];
}

interface ComponentSummary {
  componentId: string;
  rootId: string;
  name: string;
  depth: number;
  key: string | null;
  propsPreview: string;
  statePreview: string;
  parentId: string | null;
  childrenIds: string[];
  fiberPath: string;
}

interface SelectionSummary {
  selectedText: string;
  element: string | null;
  nearestComponent: ComponentSummary | null;
}

interface ReactSnapshot {
  reactDetected: boolean;
  rendererCount: number;
  roots: RootSummary[];
  componentMap: Map<string, ComponentSummary>;
  diagnostics: string[];
}

interface ReactAdapterState {
  lastSnapshot: ReactSnapshot | null;
  lastSelection: SelectionSummary | null;
  lastComponent: ComponentSummary | null;
  installedAt: string;
  /** Prop diff snapshots keyed by componentId (max 20 entries, LRU eviction) */
  propSnapshots: Map<string, { hash: string; propsExpanded: unknown }>;
  /** Render baseline snapshots keyed by componentId (max 10 entries, LRU eviction) */
  renderBaselines: Map<
    string,
    { capturedAt: string; propsSnapshot: unknown; stateHooksPreview: string[] }
  >;
  /** Hook snapshots for change detection between calls (Enhancement 5) - max 20 entries, LRU eviction */
  hookSnapshots: Map<string, { hash: string; hooks: { hookType: string; preview: string }[] }>;
}

interface HookSummary {
  hookType: string;
  preview: string;
  value?: unknown;
  /** Fully expanded dependency array for effect/memo/callback hooks (Enhancement 1) */
  depsExpanded?: unknown[];
  /** Ref type annotation: "dom" | "function" | "object" | "null" | "number" | "string" | "unknown" (Enhancement 2) */
  refType?: string;
  /** Deeper preview of .current value for useRef hooks (depth 3) (Enhancement 2) */
  refCurrentPreview?: string;
  /** Whether useState/useReducer has pending updates in queue (Enhancement 3) */
  hasPendingUpdate?: boolean;
  /** Preview of lastRenderedState from queue (Enhancement 3) */
  lastRenderedStatePreview?: string;
  /** Display name of reducer function for useReducer (Enhancement 4) */
  reducerName?: string;
}

interface SafeTraversalOptions {
  maxDepth: number;
  maxKeys?: number;
  maxArrayLength?: number;
}

const NS = 'react';
const INSTANCE = 'primary';
const RESOURCE_IDS = {
  summary: 'react.summary',
  roots: 'react.roots',
  selection: 'react.selection',
  component: 'react.component',
  diagnostics: 'react.diagnostics',
  componentTree: 'react.componentTree',
} as const;

const SKILL_IDS = {
  rootLandscape: 'react.analyze-root-landscape',
  selectionTrace: 'react.trace-selection-component',
  componentReview: 'react.review-component-state',
  hierarchyTrace: 'react.trace-component-hierarchy',
} as const;

const NAMESPACE: ContextNamespaceDescriptor = {
  namespace: NS,
  title: 'React',
  description: 'Read-only React runtime inspection via DevTools global hook.',
  tags: ['react', 'readonly', 'inspect'],
};

const TOOLS: ToolSpec[] = [
  {
    name: 'listRoots',
    description: 'List the React root summaries detected on the current page.',
    inputSchema: {
      type: 'object',
      properties: {
        includeDiagnostics: {
          type: 'boolean',
          description: 'Include diagnostics in the response.',
        },
      },
      additionalProperties: false,
    },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: 'inspectComponent',
    description: 'Inspect a component summary by componentId.',
    inputSchema: {
      type: 'object',
      properties: {
        componentId: {
          type: 'string',
          description: 'A componentId returned by listRoots or inspectSelectedElement.',
        },
      },
      required: ['componentId'],
      additionalProperties: false,
    },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: 'inspectSelectedElement',
    description: 'Inspect the current selection and trace back to the nearest React component.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: 'searchComponents',
    description: 'Search components by name substring with optional depth and root filters.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term (substring match on component name).' },
        rootId: { type: 'string', description: 'Optional: scope to a specific root.' },
        maxResults: {
          type: 'number',
          description: 'Max results to return (default: 20, max: 100).',
        },
        filterByDepth: {
          type: 'object',
          properties: {
            min: { type: 'number' },
            max: { type: 'number' },
          },
          description: 'Optional depth range filter.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: 'inspectComponentDeep',
    description:
      'Inspect a component with expanded props, parsed hook chain (useState/useEffect/useRef/etc.), and optional subtree children.',
    inputSchema: {
      type: 'object',
      properties: {
        componentId: {
          type: 'string',
          description: 'A componentId from listRoots or inspectSelectedElement.',
        },
        maxDepth: {
          type: 'number',
          description: 'Max object depth for props/state expansion (default: 3, max: 8).',
        },
        includeSubtree: {
          type: 'boolean',
          description: 'Include direct children summaries (default: false).',
        },
      },
      required: ['componentId'],
      additionalProperties: false,
    },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: 'listContextProviders',
    description:
      'List all detected React Context Providers with their names and locations in the component tree.',
    inputSchema: {
      type: 'object',
      properties: {
        rootId: { type: 'string', description: 'Optional: scope to a specific root.' },
      },
      additionalProperties: false,
    },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: 'listSpecialBoundaries',
    description: 'List Suspense boundaries and Error Boundaries with their coverage areas.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: 'analyzeStaleClosures',
    description:
      'Analyze components for potential stale closure issues in useEffect/useMemo/useCallback hooks.',
    inputSchema: {
      type: 'object',
      properties: {
        rootId: { type: 'string', description: 'Optional: scope to specific root.' },
      },
      additionalProperties: false,
    },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: 'analyzeRenderTriggers',
    description:
      'Analyze why a component may have re-rendered by comparing current props/state against a captured baseline.',
    inputSchema: {
      type: 'object',
      properties: {
        componentId: { type: 'string', description: 'Component to analyze.' },
        action: {
          type: 'string',
          enum: ['capture', 'compare'],
          description: 'capture=save baseline, compare=diff against saved.',
        },
      },
      required: ['componentId', 'action'],
      additionalProperties: false,
    },
    annotations: READONLY_ANNOTATION,
  },
];

const RESOURCES: ContextResourceDescriptor[] = [
  {
    id: RESOURCE_IDS.summary,
    namespace: NS,
    title: 'React Summary',
    description: 'React detection summary and recent inspection state.',
    mimeType: 'application/json',
    kind: 'json',
    tags: ['summary'],
  },
  {
    id: RESOURCE_IDS.roots,
    namespace: NS,
    title: 'React Roots',
    description: 'List of React root summaries.',
    mimeType: 'application/json',
    kind: 'json',
    tags: ['roots'],
  },
  {
    id: RESOURCE_IDS.selection,
    namespace: NS,
    title: 'React Selection',
    description: 'Current selection, matching element, and nearest component summary.',
    mimeType: 'application/json',
    kind: 'json',
    tags: ['selection'],
  },
  {
    id: RESOURCE_IDS.component,
    namespace: NS,
    title: 'React Component',
    description: 'Result of the most recent inspectComponent call.',
    mimeType: 'application/json',
    kind: 'json',
    tags: ['component'],
  },
  {
    id: RESOURCE_IDS.diagnostics,
    namespace: NS,
    title: 'React Diagnostics',
    description: 'React hook detection and fallback diagnostics.',
    mimeType: 'application/json',
    kind: 'json',
    tags: ['diagnostics'],
  },
  {
    id: RESOURCE_IDS.componentTree,
    namespace: NS,
    title: 'React Component Tree',
    description: 'Hierarchical component tree with parent-child relationships.',
    mimeType: 'application/json',
    kind: 'json',
    tags: ['tree', 'components'],
  },
];

const SKILLS: ContextSkillDescriptor[] = [
  {
    id: SKILL_IDS.rootLandscape,
    namespace: NS,
    title: 'Analyze React Root Landscape',
    description: 'Analyze root count, topology, and suspicious areas.',
    intentTags: ['analysis', 'react', 'roots'],
    resourceIds: [RESOURCE_IDS.summary, RESOURCE_IDS.roots, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[0]!]),
    mode: 'analysis',
  },
  {
    id: SKILL_IDS.selectionTrace,
    namespace: NS,
    title: 'Trace Selected Element to Component',
    description: 'Map the current selection to a component and explain the context.',
    intentTags: ['analysis', 'selection', 'react'],
    resourceIds: [RESOURCE_IDS.selection, RESOURCE_IDS.component, RESOURCE_IDS.roots],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[2]!, TOOLS[1]!]),
    mode: 'analysis',
  },
  {
    id: SKILL_IDS.componentReview,
    namespace: NS,
    title: 'Review Component Props and State',
    description: 'Review component props/state previews and summarize the evidence chain.',
    intentTags: ['analysis', 'component', 'state'],
    resourceIds: [RESOURCE_IDS.component, RESOURCE_IDS.summary, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[1]!, TOOLS[0]!]),
    mode: 'analysis',
  },
  {
    id: SKILL_IDS.hierarchyTrace,
    namespace: NS,
    title: 'Trace Component Hierarchy Path',
    description:
      'Given a component, trace its ancestry chain and summarize the rendering path from root.',
    intentTags: ['analysis', 'hierarchy', 'navigation'],
    resourceIds: [RESOURCE_IDS.componentTree, RESOURCE_IDS.component, RESOURCE_IDS.summary],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[1]!, TOOLS[3]!, TOOLS[0]!]),
    mode: 'analysis',
  },
];

export function createReactUserscriptAdapter(win: Window, doc: Document): UserscriptBridgeAdapter {
  const state: ReactAdapterState = {
    lastSnapshot: null,
    lastSelection: null,
    lastComponent: null,
    installedAt: new Date().toISOString(),
    propSnapshots: new Map(),
    renderBaselines: new Map(),
    hookSnapshots: new Map(),
  };

  const primaryInstance: PageToolInstance = {
    instanceId: INSTANCE,
    listTools: () => TOOLS,
    callTool: (name, input) => callReactTool(name, input ?? {}, win, doc, state),
  };

  return {
    adapterId: 'react-inspector',
    namespace: NAMESPACE,
    listInstances: () => [primaryInstance],
    listResources: () => RESOURCES,
    readResource: (id) => readReactResource(id, win, doc, state),
    listSkills: () => SKILLS,
    getSkill: (id, input) => getReactSkillPrompt(id, input ?? {}, win, doc, state),
    getSceneHint: () => 'react',
  };
}

function callReactTool(
  name: string,
  input: ToolInput,
  win: Window,
  doc: Document,
  state: ReactAdapterState,
): unknown {
  if (name === 'listRoots') {
    const snapshot = collectReactSnapshot(win, doc);
    state.lastSnapshot = snapshot;
    return {
      reactDetected: snapshot.reactDetected,
      rendererCount: snapshot.rendererCount,
      roots: snapshot.roots,
      diagnostics: input.includeDiagnostics ? snapshot.diagnostics : undefined,
    };
  }

  if (name === 'inspectComponent') {
    const componentId = typeof input.componentId === 'string' ? input.componentId : '';
    if (!componentId) {
      return { ok: false, reason: 'componentId must not be empty.' };
    }

    const snapshot = collectReactSnapshot(win, doc);
    state.lastSnapshot = snapshot;
    const component = snapshot.componentMap.get(componentId) ?? null;
    state.lastComponent = component;
    if (!component) {
      return {
        ok: false,
        reason: `Component not found: ${componentId}`,
        suggestion: 'Run listRoots or inspectSelectedElement first to get a valid componentId.',
      };
    }
    return { ok: true, component };
  }

  if (name === 'inspectSelectedElement') {
    const snapshot = collectReactSnapshot(win, doc);
    state.lastSnapshot = snapshot;

    const selectedElement = resolveSelectedElement(win);
    const nearestFiber = findNearestFiberFromElement(selectedElement);
    const nearestComponent = nearestFiber
      ? buildComponentSummaryFromFiber(nearestFiber, snapshot.roots)
      : null;

    const selection: SelectionSummary = {
      selectedText: (win.getSelection?.()?.toString() ?? '').trim(),
      element: describeElement(selectedElement),
      nearestComponent,
    };
    state.lastSelection = selection;
    if (nearestComponent) {
      state.lastComponent = nearestComponent;
    }
    return { ok: true, ...selection };
  }

  if (name === 'searchComponents') {
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
    if (!query) {
      return { ok: false, reason: 'query must be a non-empty string.' };
    }

    const snapshot = collectReactSnapshot(win, doc);
    state.lastSnapshot = snapshot;

    const maxResults = Math.min(
      100,
      Math.max(1, typeof input.maxResults === 'number' ? input.maxResults : 20),
    );
    const rootFilter = typeof input.rootId === 'string' ? input.rootId : null;

    const results: ComponentSummary[] = [];
    let totalCount = 0;

    for (const comp of snapshot.componentMap.values()) {
      if (rootFilter && comp.rootId !== rootFilter) {
        continue;
      }
      if (!comp.name.toLowerCase().includes(query)) {
        continue;
      }
      totalCount += 1;
      if (isObjectRecord(input.filterByDepth)) {
        const fb = input.filterByDepth as Record<string, unknown>;
        if (typeof fb.min === 'number' && comp.depth < fb.min) {
          continue;
        }
        if (typeof fb.max === 'number' && comp.depth > fb.max) {
          continue;
        }
      }
      results.push(comp);
      if (results.length >= maxResults) {
        break;
      }
    }

    return { ok: true, query, totalCount, results };
  }

  if (name === 'inspectComponentDeep') {
    const componentId = typeof input.componentId === 'string' ? input.componentId : '';
    if (!componentId) {
      return { ok: false, reason: 'componentId must not be empty.' };
    }

    const maxDepth = Math.min(
      8,
      Math.max(1, typeof input.maxDepth === 'number' ? input.maxDepth : 3),
    );
    const includeSubtree = input.includeSubtree === true;

    try {
      const snapshot = collectReactSnapshot(win, doc);
      state.lastSnapshot = snapshot;
      const component = snapshot.componentMap.get(componentId) ?? null;
      if (!component) {
        return {
          ok: false,
          reason: `Component not found: ${componentId}`,
          suggestion: 'Run listRoots or inspectSelectedElement first.',
        };
      }
      state.lastComponent = component;

      const fiber = findLiveFiberByPath(win, componentId);
      const propsExpanded = fiber
        ? safeTraverseValue(fiber.memoizedProps, { maxDepth })
        : undefined;
      const hooks = fiber ? traverseHookChain(fiber.memoizedState, { maxDepth }) : [];

      // Enhancement 4: Compute prop type inference hints
      const propTypeHints: Record<string, string> | undefined =
        fiber && isObjectRecord(fiber.memoizedProps)
          ? buildPropTypeHints(fiber.memoizedProps as Record<string, unknown>)
          : undefined;

      // Enhancement 4: Prop-to-state mapping heuristic
      const propStateMapping = computePropStateMapping(
        propsExpanded && isObjectRecord(propsExpanded)
          ? Object.keys(propsExpanded as Record<string, unknown>)
          : [],
        hooks,
      );

      // Enhancement 1: Prop diff snapshot
      const propChanges = computePropDiff(componentId, propsExpanded, state.propSnapshots);

      // ── Enhancement 5: Hook change snapshot between calls ──
      const MAX_HOOK_SNAPSHOTS = 20;
      const hookSnapshotEntries = hooks.map((h) => ({ hookType: h.hookType, preview: h.preview }));
      const currentHash = JSON.stringify(hookSnapshotEntries).slice(0, 200);
      let hookChanges:
        | Array<{
            index: number;
            hookType: string;
            previousPreview: string;
            currentPreview: string;
          }>
        | undefined;

      const previousHookSnapshot = state.hookSnapshots.get(componentId);
      if (previousHookSnapshot) {
        hookChanges = [];
        if (previousHookSnapshot.hash !== currentHash) {
          const prevHooks = previousHookSnapshot.hooks;
          const maxLen = Math.max(prevHooks.length, hookSnapshotEntries.length);
          for (let i = 0; i < maxLen; i++) {
            const prev = prevHooks[i];
            const curr = hookSnapshotEntries[i];
            if (
              !prev ||
              !curr ||
              prev.preview !== curr.preview ||
              prev.hookType !== curr.hookType
            ) {
              hookChanges.push({
                index: i,
                hookType: curr?.hookType ?? '(removed)',
                previousPreview: prev?.preview ?? '(none)',
                currentPreview: curr?.preview ?? '(removed)',
              });
            }
          }
        }
      }

      // Store current snapshot with LRU eviction (max 20 entries)
      if (state.hookSnapshots.size >= MAX_HOOK_SNAPSHOTS) {
        const firstKey = state.hookSnapshots.keys().next().value;
        if (firstKey !== undefined) {
          state.hookSnapshots.delete(firstKey);
        }
      }
      state.hookSnapshots.set(componentId, { hash: currentHash, hooks: hookSnapshotEntries });

      let children:
        | Array<{
            componentId: string;
            name: string;
            depth: number;
            key: string | null;
            propsPreview: string;
            statePreview: string;
          }>
        | undefined;
      if (includeSubtree) {
        children = component.childrenIds
          .map((cid) => snapshot.componentMap.get(cid))
          .filter((c): c is ComponentSummary => c != null)
          .map((c) => ({
            componentId: c.componentId,
            name: c.name,
            depth: c.depth,
            key: c.key,
            propsPreview: c.propsPreview,
            statePreview: c.statePreview,
          }));
      }

      return {
        ok: true,
        component: {
          ...component,
          propsExpanded,
          propTypeHints,
          hooks,
          children,
          propChanges,
          propStateMapping,
        },
        hookChanges,
      };
    } catch (error) {
      return {
        ok: false,
        reason: `Deep inspection failed: ${toErrorMessage(error)}`,
        suggestion: 'Try with lower maxDepth or use inspectComponent for basic info.',
      };
    }
  }

  if (name === 'listContextProviders') {
    const snapshot = collectReactSnapshot(win, doc);
    state.lastSnapshot = snapshot;

    const rootFilter = typeof input.rootId === 'string' ? input.rootId : null;
    const providers: Array<{
      componentId: string;
      contextName: string;
      fullName: string;
      depth: number;
      location: string;
    }> = [];

    for (const comp of snapshot.componentMap.values()) {
      if (rootFilter && comp.rootId !== rootFilter) continue;
      if (!comp.name.endsWith('.Provider')) continue;

      const contextName = comp.name.replace(/\.Provider$/, '');
      providers.push({
        componentId: comp.componentId,
        contextName,
        fullName: comp.name,
        depth: comp.depth,
        location: comp.fiberPath,
      });
    }

    return { ok: true, providerCount: providers.length, providers };
  }

  if (name === 'listSpecialBoundaries') {
    const snapshot = collectReactSnapshot(win, doc);
    state.lastSnapshot = snapshot;

    // Re-walk live fibers to detect special types (Suspense/ErrorBoundary)
    const diagnostics: string[] = [];
    const hook = getDevtoolsHook(win, diagnostics);
    const suspenseBoundaries: Array<{
      componentId: string;
      name: string;
      depth: number;
      fallbackPreview: string;
      childComponentCount: number;
    }> = [];
    const errorBoundaries: Array<{
      componentId: string;
      name: string;
      depth: number;
      hasGetDerivedStateFromError: boolean;
      hasComponentDidCatch: boolean;
    }> = [];

    if (hook) {
      const rendererIds = getRendererIds(hook, diagnostics);
      for (const rid of rendererIds) {
        const fiberRoots = getFiberRoots(hook, rid, diagnostics);
        for (const root of fiberRoots) {
          collectSpecialFibers(root, snapshot, suspenseBoundaries, errorBoundaries, '0', rid);
        }
      }
    }

    return {
      ok: true,
      suspenseBoundaryCount: suspenseBoundaries.length,
      suspenseBoundaries,
      errorBoundaryCount: errorBoundaries.length,
      errorBoundaries,
    };
  }

  if (name === 'analyzeStaleClosures') {
    return analyzeStaleClosures(win, doc, state, input);
  }

  if (name === 'analyzeRenderTriggers') {
    const componentId = typeof input.componentId === 'string' ? input.componentId : '';
    const action = typeof input.action === 'string' ? input.action : '';
    if (!componentId || !action) {
      return { ok: false, reason: 'componentId and action are required.' };
    }
    if (action !== 'capture' && action !== 'compare') {
      return { ok: false, reason: 'action must be either "capture" or "compare".' };
    }
    return handleRenderTriggers(componentId, action, win, state);
  }

  throw new Error(`Unknown React tool: ${name}`);
}

function readReactResource(id: string, win: Window, doc: Document, state: ReactAdapterState) {
  const snapshot = state.lastSnapshot ?? collectReactSnapshot(win, doc);
  state.lastSnapshot = snapshot;

  if (id === RESOURCE_IDS.summary) {
    return toJsonResource(id, {
      reactDetected: snapshot.reactDetected,
      rendererCount: snapshot.rendererCount,
      rootCount: snapshot.roots.length,
      installedAt: state.installedAt,
      lastSelection: state.lastSelection,
      lastComponent: state.lastComponent,
    });
  }

  if (id === RESOURCE_IDS.roots) {
    return toJsonResource(id, {
      reactDetected: snapshot.reactDetected,
      rendererCount: snapshot.rendererCount,
      roots: snapshot.roots,
    });
  }

  if (id === RESOURCE_IDS.selection) {
    return toJsonResource(
      id,
      state.lastSelection ?? { selectedText: '', element: null, nearestComponent: null },
    );
  }

  if (id === RESOURCE_IDS.component) {
    return toJsonResource(id, {
      component: state.lastComponent,
      hasComponent: Boolean(state.lastComponent),
    });
  }

  if (id === RESOURCE_IDS.diagnostics) {
    return toJsonResource(id, {
      diagnostics: snapshot.diagnostics,
      rendererCount: snapshot.rendererCount,
    });
  }

  if (id === RESOURCE_IDS.componentTree) {
    const trees = buildTreesFromComponentMap(snapshot.componentMap, snapshot.roots);
    return toJsonResource(id, {
      reactDetected: snapshot.reactDetected,
      totalComponents: snapshot.componentMap.size,
      roots: snapshot.roots.map((r) => ({
        rootId: r.rootId,
        componentCount: r.componentCount,
        tree: trees.get(r.rootId) ?? [],
      })),
    });
  }

  return toJsonResource(id, { error: `Unknown resource id: ${id}` });
}

function getReactSkillPrompt(
  id: string,
  input: ToolInput,
  win: Window,
  doc: Document,
  state: ReactAdapterState,
) {
  const skill = SKILLS.find((item) => item.id === id);
  if (!skill) {
    return undefined;
  }
  const snapshot = state.lastSnapshot ?? collectReactSnapshot(win, doc);
  state.lastSnapshot = snapshot;
  const normalized = normalizeSkillInput(input);
  return buildSkillPrompt(skill, {
    goal: normalized.goal,
    focus: normalized.focus,
    facts: [
      `reactDetected=${snapshot.reactDetected}`,
      `rendererCount=${snapshot.rendererCount}`,
      `rootCount=${snapshot.roots.length}`,
    ],
  });
}

function collectReactSnapshot(win: Window, doc: Document): ReactSnapshot {
  const diagnostics: string[] = [];
  const hook = getDevtoolsHook(win, diagnostics);
  if (!hook) {
    return {
      reactDetected: false,
      rendererCount: 0,
      roots: [],
      componentMap: new Map(),
      diagnostics,
    };
  }

  const rendererIds = getRendererIds(hook, diagnostics);
  const roots: RootSummary[] = [];
  const componentMap = new Map<string, ComponentSummary>();

  rendererIds.forEach((rendererId) => {
    const fiberRoots = getFiberRoots(hook, rendererId, diagnostics);
    fiberRoots.forEach((root, rootIndex) => {
      const rootId = `renderer:${rendererId}:root:${rootIndex}`;
      const analysis = analyzeRoot(root, rootId, componentMap);
      roots.push({
        rootId,
        rendererId,
        componentCount: analysis.componentCount,
        fiberCount: analysis.fiberCount,
        container: describeContainer(root.containerInfo),
        topComponents: analysis.topComponents,
      });
    });
  });

  if (rendererIds.length === 0) {
    diagnostics.push('The DevTools hook exists, but renderers is empty.');
  }
  if (rendererIds.length > 0 && roots.length === 0) {
    diagnostics.push(
      'Renderers were detected but no roots were found. The page may not have mounted yet.',
    );
  }

  const containerHints = countReactContainerHints(doc);
  if (containerHints > 0 && roots.length === 0) {
    diagnostics.push(
      `Found ${containerHints} React container markers in the DOM, but could not build root summaries.`,
    );
  }

  return {
    reactDetected: rendererIds.length > 0 || containerHints > 0,
    rendererCount: rendererIds.length,
    roots,
    componentMap,
    diagnostics,
  };
}

function analyzeRoot(
  root: FiberRootLike,
  rootId: string,
  componentMap: Map<string, ComponentSummary>,
): { fiberCount: number; componentCount: number; topComponents: string[] } {
  const start = root.current?.child ?? root.current ?? null;
  if (!start) {
    return { fiberCount: 0, componentCount: 0, topComponents: [] };
  }

  let fiberCount = 0;
  let componentCount = 0;
  const topComponents: string[] = [];
  const stack: Array<{
    fiber: FiberNodeLike;
    depth: number;
    path: string;
    parentComponentId: string | null;
  }> = [{ fiber: start, depth: 0, path: '0', parentComponentId: null }];

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) {
      continue;
    }
    fiberCount += 1;

    const displayName = getFiberDisplayName(item.fiber);
    if (displayName) {
      componentCount += 1;
      if (topComponents.length < 8) {
        topComponents.push(displayName);
      }
      const componentId = `${rootId}:fiber:${item.path}`;
      const summary: ComponentSummary = {
        componentId,
        rootId,
        name: displayName,
        depth: item.depth,
        key: readFiberKey(item.fiber),
        propsPreview: previewValue(item.fiber.memoizedProps),
        statePreview: previewValue(item.fiber.memoizedState),
        parentId: item.parentComponentId,
        childrenIds: [],
        fiberPath: item.path,
      };
      componentMap.set(componentId, summary);

      if (item.parentComponentId && componentMap.has(item.parentComponentId)) {
        componentMap.get(item.parentComponentId)!.childrenIds.push(componentId);
      }
    }

    const children = collectFiberChildren(item.fiber);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (!child) {
        continue;
      }
      stack.push({
        fiber: child,
        depth: item.depth + 1,
        path: `${item.path}.${index}`,
        parentComponentId: displayName ? `${rootId}:fiber:${item.path}` : item.parentComponentId,
      });
    }
  }

  return { fiberCount, componentCount, topComponents };
}

function collectFiberChildren(fiber: FiberNodeLike): Array<FiberNodeLike | null> {
  const children: Array<FiberNodeLike | null> = [];
  let child = fiber.child ?? null;
  while (child) {
    children.push(child);
    child = child.sibling ?? null;
  }
  return children;
}

function getDevtoolsHook(win: Window, diagnostics: string[]): ReactDevtoolsHookLike | undefined {
  const hook = (win as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevtoolsHookLike })
    .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) {
    diagnostics.push('Did not detect __REACT_DEVTOOLS_GLOBAL_HOOK__.');
    return undefined;
  }
  return hook;
}

function getRendererIds(hook: ReactDevtoolsHookLike, diagnostics: string[]): number[] {
  if (!(hook.renderers instanceof Map)) {
    diagnostics.push('The DevTools hook does not expose a renderers Map.');
    return [];
  }
  const ids: number[] = [];
  for (const key of hook.renderers.keys()) {
    const numeric = Number(key);
    if (!Number.isFinite(numeric)) {
      diagnostics.push(`Ignoring invalid renderer id: ${String(key)}`);
      continue;
    }
    ids.push(numeric);
  }
  return ids;
}

function getFiberRoots(
  hook: ReactDevtoolsHookLike,
  rendererId: number,
  diagnostics: string[],
): FiberRootLike[] {
  if (typeof hook.getFiberRoots !== 'function') {
    diagnostics.push('The DevTools hook does not expose getFiberRoots.');
    return [];
  }
  try {
    const roots = hook.getFiberRoots(rendererId);
    if (!(roots instanceof Set)) {
      diagnostics.push(`Renderer ${rendererId} returned roots in a non-Set shape.`);
      return [];
    }
    return Array.from(roots).filter((item): item is FiberRootLike => isObjectRecord(item));
  } catch (error) {
    diagnostics.push(`Failed to read roots for renderer ${rendererId}: ${toErrorMessage(error)}`);
    return [];
  }
}

function resolveSelectedElement(win: Window): Element | null {
  const selection = win.getSelection?.();
  if (!selection || selection.rangeCount === 0) {
    return fallbackSelectionElement(win);
  }
  const anchor = selection.anchorNode;
  if (!anchor) {
    return fallbackSelectionElement(win);
  }
  if (anchor instanceof Element) {
    return anchor;
  }
  return anchor.parentElement ?? fallbackSelectionElement(win);
}

function fallbackSelectionElement(win: Window): Element | null {
  const activeElement = win.document.activeElement;
  return activeElement instanceof Element ? activeElement : null;
}

function findNearestFiberFromElement(start: Element | null): FiberNodeLike | null {
  const MAX_DOM_WALK_DEPTH = 12;
  let cursor: Element | null = start;
  let depth = 0;

  while (cursor && depth < MAX_DOM_WALK_DEPTH) {
    const fiber = readFiberFromDomNode(cursor);
    if (fiber) {
      return fiber;
    }
    cursor = getParentElementCrossingShadow(cursor);
    depth += 1;
  }

  return null;
}

function getParentElementCrossingShadow(element: Element): Element | null {
  if (element.parentElement) {
    return element.parentElement;
  }
  try {
    const rootNode = element.getRootNode();
    if (rootNode instanceof ShadowRoot) {
      return rootNode.host;
    }
  } catch {
    // getRootNode may not be available in all environments
  }
  return null;
}

function readFiberFromDomNode(node: Element): FiberNodeLike | null {
  const ownKeys = Object.getOwnPropertyNames(node);

  // Check fiber keys first (host elements like div, span, button)
  const fiberKey = ownKeys.find(
    (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'),
  );
  if (fiberKey) {
    const value = (node as unknown as Record<string, unknown>)[fiberKey];
    if (isObjectRecord(value)) {
      return value as FiberNodeLike;
    }
  }

  // Check container keys (container elements like #app, #root)
  const containerKey = ownKeys.find((key) => key.startsWith('__reactContainer$'));
  if (containerKey) {
    const container = (node as unknown as Record<string, unknown>)[containerKey];
    if (isObjectRecord(container) && isObjectRecord(container.stateNode)) {
      const stateNode = container.stateNode as Record<string, unknown>;
      if (isObjectRecord(stateNode.current) && isObjectRecord(stateNode.current.child)) {
        return stateNode.current.child as FiberNodeLike;
      }
    }
  }

  return null;
}

function buildComponentSummaryFromFiber(
  fiber: FiberNodeLike,
  roots: RootSummary[],
): ComponentSummary | null {
  const name = getFiberDisplayName(fiber);
  if (!name) {
    return null;
  }
  const rootId = roots[0]?.rootId ?? 'renderer:unknown:root:0';
  const path = buildFiberPath(fiber);
  return {
    componentId: `${rootId}:fiber:${path}`,
    rootId,
    name,
    depth: path.split('.').length - 1,
    key: readFiberKey(fiber),
    propsPreview: previewValue(fiber.memoizedProps),
    statePreview: previewValue(fiber.memoizedState),
    parentId: null,
    childrenIds: [],
    fiberPath: path,
  };
}

function buildFiberPath(fiber: FiberNodeLike): string {
  const segments: number[] = [];
  let cursor: FiberNodeLike | null = fiber;
  while (cursor?.return) {
    let index = 0;
    let sibling: FiberNodeLike | null = cursor.return.child ?? null;
    while (sibling && sibling !== cursor) {
      index += 1;
      sibling = sibling.sibling ?? null;
    }
    segments.push(index);
    cursor = cursor.return;
  }
  segments.reverse();
  return segments.length > 0 ? segments.join('.') : '0';
}

function getFiberDisplayName(fiber: FiberNodeLike): string | null {
  const type = fiber.elementType ?? fiber.type;
  if (typeof type === 'string') {
    return type;
  }
  if (typeof type === 'function') {
    const named = type as Function & { displayName?: string };
    return named.displayName || named.name || 'AnonymousComponent';
  }
  if (isObjectRecord(type)) {
    if (typeof type.displayName === 'string' && type.displayName) {
      return type.displayName;
    }
    if (typeof type.render === 'function') {
      const render = type.render as Function & { displayName?: string };
      return render.displayName || render.name || 'AnonymousRender';
    }

    // Detect Context.Provider via _context.displayName
    const contextObj = type._context;
    if (
      isObjectRecord(contextObj) &&
      typeof contextObj.displayName === 'string' &&
      contextObj.displayName
    ) {
      return `${contextObj.displayName}.Provider`;
    }

    // Check nested render prop for wrapped context providers
    if (isObjectRecord(type.render)) {
      const innerContext = (type.render as Record<string, unknown>)._context;
      if (
        isObjectRecord(innerContext) &&
        typeof innerContext.displayName === 'string' &&
        innerContext.displayName
      ) {
        return `${innerContext.displayName}.Provider`;
      }
    }
  }
  return null;
}

function readFiberKey(fiber: FiberNodeLike): string | null {
  if (fiber.key === undefined || fiber.key === null) {
    return null;
  }
  return String(fiber.key);
}

function describeContainer(containerInfo: unknown): string | null {
  if (!isObjectRecord(containerInfo)) {
    return null;
  }
  const nodeName =
    typeof containerInfo.nodeName === 'string' ? containerInfo.nodeName.toLowerCase() : 'unknown';
  const id = typeof containerInfo.id === 'string' && containerInfo.id ? `#${containerInfo.id}` : '';
  const className =
    typeof containerInfo.className === 'string' && containerInfo.className
      ? `.${containerInfo.className.split(/\s+/).filter(Boolean).join('.')}`
      : '';
  return `${nodeName}${id}${className}`;
}

function describeElement(element: Element | null): string | null {
  if (!element) {
    return null;
  }
  const id = element.id ? `#${element.id}` : '';
  const className =
    element.classList.length > 0 ? `.${Array.from(element.classList).join('.')}` : '';
  return `${element.tagName.toLowerCase()}${id}${className}`;
}

function countReactContainerHints(doc: Document): number {
  const root = doc.documentElement ?? doc.body;
  if (!root) {
    return 0;
  }
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let hints = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!(node instanceof Element)) {
      continue;
    }
    const keys = Object.getOwnPropertyNames(node);
    if (keys.some((key) => key.startsWith('__reactContainer$'))) {
      hints += 1;
    }
  }
  return hints;
}

// ─── Deep inspection helpers ────────────────────────────────────────────────

const SAFE_TRAVERSAL_DEFAULTS = { maxKeys: 30, maxArrayLength: 20 } as const;

function safeTraverseValue(
  value: unknown,
  options: SafeTraversalOptions,
  visited: Set<unknown> = new Set(),
  depth: number = 0,
  parentKey?: string,
): unknown {
  const {
    maxKeys = SAFE_TRAVERSAL_DEFAULTS.maxKeys,
    maxArrayLength = SAFE_TRAVERSAL_DEFAULTS.maxArrayLength,
  } = options;

  if (depth > options.maxDepth) {
    return '[max depth reached]';
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return value;
  }

  // Enhancement 3: Event handler classification for functions that are object property values
  if (typeof value === 'function') {
    const namedFn = value as Function & { displayName?: string; name?: string };
    const baseName = namedFn.displayName || namedFn.name || 'anonymous';

    // Only classify when we have parent key context (inside props/object traversal)
    if (parentKey && typeof parentKey === 'string') {
      // SyntheticEvent pattern: onClick, onChange, onSubmit, etc.
      if (/^on[A-Z]/.test(parentKey)) {
        return `[SyntheticEvent: ${parentKey}]`;
      }
      // Handler pattern: handleClick, handleSubmit, etc.
      if (/^handle[A-Z]?/.test(parentKey)) {
        return `[Handler: ${parentKey}]`;
      }
    }

    return `[Function ${baseName}]`;
  }

  if (typeof value === 'symbol') {
    return value.toString();
  }

  if (visited.has(value)) {
    return '[circular]';
  }
  visited.add(value);

  // Enhancement 2: JSX Element rendering - detect React Elements
  if (isObjectRecord(value) && typeof (value as Record<string, unknown>)['$$typeof'] === 'symbol') {
    try {
      const reactElement = value as Record<string, unknown>;
      const elementType = reactElement['$$typeof'];
      // Check for Symbol.for('react.element')
      const expectedSymbol = Symbol.for('react.element');
      if (elementType === expectedSymbol) {
        const type = reactElement['type'];
        const elementKey = reactElement['key'];
        const props = reactElement['props'];

        let componentName: string;
        if (typeof type === 'string') {
          componentName = type;
        } else if (typeof type === 'function') {
          const fnType = type as Function & { displayName?: string; name?: string };
          componentName = fnType.displayName || fnType.name || 'Anonymous';
        } else if (
          isObjectRecord(type) &&
          typeof (type as Record<string, unknown>)['displayName'] === 'string'
        ) {
          componentName = String((type as Record<string, unknown>)['displayName']);
        } else {
          componentName = String(type ?? 'Unknown');
        }

        const keyStr = elementKey != null ? ` key="${String(elementKey)}"` : '';

        // Shallow-preview props (first few keys only)
        let propsPreview = '';
        if (isObjectRecord(props)) {
          const propKeys = Object.keys(props).slice(0, 3);
          const parts = propKeys.map((pk) => `${pk}="${previewValue(props[pk])}"`);
          if (parts.length > 0) {
            propsPreview = ` ${parts.join(' ')}`;
            if (Object.keys(props).length > 3) {
              propsPreview += ' ...';
            }
          }
        }

        return `<${componentName}${keyStr}${propsPreview} />`;
      }
    } catch {
      // Fall through to normal object handling if element parsing fails
    }
  }

  if (Array.isArray(value)) {
    if (value.length > maxArrayLength) {
      return [
        ...value
          .slice(0, maxArrayLength)
          .map((item) => safeTraverseValue(item, options, visited, depth + 1)),
        `... ${value.length - maxArrayLength} more items`,
      ];
    }
    return value.map((item) => safeTraverseValue(item, options, visited, depth + 1));
  }

  if (value instanceof Element) {
    return describeElement(value);
  }

  if (isObjectRecord(value)) {
    const keys = Object.keys(value);
    const result: Record<string, unknown> = {};

    for (let i = 0; i < keys.length && i < maxKeys; i++) {
      const k = keys[i]!;
      try {
        const childValue = (value as Record<string, unknown>)[k];

        // Enhancement 1: Children smart truncation for known heavy prop keys
        if (k === 'children') {
          // Count direct children
          try {
            if (childValue == null) {
              result[k] = '[ReactChildren: count=0]';
            } else if (Array.isArray(childValue)) {
              result[k] = `[ReactChildren: count=${childValue.length}]`;
            } else {
              // Single child or text node
              result[k] = '[ReactChildren: count=1]';
            }
          } catch {
            result[k] = safeTraverseValue(childValue, options, visited, depth + 1, k);
          }
          continue;
        }

        if (k === 'dangerouslySetInnerHTML' || k === 'innerHTML') {
          try {
            const htmlContent =
              k === 'dangerouslySetInnerHTML' && isObjectRecord(childValue)
                ? (childValue as Record<string, unknown>)['__html']
                : childValue;
            const charCount = typeof htmlContent === 'string' ? htmlContent.length : 0;
            result[k] = `[HTML: ${charCount} chars]`;
          } catch {
            result[k] = safeTraverseValue(childValue, options, visited, depth + 1, k);
          }
          continue;
        }

        // Large style objects (>50 keys): keep existing __more__ behavior via normal traversal
        // (the existing maxKeys limit already handles this)

        result[k] = safeTraverseValue(childValue, options, visited, depth + 1, k);
      } catch {
        result[k] = '[error reading]';
      }
    }
    if (keys.length > maxKeys) {
      result['__more__'] = `${keys.length - maxKeys} more keys`;
    }
    return result;
  }

  return Object.prototype.toString.call(value);
}

// ─── Enhancement 4: Prop type inference hints ──────────────────────────────

/**
 * Returns a human-readable type hint string for a given value.
 * Used to provide type information alongside expanded props in inspectComponentDeep.
 */
function inferPropTypeHints(value: unknown): string | null {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return 'string';
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return 'number';
  }

  if (typeof value === 'boolean') {
    return 'boolean';
  }

  if (typeof value === 'function') {
    return 'function';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  if (value instanceof Element) {
    return 'HTMLElement';
  }

  // Object with specific shape patterns - infer record with field types
  if (isObjectRecord(value) && Object.keys(value).length > 0) {
    try {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).slice(0, 10); // Limit field count for display
      const fields = keys.map((k) => {
        const fieldType = inferPropTypeHints(obj[k]);
        return fieldType ? `${k}: ${fieldType}` : k;
      });
      if (fields.length > 0) {
        return `{ ${fields.join(', ')}${keys.length > Object.keys(obj).length ? ', ...' : ''} }`;
      }
    } catch {
      // Fall through
    }
  }

  return null;
}

/**
 * Builds a Record<string, string> mapping prop keys to their inferred type hints.
 */
function buildPropTypeHints(props: Record<string, unknown>): Record<string, string> {
  const hints: Record<string, string> = {};
  try {
    for (const key of Object.keys(props)) {
      const hint = inferPropTypeHints(props[key]);
      if (hint != null) {
        hints[key] = hint;
      }
    }
  } catch {
    // Return partial hints on error
  }
  return hints;
}

function traverseHookChain(memoizedState: unknown, options: SafeTraversalOptions): HookSummary[] {
  const hooks: HookSummary[] = [];
  let cursor: unknown = memoizedState;
  let index = 0;
  const MAX_HOOKS = 50;

  while (cursor && isObjectRecord(cursor) && index < MAX_HOOKS) {
    const rec = cursor as Record<string, unknown>;
    const inferred = inferHookType(rec);

    // Build base summary
    const summary: HookSummary = {
      hookType: inferred.type,
      preview: previewValue(inferred.primaryField ?? rec.memoizedState),
      value:
        inferred.type !== 'effect'
          ? safeTraverseValue(inferred.primaryField ?? rec.memoizedState, {
              ...options,
              maxDepth: Math.min(options.maxDepth, 2),
            })
          : undefined,
    };

    // ── Enhancement 1: Dependency array full expansion for effect/memo/callback hooks ──
    if (inferred.deps !== undefined && Array.isArray(inferred.deps)) {
      summary.depsExpanded = safeTraverseValue(inferred.deps, {
        ...options,
        maxDepth: 4,
      }) as unknown[];
    }

    // ── Enhancement 2: Ref depth check + type annotation for useRef hooks ──
    if (inferred.type === 'useRef') {
      const currentVal = rec.current ?? rec._instance;
      if (currentVal instanceof Element) {
        summary.refType = 'dom';
      } else if (typeof currentVal === 'function') {
        summary.refType = 'function';
      } else if (currentVal === null || currentVal === undefined) {
        summary.refType = 'null';
      } else if (typeof currentVal === 'number') {
        summary.refType = 'number';
      } else if (typeof currentVal === 'string') {
        summary.refType = 'string';
      } else if (isObjectRecord(currentVal)) {
        summary.refType = 'object';
      } else {
        summary.refType = 'unknown';
      }
      // Deeper preview of .current value at depth 3
      summary.refCurrentPreview = previewValue(
        safeTraverseValue(currentVal, { ...options, maxDepth: 3 }),
      );
    }

    // ── Enhancement 3 & 4: Pending update queue inspection + Reducer name extraction ──
    if (inferred.queue && isObjectRecord(inferred.queue)) {
      const queueRec = inferred.queue as Record<string, unknown>;

      // Enhancement 3: Check for pending updates
      if (queueRec.pending !== undefined && queueRec.pending !== null) {
        summary.hasPendingUpdate = true;
      }

      // Enhancement 3: Extract lastRenderedState from queue
      if (queueRec.lastRenderedState !== undefined) {
        summary.lastRenderedStatePreview = previewValue(queueRec.lastRenderedState);
      }

      // Enhancement 4: Extract reducer name for useReducer
      if (
        queueRec.lastRenderedReducer !== undefined &&
        typeof queueRec.lastRenderedReducer === 'function'
      ) {
        const reducerFn = queueRec.lastRenderedReducer as Function & {
          displayName?: string;
          name?: string;
        };
        summary.reducerName = reducerFn.displayName || reducerFn.name || undefined;
        // If we found a reducer, this is likely useReducer not useState
        if (summary.reducerName) {
          summary.hookType = 'useReducer';
        }
      }
    }

    hooks.push(summary);
    cursor = rec.next;
    index += 1;
  }

  if (index >= MAX_HOOKS) {
    hooks.push({ hookType: 'truncated', preview: `... ${MAX_HOOKS}+ hooks` });
  }

  return hooks;
}

interface InferredHook {
  type: string;
  primaryField?: unknown;
  /** Dependency array extracted from hook record (Enhancement 1) */
  deps?: unknown;
  /** Create function for effect/memo hooks (Enhancement 1) */
  create?: unknown;
  /** Destroy/cleanup function for effect hooks (Enhancement 1) */
  destroy?: unknown;
  /** Callback function for useCallback hooks (Enhancement 1) */
  callback?: unknown;
  /** Queue object for state/reducer hooks (Enhancement 3 & 4) */
  queue?: unknown;
}

function inferHookType(hookRecord: Record<string, unknown>): InferredHook {
  // useRef: has _init or _instance but no queue
  if ('_init' in hookRecord || '_instance' in hookRecord) {
    // Check for ref shape: { current: ... }
    if ('current' in hookRecord || '_instance' in hookRecord) {
      return { type: 'useRef', primaryField: hookRecord.current ?? hookRecord._instance };
    }
  }

  // useContext: has context and memoizedValue
  if ('context' in hookRecord && 'memoizedValue' in hookRecord) {
    return { type: 'useContext', primaryField: hookRecord.memoizedValue };
  }

  // useMemo / useCallback: has create/deps or callback/deps
  if ('create' in hookRecord || 'callback' in hookRecord) {
    const isMemo = 'create' in hookRecord;
    return {
      type: isMemo ? 'useMemo' : 'useCallback',
      primaryField: hookRecord.memoizedState,
      deps: hookRecord.deps,
      create: isMemo ? hookRecord.create : undefined,
      callback: !isMemo ? hookRecord.callback : undefined,
    };
  }

  // useEffect / useLayoutEffect: has next with deps/create/destroy pattern
  if ('deps' in hookRecord && ('create' in hookRecord || 'destroy' in hookRecord)) {
    return {
      type: 'useEffect',
      primaryField: hookRecord.deps,
      deps: hookRecord.deps,
      create: hookRecord.create,
      destroy: hookRecord.destroy,
    };
  }

  // useState / useReducer: has queue and memoizedState (most common)
  if ('queue' in hookRecord || 'baseState' in hookRecord) {
    return { type: 'useState', primaryField: hookRecord.memoizedState, queue: hookRecord.queue };
  }

  // Fallback: treat as state-like
  return { type: 'state', primaryField: hookRecord.memoizedState };
}

function findFiberByComponentId(
  snapshot: ReactSnapshot,
  componentId: string,
): FiberNodeLike | null {
  // Cannot resolve fiber from stored summary alone.
  // Return null — caller degrades gracefully (omits propsExpanded/hooks).
  return null;
}

// ─── Live fiber lookup by path ─────────────────────────────────────────────

function findLiveFiberByPath(win: Window, componentId: string): FiberNodeLike | null {
  const colonIdx = componentId.indexOf(':fiber:');
  if (colonIdx < 0) return null;

  const rootPart = componentId.slice(0, colonIdx); // e.g. "renderer:1:root:0"
  const pathPart = componentId.slice(colonIdx + 7); // e.g. "0.1"

  const diagnostics: string[] = [];
  const hook = getDevtoolsHook(win, diagnostics);
  if (!hook) return null;

  const rendererIds = getRendererIds(hook, diagnostics);
  for (const rid of rendererIds) {
    const expectedRootPrefix = `renderer:${rid}:root:`;
    if (!rootPart.startsWith(expectedRootPrefix)) continue;

    const fiberRoots = getFiberRoots(hook, rid, diagnostics);
    for (const root of fiberRoots) {
      const found = findFiberAtPath(root, pathPart.split('.').map(Number));
      if (found) return found;
    }
  }
  return null;
}

function findFiberAtPath(root: FiberRootLike, segments: number[]): FiberNodeLike | null {
  let cursor: FiberNodeLike | null | undefined = root.current?.child ?? root.current;
  if (!cursor) return null;

  for (let i = 0; i < segments.length; i++) {
    if (!cursor) return null;
    const targetIndex = segments[i] ?? 0;
    let child: FiberNodeLike | null = cursor.child ?? null;
    let idx = 0;
    while (child && idx < targetIndex) {
      child = child.sibling ?? null;
      idx += 1;
    }
    cursor = child;
  }

  return cursor ?? null;
}

// ─── Component tree builder ───────────────────────────────────────────────

interface TreeNode {
  componentId: string;
  name: string;
  depth: number;
  key: string | null;
  propsPreview: string;
  statePreview: string;
  children: TreeNode[];
}

const TREE_MAX_DEPTH = 15;

function buildTreesFromComponentMap(
  componentMap: Map<string, ComponentSummary>,
  roots: RootSummary[],
): Map<string, TreeNode[]> {
  const result = new Map<string, TreeNode[]>();

  for (const root of roots) {
    // Find top-level components under this root (parentId is null or points outside this root)
    const topLevel = Array.from(componentMap.values()).filter(
      (c) =>
        c.rootId === root.rootId &&
        (c.parentId === null ||
          !componentMap.has(c.parentId) ||
          componentMap.get(c.parentId)?.rootId !== root.rootId),
    );
    result.set(
      root.rootId,
      topLevel.map((c) => buildTreeNode(c, componentMap, 0)),
    );
  }

  return result;
}

function buildTreeNode(
  comp: ComponentSummary,
  componentMap: Map<string, ComponentSummary>,
  depth: number,
): TreeNode {
  if (depth >= TREE_MAX_DEPTH) {
    return {
      componentId: comp.componentId,
      name: comp.name,
      depth: comp.depth,
      key: comp.key,
      propsPreview: comp.propsPreview,
      statePreview: comp.statePreview,
      children: [],
    };
  }

  const children = comp.childrenIds
    .map((cid) => componentMap.get(cid))
    .filter((c): c is ComponentSummary => c != null)
    .map((c) => buildTreeNode(c, componentMap, depth + 1));

  return {
    componentId: comp.componentId,
    name: comp.name,
    depth: comp.depth,
    key: comp.key,
    propsPreview: comp.propsPreview,
    statePreview: comp.statePreview,
    children,
  };
}

// ─── Special fiber collection ──────────────────────────────────────────────

function collectSpecialFibers(
  root: FiberRootLike,
  snapshot: ReactSnapshot,
  suspenseBoundaries: Array<{
    componentId: string;
    name: string;
    depth: number;
    fallbackPreview: string;
    childComponentCount: number;
  }>,
  errorBoundaries: Array<{
    componentId: string;
    name: string;
    depth: number;
    hasGetDerivedStateFromError: boolean;
    hasComponentDidCatch: boolean;
  }>,
  pathPrefix: string,
  rendererId: number,
): void {
  const start = root.current?.child ?? root.current ?? null;
  if (!start) return;

  const stack: Array<{ fiber: FiberNodeLike; path: string; depth: number }> = [
    { fiber: start, path: pathPrefix, depth: 0 },
  ];
  const rootId = `renderer:${rendererId}:root:0`;

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) continue;

    const componentId = `${rootId}:fiber:${item.path}`;
    const displayName = getFiberDisplayName(item.fiber);

    // Detect Suspense
    if (displayName === 'Suspense') {
      suspenseBoundaries.push({
        componentId,
        name: displayName,
        depth: item.depth,
        fallbackPreview: previewValue(item.fiber.memoizedProps),
        childComponentCount: snapshot.componentMap.get(componentId)?.childrenIds.length ?? 0,
      });
    }

    // Detect Error Boundary (class components with error handling methods)
    const type = item.fiber.elementType ?? item.fiber.type;
    if (typeof type === 'function') {
      const proto = (type as Function).prototype;
      const hasStatic =
        typeof (type as unknown as Record<string, unknown>).getDerivedStateFromError === 'function';
      const hasInstance = typeof proto?.componentDidCatch === 'function';
      if (hasStatic || hasInstance) {
        errorBoundaries.push({
          componentId,
          name: displayName ?? 'Unknown',
          depth: item.depth,
          hasGetDerivedStateFromError: hasStatic,
          hasComponentDidCatch: hasInstance,
        });
      }
    }

    const children = collectFiberChildren(item.fiber);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) stack.push({ fiber: child, path: `${item.path}.${i}`, depth: item.depth + 1 });
    }
  }
}

// ─── Enhancement 1: Prop diff snapshot ─────────────────────────────────────

const MAX_PROP_SNAPSHOTS = 20;

interface PropChanges {
  added: string[];
  removed: string[];
  changed: Array<{ key: string; oldValue: unknown; newValue: unknown }>;
}

function computePropDiff(
  componentId: string,
  propsExpanded: unknown,
  propSnapshots: Map<string, { hash: string; propsExpanded: unknown }>,
): PropChanges | undefined {
  const currentHash = JSON.stringify(propsExpanded ?? {}).slice(0, 500);
  const previousSnapshot = propSnapshots.get(componentId);

  // Store current snapshot with LRU eviction (max 20 entries)
  if (propSnapshots.size >= MAX_PROP_SNAPSHOTS) {
    const firstKey = propSnapshots.keys().next().value;
    if (firstKey !== undefined) {
      propSnapshots.delete(firstKey);
    }
  }
  propSnapshots.set(componentId, { hash: currentHash, propsExpanded });

  if (!previousSnapshot) {
    return undefined;
  }

  // Keep output stable for callers that want a "second call" diff signal.
  if (previousSnapshot.hash === currentHash) {
    return { added: [], removed: [], changed: [] };
  }

  // Compute field-level diff
  const oldObj = isObjectRecord(previousSnapshot.propsExpanded)
    ? (previousSnapshot.propsExpanded as Record<string, unknown>)
    : {};
  const newObj = isObjectRecord(propsExpanded) ? (propsExpanded as Record<string, unknown>) : {};

  const oldKeys = new Set(Object.keys(oldObj));
  const newKeys = new Set(Object.keys(newObj));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ key: string; oldValue: unknown; newValue: unknown }> = [];

  for (const key of Array.from(newKeys)) {
    if (!oldKeys.has(key)) {
      added.push(key);
    } else if (JSON.stringify(oldObj[key]) !== JSON.stringify(newObj[key])) {
      changed.push({ key, oldValue: oldObj[key], newValue: newObj[key] });
    }
  }

  for (const key of Array.from(oldKeys)) {
    if (!newKeys.has(key)) {
      removed.push(key);
    }
  }

  return { added, removed, changed };
}

// ─── Enhancement 4: Prop-to-state mapping heuristic ────────────────────────

interface PropStateMappingEntry {
  propKey: string;
  relation: string;
  targetHookIndex?: number;
}

function computePropStateMapping(
  propKeys: string[],
  hooks: HookSummary[],
): PropStateMappingEntry[] {
  const mapping: PropStateMappingEntry[] = [];

  // Collect useState hook indices and their value types
  const stateHookIndices: number[] = [];
  const stateValueTypes: Array<'array' | 'object' | 'other'> = [];
  hooks.forEach((hook, idx) => {
    if (hook.hookType === 'useState') {
      stateHookIndices.push(idx);
      const val = hook.value;
      if (Array.isArray(val)) {
        stateValueTypes.push('array');
      } else if (isObjectRecord(val)) {
        stateValueTypes.push('object');
      } else {
        stateValueTypes.push('other');
      }
    }
  });

  // Check if any hook directly consumes a function prop (heuristic: check preview for handler-like strings)
  const consumedHandlerProps = new Set<string>();
  for (const hook of hooks) {
    if (
      typeof hook.preview === 'string' &&
      (hook.preview.startsWith('[SyntheticEvent:') || hook.preview.startsWith('[Handler:'))
    ) {
      // Extract prop key from preview format "[SyntheticEvent: onClick]" or "[Handler: handleClick]"
      const match = hook.preview.match(/\[SyntheticEvent:\s*(\w+)\]|\[Handler:\s*(\w+)\]/);
      if (match) {
        consumedHandlerProps.add(match[1] ?? match[2]);
      }
    }
  }

  for (const propKey of propKeys) {
    // Rule: defaultValue / initialValue / value -> likely initializes first useState
    if (
      (propKey === 'defaultValue' || propKey === 'initialValue' || propKey === 'value') &&
      stateHookIndices.length > 0
    ) {
      mapping.push({
        propKey,
        relation: `likely initializes state[${stateHookIndices[0]}]`,
        targetHookIndex: stateHookIndices[0],
      });
      continue;
    }

    // Rule: items / data / list -> may feed a state holding an array
    if (propKey === 'items' || propKey === 'data' || propKey === 'list') {
      const arrayStateIdx = stateValueTypes.findIndex((t) => t === 'array');
      if (arrayStateIdx >= 0) {
        mapping.push({
          propKey,
          relation: `may feed state[${stateHookIndices[arrayStateIdx]}]`,
          targetHookIndex: stateHookIndices[arrayStateIdx],
        });
      } else {
        mapping.push({ propKey, relation: 'may feed state (no array state found)' });
      }
      continue;
    }

    // Rule: Function props starting with 'on' that are not consumed by any hook
    if (/^on[A-Z]/.test(propKey)) {
      if (!consumedHandlerProps.has(propKey)) {
        mapping.push({ propKey, relation: 'event handler (untracked)' });
      } else {
        mapping.push({ propKey, relation: 'event handler (consumed by hook)' });
      }
      continue;
    }
  }

  return mapping;
}

// ─── Enhancement 2: Stale closure detection ─────────────────────────────────

interface StaleClosureFinding {
  componentId: string;
  componentName: string;
  severity: 'high' | 'medium' | 'low';
  rule: string;
  message: string;
  hookIndex: number;
  details?: Record<string, unknown>;
}

/** Patterns that suggest reactive variables that should be in deps */
const REACTIVE_PROP_PATTERNS = [
  /^(.*)(Id|ID|Uuid|UUID)$/,
  /^(.*)(List|Items|Rows|Entries|Options|Choices)$/,
  /^(.*)(Count|Total|Size|Length|Num)$/,
  /^(.*)(Status|State|Mode|Phase|Step)$/,
  /^(.*)(Value|Val|Data|Payload|Config|Settings)$/,
  /^(.*)(Enabled|Disabled|Visible|Hidden|Open|Closed|Active|Selected|Checked)$/,
  /^(.*)(Url|URI|Path|Route|Query|Params)$/,
  /^(.*)(Token|Key|Secret|Auth|Session|User|Account|Profile)$/,
];

function analyzeStaleClosures(
  win: Window,
  _doc: Document,
  _state: ReactAdapterState,
  input: ToolInput,
):
  | { ok: true; findings: StaleClosureFinding[]; componentCount: number }
  | { ok: false; reason: string } {
  const rootFilter = typeof input.rootId === 'string' ? input.rootId : null;

  const diagnostics: string[] = [];
  const hook = getDevtoolsHook(win, diagnostics);
  if (!hook) {
    return { ok: false, reason: 'React DevTools hook not detected on this page.' };
  }

  const snapshot = collectReactSnapshot(win, _doc);
  const findings: StaleClosureFinding[] = [];

  const rendererIds = getRendererIds(hook, diagnostics);
  for (const rid of rendererIds) {
    const fiberRoots = getFiberRoots(hook, rid, diagnostics);
    for (const root of fiberRoots) {
      walkFibersForStaleClosures(root, snapshot, rootFilter, rid, findings, '0');
    }
  }

  return { ok: true, findings, componentCount: snapshot.componentMap.size };
}

function walkFibersForStaleClosures(
  root: FiberRootLike,
  snapshot: ReactSnapshot,
  rootFilter: string | null,
  rendererId: number,
  findings: StaleClosureFinding[],
  pathPrefix: string,
): void {
  const start = root.current?.child ?? root.current ?? null;
  if (!start) return;

  const stack: Array<{ fiber: FiberNodeLike; path: string; depth: number }> = [
    { fiber: start, path: pathPrefix, depth: 0 },
  ];
  const rootId = `renderer:${rendererId}:root:0`;

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) continue;

    const componentId = `${rootId}:fiber:${item.path}`;
    const displayName = getFiberDisplayName(item.fiber);
    if (!displayName) {
      // Still traverse children even for non-component fibers
      const children = collectFiberChildren(item.fiber);
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (child) stack.push({ fiber: child, path: `${item.path}.${i}`, depth: item.depth + 1 });
      }
      continue;
    }

    // Apply scope filter
    if (rootFilter && !componentId.startsWith(rootFilter)) {
      const children = collectFiberChildren(item.fiber);
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (child) stack.push({ fiber: child, path: `${item.path}.${i}`, depth: item.depth + 1 });
      }
      continue;
    }

    // Analyze this component's hooks for stale closures
    analyzeComponentHooks(item.fiber, componentId, displayName, item.depth, findings);

    const children = collectFiberChildren(item.fiber);
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) stack.push({ fiber: child, path: `${item.path}.${i}`, depth: item.depth + 1 });
    }
  }
}

function analyzeComponentHooks(
  fiber: FiberNodeLike,
  componentId: string,
  componentName: string,
  depth: number,
  findings: StaleClosureFinding[],
): void {
  const memoizedState = fiber.memoizedState;
  if (!memoizedState || !isObjectRecord(memoizedState)) return;

  // Collect all hooks for analysis
  const hookEntries: Array<{
    index: number;
    type: string;
    deps: unknown;
    create?: unknown;
    callback?: unknown;
    refCurrent?: unknown;
  }> = [];

  let cursor: unknown = memoizedState;
  let index = 0;
  const MAX_HOOKS = 50;

  while (cursor && isObjectRecord(cursor) && index < MAX_HOOKS) {
    const rec = cursor as Record<string, unknown>;
    const inferred = inferHookType(rec);

    hookEntries.push({
      index,
      type: inferred.type,
      deps: rec.deps,
      create: rec.create,
      callback: rec.callback,
      refCurrent: rec.current,
    });

    cursor = rec.next;
    index += 1;
  }

  // Get component's prop keys for Rule 2 analysis
  const propKeys = isObjectRecord(fiber.memoizedProps)
    ? Object.keys(fiber.memoizedProps as Record<string, unknown>)
    : [];

  // Apply rules per hook
  for (const entry of hookEntries) {
    // --- Rule 1: Empty deps with external references ---
    if (
      (entry.type === 'useEffect' || entry.type === 'useMemo' || entry.type === 'useCallback') &&
      entry.deps !== undefined
    ) {
      const isEmptyDeps =
        (Array.isArray(entry.deps) && entry.deps.length === 0) ||
        (Array.isArray(entry.deps) && entry.deps.length === 1 && entry.deps[0] === undefined);

      if (isEmptyDeps) {
        const fnToCheck = entry.create ?? entry.callback;
        if (fnToCheck && typeof fnToCheck === 'function') {
          const fnStr = fnToCheck.toString();
          const hasOuterReferences = fnStr.length > 80 && /\b(this|props|state)\b/.test(fnStr);
          if (hasOuterReferences) {
            findings.push({
              componentId,
              componentName,
              severity: 'high',
              rule: 'empty-deps-with-external-references',
              message: `${entry.type} at hook[${entry.index}] has empty deps but create/callback appears to reference outer scope variables.`,
              hookIndex: entry.index,
              details: { hookType: entry.type, fnLength: fnStr.length },
            });
          }
        }
      }
    }

    // --- Rule 3: Stale ref pattern ---
    if (entry.type === 'useRef' && entry.refCurrent !== undefined) {
      if (entry.refCurrent instanceof Element && depth > 8) {
        findings.push({
          componentId,
          componentName,
          severity: 'low',
          rule: 'stale-ref-deep-dom',
          message: `useRef at hook[${entry.index}] holds a DOM element reference at depth ${depth}, which may become stale if parent unmounts.`,
          hookIndex: entry.index,
          details: { refType: 'dom', depth },
        });
      }
    }
  }

  // --- Rule 2: Missing dependency ---
  const reactivePropKeys = propKeys.filter((key) =>
    REACTIVE_PROP_PATTERNS.some((pattern) => pattern.test(key)),
  );

  if (reactivePropKeys.length > 0 && hookEntries.some((e) => e.type === 'useEffect')) {
    for (const entry of hookEntries) {
      if (entry.type !== 'useEffect') continue;

      const hasDeps = Array.isArray(entry.deps) && entry.deps.length > 0;
      const isEmptyOrMissing = !hasDeps || (Array.isArray(entry.deps) && entry.deps.length === 0);

      if (isEmptyOrMissing && reactivePropKeys.length > 0) {
        findings.push({
          componentId,
          componentName,
          severity: 'medium',
          rule: 'missing-reactive-dependency',
          message: `useEffect at hook[${entry.index}] has ${Array.isArray(entry.deps) ? 'empty' : 'no'} deps array, but component has reactive-looking props: ${reactivePropKeys.slice(0, 5).join(', ')}.`,
          hookIndex: entry.index,
          details: {
            reactiveProps: reactivePropKeys.slice(0, 10),
            depsCount: Array.isArray(entry.deps) ? entry.deps.length : 0,
          },
        });
        break;
      }
    }
  }
}

// ─── Enhancement 3: Render trigger attribution ─────────────────────────────

const MAX_RENDER_BASELINES = 10;

function handleRenderTriggers(
  componentId: string,
  action: string,
  win: Window,
  state: ReactAdapterState,
):
  | { ok: true; action: 'capture'; capturedAt: string; message: string }
  | { ok: true; action: 'compare'; capturedAt: string; triggers: RenderTriggerResult }
  | { ok: false; reason: string } {
  if (action === 'capture') {
    const fiber = findLiveFiberByPath(win, componentId);
    if (!fiber) {
      return { ok: false, reason: `Cannot resolve live fiber for component: ${componentId}` };
    }

    const capturedAt = new Date().toISOString();
    const propsSnapshot = safeTraverseValue(fiber.memoizedProps, { maxDepth: 4 });
    const hooks = traverseHookChain(fiber.memoizedState, { maxDepth: 2 });
    const stateHooksPreview = hooks.map((h) => `[${h.hookType}] ${h.preview}`);

    // LRU eviction (max 10 entries)
    if (state.renderBaselines.size >= MAX_RENDER_BASELINES) {
      const firstKey = state.renderBaselines.keys().next().value;
      if (firstKey !== undefined) {
        state.renderBaselines.delete(firstKey);
      }
    }
    state.renderBaselines.set(componentId, { capturedAt, propsSnapshot, stateHooksPreview });

    return {
      ok: true,
      action: 'capture',
      capturedAt,
      message: `Baseline captured for ${componentId} at ${capturedAt}.`,
    };
  }

  // action === "compare"
  const baseline = state.renderBaselines.get(componentId);
  if (!baseline) {
    return {
      ok: false,
      reason: `No baseline found for component: ${componentId}. Call with action="capture" first.`,
    };
  }

  const fiber = findLiveFiberByPath(win, componentId);
  if (!fiber) {
    return { ok: false, reason: `Cannot resolve live fiber for component: ${componentId}` };
  }

  const currentProps = safeTraverseValue(fiber.memoizedProps, { maxDepth: 4 });
  const currentHooks = traverseHookChain(fiber.memoizedState, { maxDepth: 2 });
  const currentStatePreviews = currentHooks.map((h) => `[${h.hookType}] ${h.preview}`);

  const triggers = computeRenderTriggers(
    baseline.propsSnapshot,
    currentProps,
    baseline.stateHooksPreview,
    currentStatePreviews,
  );

  return { ok: true, action: 'compare', capturedAt: baseline.capturedAt, triggers };
}

interface RenderTriggerResult {
  propsChanged: boolean;
  stateChanged: boolean;
  changedPropKeys: string[];
  changedHookIndices: number[];
  likelyCause: string;
}

function computeRenderTriggers(
  baselineProps: unknown,
  currentProps: unknown,
  baselineStatePreviews: string[],
  currentStatePreviews: string[],
): RenderTriggerResult {
  const baseObj = isObjectRecord(baselineProps) ? (baselineProps as Record<string, unknown>) : {};
  const currObj = isObjectRecord(currentProps) ? (currentProps as Record<string, unknown>) : {};

  const changedPropKeys: string[] = [];
  const baseKeys = Object.keys(baseObj);
  const currKeys = Object.keys(currObj);

  for (const key of currKeys) {
    if (!(key in baseObj) || JSON.stringify(baseObj[key]) !== JSON.stringify(currObj[key])) {
      changedPropKeys.push(key);
    }
  }
  for (const key of baseKeys) {
    if (!(key in currKeys)) {
      changedPropKeys.push(key);
    }
  }

  const changedHookIndices: number[] = [];
  const maxLen = Math.max(baselineStatePreviews.length, currentStatePreviews.length);
  for (let i = 0; i < maxLen; i++) {
    const prev = baselineStatePreviews[i];
    const curr = currentStatePreviews[i];
    if ((prev ?? '') !== (curr ?? '')) {
      changedHookIndices.push(i);
    }
  }

  const parts: string[] = [];
  if (changedPropKeys.length > 0) {
    parts.push(
      `props changed: ${changedPropKeys.slice(0, 5).join(', ')}${changedPropKeys.length > 5 ? ` (+${changedPropKeys.length - 5} more)` : ''}`,
    );
  }
  if (changedHookIndices.length > 0) {
    parts.push(
      `state/hooks changed at indices: [${changedHookIndices.slice(0, 5).join(', ')}${changedHookIndices.length > 5 ? '...' : ''}]`,
    );
  }
  if (parts.length === 0) {
    parts.push('no changes detected between baseline and current state');
  }

  return {
    propsChanged: changedPropKeys.length > 0,
    stateChanged: changedHookIndices.length > 0,
    changedPropKeys,
    changedHookIndices,
    likelyCause: parts.join('; '),
  };
}
