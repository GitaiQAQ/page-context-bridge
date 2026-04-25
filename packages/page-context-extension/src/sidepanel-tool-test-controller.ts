/**
 * Tool Test Panel state initialization and reset helpers.
 * Pure functions — no LitElement dependency.
 */

import type { ToolTestSelection } from "./sidepanel-types";
import { createArgsTemplate, formatJson } from "./sidepanel-tree-renderer";

export interface ToolTestInitState {
  toolTestTitle: string;
  toolTestSubtitle: string;
  toolTestTabIdValue: string;
  toolTestTabIdDisabled: boolean;
  toolTestSchemaOutput: string;
  toolTestArgs: string;
  toolTestOutput: string;
  toolTestStatusText: string;
  toolTestStatusClass: string;
}

/** Computes initial Tool Test state from a selection. */
export function initializeToolTestState(selection: ToolTestSelection): ToolTestInitState {
  return {
    toolTestTitle: `Tool Test · ${selection.label}`,
    toolTestSubtitle: selection.root === "builtin"
      ? `Built-in tool: ${selection.toolName}`
      : `Context tool: ${selection.toolName}${selection.tabId != null ? ` · tab ${selection.tabId}` : ""}`,
    toolTestTabIdValue: selection.tabId != null ? String(selection.tabId) : "",
    toolTestTabIdDisabled: selection.root === "page" && selection.tabId != null,
    toolTestSchemaOutput: formatJson(selection.inputSchema ?? {}),
    toolTestArgs: createArgsTemplate(selection.inputSchema),
    toolTestOutput: "(no output yet)",
    toolTestStatusText: "Ready",
    toolTestStatusClass: "text-xs font-semibold opacity-60",
  };
}

/** Returns reset state for args-related fields while preserving selection. */
export function resetToolTestArgsState(inputSchema?: Record<string, unknown>): Partial<ToolTestInitState> {
  return {
    toolTestArgs: createArgsTemplate(inputSchema),
    toolTestOutput: "(no output yet)",
    toolTestStatusText: "Ready",
    toolTestStatusClass: "text-xs font-semibold opacity-60",
  };
}
