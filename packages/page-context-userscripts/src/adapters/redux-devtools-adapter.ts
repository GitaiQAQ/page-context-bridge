import type {
  ContextNamespaceDescriptor,
  ContextResourceDescriptor,
  ContextSkillDescriptor,
  ToolSpec,
} from "@page-context/shared-protocol";

import type { PageToolInstance, ToolInput, UserscriptBridgeAdapter } from "../types";
import { buildSkillPrompt, listToolNames, normalizeSkillInput, previewValue, READONLY_ANNOTATION, toErrorMessage, toJsonResource, isObjectRecord } from "../utils";

interface ReduxDevtoolsConnectionLike extends Record<string, unknown> {
  init?: (state: unknown) => unknown;
  send?: (action: unknown, state: unknown) => unknown;
  subscribe?: (listener: (message: unknown) => void) => (() => void) | void;
  unsubscribe?: () => void;
  error?: (payload: unknown) => unknown;
}

interface ReduxDevtoolsExtensionLike extends Record<string, unknown> {
  connect?: (options?: Record<string, unknown>) => ReduxDevtoolsConnectionLike;
}

interface ActionRecord {
  type: string;
  preview: string;
  at: string;
}

interface StoreRecord {
  storeId: string;
  name: string;
  latestStatePreview: string;
  latestStateRaw: unknown;
  latestActionType: string | null;
  recentActions: ActionRecord[];
  connectedAt: string;
  updatedAt: string;
}

interface RecorderSnapshot {
  extensionDetected: boolean;
  wrapped: boolean;
  stores: StoreRecord[];
  diagnostics: string[];
}

interface RecorderState {
  extensionDetected: boolean;
  wrapped: boolean;
  stores: Map<string, StoreRecord>;
  diagnostics: string[];
  storeCounter: number;
}

const NS = "reduxDevtools";
const INSTANCE = "primary";
const MAX_ACTIONS = 40;
const REDUX_EXTENSION_KEY = "__REDUX_DEVTOOLS_EXTENSION__";
const WRAP_MARKER = "__pageContextUserscriptReduxWrapped__";

const RESOURCE_IDS = {
  summary: "reduxDevtools.summary",
  diagnostics: "reduxDevtools.diagnostics",
  stores: "reduxDevtools.stores",
} as const;

const SKILL_IDS = {
  storeHealth: "reduxDevtools.analyze-store-health",
  actionFlow: "reduxDevtools.trace-action-flow",
  connectionGap: "reduxDevtools.explain-connection-gaps",
} as const;

const NAMESPACE: ContextNamespaceDescriptor = {
  namespace: NS,
  title: "Redux DevTools",
  description: "Read-only recorder for Redux DevTools extension connect/init/send/subscribe.",
  tags: ["redux-devtools", "readonly", "actions"],
};

const TOOLS: ToolSpec[] = [
  {
    name: "listStores",
    description: "List store instances captured by the recorder.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: "inspectStore",
    description: "Inspect the latest state and actions for a store.",
    inputSchema: {
      type: "object",
      properties: {
        storeId: { type: "string", description: "A storeId returned by listStores." },
      },
      additionalProperties: false,
    },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: "listRecentActions",
    description: "Read recent actions for a store.",
    inputSchema: {
      type: "object",
      properties: {
        storeId: { type: "string", description: "Optional. Defaults to the first known store." },
      },
      additionalProperties: false,
    },
    annotations: READONLY_ANNOTATION,
  },
];

const RESOURCES: ContextResourceDescriptor[] = [
  {
    id: RESOURCE_IDS.summary,
    namespace: NS,
    title: "Redux DevTools Summary",
    description: "Redux DevTools recorder detection summary.",
    mimeType: "application/json",
    kind: "json",
    tags: ["summary"],
  },
  {
    id: RESOURCE_IDS.diagnostics,
    namespace: NS,
    title: "Redux DevTools Diagnostics",
    description: "Extension interception and fallback diagnostics.",
    mimeType: "application/json",
    kind: "json",
    tags: ["diagnostics"],
  },
  {
    id: RESOURCE_IDS.stores,
    namespace: NS,
    title: "Redux DevTools Stores",
    description: "Current store list captured by the recorder.",
    mimeType: "application/json",
    kind: "json",
    tags: ["stores"],
  },
];

const SKILLS: ContextSkillDescriptor[] = [
  {
    id: SKILL_IDS.storeHealth,
    namespace: NS,
    title: "Analyze Store Health",
    description: "Analyze store activity and state update signals.",
    intentTags: ["analysis", "redux", "state"],
    resourceIds: [RESOURCE_IDS.summary, RESOURCE_IDS.stores, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[0]!, TOOLS[1]!]),
    mode: "analysis",
  },
  {
    id: SKILL_IDS.actionFlow,
    namespace: NS,
    title: "Trace Action Flow",
    description: "Trace state changes from recent actions.",
    intentTags: ["analysis", "redux", "actions"],
    resourceIds: [RESOURCE_IDS.stores, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[2]!, TOOLS[1]!]),
    mode: "analysis",
  },
  {
    id: SKILL_IDS.connectionGap,
    namespace: NS,
    title: "Explain Recorder Coverage Gaps",
    description: "Explain why the recorder did not capture the target store.",
    intentTags: ["analysis", "diagnostics", "redux-devtools"],
    resourceIds: [RESOURCE_IDS.summary, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[0]!]),
    mode: "analysis",
  },
];

