# @page-context/userscripts

`@page-context/userscripts` 提供可独立发布的 userscript 适配层，把页面状态暴露成 `window.__pageContextBridge__` 协议，供 Page Context Bridge extension 直接发现。

## 设计要点

- 每个 userscript 只负责一个 adapter（React/Apollo/TanStack Query/Jotai/Redux DevTools）。
- 多个 userscript 可同时注入，都会注册到共享 hub（`window.__pageContextUserscriptHub__`）。
- hub 只在没有页面自带 bridge 时挂载 `window.__pageContextBridge__` / `window.__pageContextTools__`，避免破坏站点原逻辑。

## 构建产物

- `dist/react-inspector.user.js`
- `dist/apollo-client.user.js`
- `dist/tanstack-query.user.js`
- `dist/jotai-devtools.user.js`
- `dist/redux-devtools.user.js`

其中 `redux-devtools.user.js` 以 `@run-at document-start` 构建，用于尽早拦截 `window.__REDUX_DEVTOOLS_EXTENSION__`。

常用命令：

```bash
pnpm --filter @page-context/userscripts build
pnpm --filter @page-context/userscripts typecheck
pnpm --filter @page-context/userscripts test
```
