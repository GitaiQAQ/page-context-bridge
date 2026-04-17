import type {
  ContextNamespaceDescriptor,
  ContextResourceDescriptor,
  ContextSkillDescriptor,
  ToolSpec,
} from "@page-context/shared-protocol";

import type { PageToolInstance, ToolInput, UserscriptBridgeAdapter } from "../types";
import { buildSkillPrompt, listToolNames, normalizeSkillInput, previewValue, READONLY_ANNOTATION, toErrorMessage, toJsonResource, isObjectRecord } from "../utils";

interface TanstackQuerySummary {
  queryHash: string;
  status: string;
  fetchStatus: string;
  observers: number;
  dataPreview: string;
}

interface TanstackMutationSummary {
  mutationId: string;
  status: string;
  variablesPreview: string;
}

interface TanstackSnapshot {
  detected: boolean;
  isFetching: number;
  isMutating: number;
  queries: TanstackQuerySummary[];
  mutations: TanstackMutationSummary[];
  diagnostics: string[];
}

interface TanstackAdapterState {
  lastSnapshot: TanstackSnapshot | null;
}

const NS = "tanstackQuery";
const INSTANCE = "primary";

const RESOURCE_IDS = {
  summary: "tanstackQuery.summary",
  diagnostics: "tanstackQuery.diagnostics",
  queries: "tanstackQuery.queries",
} as const;

const SKILL_IDS = {
  queryHealth: "tanstackQuery.analyze-query-health",
  staleData: "tanstackQuery.detect-stale-data-risks",
  mutationFlow: "tanstackQuery.trace-mutation-flow",
} as const;

const NAMESPACE: ContextNamespaceDescriptor = {
  namespace: NS,
  title: "TanStack Query",
  description: "Read-only TanStack Query client inspection based on window.TANSTACK_QUERY_CLIENT.",
  tags: ["tanstack-query", "readonly", "cache"],
};

const TOOLS: ToolSpec[] = [
  {
    name: "listQueries",
    description: "列出 QueryCache 中的查询摘要。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: "inspectQuery",
    description: "按 queryHash 查看查询详情。",
    inputSchema: {
      type: "object",
      properties: {
        queryHash: { type: "string", description: "query.queryHash 值。" },
      },
      additionalProperties: false,
    },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: "listMutations",
    description: "列出 MutationCache 中的 mutation 摘要。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READONLY_ANNOTATION,
  },
];

const RESOURCES: ContextResourceDescriptor[] = [
  {
    id: RESOURCE_IDS.summary,
    namespace: NS,
    title: "TanStack Query Summary",
    description: "TanStack Query 检测和缓存摘要。",
    mimeType: "application/json",
    kind: "json",
    tags: ["summary"],
  },
  {
    id: RESOURCE_IDS.diagnostics,
    namespace: NS,
    title: "TanStack Query Diagnostics",
    description: "TanStack Query 读取降级信息。",
    mimeType: "application/json",
    kind: "json",
    tags: ["diagnostics"],
  },
  {
    id: RESOURCE_IDS.queries,
    namespace: NS,
    title: "TanStack Query Cache",
    description: "QueryCache 查询清单。",
    mimeType: "application/json",
    kind: "json",
    tags: ["queries"],
  },
];

const SKILLS: ContextSkillDescriptor[] = [
  {
    id: SKILL_IDS.queryHealth,
    namespace: NS,
    title: "Analyze Query Health",
    description: "分析查询状态分布与加载压力。",
    intentTags: ["analysis", "query", "tanstack"],
    resourceIds: [RESOURCE_IDS.summary, RESOURCE_IDS.queries, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[0]!, TOOLS[1]!]),
    mode: "analysis",
  },
  {
    id: SKILL_IDS.staleData,
    namespace: NS,
    title: "Detect Stale Data Risks",
    description: "定位高风险 stale query 线索。",
    intentTags: ["analysis", "stale", "cache"],
    resourceIds: [RESOURCE_IDS.queries, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[0]!, TOOLS[1]!]),
    mode: "analysis",
  },
  {
    id: SKILL_IDS.mutationFlow,
    namespace: NS,
    title: "Trace Mutation Flow",
    description: "检查 mutation 执行状态和变量摘要。",
    intentTags: ["analysis", "mutation", "tanstack"],
    resourceIds: [RESOURCE_IDS.summary, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[2]!]),
    mode: "analysis",
  },
];

