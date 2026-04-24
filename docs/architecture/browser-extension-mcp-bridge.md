# Browser Extension ↔ MCP Bridge Architecture Design

> Architecture design for the browser debugging extension and local MCP (Model Context Protocol) service bridging — covering communication links, component responsibilities, protocol details, and future separation plans.

## 1. Overview

### 1.1 Design Goals

Implement bidirectional communication between the browser extension and the local MCP server, enabling external MCP clients (such as OpenCode, Claude Desktop) to access browser page debugging tools.

### 1.2 Core Features

- **Auto-discovery and Connection**: The extension automatically connects to the local MCP server on startup
- **Bidirectional Communication**: Server push via SSE (Server-Sent Events)
- **Protocol Compatibility**: Full support for MCP JSON-RPC 2.0 protocol
- **Reconnection**: Heartbeat detection and automatic reconnection mechanism

## 2. Architecture Design

### 2.1 Overall Architecture

```
┌─────────────────┐     HTTP/SSE      ┌──────────────────┐     chrome.runtime     ┌─────────────────┐
│   MCP Client    │ ◄───────────────► │   MCP Server     │ ◄───────────────────► │  Extension SW   │
│  (OpenCode etc.) │                   │  (Node.js HTTP)  │                      │ (Service Worker)│
└─────────────────┘                   └──────────────────┘                      └────────┬────────┘
        │                                                                             │
        │                           ┌──────────────────────┐                          │
        └──────────────────────────►│   Page Context Bridge  │◄─────────────────────────┘
                                    │ (window.__pageContextBridge__)
                                    └──────────────────────┘
```

### 2.2 Component Responsibilities

| Component | File Path | Responsibility |
|-----------|-----------|----------------|
| MCP Server | `src/companion/mcp-server.ts` | Node.js HTTP server, handles MCP protocol, manages SSE connections |
| MCP Client | `src/service-worker/mcp-server-client.ts` | Extension-side client, maintains SSE connection, handles relay requests |
| Message Handler | `src/service-worker/companion-message-handler.ts` | Routes messages from MCP server |
| Launcher | `scripts/mcp-server.mjs` | MCP server startup script |

## 3. Communication Protocol

### 3.1 Transport Layer

HTTP + SSE dual-channel design:

- **HTTP POST**: Client sends requests to server
- **SSE (Server-Sent Events)**: Server pushes responses and notifications to client

### 3.2 Connection Establishment Flow

```
Extension                                          MCP Server
    │                                                   │
    │  1. GET /mcp?sessionId=<id> (EventSource)        │
    │ ────────────────────────────────────────────────► │
    │                                                   │
    │  2. SSE: event: connected                         │
    │ ◄──────────────────────────────────────────────── │
    │                                                   │
    │  3. POST /register                                │
    │ ────────────────────────────────────────────────► │
    │                                                   │
    │  4. { ok: true }                                  │
    │ ◄──────────────────────────────────────────────── │
    │                                                   │
    │  5. Heartbeat (every 30s)                         │
    │ ◄──────────────────────────────────────────────── │
```

### 3.3 MCP JSON-RPC Message Format

**Request Example:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

**Response Example:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "namespace.toolName",
        "description": "Tool description",
        "inputSchema": { ... }
      }
    ]
  }
}
```

### 3.4 Relay Request Types

| Type | Description | Direction |
|------|-------------|-----------|
| `browser-mcp.list-tools` | Get page debugging tools list | Server → Extension |
| `browser-mcp.call-tool` | Call specified debugging tool | Server → Extension |
| `browser-mcp/status` | Get connection status | Server → Extension |

## 4. API Endpoints

### 4.1 HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check, returns server status and extension registration status |
| GET | `/mcp?sessionId=<id>` | SSE connection endpoint |
| POST | `/register` | Extension registration endpoint |
| POST | `/mcp?sessionId=<id>` | MCP JSON-RPC request endpoint |

### 4.2 Health Check Response

```json
{
  "ok": true,
  "server": "page-context-bridge",
  "version": "0.0.1",
  "extensionRegistered": true,
  "extensionId": "extension-id",
  "pendingRequests": 0,
  "sseClients": 1
}
```

## 5. Extension-side Implementation

### 5.1 Auto-connection Mechanism

The extension automatically attempts to connect to the MCP server at the following times:

```typescript
// src/service-worker/index.ts
chrome.runtime.onInstalled.addListener(() => {
  void initMcpServerClient();
});

chrome.runtime.onStartup.addListener(() => {
  void initMcpServerClient();
});

// Connect immediately when service worker reloads
void initMcpServerClient();
```

### 5.2 Reconnection Strategy

- **Initial Retry**: Retry 5 seconds after registration failure
- **Heartbeat Detection**: Check connection status every 30 seconds
- **Timeout Reconnection**: Trigger reconnection if no heartbeat received for over 60 seconds

### 5.3 Configuration

```typescript
// Default configuration
const DEFAULT_MCP_SERVER_URL = 'http://127.0.0.1:22334';
const REGISTRATION_RETRY_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
```

## 6. Usage

### 6.1 Start MCP Server

```bash
npx @page-context/mcp-bridge sse 22334
```

### 6.2 Test Connection

```bash
# 1. Health check
curl http://127.0.0.1:22334/health

# 2. Establish SSE connection
curl -N "http://127.0.0.1:22334/sse"

# 3. Send MCP request
curl -X POST "http://127.0.0.1:22334/message?sessionId=test" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 6.3 Configure MCP Client

Using OpenCode as an example:

```json
{
  "mcpServers": {
    "page-context-bridge": {
      "command": "npx",
      "args": ["-y", "@page-context/mcp-bridge"]
    }
  }
}
```

### 6.4 Agent-Facing Control Runbook (Current `extension.*` + `feedback.*`)

This section is the current operational contract for agents. Prefer namespaced tools and treat legacy underscore names as compatibility aliases only.

#### Preferred tool entrypoints

- `extension.get_runtime_status`
- `extension.get_tool_tree`
- `extension.get_context_manifest_debug`
- `extension.refresh_page_tools`
- `extension.set_tools_enabled`
- `extension.ensure_main_world_host`
- `extension.ensure_agentation_main`
- `extension.tool_debug_call` (read-only + enabled tools only)
- `feedback.get_snapshot`
- `feedback.watch_events`
- `feedback.create_annotation`
- `feedback.update_annotation`
- `feedback.claim`
- `feedback.reply`
- `feedback.resolve`
- `feedback.dismiss`

#### Recommended call order (control plane convergence)

Use this order when an agent starts or takes over a tab/session:

1. `extension.get_runtime_status` to confirm bridge-extension runtime is ready.
2. `extension.get_tool_tree` to read current tool visibility/enabled state.
3. If page tools are stale/missing, call `extension.refresh_page_tools({ "tabId": <tabId> })`.
4. Re-read `extension.get_tool_tree` and only then call `extension.set_tools_enabled` for explicit enable/disable changes.
5. Use `extension.get_context_manifest_debug({ "tabId": <tabId> })` when namespace/resource/skill filtering needs evidence.
6. If page host injection is suspect, call `extension.ensure_main_world_host` and `extension.ensure_agentation_main`, then run step 3 again.
7. For low-risk direct probing only, call `extension.tool_debug_call` after step 2/4 confirms the target tool is unique, enabled, and read-only.

#### Typical troubleshooting flow

When "tool not found", "tool disabled", or "context mismatch" occurs:

1. `extension.get_runtime_status`
2. `extension.get_tool_tree`
3. Branch by symptom:
- Missing expected page tool: `extension.refresh_page_tools(tabId)` -> `extension.get_tool_tree`
- Tool exists but `enabled=false`: `extension.set_tools_enabled({ "updates": [...] })` -> `extension.get_tool_tree`
- Manifest/filter looks wrong: `extension.get_context_manifest_debug(tabId)` and inspect `manifest/rawManifest/debug`
- Suspected MAIN world injection issue: `extension.ensure_main_world_host` + `extension.ensure_agentation_main` -> `extension.refresh_page_tools(tabId)`
4. Retry target tool call only after the above evidence is consistent.

#### When to use `feedback.get_snapshot` vs `feedback.watch_events`

- Use `feedback.get_snapshot` for baseline reads:
  - first read in a new agent session
  - tab/session switch
  - after reconnect or uncertain cursor state
- Use `feedback.watch_events` for incremental polling:
  - pass `afterSeq` from previous `snapshot.lastSeq` or `watch_events.lastSeq`
  - optionally pass `sessionId` to narrow scope
- `feedback.watch_events` is cursor-based pull, not a long-lived streaming subscription.

#### When to use `extension.refresh_page_tools` vs `extension.set_tools_enabled`

- Use `extension.refresh_page_tools` when registry contents may be stale:
  - page navigation/reload
  - userscript/bridge host newly injected
  - expected namespace/tool absent in tree
- Use `extension.set_tools_enabled` when the tool already exists in tree and only state changes are needed.
- For `root: "page"` updates, `tabId` is required; missing `tabId` is a hard error (not silent no-op).

## 7. Future Separation Plan

### 7.1 Separable Components

1. **MCP Server** (`packages/page-context-bridge-server/src/index.ts`)
2. **CLI** (`packages/page-context-bridge-server/bin/page-context-bridge`)
3. **Protocol Types** (`packages/shared-protocol/src/`)

### 7.2 Architecture After Separation

```
page-context-bridge-server/          # Standalone package
├── src/
│   ├── index.ts                  # MCP server core
│   ├── mcp-registry.ts           # MCP tool/resource/prompt registry
│   ├── extension-session.ts      # Extension WebSocket client
│   └── http-servers.ts           # SSE/HTTP servers
└── bin/
    └── page-context-bridge       # CLI entry point

page-context-extension/           # Chrome extension
├── src/
│   ├── background.ts             # Service worker: WebSocket, tool discovery
│   ├── content-script.ts         # Content script entry point
│   └── ...
```

### 7.3 Interface Contract

After separation, the MCP server and extension interact through the following interfaces:

```typescript
// Extension registration info
interface ExtensionRegistration {
  extensionId: string;
  extensionVersion?: string;
  sessionId: string;
  registeredAt: string;
}

// Relay request
interface RelayRequest {
  type: 'browser-mcp.list-tools' | 'browser-mcp.call-tool';
  requestId: string;
  payload?: Record<string, unknown>;
}

// Relay response
interface RelayResponse {
  type: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
```

## 8. Notes

1. **CORS**: MCP server allows all origins (`*`) by default, intended for local development only
2. **Security**: Current version has no authentication, relies on local network isolation
3. **Single Extension Limit**: Currently only supports single extension registration, can be extended to multiple extensions in the future
4. **Protocol Version**: Supports MCP protocol versions `2025-06-18` and `2025-03-26`

## 9. Related Files

- `packages/page-context-bridge-server/src/index.ts` - MCP server implementation
- `packages/page-context-extension/src/background.ts` - Extension-side service worker
- `packages/shared-protocol/src/index.ts` - Shared protocol types
