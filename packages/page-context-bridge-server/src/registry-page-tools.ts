/**
 * Page Tools registration domain for registry tab state.
 * Handles CRUD operations for page tools on MCP servers.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { buildRegisteredPageToolName } from './page-tool-routing.js';
import { buildZodSchema, type JsonSchemaLike } from './schema.js';
import type {
  ExtensionRpcCaller,
  PageToolSpec,
  RegisteredPageTool,
  ServerHandleStore,
} from './registry-types.js';
import type { RegistryTabState } from './registry-tab-state.js';
import {
  createTextResponse,
  getOrCreateServerHandleMap,
  log,
  normalizePageToolName,
} from './registry-utils.js';

export function registerPageToolsOnServer(input: {
  state: RegistryTabState;
  mcpServer: McpServer;
  rpcCaller: Pick<ExtensionRpcCaller, 'sendToolCall'>;
  tabId: number;
  tools: PageToolSpec[];
  logger?: (...args: unknown[]) => void;
}): void {
  const { state, mcpServer, rpcCaller, tabId, tools, logger = log } = input;
  const handles = getOrCreateServerHandleMap(state.pageToolHandlesByServer, mcpServer);

  for (const tool of tools) {
    const actualToolName = normalizePageToolName(tool);
    const registeredToolName = buildRegisteredPageToolName(tabId, actualToolName);

    // Dedup: register each tool name only once per server, preserving historical idempotent registration behavior.
    if (handles.has(registeredToolName)) {
      continue;
    }

    try {
      const registeredTool = mcpServer.registerTool(
        registeredToolName,
        {
          description: tool.description || `Page tool from tab ${tabId}`,
          inputSchema: buildZodSchema(tool.inputSchema as JsonSchemaLike | undefined),
          annotations: {
            readOnlyHint:
              actualToolName.includes('get_') ||
              actualToolName.includes('list_') ||
              actualToolName.includes('inspect_') ||
              actualToolName.includes('search_') ||
              actualToolName.includes('trace'),
          },
        },
        async (args) => {
          try {
            const result = await rpcCaller.sendToolCall(
              actualToolName,
              (args ?? {}) as Record<string, unknown>,
              tabId,
            );
            return createTextResponse(JSON.stringify(result, null, 2));
          } catch (error) {
            return createTextResponse(
              `Error: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      ) as { remove: () => void };

      handles.set(registeredToolName, { registeredTool, tabId });
    } catch (error) {
      logger(
        'Failed to register page tool',
        registeredToolName,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export function unregisterPageToolsFromServer(input: {
  state: RegistryTabState;
  mcpServer: McpServer;
  tabId: number;
}): void {
  const { state, mcpServer, tabId } = input;
  const handles = state.pageToolHandlesByServer.get(mcpServer);
  if (!handles) {
    return;
  }

  for (const [toolName, entry] of handles.entries()) {
    if (entry.tabId !== tabId) {
      continue;
    }
    // Deletion order: remove MCP resource first, then delete local handle to ensure proper release ordering.
    entry.registeredTool.remove();
    handles.delete(toolName);
  }
}

export function registerPageToolsOnAllServers(input: {
  state: RegistryTabState;
  mcpServers: Iterable<McpServer>;
  rpcCaller: Pick<ExtensionRpcCaller, 'sendToolCall'>;
  tabId: number;
  tools: PageToolSpec[];
  logger?: (...args: unknown[]) => void;
}): void {
  const { state, mcpServers, rpcCaller, tabId, tools, logger } = input;
  for (const mcpServer of mcpServers) {
    registerPageToolsOnServer({ state, mcpServer, rpcCaller, tabId, tools, logger });
  }
}

export function unregisterPageToolsFromAllServers(input: {
  state: RegistryTabState;
  mcpServers: Iterable<McpServer>;
  tabId: number;
}): void {
  const { state, mcpServers, tabId } = input;
  for (const mcpServer of mcpServers) {
    unregisterPageToolsFromServer({ state, mcpServer, tabId });
  }
}

export function setPageTools(input: {
  state: RegistryTabState;
  tabId: number;
  tools: PageToolSpec[];
}): void {
  const { state, tabId, tools } = input;
  state.pageToolsByTab.set(tabId, tools);
}

export function deletePageTools(input: { state: RegistryTabState; tabId: number }): void {
  const { state, tabId } = input;
  state.pageToolsByTab.delete(tabId);
}
