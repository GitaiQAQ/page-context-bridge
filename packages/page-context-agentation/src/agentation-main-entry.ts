/**
 * Vite build entry: outputs agentation-main.js
 *
 * This file is referenced by vite.config.ts's rollup input.
 * Vite bundles React + Agentation vendor code into a self-contained agentation-main.js.
 * This JS is injected into page main world via chrome.scripting.executeScript({ world: "MAIN", files: ["agentation-main.js"] }),
 * allowing react-detection.ts's Object.keys(element) to directly see __reactFiber$xxx properties.
 *
 * NOTE: The Agentation React component itself (@page-context/extension/vendor/agentation)
 *       is NOT included here — it remains in the extension package as a build-time dependency.
 *       This entry point only calls installAgentationInMainWorld() after DOM ready.
 */
export function agentationMainEntry(): void {
  // Defer to ensure DOM body is available
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", agentationMainEntry, { once: true });
    return;
  }
  agentationMainEntry();
}
