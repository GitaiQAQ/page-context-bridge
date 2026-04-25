/**
 * @page-context/tool-executor — Public API
 *
 * Tool execution engine extracted from extension core.
 * Provides CDP client, ServiceWorker context, and tool dispatch.
 */

export {
  executeToolCall,
  getBuiltinToolDefinitions,
  getExtensionToolProviders,
  getServiceWorkerContext,
} from "./executor";
