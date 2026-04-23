/**
 * @page-context/builtin-tools
 *
 * Builtin browser automation tools as a plugin for page-context-bridge.
 */

export { BuiltinBridgeProvider } from "./bridge-provider.js";
export { BuiltinExtensionProvider } from "./extension-provider.js";
export {
  ExtensionControlBridgeProvider,
  EXTENSION_CONTROL_LEGACY_TOOL_NAMES,
  EXTENSION_CONTROL_TOOL_SUFFIXES,
  type PageToolEnableUpdate,
  type ExtensionControlTool,
  type ExtensionControlRefreshResult,
  type ExtensionControlBridgeRpc,
  type ExtensionControlBridgeProviderOptions,
} from "./extension-control-bridge-provider.js";
export {
  FeedbackControlBridgeProvider,
  FEEDBACK_CONTROL_LEGACY_TOOL_NAMES,
  FEEDBACK_CONTROL_TOOL_SUFFIXES,
  type FeedbackControlBridgeRpc,
  type FeedbackControlBridgeProviderOptions,
} from "./feedback-control-bridge-provider.js";
export { executeContentScriptTool } from "./content-script-tools.js";
export { executeServiceWorkerTool } from "./service-worker-tools.js";
export { createConsoleCapture, type ConsoleEntry } from "./console-capture.js";
