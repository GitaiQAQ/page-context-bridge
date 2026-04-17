import type {
  ContextNamespaceDescriptor,
  ContextResourceDescriptor,
  ContextSkillDescriptor,
  ToolSpec,
} from "@page-context/shared-protocol";

import type { PageToolInstance, ToolInput, UserscriptBridgeAdapter } from "../types";
import { buildSkillPrompt, listToolNames, normalizeSkillInput, previewValue, READONLY_ANNOTATION, toErrorMessage, toJsonResource, isObjectRecord } from "../utils";

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
}

const NS = "react";
const INSTANCE = "primary";
const RESOURCE_IDS = {
  summary: "react.summary",
  roots: "react.roots",
  selection: "react.selection",
  component: "react.component",
  diagnostics: "react.diagnostics",
} as const;

const SKILL_IDS = {
  rootLandscape: "react.analyze-root-landscape",
  selectionTrace: "react.trace-selection-component",
  componentReview: "react.review-component-state",
} as const;

const NAMESPACE: ContextNamespaceDescriptor = {
  namespace: NS,
  title: "React",
  description: "Read-only React runtime inspection via DevTools global hook.",
  tags: ["react", "readonly", "inspect"],
};

const TOOLS: ToolSpec[] = [
  {
    name: "listRoots",
    description: "列出当前页面检测到的 React roots 摘要。",
    inputSchema: {
      type: "object",
      properties: {
        includeDiagnostics: { type: "boolean", description: "是否附带 diagnostics。" },
      },
      additionalProperties: false,
    },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: "inspectComponent",
    description: "按 componentId 检查组件摘要。",
    inputSchema: {
      type: "object",
      properties: {
        componentId: { type: "string", description: "来自 listRoots 或 inspectSelectedElement 的 componentId。" },
      },
      required: ["componentId"],
      additionalProperties: false,
    },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: "inspectSelectedElement",
    description: "检查当前选区所在元素并回溯最近的 React 组件。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READONLY_ANNOTATION,
  },
];

const RESOURCES: ContextResourceDescriptor[] = [
  {
    id: RESOURCE_IDS.summary,
    namespace: NS,
    title: "React Summary",
    description: "React 检测摘要和最近检查状态。",
    mimeType: "application/json",
    kind: "json",
    tags: ["summary"],
  },
  {
    id: RESOURCE_IDS.roots,
    namespace: NS,
    title: "React Roots",
    description: "React roots 摘要列表。",
    mimeType: "application/json",
    kind: "json",
    tags: ["roots"],
  },
  {
    id: RESOURCE_IDS.selection,
    namespace: NS,
    title: "React Selection",
    description: "当前选区对应元素和组件定位结果。",
    mimeType: "application/json",
    kind: "json",
    tags: ["selection"],
  },
  {
    id: RESOURCE_IDS.component,
    namespace: NS,
    title: "React Component",
    description: "最近一次 inspectComponent 的结果。",
    mimeType: "application/json",
    kind: "json",
    tags: ["component"],
  },
  {
    id: RESOURCE_IDS.diagnostics,
    namespace: NS,
    title: "React Diagnostics",
    description: "React hook 检测与降级诊断信息。",
    mimeType: "application/json",
    kind: "json",
    tags: ["diagnostics"],
  },
];

const SKILLS: ContextSkillDescriptor[] = [
  {
    id: SKILL_IDS.rootLandscape,
    namespace: NS,
    title: "Analyze React Root Landscape",
    description: "分析 roots 数量、拓扑和潜在异常区域。",
    intentTags: ["analysis", "react", "roots"],
    resourceIds: [RESOURCE_IDS.summary, RESOURCE_IDS.roots, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[0]!]),
    mode: "analysis",
  },
  {
    id: SKILL_IDS.selectionTrace,
    namespace: NS,
    title: "Trace Selected Element to Component",
    description: "把当前选区映射到组件并解释上下文。",
    intentTags: ["analysis", "selection", "react"],
    resourceIds: [RESOURCE_IDS.selection, RESOURCE_IDS.component, RESOURCE_IDS.roots],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[2]!, TOOLS[1]!]),
    mode: "analysis",
  },
  {
    id: SKILL_IDS.componentReview,
    namespace: NS,
    title: "Review Component Props and State",
    description: "分析组件 props/state 预览并输出证据链。",
    intentTags: ["analysis", "component", "state"],
    resourceIds: [RESOURCE_IDS.component, RESOURCE_IDS.summary, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[1]!, TOOLS[0]!]),
    mode: "analysis",
  },
];

