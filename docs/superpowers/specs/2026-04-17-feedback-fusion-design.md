# Feedback Fusion Design

## Status

This is the refined implementation spec for the first feedback-fusion rollout in this repository.

It intentionally narrows the original idea into a **single shippable vertical slice**:

- extension sidepanel can create and review feedback for the active tab
- bridge server keeps authoritative in-memory feedback state per tenant
- annotations are linked to the current page context manifest and page tools
- MCP clients can list, inspect, claim, reply, resolve, dismiss, and read event history

This document is not a long-range product vision only. It is the contract for the implementation work in this branch.

## Summary

Page Context Bridge already solves one side of the problem:

- discover page capabilities
- filter them inside the extension
- expose them to MCP through the bridge server

The missing layer is **feedback state**:

- humans need to leave actionable feedback
- feedback needs shared workflow state
- agents need to move from feedback into linked tools/resources/prompts
- reconnect and multi-client usage need an authoritative event history

The recommended product shape remains:

- **extension-first universal entry**
- **page-side semantic enhancement when available**
- **bridge-owned authoritative state**
- **MCP tools as the agent interface**

But the first implementation in this repository is deliberately smaller:

- no overlay target picker yet
- no area-select yet
- no screenshot pipeline yet
- no page-embedded React adapter yet
- no durable persistence yet

The first branch should deliver a reliable and testable baseline, not a broad surface area.

## Goals

1. Reuse the existing `WS + JSON-RPC + SSE` architecture.
2. Add a bridge-owned feedback domain that is isolated per tenant.
3. Let the extension sidepanel create feedback for the active tab without requiring page-side integration.
4. Link each annotation to current page capabilities when a context manifest exists.
5. Expose feedback workflows to MCP without duplicating page capability tools.
6. Preserve an append-only event history shape so later replay and persistence do not require redesign.

## Non-Goals For This Branch

1. Replacing the current transport stack.
2. Implementing overlay picking, area select, screenshots, or DOM-accurate visual anchors.
3. Making page-side React UI the primary product surface.
4. Shipping remote multi-user collaboration or durable storage.
5. Solving full semantic target mapping from DOM to business entities.
6. Building a generic issue tracker unrelated to page capabilities.

## Why This Fits The Current Repository

The repository already has the required split of responsibilities:

- `packages/page-context-extension/src/background.ts`
  owns extension runtime RPC, tab awareness, tool discovery, and bridge connectivity
- `packages/page-context-extension/src/bg-ws-connection.ts`
  already manages the bridge WebSocket lifecycle and request/notification transport
- `packages/page-context-extension/src/side-panel-app.ts`
  is already the natural place for a platform-owned review UI
- `packages/page-context-bridge-server/src/extension-session.ts`
  already terminates extension RPC and routes bridge actions per tenant
- `packages/page-context-bridge-server/src/mcp-registry.ts`
  already owns MCP server registration and is the correct host for feedback MCP tools
- `packages/shared-protocol`
  already carries shared method names and transport-safe type contracts

So the correct direction is not a new subsystem. The correct direction is to extend the current bridge with:

- a feedback data model
- a bridge-owned store
- a small set of feedback RPC methods
- a sidepanel tab for authoring and review
- MCP tools backed by the same store

## Repository-Realistic MVP

### User-visible scope

This branch should implement the following user-visible flow:

1. open the extension sidepanel on any page
2. switch to a new `Feedback` tab
3. create a feedback item for the active tab with:
   - body
   - priority
   - optional selected text captured from the page
4. see the current session and annotation list
5. inspect linked page capabilities when a manifest exists
6. claim / resolve / dismiss from MCP
7. refresh the sidepanel and still see the authoritative state from the bridge

### Explicitly deferred

The following items stay out of scope for this implementation:

- visual bounding-box capture
- CSS selector anchoring
- page overlay drawing
- screenshot upload/storage
- page-side `window.__pageContextBridge__` feedback enrichment hooks
- live push subscriptions into the sidepanel
- storage beyond process memory

The protocol and data model should allow those later, but the code in this branch should not try to do them partially.

## Architecture

### 1. Extension sidepanel as the primary authoring surface

The first implementation uses the existing sidepanel because it already exists, already has bridge status awareness, and avoids new permissions or large UI scaffolding.

Responsibilities in this branch:

- collect feedback body and priority
- collect generic page context for the active tab
- show current session snapshot
- refresh after mutations and on a timer

The sidepanel is the cheapest route to a reliable universal entry point.

### 2. Background service worker as the extension feedback gateway

