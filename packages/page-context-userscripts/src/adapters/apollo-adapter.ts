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

interface ApolloQuerySummary {
  queryId: string;
  operationName: string;
  networkStatus: string;
  variablesPreview: string;
}

interface ApolloSnapshot {
  detected: boolean;
  cacheExtract: Record<string, unknown> | null;
  activeQueries: ApolloQuerySummary[];
  diagnostics: string[];
}

interface ApolloAdapterState {
  lastSnapshot: ApolloSnapshot | null;
}

const NS = 'apollo';
const INSTANCE = 'primary';

const RESOURCE_IDS = {
  summary: 'apollo.summary',
  diagnostics: 'apollo.diagnostics',
  cache: 'apollo.cache',
} as const;

const SKILL_IDS = {
  cacheAudit: 'apollo.audit-cache-shape',
  queryFlow: 'apollo.trace-active-queries',
  cacheGap: 'apollo.find-cache-gaps',
} as const;

const NAMESPACE: ContextNamespaceDescriptor = {
  namespace: NS,
  title: 'Apollo Client',
  description: 'Read-only Apollo cache/query inspection based on window.__APOLLO_CLIENT__.',
  tags: ['apollo', 'graphql', 'readonly'],
};

const TOOLS: ToolSpec[] = [
  {
    name: 'listActiveQueries',
    description: 'List active queries visible from the Apollo query manager.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: 'inspectCache',
    description: 'Read a summary from Apollo cache.extract().',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: 'inspectQuery',
    description: 'Inspect a query summary by queryId.',
    inputSchema: {
      type: 'object',
      properties: {
        queryId: { type: 'string', description: 'The query key from the Apollo query manager.' },
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
    title: 'Apollo Summary',
    description: 'Apollo client detection summary.',
    mimeType: 'application/json',
    kind: 'json',
    tags: ['summary'],
  },
  {
    id: RESOURCE_IDS.diagnostics,
    namespace: NS,
    title: 'Apollo Diagnostics',
    description: 'Apollo fallback and degradation diagnostics.',
    mimeType: 'application/json',
    kind: 'json',
    tags: ['diagnostics'],
  },
  {
    id: RESOURCE_IDS.cache,
    namespace: NS,
    title: 'Apollo Cache',
    description: 'Apollo cache.extract() output, when readable.',
    mimeType: 'application/json',
    kind: 'json',
    tags: ['cache'],
  },
];

const SKILLS: ContextSkillDescriptor[] = [
  {
    id: SKILL_IDS.cacheAudit,
    namespace: NS,
    title: 'Audit Apollo Cache Shape',
    description: 'Inspect cache shape and entity distribution.',
    intentTags: ['analysis', 'cache', 'apollo'],
    resourceIds: [RESOURCE_IDS.summary, RESOURCE_IDS.cache, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[1]!]),
    mode: 'analysis',
  },
  {
    id: SKILL_IDS.queryFlow,
    namespace: NS,
    title: 'Trace Active Apollo Queries',
    description: 'Analyze active query names, variables, and runtime state.',
    intentTags: ['analysis', 'query', 'apollo'],
    resourceIds: [RESOURCE_IDS.summary, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[0]!, TOOLS[2]!]),
    mode: 'analysis',
  },
  {
    id: SKILL_IDS.cacheGap,
    namespace: NS,
    title: 'Find Apollo Cache Gaps',
    description: 'Find gaps between queries and cache hits.',
    intentTags: ['analysis', 'cache', 'consistency'],
    resourceIds: [RESOURCE_IDS.cache, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, [TOOLS[0]!, TOOLS[1]!, TOOLS[2]!]),
    mode: 'analysis',
  },
];

export function createApolloUserscriptAdapter(
  win: Window,
  _doc: Document,
): UserscriptBridgeAdapter {
  const state: ApolloAdapterState = { lastSnapshot: null };

  const primaryInstance: PageToolInstance = {
    instanceId: INSTANCE,
    listTools: () => TOOLS,
    callTool: (name, input) => callApolloTool(name, input ?? {}, win, state),
  };

  return {
    adapterId: 'apollo-client',
    namespace: NAMESPACE,
    listInstances: () => [primaryInstance],
    listResources: () => RESOURCES,
    readResource: (id) => readApolloResource(id, win, state),
    listSkills: () => SKILLS,
    getSkill: (id, input) => getApolloSkillPrompt(id, input ?? {}, win, state),
    getSceneHint: () => 'apollo',
  };
}

function callApolloTool(
  name: string,
  input: ToolInput,
  win: Window,
  state: ApolloAdapterState,
): unknown {
  const snapshot = collectApolloSnapshot(win);
  state.lastSnapshot = snapshot;

  if (name === 'listActiveQueries') {
    return {
      detected: snapshot.detected,
      queryCount: snapshot.activeQueries.length,
      queries: snapshot.activeQueries,
    };
  }

  if (name === 'inspectCache') {
    const cache = snapshot.cacheExtract ?? {};
    return {
      detected: snapshot.detected,
      rootKeys: Object.keys(cache),
      entityCount: Object.keys(cache).length,
      cache,
    };
  }

  if (name === 'inspectQuery') {
    const queryId =
      typeof input.queryId === 'string' && input.queryId
        ? input.queryId
        : snapshot.activeQueries[0]?.queryId;
    if (!queryId) {
      return { ok: false, reason: 'No query is available and no queryId was provided.' };
    }
    const query = snapshot.activeQueries.find((item) => item.queryId === queryId) ?? null;
    if (!query) {
      return { ok: false, reason: `Could not find queryId=${queryId}` };
    }
    return { ok: true, query };
  }

  throw new Error(`Unknown Apollo tool: ${name}`);
}

