/**
 * Context Manifest registration domain for registry tab state.
 * Handles resource and prompt (skill) registration on MCP servers.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PageContextManifest } from '@page-context/shared-protocol';
import { z } from 'zod';

import type {
  ExtensionRpcCaller,
  RegisteredContextPrompt,
  RegisteredContextResource,
  ServerHandleStore,
} from './registry-types.js';
import type { RegistryTabState } from './registry-tab-state.js';
import {
  buildContextPromptName,
  buildContextResourceName,
  buildContextResourceUri,
  createTextResponse,
  getOrCreateServerHandleMap,
} from './registry-utils.js';

export function registerContextManifestOnServer(input: {
  state: RegistryTabState;
  mcpServer: McpServer;
  rpcCaller: Pick<ExtensionRpcCaller, 'readContextResource' | 'getContextSkillPrompt'>;
  tabId: number;
  manifest: PageContextManifest;
}): void {
  const { state, mcpServer, rpcCaller, tabId, manifest } = input;
  const resourceHandles = getOrCreateServerHandleMap(
    state.contextResourceHandlesByServer,
    mcpServer,
  );
  const promptHandles = getOrCreateServerHandleMap(state.contextPromptHandlesByServer, mcpServer);

  for (const resource of manifest.resources) {
    const name = buildContextResourceName(tabId, resource);
    // Dedup: skip already-registered resources to avoid unpredictable overwrite ordering.
    if (resourceHandles.has(name)) {
      continue;
    }

    const registeredResource = mcpServer.registerResource(
      name,
      buildContextResourceUri(tabId, resource),
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType ?? 'application/json',
      },
      async (uri) => {
        const payload = await rpcCaller.readContextResource(tabId, resource.id);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: payload.mimeType ?? resource.mimeType ?? 'application/json',
              text: payload.text,
            },
          ],
        };
      },
    ) as { remove: () => void };
    resourceHandles.set(name, { registeredResource, tabId });
  }

  for (const skill of manifest.skills) {
    const name = buildContextPromptName(tabId, skill);
    if (promptHandles.has(name)) {
      continue;
    }

    const registeredPrompt = mcpServer.registerPrompt(
      name,
      {
        title: skill.title,
        description: skill.description,
        argsSchema: {
          goal: z.string().optional(),
        },
      },
      async ({ goal }) => {
        const prompt = await rpcCaller.getContextSkillPrompt(tabId, skill.id, { goal });
        const promptText = prompt?.text ?? `Skill '${skill.id}' is unavailable.`;
        return {
          description: skill.description,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: promptText,
              },
            },
          ],
        };
      },
    ) as { remove: () => void };
    promptHandles.set(name, { registeredPrompt, tabId });
  }
}

export function unregisterContextManifestFromServer(input: {
  state: RegistryTabState;
  mcpServer: McpServer;
  tabId: number;
}): void {
  const { state, mcpServer, tabId } = input;
  const resourceHandles = state.contextResourceHandlesByServer.get(mcpServer);
  if (resourceHandles) {
    for (const [name, entry] of resourceHandles.entries()) {
      if (entry.tabId !== tabId) {
        continue;
      }
      entry.registeredResource.remove();
      resourceHandles.delete(name);
    }
  }

  const promptHandles = state.contextPromptHandlesByServer.get(mcpServer);
  if (promptHandles) {
    for (const [name, entry] of promptHandles.entries()) {
      if (entry.tabId !== tabId) {
        continue;
      }
      entry.registeredPrompt.remove();
      promptHandles.delete(name);
    }
  }
}

export function syncContextManifestOnAllServers(input: {
  state: RegistryTabState;
  mcpServers: Iterable<McpServer>;
  rpcCaller: Pick<ExtensionRpcCaller, 'readContextResource' | 'getContextSkillPrompt'>;
  tabId: number;
  manifest: PageContextManifest | null;
}): void {
  const { state, mcpServers, rpcCaller, tabId, manifest } = input;

  if (manifest) {
    state.pageContextManifestByTab.set(tabId, manifest);
  } else {
    state.pageContextManifestByTab.delete(tabId);
  }

  for (const mcpServer of mcpServers) {
    // Order: must clear old handles before registering new manifest to prevent stale and new resources coexisting.
    unregisterContextManifestFromServer({ state, mcpServer, tabId });
    if (manifest) {
      registerContextManifestOnServer({ state, mcpServer, rpcCaller, tabId, manifest });
    }
  }
}
