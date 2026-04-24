# Page Context Bridge Integration Guide

This document defines the page-side integration contract for Page Context Bridge.
Goal: after integration, an engineer or LLM can read this document, run the prescribed calls, and resolve concrete business issues with evidence.

## 1. Core Model

Page Context Bridge uses **Host + multiple Source registration** on the page.

Roles:

- **Host**: `window.__pageContextBridgeHost__`
- **Host ready event**: `page-context-bridge-host:ready`
- **Merged bridge for readers**: `window.__pageContextBridge__`
- **Optional merged alias for readers**: `window.__pageContextTools__`
- **Business runtime**: a **source** registered into host by `registerSource(...)`

Rule of ownership:

1. The host owns the merged bridge on `window.__pageContextBridge__`.
2. Business code owns only its own source bridge.
3. Business code must register that source to host.
4. Business code must not overwrite the merged bridge when host exists.

## 2. Non-Negotiable Rules

These rules are mandatory.

1. Use `window.__pageContextBridgeHost__` as the only public registration point.
2. Treat `window.__pageContextBridge__` as the merged reader surface, not as a business-owned object.
3. Register a business bridge as a **source** with a stable `sourceId`.
4. Handle late host initialization by listening to `page-context-bridge-host:ready`.
5. Return a disposer from host binding and call it on unmount.
6. Support multi-instance pages inside the business bridge. Do not register one source per instance.
7. Keep `getManifest()` consistent with `listNamespaces()`, `listResources()`, and `listSkills()`.
8. Use stable, deterministic namespace IDs, resource IDs, and skill IDs.
9. Keep tools atomic, resources read-only, and skills task-oriented.
10. Do not expose project internals through random debug globals when the bridge protocol already covers the use case.

## 3. Minimum Runtime Contract

```ts
interface PageToolInstance {
  instanceId: string
  listTools(): ToolSpec[]
  callTool(name: string, input?: Record<string, unknown>): unknown
}

interface PageToolNamespace {
  namespace: string
  listInstances(): string[]
  getInstance(instanceId: string): PageToolInstance | undefined
}

interface PageContextBridgeLike {
  version: string
  listNamespaces(): string[]
  getNamespace(namespace: string): PageToolNamespace | undefined

  getScene(): string
  listResources(): ContextResourceDescriptor[]
  readResource(id: string): ContextResourcePayload

  listSkills(): ContextSkillDescriptor[]
  getSkill(id: string, input?: Record<string, unknown>): ContextSkillPrompt | undefined

  getManifest(): PageContextManifest
}

interface PageContextBridgeHost {
  registerSource(input: {
    sourceId: string
    bridge: PageContextBridgeLike
    priority?: number
    tags?: string[]
  }): () => void
}
```

Protocol mapping:

- page tool -> MCP `tool`
- page resource -> MCP `resource`
- page skill -> MCP `prompt`

## 4. What a Business Implementation Must Deliver

A correct business integration delivers all of the following:

1. One source bridge object for the business runtime.
2. One internal instance registry for all mounted page instances.
3. Namespaces grouped by business semantics, not by technical leftovers.
4. Read-only resources with deterministic IDs.
5. Skills that reference real `resourceIds` and real qualified `toolNames`.
6. Host binding that works for both immediate-host and late-host cases.
7. Mount and unmount hooks that update registry state and unregister from host when the last instance is gone.

Definition of done:

1. The integrated page can answer at least these business questions:
- Why did this page enter the current scene?
- Why is this option hidden/disabled/forbidden/absent?
- Why did this default selection win?
- Why does rendered UI not match runtime state?
- What changed between two runtime snapshots?
2. Answers must be reproducible from resources/tool outputs, not guesswork.

## 5. Proven Blueprint From `campaign-creation`

A proven namespace layout is:

- `workspace`: page-level targeting and multi-instance discovery
- `entry`: route split and deeplink reasoning
- `availability`: why an option is visible, hidden, disabled, forbidden, or absent
- `selection`: why one branch won, including default selection reasoning
- `structure`: graph, search, subtree inspection, diff, snapshot
- `runtime`: bounded runtime state and rendered surface evidence

A proven resource layout is:

- page-level resource: `workspace.page-summary`
- per-instance resources:
  - `entry.<instanceId>.routing-context`
  - `availability.<instanceId>.option-catalog`
  - `availability.<instanceId>.investigation-sop`
  - `selection.<instanceId>.selection-state`
  - `structure.<instanceId>.graph-summary`
  - `runtime.<instanceId>.state`
  - `runtime.<instanceId>.surface`

A proven skill layout is:

- `workspace.pick-instance`
- `entry.<instanceId>.explain-scene-and-deeplink`
- `availability.<instanceId>.diagnose-option-availability`
- `availability.<instanceId>.follow-investigation-sop`
- `selection.<instanceId>.explain-selection-decision`
- `structure.<instanceId>.inspect-runtime-structure`
- `runtime.<instanceId>.inspect-runtime-surface`

Why this layout works:

1. `workspace` solves multi-instance targeting before deeper analysis.
2. Per-instance namespaces keep tool scope small and explicit.
3. `investigation-sop` turns debugging procedure into runtime-readable guidance instead of hidden tribal knowledge.

## 6. Recommended File Layout

Use three layers.

1. `hub.ts`
- Builds the project-specific runtime API from local internals.
- Keeps business data collection separate from bridge protocol code.

2. `page-context-capabilities-*.ts`
- One file per namespace.
- Each file defines `listTools()` and `callTool()` for that namespace.

3. `page-context-bridge.ts`
- Owns the source bridge object.
- Owns the mounted instance registry.
- Builds resources, skills, and manifest.
- Binds and unbinds the source to host.

## 7. Source Bridge Skeleton

Use a private project-scoped registry key. Do not use `window.__pageContextBridge__` as your business-owned storage.

```ts
const PAGE_CONTEXT_BRIDGE_VERSION = "2.0.0"
const PAGE_CONTEXT_SOURCE_ID = "campaign-selector-page-runtime"
const PAGE_CONTEXT_BRIDGE_REGISTRY_KEY = "__campaignSelectorPageContextBridgeRegistry__"

type MountedInstance = {
  instanceId: string
  model: CampaignSelectorModelModule
  api: PageContextInstanceApi
}

interface MutablePageContextBridge extends PageContextBridgeLike {
  internalInstances: Record<string, MountedInstance>
  unbindFromHost?: () => void
}

declare global {
  interface Window {
    __pageContextBridgeHost__?: PageContextBridgeHost
    __pageContextBridge__?: PageContextBridgeLike
    __campaignSelectorPageContextBridgeRegistry__?: MutablePageContextBridge
  }
}

export function ensurePageContextBridge(): MutablePageContextBridge {
  if (typeof window === "undefined") {
    return createEmptyBridge()
  }

  const existingRegistry = window[PAGE_CONTEXT_BRIDGE_REGISTRY_KEY]
  if (existingRegistry) {
    syncNamespaces(existingRegistry)
    return existingRegistry
  }

  const bridge: MutablePageContextBridge = {
    version: PAGE_CONTEXT_BRIDGE_VERSION,
    internalInstances: {},
    unbindFromHost: undefined,
    listNamespaces: () => ["workspace", "entry", "availability", "selection", "structure", "runtime"],
    getNamespace: (namespace) => buildNamespace(namespace, bridge),
    getScene: () => detectScene(bridge),
    listResources: () => listResources(bridge),
    readResource: (id) => readResource(bridge, id),
    listSkills: () => listSkills(bridge),
    getSkill: (id, input) => getSkill(bridge, id, input),
    getManifest: () => buildManifest(bridge),
  }

  bridge.unbindFromHost = bindBridgeToPageContextHost(bridge)
  syncNamespaces(bridge)
  window[PAGE_CONTEXT_BRIDGE_REGISTRY_KEY] = bridge
  return bridge
}
```

Implementation rule:

- The business bridge may live on a private project key.
- The host-owned merged bridge remains on `window.__pageContextBridge__`.
- If host is absent, keep the source bridge private and wait for host readiness instead of publishing a fake merged bridge.

## 8. Host Binding Template

This pattern is required because host may appear before or after the business script.

```ts
const PAGE_CONTEXT_BRIDGE_HOST_READY_EVENT = "page-context-bridge-host:ready"

function isPageContextBridgeHost(value: unknown): value is PageContextBridgeHost {
  const candidate = value as Partial<PageContextBridgeHost> | undefined
  return Boolean(candidate && typeof candidate.registerSource === "function")
}

function bindBridgeToPageContextHost(bridge: PageContextBridgeLike): () => void {
  if (typeof window === "undefined") {
    return () => undefined
  }

  let unregisterFromHost: (() => void) | undefined
  let listeningHostReadyEvent = false

  const stopListeningHostReadyEvent = () => {
    if (!listeningHostReadyEvent) {
      return
    }
    window.removeEventListener(PAGE_CONTEXT_BRIDGE_HOST_READY_EVENT, onHostReady as EventListener)
    listeningHostReadyEvent = false
  }

  const tryRegisterOnHost = (candidateHost?: unknown) => {
    if (unregisterFromHost) {
      return
    }

    const host = isPageContextBridgeHost(candidateHost)
      ? candidateHost
      : window.__pageContextBridgeHost__

    if (!host) {
      return
    }

    unregisterFromHost = host.registerSource({
      sourceId: PAGE_CONTEXT_SOURCE_ID,
      bridge,
      priority: 120,
      tags: ["page", "campaign-selector"],
    })

    stopListeningHostReadyEvent()
  }

  const onHostReady = (event: Event) => {
    tryRegisterOnHost((event as CustomEvent<unknown>).detail)
  }

  tryRegisterOnHost()

  if (!unregisterFromHost) {
    window.addEventListener(PAGE_CONTEXT_BRIDGE_HOST_READY_EVENT, onHostReady as EventListener)
    listeningHostReadyEvent = true

    // Check again after listening to avoid host initialization happening between these two steps.
    tryRegisterOnHost()
  }

  return () => {
    stopListeningHostReadyEvent()
    unregisterFromHost?.()
    unregisterFromHost = undefined
  }
}
```

