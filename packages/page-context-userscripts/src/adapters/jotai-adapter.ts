import type {
  ContextNamespaceDescriptor,
  ContextResourceDescriptor,
  ContextSkillDescriptor,
  ToolSpec,
} from "@page-context/shared-protocol";

import type { PageToolInstance, ToolInput, UserscriptBridgeAdapter } from "../types";
import { buildSkillPrompt, listToolNames, normalizeSkillInput, previewValue, READONLY_ANNOTATION, toErrorMessage, toJsonResource, isObjectRecord } from "../utils";

interface JotaiAtomSummary {
  atomId: string;
  debugLabel: string;
  valuePreview: string;
  hasMountedInfo: boolean;
}

interface JotaiSnapshot {
  detected: boolean;
  atoms: JotaiAtomSummary[];
  diagnostics: string[];
  atomLookup: Map<string, unknown>;
}

interface JotaiAdapterState {
  lastSnapshot: JotaiSnapshot | null;
}

interface JotaiDevStoreLike extends Record<string, unknown> {
  dev4_get_mounted_atoms?: () => Set<unknown>;
  dev4_get_internal_weak_map?: () => WeakMap<object, unknown>;
  get?: (atom: unknown) => unknown;
}

const NS = "jotai";
const INSTANCE = "primary";

const RESOURCE_IDS = {
  summary: "jotai.summary",
  diagnostics: "jotai.diagnostics",
  atoms: "jotai.atoms",
} as const;

const SKILL_IDS = {
  atomTopology: "jotai.analyze-mounted-atoms",
  atomValueTrace: "jotai.trace-atom-values",
  missingDevtools: "jotai.explain-devtools-gaps",
} as const;

const NAMESPACE: ContextNamespaceDescriptor = {
  namespace: NS,
  title: "Jotai Devtools",
  description: "Read-only Jotai dev store inspection based on globalThis.__JOTAI_DEFAULT_STORE__.",
  tags: ["jotai", "readonly", "atoms"],
};

const TOOLS: ToolSpec[] = [
  {
    name: "listMountedAtoms",
    description: "列出 Jotai mounted atoms 摘要。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: "inspectAtom",
    description: "按 atomId 查看 atom 预览信息。",
    inputSchema: {
      type: "object",
      properties: {
        atomId: { type: "string", description: "来自 listMountedAtoms 的 atomId。" },
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
    title: "Jotai Summary",
    description: "Jotai dev store 检测摘要。",
    mimeType: "application/json",
    kind: "json",
    tags: ["summary"],
  },
  {
    id: RESOURCE_IDS.diagnostics,
    namespace: NS,
    title: "Jotai Diagnostics",
    description: "Jotai dev 方法读取降级信息。",
    mimeType: "application/json",
    kind: "json",
    tags: ["diagnostics"],
  },
  {
    id: RESOURCE_IDS.atoms,
    namespace: NS,
    title: "Jotai Atoms",
    description: "当前 mounted atoms 列表。",
    mimeType: "application/json",
    kind: "json",
    tags: ["atoms"],
  },
];

const SKILLS: ContextSkillDescriptor[] = [
  {
    id: SKILL_IDS.atomTopology,
    namespace: NS,
    title: "Analyze Mounted Atoms",
    description: "分析 mounted atoms 分布和可观察值。",
    intentTags: ["analysis", "jotai", "atoms"],
    resourceIds: [RESOURCE_IDS.summary, RESOURCE_IDS.atoms, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[0]!]),
    mode: "analysis",
  },
  {
    id: SKILL_IDS.atomValueTrace,
    namespace: NS,
    title: "Trace Atom Value",
    description: "按 atomId 检查当前值与可读性。",
    intentTags: ["analysis", "jotai", "state"],
    resourceIds: [RESOURCE_IDS.atoms, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[0]!, TOOLS[1]!]),
    mode: "analysis",
  },
  {
    id: SKILL_IDS.missingDevtools,
    namespace: NS,
    title: "Explain Missing Jotai Dev Hooks",
    description: "解释为什么当前页面拿不到 Jotai dev store 数据。",
    intentTags: ["analysis", "jotai", "diagnostics"],
    resourceIds: [RESOURCE_IDS.summary, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[0]!]),
    mode: "analysis",
  },
];

export function createJotaiUserscriptAdapter(_win: Window, _doc: Document): UserscriptBridgeAdapter {
  const state: JotaiAdapterState = { lastSnapshot: null };

  const primaryInstance: PageToolInstance = {
    instanceId: INSTANCE,
    listTools: () => TOOLS,
    callTool: (name, input) => callJotaiTool(name, input ?? {}, state),
  };

  return {
    adapterId: "jotai-devtools",
    namespace: NAMESPACE,
    listInstances: () => [primaryInstance],
    listResources: () => RESOURCES,
    readResource: (id) => readJotaiResource(id, state),
    listSkills: () => SKILLS,
    getSkill: (id, input) => getJotaiSkillPrompt(id, input ?? {}, state),
    getSceneHint: () => "jotai",
  };
}

function callJotaiTool(name: string, input: ToolInput, state: JotaiAdapterState): unknown {
  const snapshot = collectJotaiSnapshot();
  state.lastSnapshot = snapshot;

  if (name === "listMountedAtoms") {
    return {
      detected: snapshot.detected,
      atomCount: snapshot.atoms.length,
      atoms: snapshot.atoms,
    };
  }

  if (name === "inspectAtom") {
    const atomId = typeof input.atomId === "string" && input.atomId ? input.atomId : snapshot.atoms[0]?.atomId;
    if (!atomId) {
      return { ok: false, reason: "没有 mounted atoms，且未提供 atomId。" };
    }
    const atom = snapshot.atoms.find((item) => item.atomId === atomId) ?? null;
    if (!atom) {
      return { ok: false, reason: `找不到 atomId=${atomId}` };
    }
    return { ok: true, atom };
  }

  throw new Error(`Unknown Jotai tool: ${name}`);
}

