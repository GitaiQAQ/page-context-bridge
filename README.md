# Page Context Bridge

**Page Capability Bridge for Agents**

Page Context Bridge lets business pages declare structured capabilities and compiles them into standard MCP tools, resources, and prompts for agentic clients.

Instead of exposing the entire browser or page surface directly to the model, the bridge narrows what agents can see and use through scene-aware, namespace-aware, and enablement-aware capability trimming.

It is designed around a simple pipeline:

`Business page -> Page Context Bridge -> MCP -> Agent`

## Goals

Page Context Bridge exists to:

- Let pages expose structured capabilities through `window.__pageContextBridge__`
- Compile page capabilities into standard MCP tools, resources, and prompts
- Trim capability exposure by scene, namespace, and enablement state
- Give agents a narrower, safer, and more semantic operating surface
- Support native page bridges first, injected adapters second, and builtin debug tools last

## Core Capabilities

### 1. Capability Declaration

Pages can declare:

- Scene
- Manifest
- Tools
- Resources
- Skills

### 2. Capability Compilation

The bridge compiles:

- Page tools -> MCP tools
- Page resources -> MCP resources
- Page skills -> MCP prompts

### 3. Capability Trimming

The bridge reduces agent-visible surface area through:

- Scene-aware filtering
- Namespace-aware filtering
- Tool visibility and enablement filtering

### 4. Bridge Runtime

The runtime includes:

- A browser extension runtime for discovery and execution
- A local MCP bridge server for stdio/SSE transport
- Builtin browser diagnostics and debugging tools

## Non-Goals / Guardrails

Page Context Bridge is not trying to become:

- A generic browser automation framework
- A site-specific plugin repository
- A grab bag of arbitrary injected page scripts
- A system that exposes every available capability to agents by default

## How It Works

Page Context Bridge turns page-declared capabilities into MCP-compatible objects that agentic clients can discover and call.

```
Page (window.__pageContextBridge__)
  -> Content Script (builtin tools + page tool discovery)
  -> Service Worker (background.ts, WebSocket bridge)
  -> MCP Bridge Server (Node.js, SSE/stdio transport)
  -> MCP Client (Claude Desktop, OpenCode, etc.)
```

Core constraints:

- Extension does not directly import business code
- Extension does not hardcode business namespaces
- Extension only depends on the `window.__pageContextBridge__` protocol
- Page capabilities are compiled into standard MCP objects (tools / resources / prompts)
- Namespace-based filtering reduces the capability surface exposed to agents

## User Stories

### 1. Automated Root Cause Analysis
> As a Technical Support Engineer, I want to invoke a specialized "Diagnosis Agent" that automatically checks hidden configuration rules, so that I can identify why a complex form is invalid in seconds instead of checking multiple dashboards.

### 2. Natural Language Interface for Complex Software
> As a SaaS Product Manager, I want to expose my application's internal API as debug tools, so that my users can perform complex bulk operations via natural language.

### 3. Deep State Inspection
> As a Frontend Developer, I want to ask the agent "Which observable caused this unexpected re-render?", so that the agent can traverse the state tree and pinpoint the exact data change.

## Repository Layout

```
packages/
├── shared-protocol/          # Shared JSON-RPC 2.0 protocol and type definitions
│   └── src/
│       └── index.ts          # RpcPeer, message types, PageContextManifest types
├── page-context-bridge-server/ # Node.js MCP bridge server (SSE/stdio transport)
│   └── src/
│       ├── index.ts          # WebSocket + MCP server, builtin tools, routing
│       ├── schema.ts         # JSON Schema → Zod converter
│       └── page-tool-routing.ts
├── page-context-extension/     # Page Context Extension (Manifest V3)
│   └── src/
│       ├── background.ts              # Service worker: WebSocket, tool discovery, routing
│       ├── content-script.ts          # Content script entry point
│       ├── side-panel-app.ts          # Side panel UI
│       ├── popup-main.ts              # Popup UI (connection status)
│       ├── runtime-rpc.ts             # Chrome runtime JSON-RPC adapter
│       ├── page-tool-registry.ts      # Page tool normalization
│       ├── page-tool-visibility.ts    # Tool preference hierarchy
│       ├── context-manifest-diff.ts   # Manifest diff computation
│       ├── context-manifest-filter-debug.ts  # Filter reason tracking
│       └── builtin-tool-filtering.ts  # Builtin tool filter
├── page-context-example/       # Demo page that exposes full page-context protocol
│   └── src/
│       ├── example-page-core.ts       # Demo bridge core with tools/resources/skills
│       └── example-page-main.ts       # Demo page bootstrap entry
└── page-context-userscripts/   # Standalone userscript adapters with shared hub registry
    └── src/
        ├── hub.ts                     # Shared registry/hub, merges multiple adapters into one bridge
        ├── adapters/                  # React/Apollo/TanStack/Jotai/ReduxDevtools adapters
        └── entries/                   # Userscript entry files, each builds one .user.js artifact
```