The background worker remains the only extension process that talks to the bridge server.

Responsibilities in this branch:

- capture generic context from the active tab
- proxy feedback RPC from sidepanel to bridge server
- keep all feedback transport bridge-facing, not UI-facing

This keeps the extension consistent with the existing architecture instead of teaching the UI to speak WebSocket directly.

### 3. Bridge server as the single source of truth

The bridge server owns feedback state per tenant.

Responsibilities in this branch:

- create and update feedback sessions and annotations
- append feedback events with monotonically increasing `seq`
- derive capability links from current page manifests and page tool registrations
- expose feedback tools on every MCP server instance

### 4. MCP as the agent workflow surface

Agents should use feedback tools for workflow state and existing page capability tools/resources/prompts for actual investigation and action.

This prevents surface duplication and keeps capability execution in the existing system.

## Current Branch Data Model

The first implementation should introduce transport-safe shared types. The exact file name may vary, but the shared protocol should expose a dedicated feedback module.

```ts
type FeedbackAnnotationStatus =
  | "open"
  | "claimed"
  | "in_progress"
  | "needs_info"
  | "resolved"
  | "dismissed";

type FeedbackPriority = "low" | "normal" | "high" | "critical";

type FeedbackActorSource = "user" | "agent" | "bridge" | "extension";

interface FeedbackActor {
  source: FeedbackActorSource;
  id: string;
  displayName: string;
}

interface FeedbackSession {
  id: string;
  tenantId: string;
  tabId: number;
  url: string;
  title?: string;
  route?: string;
  scene?: string;
  app?: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  lastEventSeq: number;
}

interface FeedbackTarget {
  tabId: number;
  url: string;
  title?: string;
  textQuote?: string;
}

interface FeedbackCapabilityLinks {
  namespaceHints: string[];
  relatedToolNames: string[];
  relatedResourceIds: string[];
  relatedSkillIds: string[];
  linkReasons: string[];
}

interface FeedbackContext {
  pageInfo: {
    tabId: number;
    url: string;
    title?: string;
    app?: string;
    scene?: string;
    route?: string;
  };
  selectedText?: string;
  manifestSummary?: {
    namespaceCount: number;
    resourceCount: number;
    skillCount: number;
  };
}

interface FeedbackThreadMessage {
  id: string;
  annotationId: string;
  author: FeedbackActor;
  body: string;
  kind: "comment" | "action_note" | "resolution_note";
  createdAt: string;
}

interface FeedbackAnnotation {
  id: string;
  sessionId: string;
  author: FeedbackActor;
  body: string;
  status: FeedbackAnnotationStatus;
  priority: FeedbackPriority;
  target: FeedbackTarget;
  context: FeedbackContext;
  linkedCapabilities: FeedbackCapabilityLinks;
  thread: FeedbackThreadMessage[];
  createdAt: string;
  updatedAt: string;
  claimedBy?: FeedbackActor;
  resolvedBy?: FeedbackActor;
  resolution?: string;
  dismissReason?: string;
}

interface FeedbackEvent {
  eventId: string;
  tenantId: string;
  sessionId: string;
  annotationId?: string;
  seq: number;
  eventType:
    | "session.started"
    | "annotation.created"
    | "annotation.claimed"
    | "annotation.replied"
    | "annotation.resolved"
    | "annotation.dismissed";
  occurredAt: string;
  source: FeedbackActorSource;
  payload: Record<string, unknown>;
}
```

### Intentional simplifications

The branch should keep the wider lifecycle in types, but only expose the simple visible workflow in the first UI:

- `open`
- `claimed`
- `resolved`
- `dismissed`

`in_progress` and `needs_info` remain reserved for later expansion and do not need dedicated UI in this branch.

## Session Normalization Rule

To stay implementable, the first release should use one active feedback session per `(tenantId, tabId)`.

That means:

- creating the first annotation for a tab lazily creates the session
- later annotations on the same tab reuse the same session
- session metadata is refreshed from the latest tab and manifest state
- route changes do not split sessions yet

This is intentionally simpler than route-level or task-level session partitioning and matches the current extension runtime better.

## Capability Linking Rule

The first implementation should link capabilities using data that already exists in the repository.

### Link source priority

1. active tab context manifest, if available
2. currently registered page tools for the tab
3. no page enhancement means the annotation still remains valid

### Link behavior in this branch

When an annotation is created for a tab:

- if the tab has a manifest, copy:
  - `app`
  - `scene`
  - `route`
  - namespace names
  - resource ids
  - skill ids