function readJotaiResource(id: string, state: JotaiAdapterState) {
  const snapshot = state.lastSnapshot ?? collectJotaiSnapshot();
  state.lastSnapshot = snapshot;

  if (id === RESOURCE_IDS.summary) {
    return toJsonResource(id, {
      detected: snapshot.detected,
      atomCount: snapshot.atoms.length,
    });
  }
  if (id === RESOURCE_IDS.diagnostics) {
    return toJsonResource(id, { diagnostics: snapshot.diagnostics });
  }
  if (id === RESOURCE_IDS.atoms) {
    return toJsonResource(id, { atoms: snapshot.atoms });
  }
  return toJsonResource(id, { error: `Unknown resource id: ${id}` });
}

function getJotaiSkillPrompt(id: string, input: ToolInput, state: JotaiAdapterState) {
  const skill = SKILLS.find((item) => item.id === id);
  if (!skill) {
    return undefined;
  }
  const snapshot = state.lastSnapshot ?? collectJotaiSnapshot();
  state.lastSnapshot = snapshot;
  const normalized = normalizeSkillInput(input);
  return buildSkillPrompt(skill, {
    goal: normalized.goal,
    focus: normalized.focus,
    facts: [
      `jotaiDetected=${snapshot.detected}`,
      `mountedAtoms=${snapshot.atoms.length}`,
      `diagnostics=${snapshot.diagnostics.length}`,
    ],
  });
}

function collectJotaiSnapshot(): JotaiSnapshot {
  const diagnostics: string[] = [];
  const store = (globalThis as { __JOTAI_DEFAULT_STORE__?: unknown }).__JOTAI_DEFAULT_STORE__;
  if (!isObjectRecord(store)) {
    diagnostics.push("未检测到 globalThis.__JOTAI_DEFAULT_STORE__。");
    return {
      detected: false,
      atoms: [],
      diagnostics,
      atomLookup: new Map(),
    };
  }

  const devStore = store as JotaiDevStoreLike;
  const mountedAtoms = readMountedAtoms(devStore, diagnostics);
  const weakMap = readInternalWeakMap(devStore, diagnostics);

  const atomLookup = new Map<string, unknown>();
  const atoms = mountedAtoms.map((atom, index) => {
    const atomId = `atom:${index}`;
    atomLookup.set(atomId, atom);
    const debugLabel = readAtomLabel(atom, index);
    const valuePreview = readAtomValuePreview(devStore, weakMap, atom, diagnostics);
    return {
      atomId,
      debugLabel,
      valuePreview,
      hasMountedInfo: weakMap ? weakMap.has(atom as object) : false,
    };
  });

  return {
    detected: true,
    atoms,
    diagnostics,
    atomLookup,
  };
}

function readMountedAtoms(store: JotaiDevStoreLike, diagnostics: string[]): unknown[] {
  if (typeof store.dev4_get_mounted_atoms !== "function") {
    diagnostics.push("Jotai dev4_get_mounted_atoms 不可用。");
    return [];
  }
  try {
    const atoms = store.dev4_get_mounted_atoms();
    return atoms instanceof Set ? Array.from(atoms.values()) : [];
  } catch (error) {
    diagnostics.push(`读取 mounted atoms 失败: ${toErrorMessage(error)}`);
    return [];
  }
}

function readInternalWeakMap(store: JotaiDevStoreLike, diagnostics: string[]): WeakMap<object, unknown> | null {
  if (typeof store.dev4_get_internal_weak_map !== "function") {
    diagnostics.push("Jotai dev4_get_internal_weak_map 不可用。");
    return null;
  }
  try {
    const weakMap = store.dev4_get_internal_weak_map();
    if (weakMap instanceof WeakMap) {
      return weakMap;
    }
    diagnostics.push("Jotai internal weak map 返回值异常。");
    return null;
  } catch (error) {
    diagnostics.push(`读取 internal weak map 失败: ${toErrorMessage(error)}`);
    return null;
  }
}

function readAtomLabel(atom: unknown, index: number): string {
  if (!isObjectRecord(atom)) {
    return `anonymous-atom-${index}`;
  }
  if (typeof atom.debugLabel === "string" && atom.debugLabel) {
    return atom.debugLabel;
  }
  if (typeof atom.toString === "function") {
    try {
      const label = atom.toString();
      if (label && label !== "[object Object]") {
        return label;
      }
    } catch {
      // ignore to keep fallback label stable
    }
  }
  return `anonymous-atom-${index}`;
}

function readAtomValuePreview(
  store: JotaiDevStoreLike,
  weakMap: WeakMap<object, unknown> | null,
  atom: unknown,
  diagnostics: string[],
): string {
  if (weakMap && isObjectRecord(atom)) {
    const internalState = weakMap.get(atom as object);
    if (isObjectRecord(internalState) && "v" in internalState) {
      return previewValue(internalState.v);
    }
  }
  if (typeof store.get === "function") {
    try {
      return previewValue(store.get(atom));
    } catch (error) {
      diagnostics.push(`store.get(atom) 失败: ${toErrorMessage(error)}`);
      return "unreadable";
    }
  }
  return "unknown";
}
