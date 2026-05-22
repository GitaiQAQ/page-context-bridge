import type {
  ContextResourceDescriptor,
  ContextSkillDescriptor,
  FeedbackActor,
} from '@page-context/shared-protocol';
import { getBuiltinToolNameAliases } from '@page-context/builtin-tools';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type {
  FeedbackAgentPushAdapter,
  FeedbackAgentPushStatusReader,
} from './feedback-agent-push.js';
import type { PageToolSpec, ServerHandleStore } from './registry-types.js';

export function getOrCreateServerHandleMap<T>(
  store: ServerHandleStore<T>,
  server: McpServer,
): Map<string, T> {
  let handles = store.get(server);
  if (!handles) {
    handles = new Map<string, T>();
    store.set(server, handles);
  }
  return handles;
}

export function normalizePageToolName(tool: PageToolSpec): string {
  const namespace = tool._namespace;
  let toolName = tool.name;
  if (namespace && toolName.startsWith(`${namespace}.`)) {
    const trimmed = toolName.slice(namespace.length + 1);
    if (trimmed.startsWith(`${namespace}_`) || trimmed.startsWith(`${namespace}.`)) {
      toolName = trimmed;
    }
  }
  return toolName;
}

export function buildContextResourceName(
  tabId: number,
  resource: ContextResourceDescriptor,
): string {
  return `tab.${tabId}.resource.${resource.namespace}.${resource.id.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
}

export function buildContextResourceUri(
  tabId: number,
  resource: ContextResourceDescriptor,
): string {
  return `context://tab/${tabId}/resource/${resource.namespace}/${encodeURIComponent(resource.id)}`;
}

export function buildContextPromptName(tabId: number, skill: ContextSkillDescriptor): string {
  return `tab.${tabId}.skill.${skill.namespace}.${skill.id.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function createFeedbackActor(input: FeedbackActor): FeedbackActor {
  return {
    source: input.source,
    id: input.id,
    displayName: input.displayName,
  };
}

export function createTextResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function expandBuiltinToolNameAliases(toolNames: string[]): Set<string> {
  return new Set(toolNames.flatMap((toolName) => getBuiltinToolNameAliases(toolName)));
}

export function isFeedbackAgentPushStatusReader(
  adapter: FeedbackAgentPushAdapter | null,
): adapter is FeedbackAgentPushAdapter & FeedbackAgentPushStatusReader {
  return (
    !!adapter &&
    typeof (adapter as unknown as FeedbackAgentPushStatusReader).getPushAgentStatus === 'function'
  );
}

export function log(...args: unknown[]): void {
  process.stderr.write(`[PAGE-CONTEXT-BRIDGE] ${args.map(String).join(' ')}\n`);
}
