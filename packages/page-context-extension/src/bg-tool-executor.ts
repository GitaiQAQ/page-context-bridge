/**
 * Re-export shim — delegates to @page-context/tool-executor.
 * New code should import directly from "@page-context/tool-executor".
 */
export {
  executeToolCall,
  getBuiltinToolDefinitions,
  getExtensionToolProviders,
  getServiceWorkerContext,
} from "@page-context/tool-executor";
