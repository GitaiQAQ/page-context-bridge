import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { extname, join } from "path";
import { fileURLToPath } from "url";
import { readFile, stat } from "fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  BRIDGE_METHODS,
  type ContextResourceDescriptor,
  type ContextResourcePayload,
  type ContextSkillDescriptor,
  type ContextSkillPrompt,
  type PageContextManifest,
  RpcPeer,
  RpcProtocolError,
  RPC_ERROR_CODES,
} from "@page-context/shared-protocol";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import { buildRegisteredPageToolName } from "./page-tool-routing.js";
import { buildZodSchema, type JsonSchemaLike } from "./schema.js";
import {
  validateParams,
  sessionRegisterParamsSchema,
  bridgePageEventParamsSchema,
  bridgePageToolsRegisteredParamsSchema,
  bridgeBuiltinToolsUpdatedParamsSchema,
  bridgePageToolsUnregisteredParamsSchema,
  bridgeTabActivatedParamsSchema,
  bridgeTabUpdatedParamsSchema,
} from "./rpc-params.js";

const EXT_WS_PORT = Number.parseInt(process.env.EXT_WS_PORT || "9001", 10);
const EXAMPLE_HTTP_PORT = Number.parseInt(process.env.EXAMPLE_HTTP_PORT || "9002", 10);
const MCP_HTTP_PORT = Number.parseInt(process.env.MCP_HTTP_PORT || "0", 10);
const TOOL_CALL_TIMEOUT_MS = 30_000;
const HEARTBEAT_GRACE_MS = 45_000;

const __dirname = join(fileURLToPath(import.meta.url), "..");

interface ExtensionState {
  ws: WebSocket;
  peer: RpcPeer;
  ready: boolean;
  sessionId: string | null;
  lastHeartbeatAt: number;
}

