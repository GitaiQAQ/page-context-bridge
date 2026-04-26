# React Userscript Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `packages/page-context-userscripts` subproject that builds a Tampermonkey-style React inspection userscript which injects a standards-compliant `window.__pageContextBridge__` for agent-facing React analysis.

**Architecture:** Create one monorepo package with a single React inspection entrypoint that discovers React through the global DevTools hook, exposes a `react` namespace with readonly resources, skills, and tools, and emits a `.user.js` bundle. Keep the package logically decoupled from the core bridge runtime by depending only on the shared public protocol types from `@page-context/shared-protocol`.

**Tech Stack:** TypeScript, Vite library build, Vitest, userscript metadata banner, `@page-context/shared-protocol`

---

## File map

- Create: `packages/page-context-userscripts/package.json`
  - New workspace package definition and scripts.
- Create: `packages/page-context-userscripts/tsconfig.json`
  - TypeScript config for the userscript package.
- Create: `packages/page-context-userscripts/vite.config.ts`
  - Multi-step userscript bundle config and banner injection.
- Create: `packages/page-context-userscripts/README.md`
  - Package-specific purpose and usage notes.
- Create: `packages/page-context-userscripts/src/shared/bridge-meta.ts`
  - Helpers for injected bridge/provider metadata.
- Create: `packages/page-context-userscripts/src/shared/serialization.ts`
  - Safe preview/JSON serialization helpers for props/state/hook values.
- Create: `packages/page-context-userscripts/src/react-inspector/detect-react.ts`
  - Detect React DevTools hook/renderers and basic availability.
- Create: `packages/page-context-userscripts/src/react-inspector/fiber-tree.ts`
  - Normalize fiber IDs and summarize component nodes.
- Create: `packages/page-context-userscripts/src/react-inspector/roots.ts`
  - Enumerate React roots and root summaries.
- Create: `packages/page-context-userscripts/src/react-inspector/inspect-component.ts`
  - Return detailed readonly component inspection payloads.
- Create: `packages/page-context-userscripts/src/react-inspector/resources.ts`
  - Build `react.summary`, `react.roots`, `react.selection`, `react.component`, and `react.diagnostics` resources.
- Create: `packages/page-context-userscripts/src/react-inspector/tools.ts`
  - Build readonly `react.primary.*` tool definitions.
- Create: `packages/page-context-userscripts/src/react-inspector/skills.ts`
  - Build analysis-oriented React skills.
- Create: `packages/page-context-userscripts/src/react-inspector/manifest.ts`
  - Build the injected manifest.
- Create: `packages/page-context-userscripts/src/react-inspector/index.ts`
  - Assemble and inject `window.__pageContextBridge__`.
- Create: `packages/page-context-userscripts/src/react-inspector/index.test.ts`
  - Package-level tests for detection, resources, skills, and injection.
- Modify: `package.json`
  - Add a script for building/typechecking/testing the userscripts package if needed.
- Test: `packages/page-context-userscripts/src/react-inspector/index.test.ts`

### Task 1: Scaffold the userscript package

**Files:**

- Create: `packages/page-context-userscripts/package.json`
- Create: `packages/page-context-userscripts/tsconfig.json`
- Create: `packages/page-context-userscripts/vite.config.ts`
- Create: `packages/page-context-userscripts/README.md`
- Modify: `package.json:8-15`

- [ ] **Step 1: Write the failing package layout expectation**

Create this checklist in your notes before editing:

```md
- page-context-userscripts exists as a workspace package
- package can build a react-inspector userscript bundle
- package can run typecheck
- package can run a focused vitest suite
- root scripts can target the new package
```

- [ ] **Step 2: Verify the package does not exist yet**

Run:

```bash
ls packages/page-context-userscripts
```

Expected:

- `ls: packages/page-context-userscripts: No such file or directory`

- [ ] **Step 3: Create the package manifest**

Write `packages/page-context-userscripts/package.json` with this content:

```json
{
  "name": "@page-context/userscripts",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "files": ["dist"],
  "scripts": {
    "build": "pnpm --filter @page-context/shared-protocol build && vite build",
    "typecheck": "pnpm --filter @page-context/shared-protocol build && tsc -p tsconfig.json --noEmit",
    "test": "pnpm --filter @page-context/shared-protocol build && pnpm --dir ../.. exec vitest run packages/page-context-userscripts/src/react-inspector/index.test.ts"
  },
  "dependencies": {
    "@page-context/shared-protocol": "workspace:*"
  },
  "devDependencies": {
    "vite": "^8.0.8"
  },
  "license": "MIT"
}
```

