import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ContextResourcePayload,
  PageContextManifest,
} from "@page-context/shared-protocol";
import type { PageToolEnableUpdate } from "@page-context/builtin-tools";

export interface PageToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  _pageTool?: boolean;
  _namespace?: string;
  _instanceId?: string;
}

export interface ExtensionRpcCaller {
  sendToolCall<TResult = unknown>(
    tool: string,
    args: Record<string, unknown>,
    tabId?: number,
  ): Promise<TResult>;
  getRuntimeStatus(): Promise<unknown>;
  reconnectExtension(): Promise<unknown>;
  debugToolCall(toolName: string, args: Record<string, unknown>, tabId?: number): Promise<unknown>;
  ensureMainWorldHost(tabId: number, frameId?: number): Promise<unknown>;
  ensureAgentationMain(tabId: number, frameId?: number): Promise<unknown>;
  getContextManifest(tabId: number): Promise<PageContextManifest | null>;
  getContextManifestDebug(tabId: number): Promise<unknown>;
  refreshPageTools(tabId: number): Promise<PageToolSpec[]>;
  readContextResource(tabId: number, resourceId: string): Promise<ContextResourcePayload>;
  getContextSkillPrompt(
    tabId: number,
    skillId: string,
    input?: Record<string, unknown>,
  ): Promise<{ text: string } | null>;
  getPageToolsTree(): Promise<unknown>;
  setPageToolsEnabledBatch(updates: PageToolEnableUpdate[]): Promise<unknown>;
}

export interface RemovableHandle {
  remove: () => void;
}

export interface RegisteredPageTool {
  registeredTool: RemovableHandle;
  tabId: number;
}

export interface RegisteredContextResource {
  registeredResource: RemovableHandle;
  tabId: number;
}

export interface RegisteredContextPrompt {
  registeredPrompt: RemovableHandle;
  tabId: number;
}

export type ServerHandleStore<T> = WeakMap<McpServer, Map<string, T>>;
