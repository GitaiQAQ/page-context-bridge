# Browser Extension ↔ MCP Bridge 架构设计

> 浏览器调试扩展与本地 MCP (Model Context Protocol) 服务的桥接架构设计——涵盖通信链路、节点职责拆分、协议细节及后续分离计划。

## 1. 概述

### 1.1 设计目标

实现浏览器扩展与本地 MCP 服务器的双向通信，使外部 MCP 客户端（如 OpenCode、Claude Desktop）能够访问浏览器页面调试工具。

### 1.2 核心特性

- **自动发现与连接**：扩展启动时自动连接本地 MCP 服务器
- **双向通信**：基于 SSE (Server-Sent Events) 实现服务器推送
- **协议兼容**：完整支持 MCP JSON-RPC 2.0 协议
- **断线重连**：具备心跳检测和自动重连机制

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────────┐     HTTP/SSE      ┌──────────────────┐     chrome.runtime     ┌─────────────────┐
│   MCP Client    │ ◄───────────────► │   MCP Server     │ ◄───────────────────► │  Extension SW   │
│  (OpenCode等)   │                   │  (Node.js HTTP)  │                      │ (Service Worker)│
└─────────────────┘                   └──────────────────┘                      └────────┬────────┘
        │                                                                             │
        │                           ┌──────────────────────┐                          │
        └──────────────────────────►│   Page Debug Tools   │◄─────────────────────────┘
                                    │ (window.__pageDebugTools__)
                                    └──────────────────────┘
```

### 2.2 组件职责

| 组件 | 文件路径 | 职责 |
|------|----------|------|
| MCP Server | `src/companion/mcp-server.ts` | Node.js HTTP 服务器，处理 MCP 协议，管理 SSE 连接 |
| MCP Client | `src/service-worker/mcp-server-client.ts` | 扩展端客户端，维护 SSE 连接，处理中继请求 |
| Message Handler | `src/service-worker/companion-message-handler.ts` | 处理来自 MCP 服务器的消息路由 |
| Launcher | `scripts/mcp-server.mjs` | MCP 服务器启动脚本 |

## 3. 通信协议

### 3.1 传输层

采用 HTTP + SSE 双通道设计：

- **HTTP POST**：客户端向服务器发送请求
- **SSE (Server-Sent Events)**：服务器向客户端推送响应和通知

### 3.2 连接建立流程

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

### 3.3 MCP JSON-RPC 消息格式

**请求示例：**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

**响应示例：**
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

### 3.4 中继请求类型

| 类型 | 描述 | 流向 |
|------|------|------|
| `browser-mcp.list-tools` | 获取页面调试工具列表 | Server → Extension |
| `browser-mcp.call-tool` | 调用指定调试工具 | Server → Extension |
| `browser-mcp/status` | 获取连接状态 | Server → Extension |

## 4. API 端点

### 4.1 HTTP 端点

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/health` | 健康检查，返回服务器状态和扩展注册状态 |
| GET | `/mcp?sessionId=<id>` | SSE 连接端点 |
| POST | `/register` | 扩展注册端点 |
| POST | `/mcp?sessionId=<id>` | MCP JSON-RPC 请求端点 |

### 4.2 健康检查响应

```json
{
  "ok": true,
  "server": "browser-debug-mcp",
  "version": "0.0.1",
  "extensionRegistered": true,
  "extensionId": "extension-id",
  "pendingRequests": 0,
  "sseClients": 1
}
```

## 5. 扩展端实现

### 5.1 自动连接机制

扩展在以下时机自动尝试连接 MCP 服务器：

```typescript
// src/service-worker/index.ts
chrome.runtime.onInstalled.addListener(() => {
  void initMcpServerClient();
});

chrome.runtime.onStartup.addListener(() => {
  void initMcpServerClient();
});

// 服务 worker 重新加载时立即连接
void initMcpServerClient();
```

### 5.2 重连策略

- **初始重试**：注册失败后 5 秒重试
- **心跳检测**：每 30 秒检测一次连接状态
- **超时重连**：超过 60 秒未收到心跳则触发重连

### 5.3 配置

```typescript
// 默认配置
const DEFAULT_MCP_SERVER_URL = 'http://127.0.0.1:3333';
const REGISTRATION_RETRY_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
```

## 6. 使用方式

### 6.1 启动 MCP 服务器

```bash
node scripts/mcp-server.mjs [port]
# 默认端口 3333
```

### 6.2 测试连接

```bash
# 1. 健康检查
curl http://127.0.0.1:3333/health

# 2. 建立 SSE 连接
curl -N "http://127.0.0.1:3333/mcp?sessionId=test"

# 3. 发送 MCP 请求
curl -X POST "http://127.0.0.1:3333/mcp?sessionId=test" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 6.3 配置 MCP 客户端

以 OpenCode 为例：

```json
{
  "mcpServers": {
    "browser-debug": {
      "command": "node",
      "args": ["/path/to/scripts/mcp-server.mjs", "3333"]
    }
  }
}
```

## 7. 后续分离计划

### 7.1 可分离组件

1. **MCP Server** (`src/companion/mcp-server.ts`)
2. **Launcher** (`scripts/mcp-server.mjs`)
3. **Protocol Types** (部分 `src/shared/protocol.ts`)

### 7.2 分离后架构

```
browser-debug-mcp-server/          # 新的独立仓库
├── src/
│   ├── mcp-server.ts              # MCP 服务器核心
│   ├── types.ts                   # 协议类型定义
│   └── extension-client.ts        # 扩展客户端接口
├── scripts/
│   └── mcp-server.mjs             # 启动脚本
└── package.json

browser-debug-extension/           # 原项目
├── src/
│   └── service-worker/
│       ├── mcp-server-client.ts   # 客户端实现
│       └── companion-message-handler.ts
```

### 7.3 接口契约

分离后，MCP 服务器与扩展之间通过以下接口交互：

```typescript
// 扩展注册信息
interface ExtensionRegistration {
  extensionId: string;
  extensionVersion?: string;
  sessionId: string;
  registeredAt: string;
}

// 中继请求
interface RelayRequest {
  type: 'browser-mcp.list-tools' | 'browser-mcp.call-tool';
  requestId: string;
  payload?: Record<string, unknown>;
}

// 中继响应
interface RelayResponse {
  type: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
```

## 8. 注意事项

1. **CORS**：MCP 服务器默认允许所有来源 (`*`)，仅用于本地开发环境
2. **安全性**：当前版本无身份验证，依赖本地网络隔离
3. **单扩展限制**：当前仅支持单个扩展注册，后续可扩展为多扩展
4. **协议版本**：支持 MCP 协议版本 `2025-06-18` 和 `2025-03-26`

## 9. 相关文件

- `packages/chrome-mcp-bridge-server/src/index.ts` - MCP 服务器实现
- `packages/chrome-mcp-extension/src/background.ts` - 扩展端 service worker
- `packages/shared-protocol/src/index.ts` - 共享协议类型