- [ ] **Step 4: Create the TypeScript config**

Write `packages/page-context-userscripts/tsconfig.json` with this content:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "vite.config.ts"]
}
```

- [ ] **Step 5: Create the initial Vite config for `.user.js` output**

Write `packages/page-context-userscripts/vite.config.ts` with this content:

```ts
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const banner = `// ==UserScript==
// @name         Page Context React Inspector
// @namespace    https://github.com/page-context-bridge
// @version      0.0.1
// @description  Injects a Page Context Bridge for React inspection
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==`;

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/react-inspector/index.ts'),
      formats: ['es'],
      fileName: () => 'react-inspector.user.js',
    },
    rollupOptions: {
      output: {
        banner,
      },
    },
    minify: false,
    target: 'es2022',
  },
});
```

- [ ] **Step 6: Create the package README**

Write `packages/page-context-userscripts/README.md` with this content:

```md
# @page-context/userscripts

Userscript-based external page bridge implementations for Page Context Bridge.

The first entrypoint is a React inspection userscript that injects a standards-compliant `window.__pageContextBridge__` into React pages so the core project can compile it into MCP without site-specific runtime logic.
```

- [ ] **Step 7: Add root convenience scripts**

Update the root `package.json` scripts block to include:

```json
"userscripts:build": "pnpm --filter @page-context/userscripts build",
"userscripts:typecheck": "pnpm --filter @page-context/userscripts typecheck",
"userscripts:test": "pnpm --filter @page-context/userscripts test"
```

- [ ] **Step 8: Run typecheck to verify the scaffold fails for missing source files**

Run:

```bash
pnpm --filter @page-context/userscripts typecheck
```

Expected:

- FAIL because `src/react-inspector/index.ts` does not exist yet

### Task 2: Add shared metadata and serialization helpers

**Files:**

- Create: `packages/page-context-userscripts/src/shared/bridge-meta.ts`
- Create: `packages/page-context-userscripts/src/shared/serialization.ts`
- Test: `packages/page-context-userscripts/src/react-inspector/index.test.ts`

- [ ] **Step 1: Write the failing test for shared helpers**

Create `packages/page-context-userscripts/src/react-inspector/index.test.ts` with this initial test block:

```ts
import { describe, expect, it } from 'vitest';

import { createBridgeMeta } from '../shared/bridge-meta';
import { createValuePreview } from '../shared/serialization';

describe('shared helpers', () => {
  it('creates injected bridge metadata', () => {
    expect(createBridgeMeta('react-inspector', '0.0.1')).toEqual({
      bridgeSource: 'injected',
      bridgeProvider: 'page-context-userscripts/react-inspector',
      bridgeVersion: '0.0.1',
    });
  });

  it('summarizes nested values safely', () => {
    expect(
      createValuePreview({
        ok: true,
        nested: { count: 1, items: [1, 2, 3, 4] },
      }),
    ).toEqual({
      ok: true,
      nested: {
        count: 1,
        items: [1, 2, 3, '…'],
      },
    });
  });
});
```

- [ ] **Step 2: Run the shared helper tests and verify they fail**

Run:

```bash
pnpm --filter @page-context/userscripts test
```

Expected:

- FAIL with module-not-found errors for `bridge-meta` and `serialization`

- [ ] **Step 3: Implement bridge metadata helper**

Write `packages/page-context-userscripts/src/shared/bridge-meta.ts` with this content:

```ts
export interface InjectedBridgeMeta {
  bridgeSource: 'injected';
  bridgeProvider: string;
  bridgeVersion: string;
}

export function createBridgeMeta(name: string, version: string): InjectedBridgeMeta {
  return {
    bridgeSource: 'injected',
    bridgeProvider: `page-context-userscripts/${name}`,
    bridgeVersion: version,
  };
}
```

- [ ] **Step 4: Implement safe preview serialization**

Write `packages/page-context-userscripts/src/shared/serialization.ts` with this content:

```ts
const MAX_DEPTH = 2;
const MAX_ITEMS = 3;