export function createReduxDevtoolsUserscriptAdapter(win: Window, _doc: Document): UserscriptBridgeAdapter {
  const recorder = createReduxDevtoolsRecorder(win);
  recorder.start();

  const primaryInstance: PageToolInstance = {
    instanceId: INSTANCE,
    listTools: () => TOOLS,
    callTool: (name, input) => callReduxTool(name, input ?? {}, recorder),
  };

  return {
    adapterId: "redux-devtools",
    namespace: NAMESPACE,
    listInstances: () => [primaryInstance],
    listResources: () => RESOURCES,
    readResource: (id) => readReduxResource(id, recorder),
    listSkills: () => SKILLS,
    getSkill: (id, input) => getReduxSkillPrompt(id, input ?? {}, recorder),
    getSceneHint: () => "redux-devtools",
  };
}

function callReduxTool(name: string, input: ToolInput, recorder: ReturnType<typeof createReduxDevtoolsRecorder>): unknown {
  const snapshot = recorder.snapshot();

  if (name === "listStores") {
    return {
      extensionDetected: snapshot.extensionDetected,
      wrapped: snapshot.wrapped,
      storeCount: snapshot.stores.length,
      stores: snapshot.stores.map((store) => ({
        storeId: store.storeId,
        name: store.name,
        latestActionType: store.latestActionType,
        updatedAt: store.updatedAt,
      })),
    };
  }

  if (name === "inspectStore") {
    const store = resolveStore(snapshot.stores, input.storeId);
    if (!store) {
      return { ok: false, reason: "Store not found. Run listStores first." };
    }
    return {
      ok: true,
      store: {
        storeId: store.storeId,
        name: store.name,
        latestActionType: store.latestActionType,
        latestStatePreview: store.latestStatePreview,
        recentActions: store.recentActions,
      },
    };
  }

  if (name === "listRecentActions") {
    const store = resolveStore(snapshot.stores, input.storeId);
    if (!store) {
      return { ok: false, reason: "Store not found. Run listStores first." };
    }
    return {
      ok: true,
      storeId: store.storeId,
      actions: store.recentActions,
    };
  }

  throw new Error(`Unknown Redux DevTools tool: ${name}`);
}

function readReduxResource(id: string, recorder: ReturnType<typeof createReduxDevtoolsRecorder>) {
  const snapshot = recorder.snapshot();
  if (id === RESOURCE_IDS.summary) {
    return toJsonResource(id, {
      extensionDetected: snapshot.extensionDetected,
      wrapped: snapshot.wrapped,
      storeCount: snapshot.stores.length,
    });
  }
  if (id === RESOURCE_IDS.diagnostics) {
    return toJsonResource(id, { diagnostics: snapshot.diagnostics });
  }
  if (id === RESOURCE_IDS.stores) {
    return toJsonResource(id, { stores: snapshot.stores });
  }
  return toJsonResource(id, { error: `Unknown resource id: ${id}` });
}

function getReduxSkillPrompt(id: string, input: ToolInput, recorder: ReturnType<typeof createReduxDevtoolsRecorder>) {
  const skill = SKILLS.find((item) => item.id === id);
  if (!skill) {
    return undefined;
  }
  const snapshot = recorder.snapshot();
  const normalized = normalizeSkillInput(input);
  return buildSkillPrompt(skill, {
    goal: normalized.goal,
    focus: normalized.focus,
    facts: [
      `extensionDetected=${snapshot.extensionDetected}`,
      `wrapped=${snapshot.wrapped}`,
      `stores=${snapshot.stores.length}`,
    ],
  });
}

function resolveStore(stores: StoreRecord[], storeId: unknown): StoreRecord | undefined {
  if (typeof storeId === "string" && storeId) {
    return stores.find((store) => store.storeId === storeId);
  }
  return stores[0];
}

function createReduxDevtoolsRecorder(win: Window) {
  const state: RecorderState = {
    extensionDetected: false,
    wrapped: false,
    stores: new Map(),
    diagnostics: [],
    storeCounter: 0,
  };

  return {
    start() {
      observeReduxExtension(win, state);
    },
    snapshot(): RecorderSnapshot {
      return {
        extensionDetected: state.extensionDetected,
        wrapped: state.wrapped,
        stores: Array.from(state.stores.values()),
        diagnostics: [...state.diagnostics],
      };
    },
  };
}