- if the tab has registered page tools, copy their tool names
- save the derived lists into `linkedCapabilities`

This branch does **not** need semantic ranking or tool recommendation scoring. A complete and stable manifest-derived linkage set is enough.

## Generic Context Capture Rule

The extension should capture only generic context that is cheap and reliable:

- `tabId`
- `url`
- `title`
- current selected text, if any

This branch should use a light-weight page script read through the existing extension capabilities. It should not attempt brittle selector or layout capture yet.

## Event Model

The bridge store must append an event for every state mutation.

Required event types in this branch:

- `session.started`
- `annotation.created`
- `annotation.claimed`
- `annotation.replied`
- `annotation.resolved`
- `annotation.dismissed`

### Cursor rule

For each tenant store:

- `seq` starts at `1`
- each mutation increments `seq`
- sessions track `lastEventSeq`
- the bridge stores a recent ring buffer for `feedback.state.delta`

The sidepanel may stay pull-based for now, but the store must already look like an event-backed system.

## Protocol Design

### Transport

Do not change transport:

- extension background ↔ bridge server: WebSocket + JSON-RPC
- sidepanel ↔ background: existing runtime JSON-RPC helper
- bridge server ↔ MCP clients: existing MCP SDK server

### Bridge RPC methods

The bridge-facing feedback RPC should be small and mutation-oriented:

- `feedback.state.snapshot`
- `feedback.state.delta`
- `feedback.annotation.create`
- `feedback.annotation.claim`
- `feedback.annotation.reply`
- `feedback.annotation.resolve`
- `feedback.annotation.dismiss`

`feedback.state.snapshot` should accept filters such as:

- `tabId?`
- `sessionId?`

and return:

- matching sessions
- matching annotations
- current `snapshotVersion`
- current `lastSeq`

`feedback.state.delta` should accept:

- `afterSeq`
- `sessionId?`

and return:

- ordered `events`
- latest `lastSeq`

### Extension runtime methods

The sidepanel-facing runtime methods should mirror the bridge actions but stay explicitly namespaced for extension callers:

- `extension.feedback.state.snapshot`
- `extension.feedback.annotation.create`
- `extension.feedback.annotation.claim`
- `extension.feedback.annotation.reply`
- `extension.feedback.annotation.resolve`
- `extension.feedback.annotation.dismiss`

The background worker should translate these into bridge RPC and should not maintain a second feedback store locally.

### MCP tool surface

The bridge server should register the following tools on every MCP server:

- `feedback_list_sessions`
- `feedback_get_session`
- `feedback_list_annotations`
- `feedback_get_annotation`
- `feedback_claim_annotation`
- `feedback_reply_annotation`
- `feedback_resolve_annotation`
- `feedback_dismiss_annotation`
- `feedback_watch_events`

### `feedback_watch_events` semantics

In this branch, `feedback_watch_events` is **cursor-based pull**, not long-lived streaming.

Input:

- `afterSeq`
- optional `sessionId`

Output:

- ordered events after the cursor
- latest cursor

This is enough for agents and tests, and it matches the current MCP server shape better than forcing streaming too early.

## Store Design

The bridge should add a dedicated in-memory store per tenant.

Recommended internal shape:

```ts
interface FeedbackStoreState {
  sessionsById: Map<string, FeedbackSession>;
  sessionIdByTabId: Map<number, string>;
  annotationsById: Map<string, FeedbackAnnotation>;
  annotationIdsBySessionId: Map<string, string[]>;
  events: FeedbackEvent[];
  lastSeq: number;
  snapshotVersion: number;
}
```

### Required store operations

- ensure session for tab
- create annotation
- list sessions
- list annotations by session
- get annotation
- claim annotation
- append reply
- resolve annotation
- dismiss annotation
- read snapshot
- read delta

The store should stay deterministic and side-effect free except for id/time generation.

## Implementation Shape In Current Modules

### Shared Protocol

Files to change:

- `packages/shared-protocol/src/context-manifest.ts`
- `packages/shared-protocol/src/index.ts`
- new `packages/shared-protocol/src/feedback.ts`

Responsibilities:

- feedback type definitions
- feedback method constants
- snapshot / delta payload shapes

### Extension

Files to change:

- `packages/page-context-extension/src/bg-ws-connection.ts`
- `packages/page-context-extension/src/background.ts`
- `packages/page-context-extension/src/side-panel-app.ts`
- `packages/page-context-extension/src/sidepanel-types.ts`
- new helper module for generic feedback context capture