## Architecture

### Communication Flow

```
┌─────────────────┐    HTTP/SSE/stdio    ┌──────────────────┐    WebSocket     ┌─────────────────┐
│   MCP Client    │ ◄──────────────────► │  MCP Bridge      │ ◄──────────────► │  Extension SW   │
│ (Claude, etc.)  │                      │  Server (Node)   │                  │ (background.ts) │
└─────────────────┘                      └──────────────────┘                  └────────┬────────┘
                                                                                       │
                                                                               chrome.scripting
                                                                                       │
                                                                              ┌────────▼────────┐
                                                                              │  Content Script  │
                                                                              │  + Page Context  │
                                                                              │  (__pageContext  │
                                                                              │   Bridge__)      │
                                                                              └─────────────────┘
```

### Builtin Tools

The extension also provides builtin diagnostics and browser interaction tools that complement page-declared capabilities:

| Tool | Description |
|------|-------------|
| `list_tabs` | List open browser tabs |
| `get_page_info` | Get page title, URL, and metadata |
| `get_selected_text` | Get currently selected text |
| `click_element` | Click an element by CSS selector |
| `get_element_text` | Get text content of an element |
| `get_element_html` | Get HTML of an element |
| `query_elements` | Query elements by CSS selector |
| `fill_input` | Fill an input field (triggers React/Vue change detection) |
| `execute_js` | Execute JavaScript in page context |
| `screenshot_tab` | Capture a tab screenshot |
| `get_console_logs` | Get captured console output |
| `navigate` | Navigate to a URL |

### Page Context Protocol

Pages can expose custom tools, resources, and skills via `window.__pageContextBridge__`:

- **Tools** → compiled as MCP `tools` (e.g., `tab.42.catalog.primary.getItems`)
- **Resources** → compiled as MCP `resources` (e.g., `tab.42.resource.catalog.items`)
- **Skills** → compiled as MCP `prompts` (e.g., `tab.42.skill.catalog.manage-items`)

See [Page Context Bridge Integration Guide](./docs/page-context-bridge-all-in-one-guidance.md) for the full specification.

## Getting Started

### Prerequisites

- Node.js >= 18
- pnpm >= 8

### Install

```bash
pnpm install
```

### Build

```bash
pnpm build
```

Build userscript bundle only:

```bash
pnpm userscripts:build
```

### Type Check

```bash
pnpm typecheck
```

Typecheck userscripts only:

```bash
pnpm userscripts:typecheck
```

### Test

```bash
pnpm test
```

Run userscript tests only:

```bash
pnpm userscripts:test
```

### Development

Start the MCP bridge server in dev mode:

```bash
pnpm mcp:dev
```

Start the extension dev preview (Playwright-based):

```bash
pnpm dev
```

## Quick Start (For AI Integration)

**Goal**: Let LLM quickly produce business-domain abstractions and source bridge implementations under the current **Host merge** architecture.

Use the single canonical guide:

1. [Page Context Bridge Integration Guide](./docs/page-context-bridge-all-in-one-guidance.md)

**Copy this prompt to any LLM:**

```text
Read ./docs/page-context-bridge-all-in-one-guidance.md.
Then implement page integration for the current business project as a source bridge registered to window.__pageContextBridgeHost__.

Requirements:
1. Namespace design must follow business domains (not misc/common/utils).
2. tools/resources/skills must all be present and task-oriented.
3. Support multi-instance routing in namespace.
4. Do NOT directly overwrite window.__pageContextBridge__; registerSource to host and handle host-ready late binding.
5. Output ready-to-paste TypeScript code and a concrete getManifest() example.
```

## Load Extension in Chrome