export function createReactUserscriptAdapter(win: Window, doc: Document): UserscriptBridgeAdapter {
  const state: ReactAdapterState = {
    lastSnapshot: null,
    lastSelection: null,
    lastComponent: null,
    installedAt: new Date().toISOString(),
  };

  const primaryInstance: PageToolInstance = {
    instanceId: INSTANCE,
    listTools: () => TOOLS,
    callTool: (name, input) => callReactTool(name, input ?? {}, win, doc, state),
  };

  return {
    adapterId: "react-inspector",
    namespace: NAMESPACE,
    listInstances: () => [primaryInstance],
    listResources: () => RESOURCES,
    readResource: (id) => readReactResource(id, win, doc, state),
    listSkills: () => SKILLS,
    getSkill: (id, input) => getReactSkillPrompt(id, input ?? {}, win, doc, state),
    getSceneHint: () => "react",
  };
}

function callReactTool(name: string, input: ToolInput, win: Window, doc: Document, state: ReactAdapterState): unknown {
  if (name === "listRoots") {
    const snapshot = collectReactSnapshot(win, doc);
    state.lastSnapshot = snapshot;
    return {
      reactDetected: snapshot.reactDetected,
      rendererCount: snapshot.rendererCount,
      roots: snapshot.roots,
      diagnostics: input.includeDiagnostics ? snapshot.diagnostics : undefined,
    };
  }

  if (name === "inspectComponent") {
    const componentId = typeof input.componentId === "string" ? input.componentId : "";
    if (!componentId) {
      return { ok: false, reason: "componentId 不能为空。" };
    }

    const snapshot = collectReactSnapshot(win, doc);
    state.lastSnapshot = snapshot;
    const component = snapshot.componentMap.get(componentId) ?? null;
    state.lastComponent = component;
    if (!component) {
      return {
        ok: false,
        reason: `找不到组件：${componentId}`,
        suggestion: "先执行 listRoots 或 inspectSelectedElement 获取 componentId。",
      };
    }
    return { ok: true, component };
  }

  if (name === "inspectSelectedElement") {
    const snapshot = collectReactSnapshot(win, doc);
    state.lastSnapshot = snapshot;

    const selectedElement = resolveSelectedElement(win);
    const nearestFiber = findNearestFiberFromElement(selectedElement);
    const nearestComponent = nearestFiber ? buildComponentSummaryFromFiber(nearestFiber, snapshot.roots) : null;

    const selection: SelectionSummary = {
      selectedText: (win.getSelection?.()?.toString() ?? "").trim(),
      element: describeElement(selectedElement),
      nearestComponent,
    };
    state.lastSelection = selection;
    if (nearestComponent) {
      state.lastComponent = nearestComponent;
    }
    return { ok: true, ...selection };
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
    return toJsonResource(id, state.lastSelection ?? { selectedText: "", element: null, nearestComponent: null });
  }

  if (id === RESOURCE_IDS.component) {
    return toJsonResource(id, { component: state.lastComponent, hasComponent: Boolean(state.lastComponent) });
  }

  if (id === RESOURCE_IDS.diagnostics) {
    return toJsonResource(id, { diagnostics: snapshot.diagnostics, rendererCount: snapshot.rendererCount });
  }

  return toJsonResource(id, { error: `Unknown resource id: ${id}` });
}

function getReactSkillPrompt(id: string, input: ToolInput, win: Window, doc: Document, state: ReactAdapterState) {
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
    diagnostics.push("DevTools hook 存在，但 renderers 为空。");
  }
  if (rendererIds.length > 0 && roots.length === 0) {
    diagnostics.push("检测到 renderers 但没有 roots，可能是页面尚未挂载。");
  }

  const containerHints = countReactContainerHints(doc);
  if (containerHints > 0 && roots.length === 0) {
    diagnostics.push(`DOM 上发现 ${containerHints} 个 React container 标记，但无法构建 root 摘要。`);
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
  const stack: Array<{ fiber: FiberNodeLike; depth: number; path: string }> = [{ fiber: start, depth: 0, path: "0" }];

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
      componentMap.set(componentId, {
        componentId,
        rootId,
        name: displayName,
        depth: item.depth,
        key: readFiberKey(item.fiber),
        propsPreview: previewValue(item.fiber.memoizedProps),
        statePreview: previewValue(item.fiber.memoizedState),
      });
    }

    const children = collectFiberChildren(item.fiber);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (!child) {
        continue;
      }
      stack.push({ fiber: child, depth: item.depth + 1, path: `${item.path}.${index}` });
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
  const hook = (win as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevtoolsHookLike }).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) {
    diagnostics.push("未检测到 __REACT_DEVTOOLS_GLOBAL_HOOK__。");
    return undefined;
  }
  return hook;
}

