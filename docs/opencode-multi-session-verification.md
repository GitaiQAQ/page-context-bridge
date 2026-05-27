# OpenCode Multi-Session Verification

验证日期：`2026-05-25`

## 自动验收

### `pnpm -w lint`

结果：通过

- 只有仓库既有 warning
- 无新增 error

### `pnpm -w typecheck`

结果：仍只剩既有 4 个错误，无新增错误

- `packages/page-context-extension/src/bg-main-world-bridge-host.ts:239`
- `packages/page-context-extension/src/bg-main-world-bridge-host.ts:251`
- `packages/page-context-extension/src/content-script.ts:331`
- `packages/page-context-extension/src/content-script.ts:569`

### `pnpm -w test`

结果：通过

- `62` test files passed
- `697` tests passed

### `BRIDGE_PORT=22334 OPENCODE_PORT=4096 BRIDGE_DEBUG_ENDPOINTS=1 node packages/page-context-bridge-server/scripts/opencode-integration-e2e.mjs`

结果：通过

关键输出：

```text
[E2E] created session: {"sessionId":"ses_1a0a5bdefffe6aSFj8OqsPWDki"}
[E2E] opencode reports bridge mcp connected: {"status":"connected"}
[E2E] discovered page-context tools: ["builtin.page.get_page_info", ...]
[E2E] bridge sees tenant: {"id":"ses_1a0a5bdefffe6aSFj8OqsPWDki", ...}
[E2E] ALL OK
```

说明：

- 该脚本要求 `__debug/tenants` 可见，因此 bridge 进程实际以 `tsx src/index.ts` + `BRIDGE_DEBUG_ENDPOINTS=1` 运行
- 这不影响产品协议，只是为了打开调试端点配合验收脚本

## 真实 Chromium / CFT

使用浏览器：

- `~/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`

扩展 ID：

- `kfhlecabejhliinlfgahgcbechikcgpe`

### Story 1: Connect

结果：通过

证据：

- session: `ses_1a0a1dc98ffegxeg8PEuSZJrli`
- scoped ws:
  - `ws://127.0.0.1:22335/?tenantId=ses_1a0a1dc98ffegxeg8PEuSZJrli`
- iframe:
  - `http://127.0.0.1:4096/L1VzZXJzL2J5dGVkYW5jZS93b3Jrc3BhY2Uvc2lkZXMvYnJvd3Nlci1kZWJ1Zy1leHRlbnNpb24/session/ses_1a0a1dc98ffegxeg8PEuSZJrli`
- `POST /mcp` 次数：`2`
- screenshot:
  - `/tmp/opencode-sidepanel-e2e-story1-connect.png`

### Story 2: iframe 内真实 LLM 调 `page.get_page_info`

结果：通过

执行模型：

- `deepseek:deepseek-v4-pro`

证据：

- session: `ses_1a09f1cd6ffeBEDi3zElPXXdtB`
- `matchedJson`:
  - `{"title":"Example Domain","url":"https://example.com/"}`
- iframe 文本尾部可见：

```text
调用了 `page-context-ses_1a09f1cd6ffeBEDi3zElPXXdtB_builtin_get_page_info`
tabId=1427775537
{"title":"Example Domain","url":"https://example.com/"}
```

- screenshot:
  - `/tmp/opencode-story2-llm.png`

### Story 3: New Session 并存，不重连旧 ws

结果：通过

证据：

- session A: `ses_1a0a1dc98ffegxeg8PEuSZJrli`
  - bridgeSessionId: `1779716465518-ga6nhsma`
- session B: `ses_1a0a1dbf2ffe8xeQRZEMKfJBKw`
  - bridgeSessionId: `1779716465684-yy1twrw9`
- 切换前后 `bridgeSessionId` 不变，说明不是切换时重连
- screenshot:
  - `/tmp/opencode-sidepanel-e2e-story3-two-sessions.png`

### Story 4: close sidepanel -> reopen，alive lastSessionId restore

结果：通过

证据：

- `lastSessionId`:
  - `ses_1a0a1dbf2ffe8xeQRZEMKfJBKw`
- `storage.local['opencode.config.v1'].lastSessionId` 仍为该值
- reopen 后 `mcpPostCountAfterReopen = 0`
  - 证明未再次 `POST /mcp`
- scoped ws 仍为 connected
- screenshot:
  - `/tmp/opencode-sidepanel-e2e-story4-restore.png`

### Story 5: stale lastSessionId 被 opencode 删除后清理恢复态

结果：通过

证据：

- 先删除 `ses_1a0a1dbf2ffe8xeQRZEMKfJBKw`
- reopen 后：
  - UI 文案：`Last session no longer exists. Cleared saved state.`
  - `storage = {}`
  - 不再渲染 stale iframe
  - background `scopedSessions` 不再包含 stale session
- 仍保留活着的另一条 session：
  - `ses_1a0a1dc98ffegxeg8PEuSZJrli`
- screenshot:
  - `/tmp/opencode-sidepanel-e2e-story5-stale.png`

## 验收结论

Done 项全部覆盖：

- Connect 自动创建 / 复用 session、建 scoped ws、`POST /mcp` connected、渲染 iframe
- iframe 内真实模型成功调用 `builtin.page.get_page_info`
- `New Session` 可并存两条 session，各自 ws + iframe 独立存在
- sidepanel reopen 可 restore alive session，不重复注册 MCP
- stale `lastSessionId` 会清 storage / UI / background stale ws

非 Done 约束保持成立：

- 未新增 bridge endpoint
- 未改变 `tenantId` 协议来源
- 未添加 idle 回收特殊逻辑