1. Run `pnpm build`
2. Open `chrome://extensions`
3. Enable **Developer mode** in the top right
4. Click **Load unpacked**
5. Select the `packages/page-context-extension/dist/` directory

After loading, the extension will:
- Inject the content script into all pages
- Start the service worker (background.ts)
- Provide a popup for connection status
- Provide a side panel for tool/context management

## Configure MCP Client

### Using npx (Recommended)

The simplest way to use Page Context Bridge is via npx:

```bash
npx @page-context/mcp-bridge
```

For OpenCode, add to `~/.config/opencode/mcp.json`:

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

For Claude Desktop, add to `claude_desktop_config.json`:

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

### CLI Commands

```bash
# Run in stdio mode (default, for MCP clients)
npx @page-context/mcp-bridge

# Run in SSE mode
npx @page-context/mcp-bridge sse 22334

# Show configuration examples
npx @page-context/mcp-bridge config

# Show help
npx @page-context/mcp-bridge --help
```

### SSE Transport

For SSE transport, start the server first:

```bash
npx @page-context/mcp-bridge sse 22334
```

Then configure your MCP client:

```json
{
  "mcpServers": {
    "page-context-bridge": {
      "url": "http://127.0.0.1:22334/sse"
    }
  }
}
```

### stdio Transport (Local Development)

For local development with stdio transport:

```json
{
  "mcpServers": {
    "page-context-bridge": {
      "command": "node",
      "args": ["/path/to/packages/page-context-bridge-server/dist/index.js"]
    }
  }
}
```

## Page Integration

Pages expose capabilities via `window.__pageContextBridge__`:

```ts
// Minimal page integration
window.__pageContextBridge__ = {
  version: "0.1.0",
  listNamespaces() { return ["catalog"] },
  getNamespace(ns) { /* return namespace object */ },
  getScene() { return "catalog-list" },
  listResources() { /* return resource descriptors */ },
  readResource(id) { /* return resource payload */ },
  listSkills() { /* return skill descriptors */ },
  getSkill(id, input?) { /* return skill prompt */ },
  getManifest() { /* return full manifest */ },
}
```

See the [Integration Guide](./docs/page-context-bridge-all-in-one-guidance.md) for the complete specification and [example-page-core.ts](./packages/page-context-extension/src/example-page-core.ts) for a full implementation.

## Security Considerations

> **Warning**: The `execute_js` builtin tool executes arbitrary JavaScript in the page context. This is by design to allow deep page inspection, but represents a significant attack surface. Use with caution in production environments.

Key security properties:
- The MCP bridge server runs locally and has no authentication — it relies on local network isolation
- CORS is set to `*` on the static asset server — intended for local development only
- Page tool discovery uses Chrome's scripting API with proper isolation boundaries
- The side panel uses HTML escaping for all user-generated content (XSS protection)

## Current Status

Implemented:
- Monorepo build system (pnpm workspaces + TypeScript + Vite + Vitest)
- MCP bridge server with SSE and stdio transport
- Chrome extension (MV3) with service worker, content script, side panel, and popup
- 12 builtin browser automation tools
- Page context protocol (tools, resources, skills)
- Namespace-based tool visibility and filtering
- JSON-RPC 2.0 shared protocol library
- Side panel UI with tool tree, context manifest, and resource/skill inspector
- Tool test panel for manual RPC invocation
- Example page with 5 namespaces and self-test suite
- 29 unit tests across all packages

Not yet completed:
- E2E tests
- CI/CD pipeline
- RPC parameter runtime validation (currently uses type assertions)

## Documentation

- [Architecture: Browser Extension ↔ MCP Bridge](./docs/architecture/browser-extension-mcp-bridge.md)
- [Page Context Bridge Integration Guide](./docs/page-context-bridge-all-in-one-guidance.md)
- [Capability Pipeline Design](./docs/page-context-capability-pipeline.md)
- [Userscript Adapter Package](./packages/page-context-userscripts/README.md)

Userscript build artifacts:
- `packages/page-context-userscripts/dist/react-inspector.user.js`
- `packages/page-context-userscripts/dist/apollo-client.user.js`
- `packages/page-context-userscripts/dist/tanstack-query.user.js`
- `packages/page-context-userscripts/dist/jotai-devtools.user.js`
- `packages/page-context-userscripts/dist/redux-devtools.user.js`

## License

MIT
