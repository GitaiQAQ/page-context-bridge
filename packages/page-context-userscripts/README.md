# @page-context/userscripts

`@page-context/userscripts` provides standalone userscript adapters that expose page state through the `window.__pageContextBridge__` protocol for direct discovery by the Page Context Bridge extension.

## Design Notes

- Each userscript owns one adapter only: React, Apollo, TanStack Query, Jotai, or Redux DevTools.
- Multiple userscripts can be injected together and will all register into the shared hub at `window.__pageContextUserscriptHub__`.
- The hub only attaches `window.__pageContextBridge__` / `window.__pageContextTools__` when the page does not already provide its own bridge, which keeps the integration non-invasive.

## Build Outputs

- `dist/react-inspector.user.js`
- `dist/apollo-client.user.js`
- `dist/tanstack-query.user.js`
- `dist/jotai-devtools.user.js`
- `dist/redux-devtools.user.js`

`redux-devtools.user.js` is built with `@run-at document-start` so it can intercept `window.__REDUX_DEVTOOLS_EXTENSION__` as early as possible.

Common commands:

```bash
pnpm --filter @page-context/userscripts build
pnpm --filter @page-context/userscripts typecheck
pnpm --filter @page-context/userscripts test
```
