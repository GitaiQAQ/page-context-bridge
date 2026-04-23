/**
 * Bridge server entry point.
 * Wires together MCP registry, extension session, and HTTP servers.
 * Multi-tenant: each tenant ID gets its own isolated McpRegistry.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { TenantManager } from "./tenant-manager.js";
import { log } from "./mcp-registry.js";
import {
  getContextManifestDebugFromExtension,
  getContextManifestFromExtension,
  getRuntimeStatusFromExtension,
  reconnectExtensionFromBridge,
  readContextResourceFromExtension,
  getContextSkillPromptFromExtension,
  getPageToolsTreeFromExtension,
  refreshPageToolsFromExtension,
  setPageToolsEnabledBatchOnExtension,
  sendToolCallToExtension,
  startWebSocketServer,
  startHeartbeatWatchdog,
} from "./extension-session.js";
import { startSseServer } from "./http-servers.js";
import { getRuntimeEnv } from "./runtime-env.js";

const runtimeEnv = getRuntimeEnv();
const EXT_WS_PORT = Number.parseInt(runtimeEnv.EXT_WS_PORT || "22335", 10);
const MCP_HTTP_PORT = Number.parseInt(runtimeEnv.MCP_HTTP_PORT || "22334", 10);
const STDIO_TENANT_ID = runtimeEnv.TENANT_ID || "default";

// ── Tenant Manager: creates isolated registries per tenant ──

const tenantManager: TenantManager = new TenantManager({
  createRegistry: (tenantId: string): import("./mcp-registry.js").McpRegistry => {
    // Import here to avoid circular dependency at module level
    const { McpRegistry } = require("./mcp-registry.js") as typeof import("./mcp-registry.js");
    return new McpRegistry({
      sendToolCall: (tool, args, tabId) => sendToolCallToExtension(tenantId, tenantManager, tool, args, tabId),
      getRuntimeStatus: () => getRuntimeStatusFromExtension(tenantId, tenantManager),
      reconnectExtension: () => reconnectExtensionFromBridge(tenantId, tenantManager),
      getContextManifest: (tabId) => getContextManifestFromExtension(tenantId, tenantManager, tabId),
      getContextManifestDebug: (tabId) => getContextManifestDebugFromExtension(tenantId, tenantManager, tabId),
      refreshPageTools: (tabId) => refreshPageToolsFromExtension(tenantId, tenantManager, tabId),
      readContextResource: (tabId, resourceId) => readContextResourceFromExtension(tenantId, tenantManager, tabId, resourceId),
      getContextSkillPrompt: (tabId, skillId, input) => getContextSkillPromptFromExtension(tenantId, tenantManager, tabId, skillId, input),
      getPageToolsTree: () => getPageToolsTreeFromExtension(tenantId, tenantManager),
      setPageToolsEnabledBatch: (updates) => setPageToolsEnabledBatchOnExtension(tenantId, tenantManager, updates),
    }, tenantId);
  },
});

// Start idle cleanup
tenantManager.startCleanup();

// ── Main ──

async function main(): Promise<void> {
  const useSse = MCP_HTTP_PORT > 0;

  if (useSse) {
    log(`Starting MCP server in SSE mode on http://127.0.0.1:${MCP_HTTP_PORT}...`);
    if (!(await startSseServer(MCP_HTTP_PORT, tenantManager))) {
      process.exit(1);
    }
  } else {
    // Stdio mode: use the configured tenant (default "default")
    const stdioTenant = tenantManager.getOrCreate(STDIO_TENANT_ID);
    const baseServer = new McpServer({ name: "page-context-bridge", version: "0.2.0" });
    stdioTenant.registry.addServer(baseServer);
    stdioTenant.registry.syncBuiltinToolsOnServer(baseServer);

    log("WARNING: MCP_HTTP_PORT is not set (default: 0). Running in stdio mode.");
    log(`  Tenant: ${STDIO_TENANT_ID}`);
    log('  To enable SSE mode, set env variable, e.g.:  MCP_HTTP_PORT=22334 node dist/index.js');
    try {
      await baseServer.connect(new StdioServerTransport());
      log("MCP Server running on stdio");
    } catch (error) {
      log("FATAL: Failed to start MCP server on stdio:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  log(`Starting WebSocket server on ws://127.0.0.1:${EXT_WS_PORT}...`);
  if (!(await startWebSocketServer(EXT_WS_PORT, tenantManager))) {
    log("WARNING: WebSocket server failed to start. MCP tools will return errors until the extension can connect.");
  }

  startHeartbeatWatchdog(tenantManager);
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