export function createTanstackQueryUserscriptAdapter(win: Window, _doc: Document): UserscriptBridgeAdapter {
  const state: TanstackAdapterState = { lastSnapshot: null };
  const primaryInstance: PageToolInstance = {
    instanceId: INSTANCE,
    listTools: () => TOOLS,
    callTool: (name, input) => callTanstackTool(name, input ?? {}, win, state),
  };

  return {
    adapterId: "tanstack-query",
    namespace: NAMESPACE,
    listInstances: () => [primaryInstance],
    listResources: () => RESOURCES,
    readResource: (id) => readTanstackResource(id, win, state),
    listSkills: () => SKILLS,
    getSkill: (id, input) => getTanstackSkillPrompt(id, input ?? {}, win, state),
    getSceneHint: () => "tanstack-query",
  };
}

function callTanstackTool(name: string, input: ToolInput, win: Window, state: TanstackAdapterState): unknown {
  const snapshot = collectTanstackSnapshot(win);
  state.lastSnapshot = snapshot;

  if (name === "listQueries") {
    return {
      detected: snapshot.detected,
      queryCount: snapshot.queries.length,
      queries: snapshot.queries,
    };
  }

  if (name === "inspectQuery") {
    const queryHash = typeof input.queryHash === "string" && input.queryHash ? input.queryHash : snapshot.queries[0]?.queryHash;
    if (!queryHash) {
      return { ok: false, reason: "没有可用 query，且未提供 queryHash。" };
    }
    const query = snapshot.queries.find((item) => item.queryHash === queryHash) ?? null;
    if (!query) {
      return { ok: false, reason: `找不到 queryHash=${queryHash}` };
    }
    return { ok: true, query };
  }

  if (name === "listMutations") {
    return {
      detected: snapshot.detected,
      mutationCount: snapshot.mutations.length,
      mutations: snapshot.mutations,
    };
  }

  throw new Error(`Unknown TanStack Query tool: ${name}`);
}

function readTanstackResource(id: string, win: Window, state: TanstackAdapterState) {
  const snapshot = state.lastSnapshot ?? collectTanstackSnapshot(win);
  state.lastSnapshot = snapshot;

  if (id === RESOURCE_IDS.summary) {
    return toJsonResource(id, {
      detected: snapshot.detected,
      queryCount: snapshot.queries.length,
      mutationCount: snapshot.mutations.length,
      isFetching: snapshot.isFetching,
      isMutating: snapshot.isMutating,
    });
  }
  if (id === RESOURCE_IDS.diagnostics) {
    return toJsonResource(id, { diagnostics: snapshot.diagnostics });
  }
  if (id === RESOURCE_IDS.queries) {
    return toJsonResource(id, { queries: snapshot.queries, mutations: snapshot.mutations });
  }
  return toJsonResource(id, { error: `Unknown resource id: ${id}` });
}

function getTanstackSkillPrompt(id: string, input: ToolInput, win: Window, state: TanstackAdapterState) {
  const skill = SKILLS.find((item) => item.id === id);
  if (!skill) {
    return undefined;
  }
  const snapshot = state.lastSnapshot ?? collectTanstackSnapshot(win);
  state.lastSnapshot = snapshot;
  const normalized = normalizeSkillInput(input);
  return buildSkillPrompt(skill, {
    goal: normalized.goal,
    focus: normalized.focus,
    facts: [
      `tanstackDetected=${snapshot.detected}`,
      `queryCount=${snapshot.queries.length}`,
      `mutationCount=${snapshot.mutations.length}`,
      `isFetching=${snapshot.isFetching}`,
    ],
  });
}

function collectTanstackSnapshot(win: Window): TanstackSnapshot {
  const diagnostics: string[] = [];
  const client = (win as Window & { TANSTACK_QUERY_CLIENT?: unknown }).TANSTACK_QUERY_CLIENT;
  if (!isObjectRecord(client)) {
    diagnostics.push("未检测到 window.TANSTACK_QUERY_CLIENT。");
    return {
      detected: false,
      isFetching: 0,
      isMutating: 0,
      queries: [],
      mutations: [],
      diagnostics,
    };
  }

  const queryCache = readCache(client, "getQueryCache", diagnostics);
  const mutationCache = readCache(client, "getMutationCache", diagnostics);
  const queries = readQueries(queryCache, diagnostics);
  const mutations = readMutations(mutationCache, diagnostics);

  const isFetching = readCounter(client, "isFetching", diagnostics);
  const isMutating = readCounter(client, "isMutating", diagnostics);

  return {
    detected: true,
    isFetching,
    isMutating,
    queries,
    mutations,
    diagnostics,
  };
}