export function createValuePreview(value: unknown, depth = 0): unknown {
  if (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ITEMS)
      .map((entry) => createValuePreview(entry, depth + 1))
      .concat(value.length > MAX_ITEMS ? ['…'] : []);
  }

  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) {
      return '[Object]';
    }

    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS);
    return Object.fromEntries(
      entries.map(([key, entry]) => [key, createValuePreview(entry, depth + 1)]),
    );
  }

  return String(value);
}
```

- [ ] **Step 5: Run the shared helper tests again**

Run:

```bash
pnpm --filter @page-context/userscripts test
```

Expected:

- PASS for the `shared helpers` tests

### Task 3: Detect React and summarize roots/components

**Files:**

- Create: `packages/page-context-userscripts/src/react-inspector/detect-react.ts`
- Create: `packages/page-context-userscripts/src/react-inspector/fiber-tree.ts`
- Create: `packages/page-context-userscripts/src/react-inspector/roots.ts`
- Modify: `packages/page-context-userscripts/src/react-inspector/index.test.ts`

- [ ] **Step 1: Add failing tests for React detection and root summaries**

Append this block to `packages/page-context-userscripts/src/react-inspector/index.test.ts`:

```ts
import { detectReactEnvironment } from './detect-react';
import { listReactRoots } from './roots';

