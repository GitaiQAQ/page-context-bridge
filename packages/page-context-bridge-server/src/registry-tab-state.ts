/**
 * Tab-scoped registry state container.
 * Manages page tools registration/unregistration on MCP servers,
 * context manifest synchronization (resources + skills as MCP resources/prompts),
 * and derives feedback links from tab state.
 *
 * Domain logic is split into:
 * - registry-page-tools.ts — Page Tools CRUD
 * - registry-context-manifest.ts — Context Manifest registration
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FeedbackCapabilityLinks, PageContextManifest } from '@page-context/shared-protocol';

import type { ExtensionRpcCaller, PageToolSpec } from './registry-types.js';
import { normalizePageToolName, uniqueStrings } from './registry-utils.js';

// Domain functions — split into focused modules
import {
  deletePageTools,
  registerPageToolsOnAllServers,
  registerPageToolsOnServer,
  setPageTools,
  unregisterPageToolsFromAllServers,
  unregisterPageToolsFromServer,
} from './registry-page-tools.js';

export {
  deletePageTools,
  registerPageToolsOnAllServers,
  registerPageToolsOnServer,
  setPageTools,
  unregisterPageToolsFromAllServers,
  unregisterPageToolsFromServer,
} from './registry-page-tools.js';

import {
  registerContextManifestOnServer,
  syncContextManifestOnAllServers,
  unregisterContextManifestFromServer,
} from './registry-context-manifest.js';

export {
  registerContextManifestOnServer,
  syncContextManifestOnAllServers,
  unregisterContextManifestFromServer,
} from './registry-context-manifest.js';

/**
 * Tab-scoped registry state container.
 * Manages only page tools / context manifest "cache + handles";
 * does not mix in builtin/feedback control tools.
 */
export interface RegistryTabState {
  pageToolHandlesByServer: import('./registry-types.js').ServerHandleStore<
    import('./registry-types.js').RegisteredPageTool
  >;
  contextResourceHandlesByServer: import('./registry-types.js').ServerHandleStore<
    import('./registry-types.js').RegisteredContextResource
  >;
  contextPromptHandlesByServer: import('./registry-types.js').ServerHandleStore<
    import('./registry-types.js').RegisteredContextPrompt
  >;
  pageToolsByTab: Map<number, PageToolSpec[]>;
  pageContextManifestByTab: Map<number, PageContextManifest>;
}

export interface RefreshPageToolsForTabInput {
  state: RegistryTabState;
  mcpServers: Iterable<McpServer>;
  tabId: number;
  rpcCaller: Pick<
    ExtensionRpcCaller,
    | 'refreshPageTools'
    | 'getContextManifest'
    | 'sendToolCall'
    | 'readContextResource'
    | 'getContextSkillPrompt'
  >;
  logger?: (...args: unknown[]) => void;
}

export interface FeedbackLinksDerivedFromTabState {
  links: FeedbackCapabilityLinks;
  manifest: PageContextManifest | null;
}

export function createRegistryTabState(): RegistryTabState {
  return {
    pageToolHandlesByServer: new WeakMap(),
    contextResourceHandlesByServer: new WeakMap(),
    contextPromptHandlesByServer: new WeakMap(),
    pageToolsByTab: new Map(),
    pageContextManifestByTab: new Map(),
  };
}

export async function refreshPageToolsForTab(
  input: RefreshPageToolsForTabInput,
): Promise<{ tools: PageToolSpec[]; manifest: PageContextManifest | null }> {
  const { state, mcpServers, tabId, rpcCaller, logger = console.log } = input;

  // Refresh extension-side tools first, then overwrite local cache so MCP sees results from the same discovery round.
  const tools = await rpcCaller.refreshPageTools(tabId);
  unregisterPageToolsFromAllServers({ state, mcpServers, tabId });
  setPageTools({ state, tabId, tools });
  registerPageToolsOnAllServers({ state, mcpServers, rpcCaller, tabId, tools });

  // Manifest sync failure should not roll back tool refresh; degrade to null per historical behavior and continue.
  const manifest = await rpcCaller.getContextManifest(tabId).catch((error) => {
    logger(
      `Refresh manifest failed for tab ${tabId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  });
  syncContextManifestOnAllServers({ state, mcpServers, rpcCaller, tabId, manifest });

  return { tools, manifest };
}

export function deriveFeedbackLinksFromTabState(input: {
  state: RegistryTabState;
  tabId: number;
}): FeedbackLinksDerivedFromTabState {
  const { state, tabId } = input;
  const manifest = state.pageContextManifestByTab.get(tabId) ?? null;
  const pageTools = state.pageToolsByTab.get(tabId) ?? [];

  const namespaceHints = manifest?.namespaces.map((item) => item.namespace) ?? [];
  const relatedResourceIds = manifest?.resources.map((item) => item.id) ?? [];
  const relatedSkillIds = manifest?.skills.map((item) => item.id) ?? [];
  const relatedToolNames = pageTools.map((tool) => normalizePageToolName(tool));

  const linkReasons: string[] = [];
  if (manifest) {
    linkReasons.push('manifest.namespaces', 'manifest.resources', 'manifest.skills');
  }
  if (relatedToolNames.length > 0) {
    linkReasons.push('page-tools.registered');
  }

  return {
    links: {
      namespaceHints: uniqueStrings(namespaceHints),
      relatedToolNames: uniqueStrings(relatedToolNames),
      relatedResourceIds: uniqueStrings(relatedResourceIds),
      relatedSkillIds: uniqueStrings(relatedSkillIds),
      linkReasons: uniqueStrings(linkReasons),
    },
    manifest,
  };
}

export function syncTabStateToNewServer(input: {
  state: RegistryTabState;
  mcpServer: McpServer;
  rpcCaller: Pick<
    ExtensionRpcCaller,
    'sendToolCall' | 'readContextResource' | 'getContextSkillPrompt'
  >;
  logger?: (...args: unknown[]) => void;
}): void {
  const { state, mcpServer, rpcCaller, logger } = input;
  for (const [tabId, tools] of state.pageToolsByTab.entries()) {
    registerPageToolsOnServer({ state, mcpServer, rpcCaller, tabId, tools, logger });
  }
  for (const [tabId, manifest] of state.pageContextManifestByTab.entries()) {
    registerContextManifestOnServer({ state, mcpServer, rpcCaller, tabId, manifest });
  }
}
