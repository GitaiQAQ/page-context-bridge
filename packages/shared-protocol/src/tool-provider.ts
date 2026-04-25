/**
 * Tool provider plugin interface.
 *
 * A tool provider declares a set of tools and provides their execution logic.
 * The core bridge-server and extension only handle page context tools;
 * builtin tools are loaded via tool providers.
 *
 * There are two execution contexts:
 * - **bridge-server** (Node.js): Registers tools as MCP tools on the McpServer.
 *   The `registerOnBridge` method receives a callback to send tool calls to the extension.
 * - **extension** (page-context):
 *   - **service worker** (background.ts): Handles tools that need extension APIs
 *     (e.g., screenshot_tab, navigate, list_tabs).
 *   - **content script** (via ExtensionToolProvider): Handles tools that need DOM access
 *     (e.g., click_element, get_page_info).
 */

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Annotations for MCP tool registration (e.g., readOnlyHint). */
  annotations?: Record<string, unknown>;
}

/**
 * Where a tool is executed.
 * - `content-script`: Needs DOM access (runs in page context).
 * - `service-worker`: Needs extension APIs only (runs in background).
 */
export type ToolExecutionContext = "content-script" | "service-worker";

/**
 * A complete tool definition with its execution context.
 */
export interface ToolDefinition extends ToolSpec {
  /** Where this tool should be executed. */
  executionContext: ToolExecutionContext;
}

/**
 * Bridge-side tool registration callback.
 * Called by the bridge-server to send a tool call to the extension.
 */
export type BridgeToolCallFn = (tool: string, args: Record<string, unknown>, tabId?: number) => Promise<unknown>;

/**
 * Tool provider for the MCP bridge server (Node.js).
 * Defines tools and registers them as MCP tools on the server.
 */
export interface BridgeToolProvider {
  /** Provider identifier (for logging/debugging). */
  readonly id: string;
  /** Tool specifications exposed to the extension side for discovery. */
  getToolSpecs(): ToolSpec[];
  /**
   * Register all tools from this provider on the given McpServer.
   * The `sendToExtension` callback is used to route tool calls to the extension.
   */
  registerOnBridge(
    registerTool: (name: string, schema: { description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }, handler: (args: Record<string, unknown>) => Promise<unknown>) => { remove: () => void },
    sendToExtension: BridgeToolCallFn,
  ): Map<string, { remove: () => void }>;
}

/**
 * Tool provider for the extension side.
 * Handles tool execution in either content script or service worker context.
 */
export interface ExtensionToolProvider {
  /** Provider identifier (must match BridgeToolProvider.id). */
  readonly id: string;
  /** Full tool definitions with execution context. */
  getToolDefinitions(): ToolDefinition[];
  /**
   * Execute a tool in the content script context.
   * Only called for tools with executionContext === "content-script".
   */
  executeInContentScript?(tool: string, args: Record<string, unknown>, env: ContentScriptToolEnv): unknown;
  /**
   * Execute a tool in the service worker context.
   * Only called for tools with executionContext === "service-worker".
   */
  executeInServiceWorker?(tool: string, args: Record<string, unknown>, ctx: ServiceWorkerToolContext): Promise<unknown>;
}

/** Environment available to content-script tools. */
export interface ContentScriptToolEnv {
  /** The window object (typed as unknown since this package is environment-agnostic). */
  win: unknown;
  /** The document object (typed as unknown since this package is environment-agnostic). */
  doc: unknown;
  consoleEntries: Array<{ level: string; timestamp: number; args: string }>;
}

/** Context available to service-worker tools. */
export interface ServiceWorkerToolContext {
  getActiveTabId(): Promise<number | null>;
  listTabs(): Promise<Array<{ id?: number; url?: string; title?: string; active?: boolean }>>;
  captureVisibleTab(format: string, quality?: number): Promise<string>;
  navigateTab(tabId: number, url: string): Promise<void>;

  /** Reload a tab. If bypassCache is true, forces reload from network. */
  reloadTab(tabId: number, bypassCache?: boolean): Promise<void>;

  /** Navigate history. */
  goBack(tabId: number): Promise<void>;
  goForward(tabId: number): Promise<void>;

  /** Create/close tabs. */
  createTab(url: string, active?: boolean): Promise<{ tabId: number }>;
  closeTab(tabId: number): Promise<void>;

  /** Wait until the tab loading status matches. */
  waitForTabStatus(tabId: number, status: "loading" | "complete", timeoutMs: number): Promise<void>;

  /** Send a CDP command to the tab (requires extension 'debugger' permission). */
  cdpSendCommand(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown>;

  /** Detach CDP from the tab if attached. */
  cdpDetach(tabId: number): Promise<void>;
}
