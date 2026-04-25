/**
 * Re-export shim — delegates to @page-context/tool-visibility.
 * New code should import directly from "@page-context/tool-visibility".
 */
export {
  buildToolTree,
  filterBuiltinTools,
  getEnabledBuiltinTools,
  getEnabledToolsForTab,
  isToolEnabled,
  setScopeEnabled,
  // Types
  type BuiltinPreference,
  type InstancePreference,
  type NamespacePreference,
  type PageToolPreferences,
  type TabPreference,
  type ToolScopeEntriesInput,
  type ToolScopeInput,
  type ToolTreeBuiltins,
  type ToolTreeBuiltinInstance,
  type ToolTreeBuiltinNamespace,
  type ToolTreeBuiltinTool,
  type ToolTreeInstance,
  type ToolTreeNamespace,
  type ToolTreeResponse,
  type ToolTreeTab,
  type ToolTreeTool,
} from "@page-context/tool-visibility";