interface PageToolSpec {
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

interface BuiltinToolSpec {
  name: string;
}

interface BuiltinToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  register: (server: McpServer) => { remove: () => void };
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

let wsServerReady = false;
let extension: ExtensionState | null = null;
const pageToolsByTab = new Map<number, PageToolSpec[]>();
const pageContextManifestByTab = new Map<number, PageContextManifest>();
const mcpServers = new Set<McpServer>();
const pageToolHandlesByServer = new WeakMap<McpServer, Map<string, RegisteredPageTool>>();
const builtinToolHandlesByServer = new WeakMap<McpServer, Map<string, { remove: () => void }>>();
const contextResourceHandlesByServer = new WeakMap<McpServer, Map<string, RegisteredContextResource>>();
const contextPromptHandlesByServer = new WeakMap<McpServer, Map<string, RegisteredContextPrompt>>();

const BUILTIN_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    name: "list_tabs",
    description: "List all open browser tabs",
    inputSchema: {},
    register: (server) => server.registerTool("list_tabs", { description: "List all open browser tabs", inputSchema: {} }, async () => {
      try {
        const current = assertExtensionReady();
        const tabs = await current.peer.request<Array<{ id?: number; title?: string; url?: string; active?: boolean }>>(BRIDGE_METHODS.bridgeTabsList, {}, { timeoutMs: TOOL_CALL_TIMEOUT_MS });
        const output = tabs.map((tab: { id?: number; title?: string; url?: string; active?: boolean }) => `[${tab.id}] ${tab.active ? "★ " : "  "}${tab.title || "Untitled"} — ${tab.url}`).join("\n");
        return createTextResponse(output || "No tabs found");
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  },
  {
    name: "get_page_info",
    description: "Get the current page URL, title, and metadata",
    inputSchema: { tabId: z.number().optional() },
    register: (server) => server.registerTool("get_page_info", { description: "Get the current page URL, title, and metadata", inputSchema: { tabId: z.number().optional() } }, async ({ tabId }) => {
      try {
        const result = await sendToolCallToExtension("get_page_info", {}, tabId);
        return createTextResponse(JSON.stringify(result, null, 2));
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  },
  {
    name: "get_selected_text",
    description: "Get the currently selected text on the page",
    inputSchema: { tabId: z.number().optional() },
    register: (server) => server.registerTool("get_selected_text", { description: "Get the currently selected text on the page", inputSchema: { tabId: z.number().optional() } }, async ({ tabId }) => {
      try {
        const result = await sendToolCallToExtension<{ text?: string }>("get_selected_text", {}, tabId);
        return createTextResponse(result.text || "(no text selected)");
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  },
  {
    name: "click_element",
    description: "Click an element on the page by CSS selector",
    inputSchema: { selector: z.string(), tabId: z.number().optional() },
    register: (server) => server.registerTool("click_element", { description: "Click an element on the page by CSS selector", inputSchema: { selector: z.string(), tabId: z.number().optional() } }, async ({ selector, tabId }) => {
      try {
        await sendToolCallToExtension("click_element", { selector }, tabId);
        return createTextResponse(`Clicked: ${selector}`);
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  },
  {
    name: "get_element_text",
    description: "Get text content of an element",
    inputSchema: { selector: z.string(), tabId: z.number().optional() },
    register: (server) => server.registerTool("get_element_text", { description: "Get text content of an element", inputSchema: { selector: z.string(), tabId: z.number().optional() } }, async ({ selector, tabId }) => {
      try {
        const result = await sendToolCallToExtension<{ text?: string }>("get_element_text", { selector }, tabId);
        return createTextResponse(result.text || "(empty)");
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  },
  {
    name: "get_element_html",
    description: "Get outer HTML of an element",
    inputSchema: { selector: z.string(), tabId: z.number().optional() },
    register: (server) => server.registerTool("get_element_html", { description: "Get outer HTML of an element", inputSchema: { selector: z.string(), tabId: z.number().optional() } }, async ({ selector, tabId }) => {
      try {
        const result = await sendToolCallToExtension<{ html?: string }>("get_element_html", { selector }, tabId);
        return createTextResponse(result.html || "(empty)");
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  },
  {
    name: "query_elements",
    description: "Query elements by CSS selector",
    inputSchema: { selector: z.string(), limit: z.number().optional(), tabId: z.number().optional() },
    register: (server) => server.registerTool("query_elements", { description: "Query elements by CSS selector", inputSchema: { selector: z.string(), limit: z.number().optional(), tabId: z.number().optional() } }, async ({ selector, limit, tabId }) => {
      try {
        const result = await sendToolCallToExtension<{ count: number; results: Array<{ tag: string; id?: string; className?: string; text: string }> }>("query_elements", { selector, limit }, tabId);
        const lines = result.results.map((element, index) => `${index + 1}. <${element.tag}${element.id ? `#${element.id}` : ""}${element.className ? `.${element.className.split(" ").join(".")}` : ""}> ${element.text}`);
        return createTextResponse(`Found ${result.count} elements:\n${lines.join("\n")}`);
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  },
  {
    name: "fill_input",
    description: "Fill an input field with a value",
    inputSchema: { selector: z.string(), value: z.string(), tabId: z.number().optional() },
    register: (server) => server.registerTool("fill_input", { description: "Fill an input field with a value", inputSchema: { selector: z.string(), value: z.string(), tabId: z.number().optional() } }, async ({ selector, value, tabId }) => {
      try {
        await sendToolCallToExtension("fill_input", { selector, value }, tabId);
        return createTextResponse(`Filled '${selector}' with: ${value}`);
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  },
  {
    name: "execute_js",
    description: "Execute JavaScript expression in page context",
    inputSchema: { expression: z.string(), tabId: z.number().optional() },
    register: (server) => server.registerTool("execute_js", { description: "Execute JavaScript expression in page context", inputSchema: { expression: z.string(), tabId: z.number().optional() } }, async ({ expression, tabId }) => {
      try {
        const result = await sendToolCallToExtension<{ ok: boolean; result?: string; type?: string; error?: string }>("execute_js", { expression }, tabId);
        return createTextResponse(result.ok ? `Result (${result.type}): ${result.result}` : `Execution error: ${result.error}`);
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  },
  {
    name: "screenshot_tab",
    description: "Take a screenshot of the current tab",
    inputSchema: { format: z.enum(["png", "jpeg"]).optional(), tabId: z.number().optional() },
    register: (server) => server.registerTool("screenshot_tab", { description: "Take a screenshot of the current tab", inputSchema: { format: z.enum(["png", "jpeg"]).optional(), tabId: z.number().optional() } }, async ({ format, tabId }) => {
      try {
        const result = await sendToolCallToExtension<{ dataUrl?: string; format?: string }>("screenshot_tab", { format: format || "png" }, tabId);
        if (!result.dataUrl) {
          return createTextResponse("Screenshot captured but no data returned");
        }
        const base64 = result.dataUrl.split(",")[1];
        return {
          content: [{ type: "image", data: base64, mimeType: result.format === "jpeg" ? "image/jpeg" : "image/png" }],
        };
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  },
  {
    name: "get_console_logs",
    description: "Get recent console log entries from the page",
    inputSchema: { limit: z.number().optional(), level: z.enum(["all", "log", "warn", "error", "info"]).optional(), tabId: z.number().optional() },
    register: (server) => server.registerTool("get_console_logs", { description: "Get recent console log entries from the page", inputSchema: { limit: z.number().optional(), level: z.enum(["all", "log", "warn", "error", "info"]).optional(), tabId: z.number().optional() } }, async ({ limit, level, tabId }) => {
      try {
        const result = await sendToolCallToExtension<{ entries: Array<{ timestamp: number; level: string; args: string }> }>("get_console_logs", { limit, level }, tabId);
        const text = result.entries.map((entry) => `[${new Date(entry.timestamp).toLocaleTimeString()}] [${entry.level.toUpperCase()}] ${entry.args}`).join("\n");
        return createTextResponse(text || "(no logs)");
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  },
  {
    name: "navigate",
    description: "Navigate the current tab to a URL",
    inputSchema: { url: z.string(), tabId: z.number().optional() },
    register: (server) => server.registerTool("navigate", { description: "Navigate the current tab to a URL", inputSchema: { url: z.string(), tabId: z.number().optional() } }, async ({ url, tabId }) => {
      try {
        await sendToolCallToExtension("navigate", { url }, tabId);
        return createTextResponse(`Navigating to: ${url}`);
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  },
];

let enabledBuiltinToolNames = new Set(BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.name));

function log(...args: unknown[]): void {
  process.stderr.write(`[PAGE-CONTEXT-BRIDGE] ${args.map(String).join(" ")}\n`);
}

function createTextResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function assertExtensionReady(): ExtensionState {
  if (!wsServerReady) {
    throw new Error(`WebSocket server is not running (port ${EXT_WS_PORT} may be occupied). Try: EXT_WS_PORT=9002 node dist/index.js`);
  }
  if (!extension || extension.ws.readyState !== WebSocket.OPEN) {
    throw new Error("Chrome extension is not connected. Load the extension and ensure its service worker is running.");
  }
  if (!extension.ready) {
    throw new Error("Chrome extension transport is connected but not ready yet; waiting for session.register.");
  }
  return extension;
}

async function sendToolCallToExtension<TResult = unknown>(tool: string, args: Record<string, unknown>, tabId?: number): Promise<TResult> {
  const current = assertExtensionReady();
  return await current.peer.request<TResult>(BRIDGE_METHODS.bridgeToolCall, { tool, args, tabId }, { timeoutMs: TOOL_CALL_TIMEOUT_MS });
}

async function getContextManifestFromExtension(tabId: number): Promise<PageContextManifest | null> {
  const current = assertExtensionReady();
  const result = await current.peer.request<{ manifest: PageContextManifest | null }>(BRIDGE_METHODS.extensionContextManifestGet, { tabId }, { timeoutMs: TOOL_CALL_TIMEOUT_MS });
  return result.manifest;
}

async function readContextResourceFromExtension(tabId: number, resourceId: string): Promise<ContextResourcePayload> {
  const current = assertExtensionReady();
  return await current.peer.request<ContextResourcePayload>(BRIDGE_METHODS.extensionContextResourceRead, { tabId, resourceId }, { timeoutMs: TOOL_CALL_TIMEOUT_MS });
}

async function getContextSkillPromptFromExtension(tabId: number, skillId: string, input?: Record<string, unknown>): Promise<ContextSkillPrompt | null> {
  const current = assertExtensionReady();
  const result = await current.peer.request<{ prompt: ContextSkillPrompt | null }>(BRIDGE_METHODS.extensionContextSkillGet, { tabId, skillId, input }, { timeoutMs: TOOL_CALL_TIMEOUT_MS });
  return result.prompt;
}

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

function registerPageToolsOnServer(mcpServer: McpServer, tabId: number, tools: PageToolSpec[]): void {
  let handles = pageToolHandlesByServer.get(mcpServer);
  if (!handles) {
    handles = new Map();
    pageToolHandlesByServer.set(mcpServer, handles);
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
            const result = await sendToolCallToExtension(actualToolName, (args ?? {}) as Record<string, unknown>, tabId);
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

function unregisterPageToolsFromServer(mcpServer: McpServer, tabId: number): void {
  const handles = pageToolHandlesByServer.get(mcpServer);
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

function registerContextManifestOnServer(mcpServer: McpServer, tabId: number, manifest: PageContextManifest): void {
  let resourceHandles = contextResourceHandlesByServer.get(mcpServer);
  if (!resourceHandles) {
    resourceHandles = new Map();
    contextResourceHandlesByServer.set(mcpServer, resourceHandles);
  }

  let promptHandles = contextPromptHandlesByServer.get(mcpServer);
  if (!promptHandles) {
    promptHandles = new Map();
    contextPromptHandlesByServer.set(mcpServer, promptHandles);
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
          const payload = await readContextResourceFromExtension(tabId, resource.id);
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
          const prompt = await getContextSkillPromptFromExtension(tabId, skill.id, { goal });
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

function unregisterContextManifestFromServer(mcpServer: McpServer, tabId: number): void {
  const resourceHandles = contextResourceHandlesByServer.get(mcpServer);
  if (resourceHandles) {
    for (const [name, entry] of resourceHandles.entries()) {
      if (entry.tabId !== tabId) {
        continue;
      }
      entry.registeredResource.remove();
      resourceHandles.delete(name);
    }
  }

  const promptHandles = contextPromptHandlesByServer.get(mcpServer);
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

function syncContextManifestOnAllServers(tabId: number, manifest: PageContextManifest | null): void {
  if (manifest) {
    pageContextManifestByTab.set(tabId, manifest);
  } else {
    pageContextManifestByTab.delete(tabId);
  }

  for (const server of mcpServers) {
    unregisterContextManifestFromServer(server, tabId);
    if (manifest) {
      registerContextManifestOnServer(server, tabId, manifest);
    }
    // The MCP SDK already emits resource/prompt list-changed notifications when
    // registrations are added or removed. Avoid unconditional notifications here,
    // because a server may not advertise prompts/resources at all for this sync.
  }
}

function registerPageToolsOnAllServers(tabId: number, tools: PageToolSpec[]): void {
  for (const mcpServer of mcpServers) {
    registerPageToolsOnServer(mcpServer, tabId, tools);
  }
}

function unregisterPageToolsFromAllServers(tabId: number): void {
  for (const mcpServer of mcpServers) {
    unregisterPageToolsFromServer(mcpServer, tabId);
  }
}

function syncPageToolsToNewServer(mcpServer: McpServer): void {
  syncBuiltinToolsOnServer(mcpServer);
  for (const [tabId, tools] of pageToolsByTab.entries()) {
    registerPageToolsOnServer(mcpServer, tabId, tools);
  }
  for (const [tabId, manifest] of pageContextManifestByTab.entries()) {
    registerContextManifestOnServer(mcpServer, tabId, manifest);
  }
}

function syncBuiltinToolsOnServer(mcpServer: McpServer): void {
  let handles = builtinToolHandlesByServer.get(mcpServer);
  if (!handles) {
    handles = new Map();
    builtinToolHandlesByServer.set(mcpServer, handles);
  }

  for (const [toolName, handle] of handles.entries()) {
    if (!enabledBuiltinToolNames.has(toolName)) {
      handle.remove();
      handles.delete(toolName);
    }
  }

  for (const definition of BUILTIN_TOOL_DEFINITIONS) {
    if (!enabledBuiltinToolNames.has(definition.name) || handles.has(definition.name)) {
      continue;
    }
    handles.set(definition.name, definition.register(mcpServer));
  }
}

function syncBuiltinToolsOnAllServers(toolSpecs: BuiltinToolSpec[]): void {
  enabledBuiltinToolNames = new Set(toolSpecs.map((tool) => tool.name));
  for (const server of mcpServers) {
    syncBuiltinToolsOnServer(server);
  }
}

const baseServer = createBaseMcpServer();

function createBaseMcpServer(): McpServer {
  const server = new McpServer({ name: "page-context-bridge", version: "0.2.0" });
  mcpServers.add(server);
  syncBuiltinToolsOnServer(server);
  return server;
}

function createExtensionState(ws: WebSocket): ExtensionState {
  const state: ExtensionState = {
    ws,
    ready: false,
    sessionId: null,
    lastHeartbeatAt: Date.now(),
    peer: new RpcPeer({
      send: (message: string) => ws.send(message),
      defaultTimeoutMs: TOOL_CALL_TIMEOUT_MS,
      getMeta: () => ({
        sessionId: state.sessionId ?? undefined,
        source: "bridge",
        target: "extension",
      }),
    }),
  };

  state.peer.register(BRIDGE_METHODS.sessionRegister, async (params: unknown) => {
    const payload = validateParams(sessionRegisterParamsSchema, params, BRIDGE_METHODS.sessionRegister);
    state.ready = true;
    state.sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    state.lastHeartbeatAt = Date.now();
    log(`Extension registered: ${payload.extensionId ?? "unknown"} v${payload.version ?? "unknown"}`);
    return { sessionId: state.sessionId, heartbeatIntervalMs: 15_000 };
  });

  state.peer.register(BRIDGE_METHODS.sessionHeartbeat, async () => {
    state.lastHeartbeatAt = Date.now();
    return { receivedAt: Date.now() };
  });

  state.peer.register(BRIDGE_METHODS.bridgePageEvent, async (params: unknown) => {
    const payload = validateParams(bridgePageEventParamsSchema, params, BRIDGE_METHODS.bridgePageEvent);
    log("PAGE_EVENT from tab", payload.tabId ?? "unknown", JSON.stringify(payload.payload).slice(0, 200));
    return { ok: true };
  });

  state.peer.register(BRIDGE_METHODS.bridgePageToolsRegistered, async (params: unknown) => {
    const payload = validateParams(bridgePageToolsRegisteredParamsSchema, params, BRIDGE_METHODS.bridgePageToolsRegistered);
    if (payload.tabId != null) {
      unregisterPageToolsFromAllServers(payload.tabId);
      pageToolsByTab.set(payload.tabId, payload.tools ?? []);
      registerPageToolsOnAllServers(payload.tabId, payload.tools ?? []);
      const manifest = await getContextManifestFromExtension(payload.tabId).catch(() => null);
      syncContextManifestOnAllServers(payload.tabId, manifest);
    }
    return { ok: true };
  });

  state.peer.register(BRIDGE_METHODS.bridgeBuiltinToolsUpdated, async (params: unknown) => {
    const payload = validateParams(bridgeBuiltinToolsUpdatedParamsSchema, params, BRIDGE_METHODS.bridgeBuiltinToolsUpdated);
    syncBuiltinToolsOnAllServers(payload.tools ?? BUILTIN_TOOL_DEFINITIONS);
    return { ok: true };
  });

  state.peer.register(BRIDGE_METHODS.bridgePageToolsUnregistered, async (params: unknown) => {
    const payload = validateParams(bridgePageToolsUnregisteredParamsSchema, params, BRIDGE_METHODS.bridgePageToolsUnregistered);
    if (payload.tabId != null) {
      pageToolsByTab.delete(payload.tabId);
      unregisterPageToolsFromAllServers(payload.tabId);
      syncContextManifestOnAllServers(payload.tabId, null);
    }
    return { ok: true };
  });

  state.peer.register(BRIDGE_METHODS.bridgeTabActivated, async (params: unknown) => {
    const payload = validateParams(bridgeTabActivatedParamsSchema, params, BRIDGE_METHODS.bridgeTabActivated);
    if (payload.tabId != null) {
      const manifest = await getContextManifestFromExtension(payload.tabId).catch(() => null);
      syncContextManifestOnAllServers(payload.tabId, manifest);
    }
    return { ok: true };
  });
  state.peer.register(BRIDGE_METHODS.bridgeTabUpdated, async (params: unknown) => {
    const payload = validateParams(bridgeTabUpdatedParamsSchema, params, BRIDGE_METHODS.bridgeTabUpdated);
    if (payload.tabId != null) {
      const manifest = await getContextManifestFromExtension(payload.tabId).catch(() => null);
      syncContextManifestOnAllServers(payload.tabId, manifest);
    }
    return { ok: true };
  });

  return state;
}

function startWebSocketServer(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const wss = new WebSocketServer({ port: EXT_WS_PORT });

      wss.on("error", (error: Error) => {
        wsServerReady = false;
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          log(`ERROR: Port ${EXT_WS_PORT} is already in use. Another process is occupying it.`);
        } else {
          log("ERROR: WebSocket server failed:", error instanceof Error ? error.message : String(error));
        }
        resolve(false);
      });

      wss.on("connection", (ws: WebSocket) => {
        log("Extension connected");
        if (extension && extension.ws.readyState === WebSocket.OPEN) {
          extension.peer.failAllPending("Chrome extension reconnected before previous requests completed");
          extension.ws.close(1012, "Superseded by a newer extension connection");
        }

        extension = createExtensionState(ws);
        const currentExtension = extension;

        ws.on("message", (data: WebSocket.RawData) => {
          void currentExtension.peer.receive(data.toString()).catch((error: unknown) => {
            log("Failed to process extension message", error instanceof Error ? error.message : String(error));
          });
        });

        ws.on("close", () => {
          if (extension?.ws === ws) {
            currentExtension.peer.failAllPending("Chrome extension disconnected while request was in flight");
            extension = null;
          }
          log("Extension disconnected");
        });
      });

      wss.on("listening", () => {
        wsServerReady = true;
        log(`Extension WebSocket server listening on ws://127.0.0.1:${EXT_WS_PORT}`);
        resolve(true);
      });
    } catch (error) {
      log("ERROR: Failed to create WebSocket server:", error instanceof Error ? error.message : String(error));
      wsServerReady = false;
      resolve(false);
    }
  });
}

function createSseServerInstance(): McpServer {
  const server = new McpServer({ name: "page-context-bridge", version: "0.2.0" });
  mcpServers.add(server);
  syncPageToolsToNewServer(server);
  return server;
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

async function serveStaticAsset(serveDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const urlPath = (req.url ?? "/").split("?")[0];
  const filePath = urlPath === "/" ? "example.html" : urlPath.slice(1);
  const fullPath = join(serveDir, filePath);
  try {
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) {
      res.writeHead(404).end("Not Found");
      return;
    }
    const data = await readFile(fullPath);
    const contentType = MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not Found");
  }
}

function startExampleHttpServer(): Promise<boolean> {
  return new Promise((resolve) => {
    const serveDir = join(__dirname, "..", "..", "chrome-mcp-extension", "dist");
    const server = createServer((req, res) => {
      void serveStaticAsset(serveDir, req, res);
    });
    server.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        log(`WARNING: Example HTTP port ${EXAMPLE_HTTP_PORT} is already in use.`);
      } else {
        log("WARNING: Example HTTP server error:", error instanceof Error ? error.message : String(error));
      }
      resolve(false);
    });
    server.listen(EXAMPLE_HTTP_PORT, "127.0.0.1", () => {
      log(`Example page served at http://127.0.0.1:${EXAMPLE_HTTP_PORT}/`);
      resolve(true);
    });
  });
}

function startSseServer(): Promise<boolean> {
  return new Promise((resolve) => {
    const serveDir = join(__dirname, "..", "..", "chrome-mcp-extension", "dist");
    const transports = new Map<string, { transport: SSEServerTransport; server: McpServer }>();
    const httpServer = createServer(async (req, res) => {
      const urlPath = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && urlPath === "/sse") {
        const mcpServer = createSseServerInstance();
        const transport = new SSEServerTransport("/message", res);
        transports.set(transport.sessionId, { transport, server: mcpServer });
        transport.onclose = () => {
          transports.delete(transport.sessionId);
          mcpServers.delete(mcpServer);
          pageToolHandlesByServer.delete(mcpServer);
        };
        try {
          await mcpServer.connect(transport);
        } catch (error) {
          log("SSE connect error:", error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (req.method === "POST" && urlPath === "/message") {
        const session = new URL(req.url ?? "/message", "http://localhost").searchParams.get("sessionId");
        const entry = session ? transports.get(session) : undefined;
        if (!entry) {
          res.writeHead(400).end("No active SSE session for this sessionId");
          return;
        }
        try {
          await entry.transport.handlePostMessage(req, res);
        } catch (error) {
          log("SSE POST handling error:", error instanceof Error ? error.message : String(error));
          if (!res.headersSent) {
            res.writeHead(500).end("Message handling failed");
          }
        }
        return;
      }
      await serveStaticAsset(serveDir, req, res);
    });

    httpServer.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        log(`ERROR: MCP HTTP port ${MCP_HTTP_PORT} is already in use.`);
      } else {
        log("ERROR: MCP HTTP server failed:", error instanceof Error ? error.message : String(error));
      }
      resolve(false);
    });

    httpServer.listen(MCP_HTTP_PORT, "127.0.0.1", () => {
      log(`MCP SSE server listening on http://127.0.0.1:${MCP_HTTP_PORT}`);
      resolve(true);
    });
  });
}

function startHeartbeatWatchdog(): void {
  setInterval(() => {
    if (!extension || !extension.ready) {
      return;
    }
    if (Date.now() - extension.lastHeartbeatAt > HEARTBEAT_GRACE_MS) {
      log("Heartbeat timed out; closing stale extension session");
      extension.peer.failAllPending("Extension heartbeat timed out");
      extension.ws.close(1011, "Heartbeat timed out");
      extension = null;
    }
  }, 10_000);
}

async function main(): Promise<void> {
  const useSse = MCP_HTTP_PORT > 0;
  if (useSse) {
    log(`Starting MCP server in SSE mode on http://127.0.0.1:${MCP_HTTP_PORT}...`);
    if (!(await startSseServer())) {
      process.exit(1);
    }
  } else {
    try {
      await baseServer.connect(new StdioServerTransport());
      log("MCP Server running on stdio");
    } catch (error) {
      log("FATAL: Failed to start MCP server on stdio:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  log(`Starting WebSocket server on ws://127.0.0.1:${EXT_WS_PORT}...`);
  if (!(await startWebSocketServer())) {
    log("WARNING: WebSocket server failed to start. MCP tools will return errors until the extension can connect.");
  }

  if (!useSse) {
    log(`Starting example page server on http://127.0.0.1:${EXAMPLE_HTTP_PORT}...`);
    await startExampleHttpServer();
  }

  startHeartbeatWatchdog();
}

process.on("uncaughtException", (error) => {
  log("UNCAUGHT EXCEPTION:", error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    log(error.stack);
  }
});

process.on("unhandledRejection", (error) => {
  log("UNHANDLED REJECTION:", error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    log(error.stack);
  }
});

void main().catch((error) => {
  log("Fatal error during startup:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
