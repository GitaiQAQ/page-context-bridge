import type {
  ContextNamespaceDescriptor,
  ContextResourceDescriptor,
  ContextSkillDescriptor,
  ToolSpec,
} from '@page-context/shared-protocol';

import type { PageToolInstance, ToolInput, UserscriptBridgeAdapter } from '../types';
import {
  buildSkillPrompt,
  isObjectRecord,
  listToolNames,
  normalizeSkillInput,
  previewValue,
  READONLY_ANNOTATION,
  toErrorMessage,
  toJsonResource,
} from '../utils';

interface NextSnapshot {
  detected: boolean;
  keys: string[];
  page: string | null;
  buildId: string | null;
  runtime: string | null;
  hasProps: boolean;
  payloadPreview: string;
  diagnostics: string[];
}

interface NextAdapterState {
  lastSnapshot: NextSnapshot | null;
}

const NS = 'next';
const INSTANCE = 'primary';

const RESOURCE_IDS = {
  summary: 'next.summary',
  nextData: 'next.nextData',
  diagnostics: 'next.diagnostics',
} as const;

const SKILL_IDS = {
  analyze: 'next.analyze-next-data',
} as const;

const NAMESPACE: ContextNamespaceDescriptor = {
  namespace: NS,
  title: 'Next.js',
  description: 'Read-only Next.js runtime inspection based on window.__NEXT_DATA__.',
  tags: ['nextjs', 'readonly', 'ssr', 'app'],
};

const TOOLS: ToolSpec[] = [
  {
    name: 'getSummary',
    description: 'Get detection summary for Next.js globals on the current page.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: 'readNextData',
    description:
      'Read window.__NEXT_DATA__. Optionally provide a simple path (dot + [index]) to select a sub-value.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            "Optional path, e.g. 'props.pageProps', 'query', 'props.pageProps.user[0].name'. If omitted, returns the whole payload (may be large).",
        },
        maxPreviewLength: {
          type: 'number',
          description: 'Max preview length for the returned selection (default: 2000).',
        },
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
    title: 'Next Summary',
    description: 'Next.js detection summary for window.__NEXT_DATA__.',
    mimeType: 'application/json',
    kind: 'json',
    tags: ['summary'],
  },
  {
    id: RESOURCE_IDS.nextData,
    namespace: NS,
    title: '__NEXT_DATA__',
    description: 'Raw window.__NEXT_DATA__ payload (may be large).',
    mimeType: 'application/json',
    kind: 'json',
    tags: ['payload'],
  },
  {
    id: RESOURCE_IDS.diagnostics,
    namespace: NS,
    title: 'Next Diagnostics',
    description: 'Diagnostics for Next.js detection and payload extraction.',
    mimeType: 'application/json',
    kind: 'json',
    tags: ['diagnostics'],
  },
];

const SKILLS: ContextSkillDescriptor[] = [
  {
    id: SKILL_IDS.analyze,
    namespace: NS,
    title: 'Analyze Next Data',
    description: 'Analyze Next.js runtime payload and highlight useful inspection pivots.',
    intentTags: ['analysis', 'nextjs', 'routing', 'ssr'],
    resourceIds: [RESOURCE_IDS.summary, RESOURCE_IDS.nextData, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, TOOLS),
    mode: 'analysis',
  },
];

export function createNextjsUserscriptAdapter(
  win: Window,
  _doc: Document,
): UserscriptBridgeAdapter {
  const state: NextAdapterState = { lastSnapshot: null };

  const primaryInstance: PageToolInstance = {
    instanceId: INSTANCE,
    listTools: () => TOOLS,
    callTool: (name, input) => callNextTool(win, name, input ?? {}, state),
  };

  return {
    adapterId: 'nextjs',
    namespace: NAMESPACE,
    listInstances: () => [primaryInstance],
    listResources: () => RESOURCES,
    readResource: (id) => readNextResource(win, id, state),
    listSkills: () => SKILLS,
    getSkill: (id, input) => getNextSkillPrompt(win, id, input ?? {}, state),
    getSceneHint: () => 'next',
  };
}

