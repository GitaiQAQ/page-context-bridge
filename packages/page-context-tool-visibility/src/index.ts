/**
 * @page-context/tool-visibility — Public API
 *
 * Tool visibility engine extracted from extension core.
 * Provides:
 *   types/       — PageToolSpec, PageToolEntry data structures
 *   registry/    — normalize/merge/flatten utilities
 *   preferences/ — enable/disable logic, tool tree builder
 *   filtering/   — builtin tool filter wrapper
 */

// ─── Types ────────────────────────────────────────────────

export type { PageToolSpec, PageToolEntry } from "./types";

// ─── Registry Utilities ───────────────────────────────────

export {
  flattenPageTools,
  mergePageToolEntry,
  normalizePageToolEntries,
} from "./registry";

// ─── Preference Engine ────────────────────────────────────

export {
  buildToolTree,
  getEnabledBuiltinTools,
  getEnabledToolsForTab,
  isToolEnabled,
  setScopeEnabled,
  // Preference & Tree types
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
} from "./preferences";

// ─── Filtering ────────────────────────────────────────────

export { filterBuiltinTools } from "./filtering";