function readApolloResource(id: string, win: Window, state: ApolloAdapterState) {
  const snapshot = state.lastSnapshot ?? collectApolloSnapshot(win);
  state.lastSnapshot = snapshot;

  if (id === RESOURCE_IDS.summary) {
    return toJsonResource(id, {
      detected: snapshot.detected,
      activeQueryCount: snapshot.activeQueries.length,
      cacheEntityCount: Object.keys(snapshot.cacheExtract ?? {}).length,
    });
  }
  if (id === RESOURCE_IDS.diagnostics) {
    return toJsonResource(id, { diagnostics: snapshot.diagnostics });
  }
  if (id === RESOURCE_IDS.cache) {
    return toJsonResource(id, { cache: snapshot.cacheExtract });
  }
  return toJsonResource(id, { error: `Unknown resource id: ${id}` });
}

function getApolloSkillPrompt(
  id: string,
  input: ToolInput,
  win: Window,
  state: ApolloAdapterState,
) {
  const skill = SKILLS.find((item) => item.id === id);
  if (!skill) {
    return undefined;
  }
  const snapshot = state.lastSnapshot ?? collectApolloSnapshot(win);
  state.lastSnapshot = snapshot;
  const normalized = normalizeSkillInput(input);
  return buildSkillPrompt(skill, {
    goal: normalized.goal,
    focus: normalized.focus,
    facts: [
      `apolloDetected=${snapshot.detected}`,
      `activeQueries=${snapshot.activeQueries.length}`,
      `cacheEntities=${Object.keys(snapshot.cacheExtract ?? {}).length}`,
    ],
  });
}

function collectApolloSnapshot(win: Window): ApolloSnapshot {
  const diagnostics: string[] = [];
  const client = (win as Window & { __APOLLO_CLIENT__?: unknown }).__APOLLO_CLIENT__;
  if (!client || !isObjectRecord(client)) {
    diagnostics.push('Did not detect window.__APOLLO_CLIENT__.');
    return { detected: false, cacheExtract: null, activeQueries: [], diagnostics };
  }

  const cacheExtract = readCacheExtract(client, diagnostics);
  const activeQueries = readActiveQueries(client, diagnostics);
  if (activeQueries.length === 0) {
    diagnostics.push('Apollo queryManager did not provide readable active queries.');
  }
  return {
    detected: true,
    cacheExtract,
    activeQueries,
    diagnostics,
  };
}

function readCacheExtract(
  client: Record<string, unknown>,
  diagnostics: string[],
): Record<string, unknown> | null {
  const cache = client.cache;
  if (!isObjectRecord(cache) || typeof cache.extract !== 'function') {
    diagnostics.push('Apollo cache.extract() is not available.');
    return null;
  }
  try {
    const extracted = cache.extract();
    return isObjectRecord(extracted) ? extracted : {};
  } catch (error) {
    diagnostics.push(`cache.extract() failed: ${toErrorMessage(error)}`);
    return null;
  }
}

function readActiveQueries(
  client: Record<string, unknown>,
  diagnostics: string[],
): ApolloQuerySummary[] {
  const manager = client.queryManager;
  if (!isObjectRecord(manager)) {
    diagnostics.push('Apollo queryManager is missing.');
    return [];
  }
  const queries = manager.queries;
  if (!queries) {
    diagnostics.push('Apollo queryManager.queries is missing.');
    return [];
  }

  const entries: Array<[string, unknown]> = [];
  if (queries instanceof Map) {
    for (const [key, value] of queries.entries()) {
      entries.push([String(key), value]);
    }
  } else if (isObjectRecord(queries)) {
    for (const [key, value] of Object.entries(queries)) {
      entries.push([key, value]);
    }
  } else {
    diagnostics.push('Apollo queryManager.queries is neither a Map nor an object.');
    return [];
  }

  return entries.map(([queryId, value]) => summarizeQuery(queryId, value));
}

function summarizeQuery(queryId: string, value: unknown): ApolloQuerySummary {
  if (!isObjectRecord(value)) {
    return {
      queryId,
      operationName: 'unknown',
      networkStatus: 'unknown',
      variablesPreview: previewValue(value),
    };
  }

  const observableQuery = isObjectRecord(value.observableQuery) ? value.observableQuery : value;
  const options = isObjectRecord(observableQuery.options) ? observableQuery.options : {};
  const queryName = readOperationName(options.query);
  const networkStatus = readNetworkStatus(observableQuery);
  const variablesPreview = previewValue(options.variables);

  return {
    queryId,
    operationName: queryName,
    networkStatus,
    variablesPreview,
  };
}

function readOperationName(queryNode: unknown): string {
  if (!isObjectRecord(queryNode) || !Array.isArray(queryNode.definitions)) {
    return 'unknown';
  }
  for (const definition of queryNode.definitions) {
    if (!isObjectRecord(definition)) {
      continue;
    }
    if (
      isObjectRecord(definition.name) &&
      typeof definition.name.value === 'string' &&
      definition.name.value
    ) {
      return definition.name.value;
    }
  }
  return 'anonymous-operation';
}

function readNetworkStatus(queryLike: Record<string, unknown>): string {
  const queryInfo = isObjectRecord(queryLike.queryInfo) ? queryLike.queryInfo : null;
  const statusValue = queryInfo?.networkStatus;
  if (typeof statusValue === 'number' || typeof statusValue === 'string') {
    return String(statusValue);
  }
  return 'unknown';
}
