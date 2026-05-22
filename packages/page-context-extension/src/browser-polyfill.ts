/**
 * Browser API polyfill for Firefox compatibility.
 *
 * Firefox provides `browser.*` with native Promise support and `chrome.*` as
 * callback-only compat layer. Vite/Rollup tree-shaking may inline `chrome.*`
 * calls that `await` the result — which silently resolves to `undefined` on
 * Firefox because `chrome.*` methods don't return Promises.
 *
 * This polyfill replaces `chrome.*` async methods with `browser.*` equivalents
 * so `await chrome.runtime.sendMessage(...)` works in all contexts.
 * On Chromium (where `browser` is undefined), this is a no-op.
 */
(function () {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = (globalThis as any).browser;
  if (!b) return; // Chromium — nothing to patch

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function wrap(chromeTarget: any, browserTarget: any, method: string): void {
    const browserMethod = browserTarget[method];
    if (typeof browserMethod !== 'function') return;
    // Replace chrome.* method with browser.* method that returns a Promise
    chromeTarget[method] = function () {
      return browserMethod.apply(browserTarget, arguments);
    };
  }

  // runtime
  if (b.runtime && chrome.runtime) {
    wrap(chrome.runtime, b.runtime, 'sendMessage');
  }

  // tabs
  if (b.tabs && chrome.tabs) {
    wrap(chrome.tabs, b.tabs, 'sendMessage');
    wrap(chrome.tabs, b.tabs, 'create');
    wrap(chrome.tabs, b.tabs, 'query');
    wrap(chrome.tabs, b.tabs, 'get');
    wrap(chrome.tabs, b.tabs, 'remove');
  }

  // storage.local
  if (b.storage && b.storage.local && chrome.storage && chrome.storage.local) {
    wrap(chrome.storage.local, b.storage.local, 'get');
    wrap(chrome.storage.local, b.storage.local, 'set');
    wrap(chrome.storage.local, b.storage.local, 'remove');
  }

  // windows
  if (b.windows && chrome.windows) {
    wrap(chrome.windows, b.windows, 'getCurrent');
  }

  // sidebarAction (Firefox)
  if (b.sidebarAction && (chrome as any).sidebarAction) {
    wrap((chrome as any).sidebarAction, b.sidebarAction, 'open');
    wrap((chrome as any).sidebarAction, b.sidebarAction, 'close');
    wrap((chrome as any).sidebarAction, b.sidebarAction, 'setPanel');
    wrap((chrome as any).sidebarAction, b.sidebarAction, 'setTitle');
  }
})();
