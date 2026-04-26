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

interface NuxtSnapshot {
  detected: boolean;
  nuxtFlavor: 'nuxt2' | 'nuxt3' | 'unknown' | null;
  keys: string[];
  payloadPreview: string;
  diagnostics: string[];
}

interface NuxtAdapterState {
  lastSnapshot: NuxtSnapshot | null;
}

const NS = 'nuxt';
const INSTANCE = 'primary';

const RESOURCE_IDS = {
  summary: 'nuxt.summary',
  nuxtPayload: 'nuxt.payload',
  diagnostics: 'nuxt.diagnostics',
} as const;

const SKILL_IDS = {
  analyze: 'nuxt.analyze-payload',
} as const;

const NAMESPACE: ContextNamespaceDescriptor = {
  namespace: NS,
  title: 'Nuxt',
  description: 'Read-only Nuxt runtime inspection based on window.__NUXT__ (Nuxt 2/3).',
  tags: ['nuxt', 'vue', 'readonly'],
};

const TOOLS: ToolSpec[] = [
  {
    name: 'getSummary',
    description: 'Get detection summary for Nuxt globals on the current page.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READONLY_ANNOTATION,
  },
  {
    name: 'readNuxtPayload',
    description:
      'Read window.__NUXT__. Optionally provide a simple path (dot + [index]) to select a sub-value.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            "Optional path, e.g. 'state', 'data', 'state.auth.user', 'data[0]'. If omitted, returns the whole payload (may be large).",
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
    title: 'Nuxt Summary',
    description: 'Nuxt detection summary for window.__NUXT__.',
    mimeType: 'application/json',
    kind: 'json',
    tags: ['summary'],
  },
  {
    id: RESOURCE_IDS.nuxtPayload,
    namespace: NS,
    title: '__NUXT__',
    description: 'Raw window.__NUXT__ payload (may be large).',
    mimeType: 'application/json',
    kind: 'json',
    tags: ['payload'],
  },
  {
    id: RESOURCE_IDS.diagnostics,
    namespace: NS,
    title: 'Nuxt Diagnostics',
    description: 'Diagnostics for Nuxt detection and payload extraction.',
    mimeType: 'application/json',
    kind: 'json',
    tags: ['diagnostics'],
  },
];

const SKILLS: ContextSkillDescriptor[] = [
  {
    id: SKILL_IDS.analyze,
    namespace: NS,
    title: 'Analyze Nuxt Payload',
    description: 'Analyze Nuxt runtime payload and highlight useful inspection pivots.',
    intentTags: ['analysis', 'nuxt', 'vue', 'routing'],
    resourceIds: [RESOURCE_IDS.summary, RESOURCE_IDS.nuxtPayload, RESOURCE_IDS.diagnostics],
    toolNames: listToolNames(NS, INSTANCE, TOOLS),
    mode: 'analysis',
  },
];

export function createNuxtUserscriptAdapter(win: Window, _doc: Document): UserscriptBridgeAdapter {
  const state: NuxtAdapterState = { lastSnapshot: null };

  const primaryInstance: PageToolInstance = {
    instanceId: INSTANCE,
    listTools: () => TOOLS,
    callTool: (name, input) => callNuxtTool(win, name, input ?? {}, state),
  };

  return {
    adapterId: 'nuxt',
    namespace: NAMESPACE,
    listInstances: () => [primaryInstance],
    listResources: () => RESOURCES,
    readResource: (id) => readNuxtResource(win, id, state),
    listSkills: () => SKILLS,
    getSkill: (id, input) => getNuxtSkillPrompt(win, id, input ?? {}, state),
    getSceneHint: () => 'nuxt',
  };
}

function callNuxtTool(
  win: Window,
  name: string,
  input: ToolInput,
  state: NuxtAdapterState,
): unknown {
  const snapshot = collectNuxtSnapshot(win);
  state.lastSnapshot = snapshot;

  if (name === 'getSummary') {
    return snapshot;
  }

  if (name === 'readNuxtPayload') {
    const payload = readNuxtPayload(win);
    if (!payload) {
      return { ok: false, detected: false, reason: 'window.__NUXT__ is not available.' };
    }
    const path = typeof input.path === 'string' ? input.path.trim() : '';
    const selected = path ? selectByPath(payload, path) : payload;
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

  throw new Error(`Unknown Nuxt tool: ${name}`);
}

function readNuxtResource(win: Window, id: string, state: NuxtAdapterState) {
  const snapshot = state.lastSnapshot ?? collectNuxtSnapshot(win);
  state.lastSnapshot = snapshot;

  if (id === RESOURCE_IDS.summary) {
    return toJsonResource(id, snapshot);
  }
  if (id === RESOURCE_IDS.diagnostics) {
    return toJsonResource(id, { diagnostics: snapshot.diagnostics });
  }
  if (id === RESOURCE_IDS.nuxtPayload) {
    const payload = readNuxtPayload(win);
    return toJsonResource(id, payload ?? { error: 'window.__NUXT__ is not available.' });
  }
  return toJsonResource(id, { error: `Unknown resource id: ${id}` });
}

function getNuxtSkillPrompt(win: Window, id: string, input: ToolInput, state: NuxtAdapterState) {
  const skill = SKILLS.find((item) => item.id === id);
  if (!skill) {
    return undefined;
  }
  const snapshot = state.lastSnapshot ?? collectNuxtSnapshot(win);
  state.lastSnapshot = snapshot;
  const normalized = normalizeSkillInput(input);
  return buildSkillPrompt(skill, {
    goal: normalized.goal,
    focus: normalized.focus,
    facts: [
      `nuxtDetected=${snapshot.detected}`,
      `nuxtFlavor=${snapshot.nuxtFlavor ?? '(unknown)'}`,
      `keys=${snapshot.keys.slice(0, 8).join(',')}${snapshot.keys.length > 8 ? ',...' : ''}`,
    ],
  });
}

function collectNuxtSnapshot(win: Window): NuxtSnapshot {
  const diagnostics: string[] = [];
  const payload = readNuxtPayload(win);
  if (!payload) {
    return {
      detected: false,
      nuxtFlavor: null,
      keys: [],
      payloadPreview: '(missing)',
      diagnostics: ['window.__NUXT__ not found'],
    };
  }

  const keys = isObjectRecord(payload)
    ? Object.keys(payload)
    : Array.isArray(payload)
      ? ['(array)']
      : [];
  const nuxtFlavor = inferNuxtFlavor(payload, diagnostics);
  return {
    detected: true,
    nuxtFlavor,
    keys,
    payloadPreview: previewValue(payload),
    diagnostics,
  };
}

function inferNuxtFlavor(payload: unknown, diagnostics: string[]): NuxtSnapshot['nuxtFlavor'] {
  // Heuristic only.
  if (Array.isArray(payload)) {
    diagnostics.push('__NUXT__ is an array payload (seen in some Nuxt3 builds)');
    return 'nuxt3';
  }
  if (isObjectRecord(payload)) {
    if ('state' in payload && ('data' in payload || 'serverRendered' in payload)) {
      return 'nuxt2';
    }
    if ('data' in payload || 'state' in payload || 'config' in payload) {
      return 'nuxt3';
    }
    return 'unknown';
  }
  return 'unknown';
}

function readNuxtPayload(win: Window): unknown | null {
  try {
    const value = (win as unknown as Record<string, unknown>).__NUXT__;
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
