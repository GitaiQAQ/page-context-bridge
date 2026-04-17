/**
 * @page-context/builtin-tools
 *
 * Builtin browser automation tools as a plugin for page-context-bridge.
 */

export { BuiltinBridgeProvider } from "./bridge-provider.js";
export { BuiltinExtensionProvider } from "./extension-provider.js";
export { executeContentScriptTool } from "./content-script-tools.js";
export { executeServiceWorkerTool } from "./service-worker-tools.js";
export { createConsoleCapture, type ConsoleEntry } from "./console-capture.js";