function callNextTool(
  win: Window,
  name: string,
  input: ToolInput,
  state: NextAdapterState,
): unknown {
  const snapshot = collectNextSnapshot(win);
  state.lastSnapshot = snapshot;

  if (name === 'getSummary') {
    return snapshot;
  }

  if (name === 'readNextData') {
    const nextData = readNextData(win);
    if (!nextData) {
      return { ok: false, detected: false, reason: 'window.__NEXT_DATA__ is not available.' };
    }
    const path = typeof input.path === 'string' ? input.path.trim() : '';
    const selected = path ? selectByPath(nextData, path) : nextData;
    const maxPreviewLength =
      typeof input.maxPreviewLength === 'number' && input.maxPreviewLength > 0
        ? input.maxPreviewLength
        : 2000;
    const preview = safeStringifyTruncated(selected, maxPreviewLength);
    return {
      ok: true,
      detected: true,
      path: path || null,
      preview,
      valueType: typeof selected,
      valuePreview: previewValue(selected),
    };
  }

  throw new Error(`Unknown Next.js tool: ${name}`);
}

function readNextResource(win: Window, id: string, state: NextAdapterState) {
  const snapshot = state.lastSnapshot ?? collectNextSnapshot(win);
  state.lastSnapshot = snapshot;

  if (id === RESOURCE_IDS.summary) {
    return toJsonResource(id, snapshot);
  }
  if (id === RESOURCE_IDS.diagnostics) {
    return toJsonResource(id, { diagnostics: snapshot.diagnostics });
  }
  if (id === RESOURCE_IDS.nextData) {
    const nextData = readNextData(win);
    return toJsonResource(id, nextData ?? { error: 'window.__NEXT_DATA__ is not available.' });
  }
  return toJsonResource(id, { error: `Unknown resource id: ${id}` });
}

function getNextSkillPrompt(win: Window, id: string, input: ToolInput, state: NextAdapterState) {
  const skill = SKILLS.find((item) => item.id === id);
  if (!skill) {
    return undefined;
  }
  const snapshot = state.lastSnapshot ?? collectNextSnapshot(win);
  state.lastSnapshot = snapshot;
  const normalized = normalizeSkillInput(input);
  return buildSkillPrompt(skill, {
    goal: normalized.goal,
    focus: normalized.focus,
    facts: [
      `nextDetected=${snapshot.detected}`,
      `page=${snapshot.page ?? '(unknown)'}`,
      `buildId=${snapshot.buildId ?? '(unknown)'}`,
      `runtime=${snapshot.runtime ?? '(unknown)'}`,
      `hasProps=${snapshot.hasProps}`,
    ],
  });
}

function collectNextSnapshot(win: Window): NextSnapshot {
  const diagnostics: string[] = [];
  const nextData = readNextData(win);
  if (!nextData) {
    return {
      detected: false,
      keys: [],
      page: null,
      buildId: null,
      runtime: null,
      hasProps: false,
      payloadPreview: '(missing)',
      diagnostics: ['window.__NEXT_DATA__ not found'],
    };
  }

  const keys = isObjectRecord(nextData) ? Object.keys(nextData) : [];
  const page = isObjectRecord(nextData) && typeof nextData.page === 'string' ? nextData.page : null;
  const buildId =
    isObjectRecord(nextData) && typeof nextData.buildId === 'string' ? nextData.buildId : null;
  const runtime =
    isObjectRecord(nextData) && typeof nextData.runtimeConfig === 'object' ? 'runtimeConfig' : null;
  const hasProps = isObjectRecord(nextData) && 'props' in nextData;

  return {
    detected: true,
    keys,
    page,
    buildId,
    runtime,
    hasProps,
    payloadPreview: previewValue(nextData),
    diagnostics,
  };
}

function readNextData(win: Window): unknown | null {
  try {
    const value = (win as unknown as Record<string, unknown>).__NEXT_DATA__;
    return value ?? null;
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

function safeStringifyTruncated(value: unknown, maxLen: number): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = JSON.stringify({ error: 'Unable to stringify payload' }, null, 2);
  }
  return text.length > maxLen ? `${text.slice(0, Math.max(0, maxLen - 3))}...` : text;
}

// A small, permissive path selector:
// - dot segments: a.b.c
// - array indices: a[0].b
function selectByPath(root: unknown, path: string): unknown {
  const tokens = tokenizePath(path);
  let cursor: unknown = root;
  for (const token of tokens) {
    if (cursor == null) {
      return null;
    }
    if (typeof token === 'number') {
      if (!Array.isArray(cursor)) {
        return null;
      }
      cursor = cursor[token];
      continue;
    }
    if (!isObjectRecord(cursor)) {
      return null;
    }
    cursor = cursor[token];
  }
  return cursor;
}

function tokenizePath(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  const parts = path
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    // e.g. "props[0][1]" or "pageProps"
    const regex = /([^[\]]+)|(\[(\d+)\])/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(part))) {
      if (match[1]) {
        tokens.push(match[1]);
      } else if (match[3]) {
        tokens.push(Number(match[3]));
      }
    }
  }
  return tokens;
}