Hard behavior requirements:

1. Register at most once for the current bridge object.
2. Remove the ready listener after successful registration.
3. Return a disposer that removes the listener and unregisters the source.
4. Never assign `window.__pageContextBridge__ = bridge` inside this binding path.

## 9. Mount and Unmount Lifecycle

Use one source bridge and many mounted instances.

```ts
export function mountPageContextInstance(input: {
  instanceId: string
  model: CampaignSelectorModelModule
  api: PageContextInstanceApi
}): () => void {
  if (typeof window === "undefined") {
    return () => undefined
  }

  const bridge = ensurePageContextBridge()

  bridge.internalInstances[input.instanceId] = {
    instanceId: input.instanceId,
    model: input.model,
    api: input.api,
  }

  syncNamespaces(bridge)

  return () => {
    delete bridge.internalInstances[input.instanceId]
    syncNamespaces(bridge)

    if (Object.keys(bridge.internalInstances).length === 0) {
      bridge.unbindFromHost?.()
      bridge.unbindFromHost = undefined

      if (window[PAGE_CONTEXT_BRIDGE_REGISTRY_KEY] === bridge) {
        delete window[PAGE_CONTEXT_BRIDGE_REGISTRY_KEY]
      }
    }
  }
}
```

Lifecycle rules:

1. Mount adds the instance to the internal registry.
2. Mount refreshes namespace projections, resources, skills, and manifest.
3. Unmount removes the instance from the internal registry.
4. Unmount refreshes projections again.
5. Only when the last instance disappears should the source unregister from host.

## 10. Namespace, Resource, and Skill Design Rules

### 10.1 Namespace rules

Good namespaces describe the problem space:

- `workspace`
- `entry`
- `availability`
- `selection`
- `structure`
- `runtime`

Bad namespaces hide meaning:

- `misc`
- `common`
- `utils`

### 10.2 Tool rules

A tool should be one bounded action.

Good:

- `explainEntryRouting`
- `explainOptionState`
- `traceDefaultSelection`
- `inspectStructureBranch`
- `inspectRenderedSurface`

Bad:

- `debugEverything`
- `inspectAll`
- `runWorkflow`

### 10.3 Resource rules

Resources are for stable, read-only context.

Requirements:

1. Use deterministic IDs.
2. Keep payloads bounded.
3. Return a structured fallback for unknown IDs.
4. Prefer one resource per investigation context instead of one giant dump.

### 10.4 Skill rules

A skill is a task guide, not a raw data bucket.

Requirements:

1. One skill should represent one job to be done.
2. `resourceIds` must point to real resources.
3. `toolNames` must point to real callable tools.
4. Skills should narrow reasoning scope instead of listing everything.

## 11. Business Problem Runbooks (Use After Integration)

Use these playbooks directly for incident handling.

Output contract for every runbook:

1. `instanceId`
2. `scene`
3. `symbol` (if relevant)
4. `nodeId` (if relevant)
5. `verdict`
6. `evidence` (resource IDs + tool outputs used)
7. `nextAction`

### 11.1 Option Is Missing, Hidden, Disabled, or Forbidden

Question:
- Why is option `X` not available?

Call order:

1. `workspace.page-summary` -> identify target instance.
2. `workspace.page.locateInstance` -> when multiple instances exist.
3. `structure.<instanceId>.inspectStructureBranch` with `symbol`.
4. `availability.<instanceId>.explainOptionState` with `symbol`.
5. `availability.<instanceId>.explainBlockingPath` with `symbol` and optional `nodeId/signal`.
6. `runtime.<instanceId>.readRuntimeState` with targeted `paths` from blocking guard hints.

Expected outcome:

1. Clear classification: `visible | hidden | disabled | forbidden | absent`.
2. Nearest blocking ancestor or winning guard source when blocked.
3. Exact feature tuple and boolean that led to the result.

### 11.2 Wrong Default Selection

Question:
- Why did selector choose branch `A` instead of expected `B`?

Call order:

1. `entry.<instanceId>.explainEntryRouting`.
2. `entry.<instanceId>.explainDeeplinkImpact` (optional `keys` filter).
3. `selection.<instanceId>.explainCurrentSelection`.
4. `selection.<instanceId>.traceDefaultSelection` with concrete `nodeId` and `resolver`.
5. `runtime.<instanceId>.readRuntimeState` for targeted inputs referenced by trace.

Expected outcome:

1. The winning resolver and path are explicit.
2. Deeplink and mode inputs that influenced defaulting are explicit.
3. If `nodeId` is missing, report insufficient trace and request a concrete node.

### 11.3 Wrong Scene or Deeplink Routing

Question:
- Why did runtime enter the wrong page scene?

Call order:

1. `entry.<instanceId>.routing-context` resource.
2. `entry.<instanceId>.explainEntryRouting`.
3. `entry.<instanceId>.explainDeeplinkImpact` with keys for suspected flags.

Expected outcome:

1. Scene decision reasons are explicit and ordered.
2. Deeplink flags are grouped by impact category.
3. Routing conclusion names the exact triggering inputs.

### 11.4 Rendered UI Does Not Match Runtime

Question:
- Why does UI surface differ from expected runtime state?

Call order:

1. `runtime.<instanceId>.inspectRenderedSurface` (`includeText`, bounded `maxItems`).
2. `runtime.<instanceId>.readRuntimeState` with targeted paths.
3. `selection.<instanceId>.explainCurrentSelection`.
4. `availability.<instanceId>.explainOptionState` for suspicious symbols.

Expected outcome:

1. DOM evidence and runtime evidence are reported separately.
2. Any mismatch is tied to concrete state or availability signals.
3. Report whether mismatch is data/state, gating, or rendering-only.

### 11.5 Refactor Regression or Snapshot Drift

Question:
- Did recent code changes alter runtime graph semantics?

Call order:

1. `structure.<instanceId>.exportRuntimeSnapshot` (`compact`) for baseline/current.
2. `structure.<instanceId>.compareStructure` with baseline.
3. `structure.<instanceId>.inspectStructureBranch` for changed symbols.

Expected outcome:

1. Graph diff is explicit (added/removed/changed).
2. Impacted symbols/branches are enumerated.
3. Regression report includes minimal reproducing evidence.

## 12. Validation Checklist

Run these checks in the page console after integration:

```ts
window.__pageContextBridgeHost__?.listSources?.()
window.__pageContextBridge__?.listNamespaces()
window.__pageContextBridge__?.getScene()
window.__pageContextBridge__?.listResources()
window.__pageContextBridge__?.readResource("workspace.page-summary")
window.__pageContextBridge__?.listSkills()
window.__pageContextBridge__?.getManifest()
```

What must be true:

1. The business source appears in `listSources()` when the host exposes diagnostics.
2. `listNamespaces()` returns stable business-oriented namespaces.
3. Per-instance resources exist only for mounted instances.
4. `readResource()` returns bounded JSON payloads and a safe fallback for unknown IDs.
5. Every skill in `listSkills()` references resources and tools that actually exist.
6. `getManifest()` matches the runtime output of `listNamespaces()`, `listResources()`, and `listSkills()`.

## 13. Test Requirements

At minimum, cover these cases.

1. Register on host when host already exists.
2. Register on late host after `page-context-bridge-host:ready`.
3. Keep host-owned `window.__pageContextBridge__` untouched.
4. Do not duplicate source registration for the same bridge object.
5. Expose expected namespaces, resources, skills, and manifest.
6. Unregister from host when the last instance unmounts.
7. Keep other mounted instances alive when only one instance unmounts.
8. Return safe fallback payloads for unknown resources.
9. Return `undefined` for unknown skills.

## 14. Direct Implementation Prompt For Another LLM

```text
Implement page-side Page Context Bridge integration for this business runtime.

Requirements:
1. Use Host + Source architecture.
2. Register the business source to window.__pageContextBridgeHost__ with registerSource(...).
3. Handle late host initialization via the page-context-bridge-host:ready event.
4. Do not overwrite window.__pageContextBridge__ when host exists.
5. Use one source bridge with an internal multi-instance registry.
6. Expose tools, resources, skills, and getManifest().
7. Use business-oriented namespaces and deterministic resource/skill IDs.
8. Return an unmount disposer that unregisters the source when the last instance is removed.
9. Ensure the integration can resolve concrete business issues using runbooks:
   - option availability
   - default selection
   - scene/deeplink routing
   - runtime vs rendered surface mismatch
   - structure regression diff

Deliverables:
- page-context-bridge.ts
- page-context-capabilities-*.ts
- resource and skill catalog assembly
- mount/unmount lifecycle wiring
- validation snippets
- tests for immediate-host and late-host registration
```
