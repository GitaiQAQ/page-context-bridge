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

| Tool                | Description                                               |
| ------------------- | --------------------------------------------------------- |
| `list_tabs`         | List open browser tabs                                    |
| `get_page_info`     | Get page title, URL, and metadata                         |
| `get_selected_text` | Get currently selected text                               |
| `click_element`     | Click an element by CSS selector                          |
| `get_element_text`  | Get text content of an element                            |
| `get_element_html`  | Get HTML of an element                                    |
| `query_elements`    | Query elements by CSS selector                            |
| `fill_input`        | Fill an input field (triggers React/Vue change detection) |
| `execute_js`        | Execute JavaScript in page context                        |
| `screenshot_tab`    | Capture a tab screenshot                                  |
| `get_console_logs`  | Get captured console output                               |
| `navigate`          | Navigate to a URL                                         |

### Page Context Protocol

Pages can expose custom tools, resources, and skills via `window.__pageContextBridge__`:

- **Tools** → compiled as MCP `tools` (e.g., `tab.42.catalog.primary.getItems`)
- **Resources** → compiled as MCP `resources` (e.g., `tab.42.resource.catalog.items`)
- **Skills** → compiled as MCP `prompts` (e.g., `tab.42.skill.catalog.manage-items`)

See [Page Context Bridge Integration Guide](./docs/page-context-bridge-all-in-one-guidance.md) for the full specification.

## Quick Start

### 1. Prerequisites

- Node.js >= 18
- Browser: Chrome / Edge (Manifest V3 supported)

### 2. Install Browser Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** in the top right corner
3. Click **Load unpacked** and select the extension package directory (or install from the Web Store by searching "Page Context Bridge")
4. Confirm the extension icon appears in the browser toolbar

### 3. Start & Configure Backend Service

#### Port Overview

The Page Context Bridge ecosystem uses the following ports in a typical setup:

- **22334**: Bridge Server HTTP/SSE Port (used by MCP clients like OpenCode/Claude to connect to the Bridge)
- **22335**: Bridge Server WebSocket Port (used by the browser extension to connect to the Bridge)
- **22336**: Built-in Example Page / Side Panel Web UI Port (local dev server for `page-context-example` and side panel debugging)
- **22337**: Userscripts Local Server Port (for serving local Tampermonkey adapters during development)
- **22338**: Local OpenCode Web UI Port (used when running `opencode web --port=22338`)

#### Starting the Bridge Server (SSE Mode)

To run the service remotely or locally with SSE support, start the bridge server:

```bash
# Starts the server on default ports (HTTP/SSE: 22334, WebSocket: 22335)
npx @page-context/mcp-bridge sse 22334
```

#### Connecting the Extension

By default, the extension connects to local `ws://127.0.0.1:22335/default`. To connect to a remote service:

1. Click the Page Context Bridge icon in the browser toolbar
2. In the WebSocket URL input, enter:
   ```text
   ws://<your-remote-server-ip>:22335/{your_identifier}
   # Example: ws://remote-host:22335/user.name
   ```
3. Click **Save & Reconnect**
4. A green status light indicates a successful connection
5. Open the browser side panel

### 4. Verify Installation

1. Click the extension icon and verify the status is "Connected" with a green light
2. Open the test page: `https://unpkg.com/@page-context/example/dist/example.html`
3. On supported pages, you should see the page context information in the Side Panel. For unsupported pages, you can still use built-in injected tools.

### 5. (Optional) Install Framework Adapters via Userscripts

If you want to inject capabilities for standard frameworks (e.g., React, Redux, Apollo) into third-party sites without modifying their source code, you can install the standalone Tampermonkey/Violentmonkey userscripts.

1. Install a userscript manager like **Tampermonkey** or **Violentmonkey**.
2. Load the desired adapters into your script manager:
   - `packages/page-context-userscripts/dist/react-inspector.user.js`
   - `packages/page-context-userscripts/dist/redux-devtools.user.js`
   - `packages/page-context-userscripts/dist/apollo-client.user.js`
   - `packages/page-context-userscripts/dist/tanstack-query.user.js`
   - `packages/page-context-userscripts/dist/jotai-devtools.user.js`
3. When you visit a site matching the `@match` rules of the script (or if you manually configure the match rules), the adapter will dynamically build the `__pageContextBridge__` API from the page's React/Redux instances.

### 6. Usage (with OpenCode)

1. Configure OpenCode by editing `~/.config/opencode/opencode.jsonc`:
   ```json
   {
     "mcp": {
       "page-context": {
         "type": "remote",
         "url": "http://<your-remote-server-ip>:22334/{your_identifier}/sse"
       }
     },
     "autoupdate": true
   }
   ```
2. Start local OpenCode:
   ```bash
   opencode web --port=22338
   ```
3. Select your project and start chatting.

### 7. FAQ

- **"No application knows how to open URL opencode://..."**
  Run `npx @page-context/opencode-handler install` to register the protocol handler.
- **Extension status indicator is red**
  Check if the Bridge Server is running and ensure the WebSocket address is correct.
- **Terminal does not pop up**
  Check your terminal preferences (iTerm/Warp needs permission to allow AppleScript control).

### 7. AI Integration Guide (For LLMs)

**Goal**: Let LLM quickly produce business-domain abstractions and source bridge implementations under the current **Host merge** architecture.

Use the single canonical guide:

1. [Page Context Bridge Integration Guide](./docs/page-context-bridge-all-in-one-guidance.md)

**Copy this prompt to any LLM:**

```text
Read the canonical integration guide from:
https://raw.githubusercontent.com/GitaiQAQ/page-context-bridge/main/docs/page-context-bridge-all-in-one-guidance.md

Then implement page integration for my business project.
Business context / Page description: {Describe your page, features, and the API/states you want to expose}

Requirements:
1. Namespace design must follow business domains (not misc/common/utils).
2. tools/resources/skills must all be present and task-oriented.
3. Support multi-instance routing in namespace.
4. Do NOT directly overwrite window.__pageContextBridge__; registerSource to host and handle host-ready late binding.
5. Output ready-to-paste TypeScript code and a concrete getManifest() example.
```

### 9. Uninstall

```bash
npx @page-context/opencode-handler uninstall
```

Then remove the Page Context Bridge extension from `chrome://extensions/`.

## Development

### Prerequisites

- macOS (Sonoma and above)
- Node.js >= 18
- pnpm >= 8
- Browser: Chrome / Edge (Manifest V3 supported)

### Install & Build

```bash
pnpm install
pnpm build
```

Build userscript bundle only:

```bash
pnpm userscripts:build
```

### Type Check & Test

```bash
pnpm typecheck
pnpm test
```

### Local Development

Start the MCP bridge server in dev mode:

```bash
pnpm mcp:dev
```

Start the extension dev preview (Playwright-based):

```bash
pnpm dev
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

## Page Integration

Pages expose capabilities via `window.__pageContextBridge__`:

```ts
// Minimal page integration
window.__pageContextBridge__ = {
  version: '0.1.0',
  listNamespaces() {
    return ['catalog'];
  },
  getNamespace(ns) {
    /* return namespace object */
  },
  getScene() {
    return 'catalog-list';
  },
  listResources() {
    /* return resource descriptors */
  },
  readResource(id) {
    /* return resource payload */
  },
  listSkills() {
    /* return skill descriptors */
  },
  getSkill(id, input?) {
    /* return skill prompt */
  },
  getManifest() {
    /* return full manifest */
  },
};
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

- [Documentation Index](./docs/README.md)
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
