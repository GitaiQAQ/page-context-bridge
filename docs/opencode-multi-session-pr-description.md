# OpenCode Multi-Session Sandbox Into Extension

## 背景

目标是把 `tenantId === opencode sessionId` 这一条既有契约真实打通到浏览器扩展端到端链路里，覆盖：

- sidepanel `Connect`
- sidepanel `New Session`
- 多 session 并存切换
- sidepanel reopen restore
- stale last session cleanup

约束保持不变：

- 不给 bridge 加新 endpoint
- 不改 `tenantId` 的协议来源
  - extension ws 继续走 `ws://.../?tenantId=<sessionId>`
  - MCP HTTP 继续走 `/{tenantId}/mcp`
- 不为了 idle 回收引入额外补丁逻辑

## 方案选择

选择 **B：多条 ws，每条对应一个 opencode sessionId**。

不选 A（单 ws + 应用层多路复用）的理由：

1. A 会把 tenant 识别从 URL query 挪到 RPC payload，直接破坏现有 `tenantId in URL` 契约。
2. bridge 现有多租户路由已经按 `?tenantId=` / `/{tenantId}/...` 成型，B 可以直接复用，不需要再发明第二套分发协议。
3. 用户要求 `tenantId === sessionId` 一一对应。B 的数据模型天然满足这个约束，调试和排障时也更直观。
4. sidepanel 需要“两个 session 切换不重连”。B 只要 background 维护 `sessionId -> ws` map 即可做到，职责边界清晰。

## 关键实现

### 1. background 引入 scoped ws manager

- 新增 `packages/page-context-extension/src/bg-scoped-ws-connection.ts`
- 一条 `sessionId` 对应一条独立 ws
- 管理 connect / disconnect / status / heartbeat / reconnect
- 不改动 default tenant 旧链路，避免把历史能力一起打坏

### 2. runtime / ws handlers 支持 session 作用域

- `extensionReconnect({ sessionId, wsUrl })` 建立指定 session 的 scoped ws
- `extensionReconnect({ sessionId, disconnect: true })` 断开指定 session 的 scoped ws
- `extensionStatusGet({ sessionId? })` 返回 scoped session 状态

### 3. bridge tenant 提取对齐双协议

- `packages/page-context-bridge-server/src/tenant-manager.ts`
- 优先 `?tenantId=...`
- 回退 path 第一段

这样同时兼容：

- extension ws: `/?tenantId=<sessionId>`
- HTTP MCP: `/<sessionId>/mcp`

### 4. sidepanel OpenCode UI 改成多 session 真相源

- `packages/page-context-extension/src/side-panel-app.ts`
- `Connect`:
  - 创建 / 复用 opencode session
  - 建 scoped ws
  - 确认 bridge 回报 connected
  - 再注册 MCP
  - 渲染该 session 的 iframe
- `New Session`:
  - 新建第二个 session
  - 保留第一个 session 的 ws 与 iframe
- reopen restore:
  - 直接恢复 `lastSessionId`
  - 不重复 `POST /mcp`
- stale restore:
  - 若 opencode 已删除该 session
  - 清 storage / UI
  - 同时主动断掉 background 残留的 stale scoped ws

### 5. opencode iframe 路由修正

- `packages/page-context-extension/src/sidepanel-opencode.ts`
- iframe 不再使用错误的 `/?session=<id>`
- 改成 opencode web 真实路由：
  - `/{base64url(directory)}/session/{sessionId}`

## 新增验证脚本

- `packages/page-context-extension/scripts/opencode-sidepanel-e2e.mjs`
  - 真实 Chromium 验证 Story 1 / 3 / 4 / 5
- `packages/page-context-extension/scripts/opencode-story2-llm-e2e.mjs`
  - 真实 iframe 内 LLM 验证 Story 2

这两个脚本只做验证，不改变产品协议。