function getRendererIds(hook: ReactDevtoolsHookLike, diagnostics: string[]): number[] {
  if (!(hook.renderers instanceof Map)) {
    diagnostics.push("DevTools hook 没有 renderers Map。");
    return [];
  }
  const ids: number[] = [];
  for (const key of hook.renderers.keys()) {
    const numeric = Number(key);
    if (!Number.isFinite(numeric)) {
      diagnostics.push(`忽略非法 renderer id: ${String(key)}`);
      continue;
    }
    ids.push(numeric);
  }
  return ids;
}

function getFiberRoots(hook: ReactDevtoolsHookLike, rendererId: number, diagnostics: string[]): FiberRootLike[] {
  if (typeof hook.getFiberRoots !== "function") {
    diagnostics.push("DevTools hook 缺少 getFiberRoots 方法。");
    return [];
  }
  try {
    const roots = hook.getFiberRoots(rendererId);
    if (!(roots instanceof Set)) {
      diagnostics.push(`renderer ${rendererId} roots 不是 Set。`);
      return [];
    }
    return Array.from(roots).filter((item): item is FiberRootLike => isObjectRecord(item));
  } catch (error) {
    diagnostics.push(`读取 renderer ${rendererId} roots 失败: ${toErrorMessage(error)}`);
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
  let cursor: Element | null = start;
  while (cursor) {
    const fiber = readFiberFromDomNode(cursor);
    if (fiber) {
      return fiber;
    }
    cursor = cursor.parentElement;
  }
  return null;
}

function readFiberFromDomNode(node: Element): FiberNodeLike | null {
  const ownKeys = Object.getOwnPropertyNames(node);
  const fiberKey = ownKeys.find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
  if (!fiberKey) {
    return null;
  }
  const value = (node as unknown as Record<string, unknown>)[fiberKey];
  return isObjectRecord(value) ? (value as FiberNodeLike) : null;
}

function buildComponentSummaryFromFiber(fiber: FiberNodeLike, roots: RootSummary[]): ComponentSummary | null {
  const name = getFiberDisplayName(fiber);
  if (!name) {
    return null;
  }
  const rootId = roots[0]?.rootId ?? "renderer:unknown:root:0";
  const path = buildFiberPath(fiber);
  return {
    componentId: `${rootId}:fiber:${path}`,
    rootId,
    name,
    depth: path.split(".").length - 1,
    key: readFiberKey(fiber),
    propsPreview: previewValue(fiber.memoizedProps),
    statePreview: previewValue(fiber.memoizedState),
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
  return segments.length > 0 ? segments.join(".") : "0";
}

function getFiberDisplayName(fiber: FiberNodeLike): string | null {
  const type = fiber.elementType ?? fiber.type;
  if (typeof type === "string") {
    return type;
  }
  if (typeof type === "function") {
    const named = type as Function & { displayName?: string };
    return named.displayName || named.name || "AnonymousComponent";
  }
  if (isObjectRecord(type)) {
    if (typeof type.displayName === "string" && type.displayName) {
      return type.displayName;
    }
    if (typeof type.render === "function") {
      const render = type.render as Function & { displayName?: string };
      return render.displayName || render.name || "AnonymousRender";
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
  const nodeName = typeof containerInfo.nodeName === "string" ? containerInfo.nodeName.toLowerCase() : "unknown";
  const id = typeof containerInfo.id === "string" && containerInfo.id ? `#${containerInfo.id}` : "";
  const className =
    typeof containerInfo.className === "string" && containerInfo.className
      ? `.${containerInfo.className.split(/\s+/).filter(Boolean).join(".")}`
      : "";
  return `${nodeName}${id}${className}`;
}

function describeElement(element: Element | null): string | null {
  if (!element) {
    return null;
  }
  const id = element.id ? `#${element.id}` : "";
  const className = element.classList.length > 0 ? `.${Array.from(element.classList).join(".")}` : "";
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
    if (keys.some((key) => key.startsWith("__reactContainer$"))) {
      hints += 1;
    }
  }
  return hints;
}