function observeReduxExtension(win: Window, state: RecorderState): void {
  const target = win as Window & { __REDUX_DEVTOOLS_EXTENSION__?: unknown };

  // Handle the already-mounted extension first, then install a setter for late attachment.
  const immediate = target[REDUX_EXTENSION_KEY as keyof Window];
  if (immediate) {
    wrapReduxExtension(immediate, state);
  }

  const descriptor = Object.getOwnPropertyDescriptor(win, REDUX_EXTENSION_KEY);
  if (descriptor && descriptor.configurable === false) {
    state.diagnostics.push("window.__REDUX_DEVTOOLS_EXTENSION__ cannot be redefined, so the interception setter cannot be installed.");
    return;
  }

  let holder = immediate;
  Object.defineProperty(win, REDUX_EXTENSION_KEY, {
    configurable: true,
    enumerable: true,
    get() {
      return holder;
    },
    set(value) {
      holder = value;
      wrapReduxExtension(value, state);
    },
  });
}

function wrapReduxExtension(extensionLike: unknown, state: RecorderState): void {
  if (!isObjectRecord(extensionLike)) {
    return;
  }
  state.extensionDetected = true;

  const extension = extensionLike as ReduxDevtoolsExtensionLike & { __pageContextUserscriptReduxWrapped__?: boolean };
  if (extension[WRAP_MARKER]) {
    state.wrapped = true;
    return;
  }
  const originalConnect = extension.connect;
  if (typeof originalConnect !== "function") {
    state.diagnostics.push("The Redux DevTools extension does not expose connect().");
    return;
  }

  extension.connect = (options?: Record<string, unknown>) => {
    const rawConnection = originalConnect.call(extensionLike, options);
    if (!isObjectRecord(rawConnection)) {
      return rawConnection as ReduxDevtoolsConnectionLike;
    }
    const record = createStoreRecord(options, state);
    const wrapped = wrapConnection(rawConnection as ReduxDevtoolsConnectionLike, record, state);
    return wrapped;
  };

  Object.defineProperty(extension, WRAP_MARKER, { value: true, enumerable: false, configurable: false });
  state.wrapped = true;
}

function createStoreRecord(options: Record<string, unknown> | undefined, state: RecorderState): StoreRecord {
  state.storeCounter += 1;
  const storeName = typeof options?.name === "string" && options.name ? options.name : `store-${state.storeCounter}`;
  const now = new Date().toISOString();
  const store: StoreRecord = {
    storeId: `${storeName}#${state.storeCounter}`,
    name: storeName,
    latestStatePreview: "uninitialized",
    latestStateRaw: undefined,
    latestActionType: null,
    recentActions: [],
    connectedAt: now,
    updatedAt: now,
  };
  state.stores.set(store.storeId, store);
  return store;
}

function wrapConnection(connection: ReduxDevtoolsConnectionLike, store: StoreRecord, state: RecorderState): ReduxDevtoolsConnectionLike {
  const wrapped: ReduxDevtoolsConnectionLike = {
    ...connection,
    init(payload) {
      pushAction(store, "@@INIT", payload);
      return connection.init?.(payload);
    },
    send(action, payload) {
      pushAction(store, readActionType(action), payload);
      return connection.send?.(action, payload);
    },
    subscribe(listener) {
      if (typeof connection.subscribe !== "function") {
        state.diagnostics.push(`store ${store.storeId} connection.subscribe is not available.`);
        return () => undefined;
      }
      return connection.subscribe((message) => {
        handleDevtoolsMessage(store, message);
        listener(message);
      });
    },
  };

  // Subscribe once proactively so extension-driven messages are still recorded when the app never calls subscribe.
  if (typeof connection.subscribe === "function") {
    try {
      connection.subscribe((message) => handleDevtoolsMessage(store, message));
    } catch (error) {
      state.diagnostics.push(`store ${store.storeId} auto-subscribe failed: ${toErrorMessage(error)}`);
    }
  }

  return wrapped;
}

function handleDevtoolsMessage(store: StoreRecord, message: unknown): void {
  if (!isObjectRecord(message)) {
    return;
  }

  if (typeof message.type === "string" && message.type) {
    pushAction(store, `EXT:${message.type}`, message);
  }

  if (typeof message.state === "string" && message.state) {
    try {
      const parsed = JSON.parse(message.state);
      updateStoreState(store, parsed);
    } catch {
      // A parse failure is non-fatal. Keep the raw string preview instead.
      updateStoreState(store, message.state);
    }
  }
}

function pushAction(store: StoreRecord, actionType: string, statePayload: unknown): void {
  updateStoreState(store, statePayload);
  store.latestActionType = actionType;
  store.recentActions.push({
    type: actionType,
    preview: previewValue(statePayload),
    at: new Date().toISOString(),
  });
  if (store.recentActions.length > MAX_ACTIONS) {
    store.recentActions.splice(0, store.recentActions.length - MAX_ACTIONS);
  }
}

function updateStoreState(store: StoreRecord, statePayload: unknown): void {
  store.latestStateRaw = statePayload;
  store.latestStatePreview = previewValue(statePayload);
  store.updatedAt = new Date().toISOString();
}

function readActionType(action: unknown): string {
  if (typeof action === "string") {
    return action;
  }
  if (isObjectRecord(action) && typeof action.type === "string" && action.type) {
    return action.type;
  }
  return "UNKNOWN_ACTION";
}