Responsibilities:

- add a general bridge request helper in the background WS layer
- capture active-tab feedback context
- expose runtime RPC methods for the sidepanel
- add a `Feedback` tab to the sidepanel
- create and refresh feedback state from the bridge

### Bridge Server

Files to change:

- `packages/page-context-bridge-server/src/extension-session.ts`
- `packages/page-context-bridge-server/src/mcp-registry.ts`
- `packages/page-context-bridge-server/src/rpc-params.ts`
- new feedback store module(s) under `packages/page-context-bridge-server/src/`

Responsibilities:

- own per-tenant feedback state
- validate feedback RPC params
- serve feedback snapshot and mutation methods to the extension
- register MCP feedback tools backed by the same store
- derive capability linkage from manifests and page tools already known to the registry

## UI Design For This Branch

### Sidepanel tab structure

Add a new top-level tab:

- `Tools`
- `Context`
- `Feedback`
- `Diagnosis`

The `Feedback` tab should contain two sections:

1. **Create feedback**
   - body textarea
   - priority select
   - read-only active tab metadata
   - selected text preview if available
   - submit button

2. **Current session**
   - session header
   - annotation list
   - status badges
   - linked capability chips
   - thread preview

### Refresh model

The first UI can stay pull-based:

- refresh on tab switch
- refresh after create/action mutations
- refresh on a modest polling interval

This is acceptable because the bridge store still preserves delta history for later push upgrades.

## Detailed Behavior

### Annotation creation flow

1. sidepanel asks background for active tab info + selected text
2. background asks bridge for `feedback.annotation.create`
3. bridge ensures or creates the tab session
4. bridge derives manifest/tool linkage
5. bridge stores the annotation
6. bridge appends `session.started` if needed and `annotation.created`
7. sidepanel reloads `extension.feedback.state.snapshot`

### Claim flow

1. MCP tool receives `annotationId` and optional actor metadata
2. bridge validates the current status transition
3. bridge updates the annotation to `claimed`
4. bridge appends `annotation.claimed`

### Reply / resolve / dismiss flow

Each action should:

- validate the target annotation exists
- update the annotation
- append a thread message when applicable
- append a matching event
- bump `snapshotVersion`

## State Machine

Supported transitions in store logic:

- `open -> claimed`
- `open -> dismissed`
- `claimed -> resolved`
- `claimed -> dismissed`
- `claimed -> in_progress`
- `in_progress -> needs_info`
- `in_progress -> resolved`
- `in_progress -> dismissed`
- `needs_info -> claimed`
- `needs_info -> in_progress`
- `needs_info -> dismissed`

Visible transitions required in this branch:

- `open -> claimed`
- `claimed -> resolved`
- `open | claimed -> dismissed`

## MCP Response Rule

Feedback MCP tools should return structured JSON text that is easy for agents to consume.

`feedback_get_annotation` must include:

- annotation core fields
- thread
- linked capabilities
- page context summary

It should not try to inline the full text of linked resources or prompts. Agents can call the existing resource/prompt surface separately.

## Testing Strategy

### Required automated tests

Add or update tests for:

- shared feedback types and method exports
- feedback store state transitions
- snapshot and delta cursor behavior
- capability linkage derivation from manifest + page tools
- MCP feedback tool registration / output behavior

### Optional for this branch

Browser-side UI tests are useful but not required if they become the slowest part of the branch. The bridge-side tests are the critical guard rails.

## Acceptance Criteria

This branch is complete when all of the following are true:

1. the shared protocol exports feedback types and method constants
2. the bridge server can create and mutate feedback state in memory per tenant
3. the extension sidepanel can create feedback for the active tab
4. the sidepanel can read the current feedback snapshot from the bridge
5. created annotations include manifest-derived capability links when available
6. MCP clients can list, inspect, claim, reply, resolve, dismiss, and read event deltas
7. node tests covering the new store and MCP-facing behavior pass

## Rollout After This Branch

The next stages after this implementation are:

### Phase 2

- page-side semantic enrichment hooks
- smarter capability ranking
- richer target capture

### Phase 3

- overlay target acquisition
- screenshots
- stronger replay/resume paths in the extension UI

### Phase 4

- durable storage
- remote collaboration
- richer workflow states in the UI

## Final Recommendation

Build the first implementation around **bridge-owned feedback state with a sidepanel-first UI**.

That keeps the existing architecture intact, ships a real feedback loop quickly, and creates the most important product property:

**an annotation is not just text; it is text plus page context plus linked capabilities plus workflow state.**
