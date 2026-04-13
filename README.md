# Page Context Bridge

[中文](#中文)

`Page Context Bridge` is a universal Chrome extension host that integrates page-exposed debugging tools into browser-side LLM agents via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

Its goal is not to create business-specific plugins, but to provide an open-source set of universal capabilities:

- Discover debug namespaces / instances / tools on the page
- Bridge page context to standard MCP tools, resources, and prompts
- Manage sessions / contexts and tool visibility
- Call page tools from any MCP-compatible client
- Execute JS analysis code under restricted capabilities

## How It Works

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
├── chrome-mcp-bridge-server/ # Node.js MCP bridge server (SSE/stdio transport)
│   └── src/
│       ├── index.ts          # WebSocket + MCP server, builtin tools, routing
│       ├── schema.ts         # JSON Schema → Zod converter
│       └── page-tool-routing.ts
└── chrome-mcp-extension/     # Chrome Extension (Manifest V3)
    └── src/
        ├── background.ts              # Service worker: WebSocket, tool discovery, routing
        ├── content-script-core.ts     # Builtin tool implementations
        ├── content-script.ts          # Content script entry point
        ├── sidepanel-main.ts          # Side panel UI (tool tree, context, browser)
        ├── popup-main.ts              # Popup UI (connection status)
        ├── runtime-rpc.ts             # Chrome runtime JSON-RPC adapter
        ├── page-tool-registry.ts      # Page tool normalization
        ├── page-tool-visibility.ts    # Tool preference hierarchy
        ├── context-manifest-diff.ts   # Manifest diff computation
        ├── context-manifest-filter-debug.ts  # Filter reason tracking
        ├── builtin-tool-filtering.ts  # Builtin tool filter
        ├── example-page-core.ts       # Demo page with namespaces/resources/skills
        └── example-page-main.ts       # Demo page entry point
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

The extension provides 12 built-in browser automation tools:

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

### Type Check

```bash
pnpm typecheck
```

### Test

```bash
pnpm test
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

## Load Extension in Chrome

1. Run `pnpm build`
2. Open `chrome://extensions`
3. Enable **Developer mode** in the top right
4. Click **Load unpacked**
5. Select the `packages/chrome-mcp-extension/dist/` directory

After loading, the extension will:
- Inject the content script into all pages
- Start the service worker (background.ts)
- Provide a popup for connection status
- Provide a side panel for tool/context management

## Configure MCP Client

### SSE Transport

Add to your MCP client configuration (e.g., Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "page-context-bridge": {
      "url": "http://127.0.0.1:9001/sse"
    }
  }
}
```

Then start the bridge server:

```bash
pnpm mcp
```

### stdio Transport

For CLI-based MCP clients:

```json
{
  "mcpServers": {
    "page-context-bridge": {
      "command": "node",
      "args": ["/path/to/packages/chrome-mcp-bridge-server/dist/index.js"]
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

See the [Integration Guide](./docs/page-context-bridge-all-in-one-guidance.md) for the complete specification and [example-page-core.ts](./packages/chrome-mcp-extension/src/example-page-core.ts) for a full implementation.

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

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

## License

MIT

---

# 中文

`Page Context Bridge` 是一个通用的 Chrome 扩展宿主，通过 [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) 将页面暴露的调试工具接入浏览器侧 LLM Agent。

它的目标不是做某个业务专属插件，而是提供一套可开源的通用能力：

- 发现页面上的 debug namespaces / instances / tools
- 将页面上下文桥接为标准 MCP tools / resources / prompts
- 管理 session / context 与工具可见性
- 从任何 MCP 兼容客户端调用页面工具
- 在受限能力下执行 JS 分析代码

## 工作原理

```
页面 (window.__pageContextBridge__)
  -> Content Script (内置工具 + 页面工具发现)
  -> Service Worker (background.ts, WebSocket 桥接)
  -> MCP Bridge Server (Node.js, SSE/stdio 传输)
  -> MCP 客户端 (Claude Desktop, OpenCode 等)
```

核心约束：

- 扩展不直接 import 业务代码
- 扩展不硬编码业务 namespace
- 扩展只依赖 `window.__pageContextBridge__` 协议
- 页面能力被编译为标准 MCP 对象 (tools / resources / prompts)
- 基于 namespace 的过滤减少暴露给 agent 的能力规模

## 用户故事

### 1. 自动化根因分析
> 作为技术支持工程师，我希望调用专门的"诊断 Agent"自动检查隐藏配置规则，以便在几秒内定位问题，而不是查看多个仪表盘。

### 2. 复杂软件的自然语言接口
> 作为 SaaS 产品经理，我希望将应用内部 API 暴露为调试工具，以便用户通过自然语言执行复杂的批量操作。

### 3. 深度状态巡检
> 作为前端开发者，我希望询问 Agent "是哪个 observable 导致了意外重渲染？"，以便 Agent 可以遍历状态树并精准定位数据变化。

## 项目结构

```
packages/
├── shared-protocol/          # 共享 JSON-RPC 2.0 协议和类型定义
│   └── src/
│       └── index.ts          # RpcPeer、消息类型、PageContextManifest 类型
├── chrome-mcp-bridge-server/ # Node.js MCP 桥接服务器 (SSE/stdio 传输)
│   └── src/
│       ├── index.ts          # WebSocket + MCP 服务器、内置工具、路由
│       ├── schema.ts         # JSON Schema → Zod 转换器
│       └── page-tool-routing.ts
└── chrome-mcp-extension/     # Chrome 扩展 (Manifest V3)
    └── src/
        ├── background.ts              # Service Worker: WebSocket、工具发现、路由
        ├── content-script-core.ts     # 内置工具实现
        ├── content-script.ts          # Content script 入口
        ├── sidepanel-main.ts          # Side panel UI（工具树、上下文、浏览器）
        ├── popup-main.ts              # Popup UI（连接状态）
        ├── runtime-rpc.ts             # Chrome runtime JSON-RPC 适配器
        ├── page-tool-registry.ts      # 页面工具标准化
        ├── page-tool-visibility.ts    # 工具偏好层级
        ├── context-manifest-diff.ts   # Manifest 差异计算
        ├── context-manifest-filter-debug.ts  # 过滤原因追踪
        ├── builtin-tool-filtering.ts  # 内置工具过滤
        ├── example-page-core.ts       # 示例页面（含 namespace/resource/skill）
        └── example-page-main.ts       # 示例页面入口
```

## 快速开始

### 前置条件

- Node.js >= 18
- pnpm >= 8

### 安装

```bash
pnpm install
```

### 构建

```bash
pnpm build
```

### 类型检查

```bash
pnpm typecheck
```

### 测试

```bash
pnpm test
```

### 开发

以开发模式启动 MCP 桥接服务器：

```bash
pnpm mcp:dev
```

启动扩展开发预览（基于 Playwright）：

```bash
pnpm dev
```

## 在 Chrome 中加载扩展

1. 运行 `pnpm build`
2. 打开 `chrome://extensions`
3. 打开右上角 **开发者模式**
4. 点击 **加载已解压的扩展程序**
5. 选择 `packages/chrome-mcp-extension/dist/` 目录

加载后，扩展会：
- 向所有页面注入 content script
- 启动 service worker (background.ts)
- 提供 popup 用于查看连接状态
- 提供 side panel 用于管理工具/上下文

## 配置 MCP 客户端

### SSE 传输

添加到 MCP 客户端配置（如 Claude Desktop 的 `claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "page-context-bridge": {
      "url": "http://127.0.0.1:9001/sse"
    }
  }
}
```

然后启动桥接服务器：

```bash
pnpm mcp
```

### stdio 传输

适用于基于 CLI 的 MCP 客户端：

```json
{
  "mcpServers": {
    "page-context-bridge": {
      "command": "node",
      "args": ["/path/to/packages/chrome-mcp-bridge-server/dist/index.js"]
    }
  }
}
```

## 页面接入

页面通过 `window.__pageContextBridge__` 暴露能力：

```ts
// 最小页面接入
window.__pageContextBridge__ = {
  version: "0.1.0",
  listNamespaces() { return ["catalog"] },
  getNamespace(ns) { /* 返回 namespace 对象 */ },
  getScene() { return "catalog-list" },
  listResources() { /* 返回资源描述 */ },
  readResource(id) { /* 返回资源内容 */ },
  listSkills() { /* 返回技能描述 */ },
  getSkill(id, input?) { /* 返回技能 prompt */ },
  getManifest() { /* 返回完整 manifest */ },
}
```

完整规范请参考[接入文档](./docs/page-context-bridge-all-in-one-guidance.md)，完整实现请参考 [example-page-core.ts](./packages/chrome-mcp-extension/src/example-page-core.ts)。

## 安全说明

> **警告**：`execute_js` 内置工具会在页面上下文中执行任意 JavaScript。这是为了允许深度页面检查，但也意味着显著的攻击面，在生产环境中请谨慎使用。

关键安全属性：
- MCP 桥接服务器在本地运行，无身份验证——依赖本地网络隔离
- 静态资源服务器的 CORS 设为 `*`——仅用于本地开发
- 页面工具发现使用 Chrome scripting API，有正确的隔离边界
- Side panel 对所有用户生成内容使用 HTML 转义（XSS 防护）

## 当前状态

已完成：
- Monorepo 构建系统（pnpm workspaces + TypeScript + Vite + Vitest）
- MCP 桥接服务器（SSE 和 stdio 传输）
- Chrome 扩展（MV3）含 service worker、content script、side panel 和 popup
- 12 个内置浏览器自动化工具
- 页面上下文协议（tools、resources、skills）
- 基于 namespace 的工具可见性和过滤
- JSON-RPC 2.0 共享协议库
- Side panel UI（工具树、上下文 manifest、资源/技能检查器）
- 工具测试面板（手动 RPC 调用）
- 示例页面（5 个 namespace + 自测套件）
- 29 个单元测试

尚未完成：
- E2E 测试
- CI/CD 流水线
- RPC 参数运行时验证（当前使用类型断言）

## 文档

- [架构：浏览器扩展 ↔ MCP Bridge](./docs/architecture/browser-extension-mcp-bridge.md)
- [Page Context Bridge 接入文档](./docs/page-context-bridge-all-in-one-guidance.md)
- [能力流水线设计](./docs/page-context-capability-pipeline.md)

## 贡献

开发指南请参考 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

MIT
