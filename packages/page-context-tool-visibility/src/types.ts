/**
 * Core data structures for page-context tools.
 */

export interface PageToolSpec extends Record<string, unknown> {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  _pageTool?: boolean;
  _namespace?: string;
  _instanceId?: string;
  _bridgeControlTool?: boolean;
}

export interface PageToolEntry {
  namespace: string;
  namespaceTitle?: string;
  namespaceDescription?: string;
  instanceId: string;
  tools: PageToolSpec[];
}
