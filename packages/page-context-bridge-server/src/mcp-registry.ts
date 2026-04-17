/**
 * MCP tool/resource/prompt registry management.
 * Handles registering and unregistering tools, resources, and prompts on McpServer instances.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type ContextResourceDescriptor,
  type ContextResourcePayload,
  type ContextSkillDescriptor,
  type ContextSkillPrompt,
  type PageContextManifest,
  type BridgeToolProvider,
  type ToolSpec,
} from "@page-context/shared-protocol";
import { BuiltinBridgeProvider } from "@page-context/builtin-tools";
import { z } from "zod";

import { buildRegisteredPageToolName } from "./page-tool-routing.js";
import { buildZodSchema, type JsonSchemaLike } from "./schema.js";

export interface PageToolSpec {
  name: string;
  description?: string;
  inputSchema?: JsonSchemaLike;
  _pageTool?: boolean;
  _namespace?: string;
  _instanceId?: string;
}

interface RegisteredPageTool {
  registeredTool: { remove: () => void };
  tabId: number;
}

interface RegisteredContextResource {
  registeredResource: { remove: () => void };
  tabId: number;
}

interface RegisteredContextPrompt {
  registeredPrompt: { remove: () => void };
  tabId: number;
}

export interface ExtensionRpcCaller {
  sendToolCall<TResult = unknown>(tool: string, args: Record<string, unknown>, tabId?: number): Promise<TResult>;
  getContextManifest(tabId: number): Promise<PageContextManifest | null>;
  readContextResource(tabId: number, resourceId: string): Promise<ContextResourcePayload>;
  getContextSkillPrompt(tabId: number, skillId: string, input?: Record<string, unknown>): Promise<ContextSkillPrompt | null>;
}

export class McpRegistry {
  private readonly mcpServers = new Set<McpServer>();
  private readonly pageToolHandlesByServer = new WeakMap<McpServer, Map<string, RegisteredPageTool>>();
  private readonly builtinToolHandlesByServer = new WeakMap<McpServer, Map<string, { remove: () => void }>>();
  private readonly contextResourceHandlesByServer = new WeakMap<McpServer, Map<string, RegisteredContextResource>>();
  private readonly contextPromptHandlesByServer = new WeakMap<McpServer, Map<string, RegisteredContextPrompt>>();
  private readonly pageToolsByTab = new Map<number, PageToolSpec[]>();
  private readonly pageContextManifestByTab = new Map<number, PageContextManifest>();

  private enabledBuiltinToolNames: Set<string>;
  private readonly toolProviders: BridgeToolProvider[] = [new BuiltinBridgeProvider()];

  constructor(private readonly rpcCaller: ExtensionRpcCaller) {
    this.enabledBuiltinToolNames = new Set(this.toolProviders.flatMap((p) => p.getToolSpecs().map((t) => t.name)));
  }

  addServer(server: McpServer): void {
    this.mcpServers.add(server);
  }

  removeServer(server: McpServer): void {
    this.mcpServers.delete(server);
    this.pageToolHandlesByServer.delete(server);
  }

  getServerCount(): number {
    return this.mcpServers.size;
  }

  getPageToolsByTab(): Map<number, PageToolSpec[]> {
    return this.pageToolsByTab;
  }

  // ── Builtin tools ──

  syncBuiltinToolsOnServer(mcpServer: McpServer): void {
    let handles = this.builtinToolHandlesByServer.get(mcpServer);
    if (!handles) {
      handles = new Map();
      this.builtinToolHandlesByServer.set(mcpServer, handles);
    }

    for (const [toolName, handle] of handles.entries()) {
      if (!this.enabledBuiltinToolNames.has(toolName)) {
        handle.remove();
        handles.delete(toolName);
      }
    }

    for (const provider of this.toolProviders) {
      const providerHandles = provider.registerOnBridge(
        (name, schema, handler) => mcpServer.registerTool(name, schema as Parameters<typeof mcpServer.registerTool>[1], handler as Parameters<typeof mcpServer.registerTool>[2]),
        (tool, args, tabId) => this.rpcCaller.sendToolCall(tool, args, tabId),
      );

      for (const [toolName, handle] of providerHandles.entries()) {
        if (!this.enabledBuiltinToolNames.has(toolName)) {
          handle.remove();
          continue;
        }
        if (handles!.has(toolName)) {
          handle.remove();
          continue;
        }
        handles!.set(toolName, handle);
      }
    }
  }

  syncBuiltinToolsOnAllServers(toolSpecs: ToolSpec[]): void {
    this.enabledBuiltinToolNames = new Set(toolSpecs.map((tool) => tool.name));
    for (const server of this.mcpServers) {
      this.syncBuiltinToolsOnServer(server);
    }
  }

  // ── Page tools ──

  registerPageToolsOnServer(mcpServer: McpServer, tabId: number, tools: PageToolSpec[]): void {
    let handles = this.pageToolHandlesByServer.get(mcpServer);
    if (!handles) {
      handles = new Map();
      this.pageToolHandlesByServer.set(mcpServer, handles);
    }

    for (const tool of tools) {
      const actualToolName = normalizePageToolName(tool);
      const registeredToolName = buildRegisteredPageToolName(tabId, actualToolName);
      if (handles.has(registeredToolName)) {
        continue;
      }

      try {
        const registeredTool = mcpServer.registerTool(
          registeredToolName,
          {
            description: tool.description || `Page tool from tab ${tabId}`,
            inputSchema: buildZodSchema(tool.inputSchema),
            annotations: {
              readOnlyHint: actualToolName.includes("get_") || actualToolName.includes("list_") || actualToolName.includes("inspect_") || actualToolName.includes("search_") || actualToolName.includes("trace"),
            },
          },
          async (args) => {
            try {
              const result = await this.rpcCaller.sendToolCall(actualToolName, (args ?? {}) as Record<string, unknown>, tabId);
              return createTextResponse(JSON.stringify(result, null, 2));
            } catch (error) {
              return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
            }
          },
        );

        handles.set(registeredToolName, { registeredTool, tabId });
      } catch (error) {
        log("Failed to register page tool", registeredToolName, error instanceof Error ? error.message : String(error));
      }
    }
  }

  unregisterPageToolsFromServer(mcpServer: McpServer, tabId: number): void {
    const handles = this.pageToolHandlesByServer.get(mcpServer);
    if (!handles) {
      return;
    }

    for (const [toolName, entry] of handles.entries()) {
      if (entry.tabId !== tabId) {
        continue;
      }
      entry.registeredTool.remove();
      handles.delete(toolName);
    }
  }

  registerPageToolsOnAllServers(tabId: number, tools: PageToolSpec[]): void {
    for (const mcpServer of this.mcpServers) {
      this.registerPageToolsOnServer(mcpServer, tabId, tools);
    }
  }

  unregisterPageToolsFromAllServers(tabId: number): void {
    for (const mcpServer of this.mcpServers) {
      this.unregisterPageToolsFromServer(mcpServer, tabId);
    }
  }

  setPageTools(tabId: number, tools: PageToolSpec[]): void {
    this.pageToolsByTab.set(tabId, tools);
  }

  deletePageTools(tabId: number): void {
    this.pageToolsByTab.delete(tabId);
  }

  // ── Context manifest ──

  registerContextManifestOnServer(mcpServer: McpServer, tabId: number, manifest: PageContextManifest): void {
    let resourceHandles = this.contextResourceHandlesByServer.get(mcpServer);
    if (!resourceHandles) {
      resourceHandles = new Map();
      this.contextResourceHandlesByServer.set(mcpServer, resourceHandles);
    }

    let promptHandles = this.contextPromptHandlesByServer.get(mcpServer);
    if (!promptHandles) {
      promptHandles = new Map();
      this.contextPromptHandlesByServer.set(mcpServer, promptHandles);
    }

    for (const resource of manifest.resources) {
      const name = buildContextResourceName(tabId, resource);
      if (!resourceHandles.has(name)) {
        const registeredResource = mcpServer.registerResource(
          name,
          buildContextResourceUri(tabId, resource),
          {
            title: resource.title,
            description: resource.description,
            mimeType: resource.mimeType ?? "application/json",
          },
          async (uri) => {
            const payload = await this.rpcCaller.readContextResource(tabId, resource.id);
            return {
              contents: [
                {
                  uri: uri.href,
                  mimeType: payload.mimeType ?? resource.mimeType ?? "application/json",
                  text: payload.text,
                },
              ],
            };
          },
        );
        resourceHandles.set(name, { registeredResource, tabId });
      }
    }

    for (const skill of manifest.skills) {
      const name = buildContextPromptName(tabId, skill);
      if (!promptHandles.has(name)) {
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
            const prompt = await this.rpcCaller.getContextSkillPrompt(tabId, skill.id, { goal });
            const promptText = prompt?.text ?? `Skill '${skill.id}' is unavailable.`;
            return {
              description: skill.description,
              messages: [
                {
                  role: "user",
                  content: {
                    type: "text",
                    text: promptText,
                  },
                },
              ],
            };
          },
        );
        promptHandles.set(name, { registeredPrompt, tabId });
      }
    }
  }

  unregisterContextManifestFromServer(mcpServer: McpServer, tabId: number): void {
    const resourceHandles = this.contextResourceHandlesByServer.get(mcpServer);
    if (resourceHandles) {
      for (const [name, entry] of resourceHandles.entries()) {
        if (entry.tabId !== tabId) {
          continue;
        }
        entry.registeredResource.remove();
        resourceHandles.delete(name);
      }
    }

    const promptHandles = this.contextPromptHandlesByServer.get(mcpServer);
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

  syncContextManifestOnAllServers(tabId: number, manifest: PageContextManifest | null): void {
    if (manifest) {
      this.pageContextManifestByTab.set(tabId, manifest);
    } else {
      this.pageContextManifestByTab.delete(tabId);
    }

    for (const server of this.mcpServers) {
      this.unregisterContextManifestFromServer(server, tabId);
      if (manifest) {
        this.registerContextManifestOnServer(server, tabId, manifest);
      }
    }
  }

  syncPageToolsToNewServer(mcpServer: McpServer): void {
    this.syncBuiltinToolsOnServer(mcpServer);
    for (const [tabId, tools] of this.pageToolsByTab.entries()) {
      this.registerPageToolsOnServer(mcpServer, tabId, tools);
    }
    for (const [tabId, manifest] of this.pageContextManifestByTab.entries()) {
      this.registerContextManifestOnServer(mcpServer, tabId, manifest);
    }
  }
}

// ── Helpers ──

function normalizePageToolName(tool: PageToolSpec): string {
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

function buildContextResourceName(tabId: number, resource: ContextResourceDescriptor): string {
  return `tab.${tabId}.resource.${resource.namespace}.${resource.id.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
}

function buildContextResourceUri(tabId: number, resource: ContextResourceDescriptor): string {
  return `context://tab/${tabId}/resource/${resource.namespace}/${encodeURIComponent(resource.id)}`;
}

function buildContextPromptName(tabId: number, skill: ContextSkillDescriptor): string {
  return `tab.${tabId}.skill.${skill.namespace}.${skill.id.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
}

function createTextResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function log(...args: unknown[]): void {
  process.stderr.write(`[PAGE-CONTEXT-BRIDGE] ${args.map(String).join(" ")}\n`);
}