function readCache(
  client: Record<string, unknown>,
  methodName: "getQueryCache" | "getMutationCache",
  diagnostics: string[],
): Record<string, unknown> | null {
  const method = client[methodName];
  if (typeof method !== "function") {
    diagnostics.push(`TanStack QueryClient.${methodName} 不可用。`);
    return null;
  }
  try {
    const cache = method.call(client);
    return isObjectRecord(cache) ? cache : null;
  } catch (error) {
    diagnostics.push(`调用 ${methodName} 失败: ${toErrorMessage(error)}`);
    return null;
  }
}

function readQueries(queryCache: Record<string, unknown> | null, diagnostics: string[]): TanstackQuerySummary[] {
  if (!queryCache) {
    return [];
  }
  const getAll = queryCache.getAll;
  if (typeof getAll !== "function") {
    diagnostics.push("QueryCache.getAll 不可用。");
    return [];
  }
  try {
    const list = getAll.call(queryCache);
    if (!Array.isArray(list)) {
      diagnostics.push("QueryCache.getAll 返回非数组。");
      return [];
    }
    return list.map((item, index) => summarizeQuery(item, index));
  } catch (error) {
    diagnostics.push(`读取 query cache 失败: ${toErrorMessage(error)}`);
    return [];
  }
}

function summarizeQuery(queryLike: unknown, index: number): TanstackQuerySummary {
  if (!isObjectRecord(queryLike)) {
    return {
      queryHash: `query-${index}`,
      status: "unknown",
      fetchStatus: "unknown",
      observers: 0,
      dataPreview: previewValue(queryLike),
    };
  }
  const state = isObjectRecord(queryLike.state) ? queryLike.state : {};
  const observers = Array.isArray(queryLike.observers) ? queryLike.observers.length : 0;
  return {
    queryHash: typeof queryLike.queryHash === "string" ? queryLike.queryHash : `query-${index}`,
    status: typeof state.status === "string" ? state.status : "unknown",
    fetchStatus: typeof state.fetchStatus === "string" ? state.fetchStatus : "unknown",
    observers,
    dataPreview: previewValue(state.data),
  };
}

function readMutations(mutationCache: Record<string, unknown> | null, diagnostics: string[]): TanstackMutationSummary[] {
  if (!mutationCache) {
    return [];
  }
  const getAll = mutationCache.getAll;
  if (typeof getAll !== "function") {
    diagnostics.push("MutationCache.getAll 不可用。");
    return [];
  }
  try {
    const list = getAll.call(mutationCache);
    if (!Array.isArray(list)) {
      diagnostics.push("MutationCache.getAll 返回非数组。");
      return [];
    }
    return list.map((item, index) => summarizeMutation(item, index));
  } catch (error) {
    diagnostics.push(`读取 mutation cache 失败: ${toErrorMessage(error)}`);
    return [];
  }
}

function summarizeMutation(mutationLike: unknown, index: number): TanstackMutationSummary {
  if (!isObjectRecord(mutationLike)) {
    return {
      mutationId: `mutation-${index}`,
      status: "unknown",
      variablesPreview: previewValue(mutationLike),
    };
  }
  const state = isObjectRecord(mutationLike.state) ? mutationLike.state : {};
  return {
    mutationId: typeof mutationLike.mutationId === "number" ? String(mutationLike.mutationId) : `mutation-${index}`,
    status: typeof state.status === "string" ? state.status : "unknown",
    variablesPreview: previewValue(state.variables),
  };
}

function readCounter(client: Record<string, unknown>, methodName: "isFetching" | "isMutating", diagnostics: string[]): number {
  const method = client[methodName];
  if (typeof method !== "function") {
    diagnostics.push(`QueryClient.${methodName} 不可用，按 0 处理。`);
    return 0;
  }
  try {
    const value = method.call(client);
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  } catch (error) {
    diagnostics.push(`调用 ${methodName} 失败: ${toErrorMessage(error)}`);
    return 0;
  }
}