describe('react detection', () => {
  it('detects the React DevTools hook', () => {
    const hook = {
      renderers: new Map([[1, { version: '18.3.1' }]]),
      getFiberRoots: () => new Set(),
    };

    expect(detectReactEnvironment({ __REACT_DEVTOOLS_GLOBAL_HOOK__: hook })).toMatchObject({
      detected: true,
      rendererCount: 1,
      reactVersion: '18.3.1',
    });
  });

  it('lists root summaries from the hook', () => {
    const root = {
      current: {
        type: { displayName: 'App' },
        child: null,
      },
      containerInfo: { tagName: 'DIV' },
    };

    const hook = {
      renderers: new Map([[1, { version: '18.3.1' }]]),
      getFiberRoots: () => new Set([root]),
    };

    const roots = listReactRoots(hook);
    expect(roots).toEqual([
      {
        rootId: 'root-1',
        displayName: 'App',
        containerTag: 'DIV',
        childCount: 0,
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm --filter @page-context/userscripts test
```

Expected:

- FAIL with missing module errors for `detect-react` and `roots`

- [ ] **Step 3: Implement React detection**

Write `packages/page-context-userscripts/src/react-inspector/detect-react.ts` with this content:

```ts
export interface ReactEnvironmentSummary {
  detected: boolean;
  hookPresent: boolean;
  rendererCount: number;
  reactVersion: string | null;
}

export function detectReactEnvironment(target: Record<string, unknown>): ReactEnvironmentSummary {
  const hook = target.__REACT_DEVTOOLS_GLOBAL_HOOK__ as
    | { renderers?: Map<unknown, { version?: string }> }
    | undefined;

  const renderers = hook?.renderers instanceof Map ? [...hook.renderers.values()] : [];

  return {
    detected: Boolean(hook),
    hookPresent: Boolean(hook),
    rendererCount: renderers.length,
    reactVersion:
      renderers.find((renderer) => typeof renderer.version === 'string')?.version ?? null,
  };
}
```

- [ ] **Step 4: Implement fiber/root summarization**

Write `packages/page-context-userscripts/src/react-inspector/fiber-tree.ts` with this content:

```ts
export interface FiberSummary {
  componentId: string;
  displayName: string;
}

export function getDisplayName(
  node: { type?: { displayName?: string; name?: string } } | null | undefined,
): string {
  return node?.type?.displayName ?? node?.type?.name ?? 'Anonymous';
}
```

Write `packages/page-context-userscripts/src/react-inspector/roots.ts` with this content:

```ts
import { getDisplayName } from './fiber-tree';

export interface ReactRootSummary {
  rootId: string;
  displayName: string;
  containerTag: string;
  childCount: number;
}

export function listReactRoots(hook: {
  renderers?: Map<unknown, unknown>;
  getFiberRoots?: (
    rendererId: unknown,
  ) => Set<{ current?: { child?: unknown; type?: unknown }; containerInfo?: { tagName?: string } }>;
}): ReactRootSummary[] {
  if (!(hook.renderers instanceof Map) || typeof hook.getFiberRoots !== 'function') {
    return [];
  }

  const summaries: ReactRootSummary[] = [];
  let rootIndex = 0;

  for (const rendererId of hook.renderers.keys()) {
    for (const root of hook.getFiberRoots(rendererId)) {
      rootIndex += 1;
      summaries.push({
        rootId: `root-${rootIndex}`,
        displayName: getDisplayName(
          root.current as { type?: { displayName?: string; name?: string } },
        ),
        containerTag: root.containerInfo?.tagName ?? 'UNKNOWN',
        childCount: root.current?.child ? 1 : 0,
      });
    }
  }

  return summaries;
}
```

- [ ] **Step 5: Run the tests again**

Run:

```bash
pnpm --filter @page-context/userscripts test
```

Expected:

- PASS for `shared helpers` and `react detection`

### Task 4: Build resources, skills, and tools for the `react` namespace

**Files:**

- Create: `packages/page-context-userscripts/src/react-inspector/inspect-component.ts`
- Create: `packages/page-context-userscripts/src/react-inspector/resources.ts`
- Create: `packages/page-context-userscripts/src/react-inspector/skills.ts`
- Create: `packages/page-context-userscripts/src/react-inspector/tools.ts`
- Create: `packages/page-context-userscripts/src/react-inspector/manifest.ts`
- Modify: `packages/page-context-userscripts/src/react-inspector/index.test.ts`

- [ ] **Step 1: Add failing tests for resources, skills, and tools**

Append this block to `packages/page-context-userscripts/src/react-inspector/index.test.ts`:

```ts
import { buildManifest } from './manifest';
import { buildReactResources } from './resources';
import { buildReactSkills } from './skills';
import { createReactToolInstance } from './tools';

describe('react bridge contract', () => {
  it('builds readonly resources and skills', () => {
    const resources = buildReactResources({
      summary: { detected: true, rendererCount: 1 },
      roots: [{ rootId: 'root-1', displayName: 'App', containerTag: 'DIV', childCount: 0 }],
      selection: { hasSelection: false },
      diagnostics: { detected: true, hookPresent: true, issues: [], warnings: [] },
    });

    expect(resources.list()).toHaveLength(5);
    expect(buildReactSkills()).toHaveLength(3);
  });

  it('creates readonly react tools', () => {
    const instance = createReactToolInstance({
      listRoots: () => [
        { rootId: 'root-1', displayName: 'App', containerTag: 'DIV', childCount: 0 },
      ],
      inspectSelectedElement: () => ({ hasSelection: false }),
      inspectComponent: ({ componentId }) => ({ componentId, displayName: 'App' }),
    });

    expect(instance.listTools().map((tool) => tool.name)).toEqual([
      'listRoots',
      'inspectComponent',
      'inspectSelectedElement',
    ]);
  });

  it('builds an injected manifest', () => {
    const manifest = buildManifest({
      route: '/demo',
      resources: [],
      skills: [],
    });

    expect(manifest).toMatchObject({
      app: 'react-app',
      scene: 'react-inspection',
      bridgeSource: 'injected',
      bridgeProvider: 'page-context-userscripts/react-inspector',
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm --filter @page-context/userscripts test
```

Expected:

- FAIL with missing module errors for `manifest`, `resources`, `skills`, and `tools`

- [ ] **Step 3: Implement component inspection**

Write `packages/page-context-userscripts/src/react-inspector/inspect-component.ts` with this content:

```ts
import { createValuePreview } from '../shared/serialization';
import { getDisplayName } from './fiber-tree';

export interface InspectableFiber {
  __id?: string;
  memoizedProps?: unknown;
  memoizedState?: unknown;
  memoizedStateQueue?: Array<{ name: string; value: unknown }>;
  return?: InspectableFiber | null;
  child?: InspectableFiber | null;
  sibling?: InspectableFiber | null;
  type?: { displayName?: string; name?: string };
  key?: string | null;
}

export function inspectComponent(node: InspectableFiber | null | undefined) {
  if (!node) {
    return null;
  }

  const parentChain: Array<{ componentId: string; displayName: string }> = [];
  let current = node.return ?? null;

  while (current) {
    parentChain.push({
      componentId: current.__id ?? 'unknown',
      displayName: getDisplayName(current),
    });
    current = current.return ?? null;
  }

  return {
    componentId: node.__id ?? 'unknown',
    displayName: getDisplayName(node),
    key: node.key ?? null,
    props: { preview: createValuePreview(node.memoizedProps ?? {}) },
    state: { preview: createValuePreview(node.memoizedState ?? {}) },
    hooks: Array.isArray(node.memoizedStateQueue)
      ? node.memoizedStateQueue.map((entry) => ({
          name: entry.name,
          valuePreview: createValuePreview(entry.value),
        }))
      : [],
    parentChain,
    children: [],
  };
}
```

- [ ] **Step 4: Implement resources, skills, tools, and manifest builders**

Write `packages/page-context-userscripts/src/react-inspector/resources.ts` with this content:

```ts
import type {
  ContextResourceDescriptor,
  ContextResourcePayload,
} from '@page-context/shared-protocol';

interface ReactResourceState {
  summary: unknown;
  roots: unknown;
  selection: unknown;
  component?: unknown;
  diagnostics: unknown;
}

export function buildReactResources(state: ReactResourceState) {
  const descriptors: ContextResourceDescriptor[] = [
    {
      id: 'react.summary',
      namespace: 'react',
      title: 'React Summary',
      mimeType: 'application/json',
      kind: 'json',
    },
    {
      id: 'react.roots',
      namespace: 'react',
      title: 'React Roots',
      mimeType: 'application/json',
      kind: 'json',
    },
    {
      id: 'react.selection',
      namespace: 'react',
      title: 'React Selection',
      mimeType: 'application/json',
      kind: 'json',
    },
    {
      id: 'react.component',
      namespace: 'react',
      title: 'React Component',
      mimeType: 'application/json',
      kind: 'json',
    },
    {
      id: 'react.diagnostics',
      namespace: 'react',
      title: 'React Diagnostics',
      mimeType: 'application/json',
      kind: 'json',
    },
  ];

  const values: Record<string, unknown> = {
    'react.summary': state.summary,
    'react.roots': state.roots,
    'react.selection': state.selection,
    'react.component': state.component ?? null,
    'react.diagnostics': state.diagnostics,
  };

  return {
    list(): ContextResourceDescriptor[] {
      return descriptors;
    },
    read(id: string): ContextResourcePayload {
      return {
        id,
        mimeType: 'application/json',
        text: JSON.stringify(values[id] ?? null, null, 2),
      };
    },
  };
}
```

Write `packages/page-context-userscripts/src/react-inspector/skills.ts` with this content:

```ts
import type { ContextSkillDescriptor, ContextSkillPrompt } from '@page-context/shared-protocol';

export function buildReactSkills(): ContextSkillDescriptor[] {
  return [
    {
      id: 'react.inspect-active-app',
      namespace: 'react',
      title: 'Inspect Active React App',
      description: 'Understand the active React roots and overall app structure.',
      resourceIds: ['react.summary', 'react.roots'],
      toolNames: ['react.primary.listRoots'],
      mode: 'analysis',
    },
    {
      id: 'react.inspect-selected-component',
      namespace: 'react',
      title: 'Inspect Selected React Component',
      description: 'Inspect the React component mapped from the current DOM selection.',
      resourceIds: ['react.selection'],
      toolNames: ['react.primary.inspectSelectedElement'],
      mode: 'analysis',
    },
    {
      id: 'react.trace-component-context',
      namespace: 'react',
      title: 'Trace Component Context',
      description: 'Trace a component through its parent chain and summarized state.',
      resourceIds: ['react.component'],
      toolNames: ['react.primary.inspectComponent'],
      mode: 'analysis',
    },
  ];
}

export function getReactSkillPrompt(id: string): ContextSkillPrompt | undefined {
  const skill = buildReactSkills().find((entry) => entry.id === id);
  if (!skill) {
    return undefined;
  }

  return {
    skill,
    text: [
      `You are using the React analysis skill '${skill.title}'.`,
      `Goal: ${skill.description}`,
      `Recommended resources: ${(skill.resourceIds ?? []).join(', ')}`,
      `Allowed tools: ${(skill.toolNames ?? []).join(', ')}`,
      'Rules:',
      '1. Read resources first.',
      '2. Use only the listed readonly tools.',
      '3. Summarize findings before proposing follow-up investigation.',
    ].join('\n'),
  };
}
```

Write `packages/page-context-userscripts/src/react-inspector/tools.ts` with this content:

```ts
interface ReactToolEnv {
  listRoots: () => unknown;
  inspectComponent: (input: { componentId: string }) => unknown;
  inspectSelectedElement: () => unknown;
}

export function createReactToolInstance(env: ReactToolEnv) {
  return {
    instanceId: 'primary',
    listTools() {
      return [
        {
          name: 'listRoots',
          description: 'List React roots',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'inspectComponent',
          description: 'Inspect a React component by componentId',
          inputSchema: {
            type: 'object',
            properties: { componentId: { type: 'string' } },
            required: ['componentId'],
          },
        },
        {
          name: 'inspectSelectedElement',
          description: "Inspect the selected DOM element's React component",
          inputSchema: { type: 'object', properties: {} },
        },
      ];
    },
    callTool(name: string, input: Record<string, unknown> = {}) {
      switch (name) {
        case 'listRoots':
          return env.listRoots();
        case 'inspectComponent':
          return env.inspectComponent({ componentId: String(input.componentId ?? '') });
        case 'inspectSelectedElement':
          return env.inspectSelectedElement();
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    },
  };
}
```

Write `packages/page-context-userscripts/src/react-inspector/manifest.ts` with this content:

```ts
import type {
  ContextResourceDescriptor,
  ContextSkillDescriptor,
  PageContextManifest,
} from '@page-context/shared-protocol';

import { createBridgeMeta } from '../shared/bridge-meta';

export function buildManifest(input: {
  route: string;
  resources: ContextResourceDescriptor[];
  skills: ContextSkillDescriptor[];
}): PageContextManifest & {
  bridgeSource: 'injected';
  bridgeProvider: string;
  bridgeVersion: string;
} {
  return {
    version: '0.1.0',
    app: 'react-app',
    route: input.route,
    scene: 'react-inspection',
    namespaces: [
      { namespace: 'react', title: 'React', description: 'React application inspection' },
    ],
    resources: input.resources,
    skills: input.skills,
    generatedAt: new Date().toISOString(),
    ...createBridgeMeta('react-inspector', '0.0.1'),
  };
}
```

- [ ] **Step 5: Run the tests again**

Run:

```bash
pnpm --filter @page-context/userscripts test
```

Expected:

- PASS for resource, skill, tool, and manifest tests

### Task 5: Inject the React bridge into the page

**Files:**

- Create: `packages/page-context-userscripts/src/react-inspector/index.ts`
- Modify: `packages/page-context-userscripts/src/react-inspector/index.test.ts`

- [ ] **Step 1: Add a failing injection test**

Append this block to `packages/page-context-userscripts/src/react-inspector/index.test.ts`:

```ts
import { injectReactInspectorBridge } from './index';

describe('react bridge injection', () => {
  it('injects a standards-compliant page context bridge', () => {
    const target = {
      location: { pathname: '/app' },
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        renderers: new Map([[1, { version: '18.3.1' }]]),
        getFiberRoots: () => new Set(),
      },
    } as unknown as Window & typeof globalThis;

    injectReactInspectorBridge(target);

    expect(target.__pageContextBridge__).toBeDefined();
    expect(target.__pageContextBridge__.listNamespaces()).toEqual(['react']);
    expect(target.__pageContextBridge__.getManifest()).toMatchObject({
      bridgeSource: 'injected',
      bridgeProvider: 'page-context-userscripts/react-inspector',
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm --filter @page-context/userscripts test
```

Expected:

- FAIL because `injectReactInspectorBridge` does not exist

- [ ] **Step 3: Implement the bridge injection entrypoint**

Write `packages/page-context-userscripts/src/react-inspector/index.ts` with this content:

```ts
import { detectReactEnvironment } from './detect-react';
import { buildManifest } from './manifest';
import { buildReactResources } from './resources';
import { getReactSkillPrompt, buildReactSkills } from './skills';
import { createReactToolInstance } from './tools';
import { listReactRoots } from './roots';

function createBridge(target: Window & typeof globalThis) {
  const environment = detectReactEnvironment(target as unknown as Record<string, unknown>);
  const hook = (
    target as unknown as {
      __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
        renderers?: Map<unknown, unknown>;
        getFiberRoots?: (rendererId: unknown) => Set<unknown>;
      };
    }
  ).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const roots = hook ? listReactRoots(hook) : [];
  const resources = buildReactResources({
    summary: {
      detected: environment.detected,
      provider: 'page-context-userscripts/react-inspector',
      reactVersion: environment.reactVersion,
      rendererCount: environment.rendererCount,
      rootCount: roots.length,
      url: target.location?.href ?? target.location?.pathname ?? '',
      rootSummaries: roots,
    },
    roots: { roots },
    selection: { hasSelection: false },
    component: null,
    diagnostics: {
      detected: environment.detected,
      hookPresent: environment.hookPresent,
      issues: environment.detected ? [] : ['React DevTools hook not detected'],
      warnings: [],
    },
  });
  const skills = buildReactSkills();
  const toolInstance = createReactToolInstance({
    listRoots: () => ({ roots }),
    inspectComponent: ({ componentId }) => ({ componentId, displayName: 'Unknown' }),
    inspectSelectedElement: () => ({ hasSelection: false }),
  });

  return {
    version: '0.1.0',
    listNamespaces() {
      return ['react'];
    },
    getNamespace(namespace: string) {
      if (namespace !== 'react') {
        return undefined;
      }

      return {
        namespace: 'react',
        listInstances() {
          return ['primary'];
        },
        getInstance(instanceId: string) {
          return instanceId === 'primary' ? toolInstance : undefined;
        },
      };
    },
    getScene() {
      return 'react-inspection';
    },
    listResources() {
      return resources.list();
    },
    readResource(id: string) {
      return resources.read(id);
    },
    listSkills() {
      return skills;
    },
    getSkill(id: string, _input?: Record<string, unknown>) {
      return getReactSkillPrompt(id);
    },
    getManifest() {
      return buildManifest({
        route: target.location?.pathname ?? '/',
        resources: resources.list(),
        skills,
      });
    },
  };
}

export function injectReactInspectorBridge(target: Window & typeof globalThis = window) {
  const bridge = createBridge(target);
  Object.assign(target, {
    __pageContextBridge__: bridge,
    __pageContextTools__: bridge,
  });
  return bridge;
}

injectReactInspectorBridge();
```

- [ ] **Step 4: Run tests, typecheck, and build**

Run:

```bash
pnpm --filter @page-context/userscripts test && pnpm --filter @page-context/userscripts typecheck && pnpm --filter @page-context/userscripts build
```

Expected:

- Tests PASS
- Typecheck PASS
- Build creates `packages/page-context-userscripts/dist/react-inspector.user.js`

### Task 6: Validate root integration and document usage

**Files:**

- Modify: `README.md`
- Modify: `packages/page-context-userscripts/README.md`
- Verify: `packages/page-context-userscripts/dist/react-inspector.user.js`

- [ ] **Step 1: Add a short root README pointer to the new package**

Insert a brief bullet under `## Repository Layout` or `## Documentation` in `README.md` describing the new package:

```md
- `packages/page-context-userscripts/` — userscript-based injected page bridges, starting with a readonly React inspection bridge
```

- [ ] **Step 2: Expand the userscripts package README with usage instructions**

Update `packages/page-context-userscripts/README.md` to include:

````md
## Build

```bash
pnpm userscripts:build
```
````

## Output

The React inspector bundle is emitted to:

- `packages/page-context-userscripts/dist/react-inspector.user.js`

## Purpose

This package is intentionally decoupled from the core extension runtime. Each userscript injects a standards-compliant `window.__pageContextBridge__` that the main Page Context Bridge project can discover and compile into MCP.

````

- [ ] **Step 3: Run a final verification for the emitted bundle**

Run:

```bash
test -f packages/page-context-userscripts/dist/react-inspector.user.js && head -n 10 packages/page-context-userscripts/dist/react-inspector.user.js
````

Expected:

- File exists
- Top lines contain the userscript banner with `@name Page Context React Inspector`

- [ ] **Step 4: Run the focused root verification commands**

Run:

```bash
pnpm userscripts:test && pnpm userscripts:typecheck && pnpm userscripts:build
```

Expected:

- All commands PASS

## Self-review

- Spec coverage: The plan covers the agreed implementation scope: a new `packages/page-context-userscripts` subproject, a readonly React inspection bridge, injected metadata, namespace/resource/skill/tool mapping, and monorepo integration.
- Placeholder scan: No `TODO`, `TBD`, or vague instructions remain; each code-writing step includes explicit file contents.
- Type consistency: The plan uses consistent naming throughout: `react` namespace, `primary` instance, `react.summary`/`react.roots`/`react.selection`/`react.component`/`react.diagnostics` resources, `react.primary.*` tools, and injected bridge metadata keyed as `bridgeSource`, `bridgeProvider`, and `bridgeVersion`.
