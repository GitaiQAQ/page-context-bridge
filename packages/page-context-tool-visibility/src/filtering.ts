/**
 * Thin wrapper around getEnabledBuiltinTools for builtin tool filtering.
 */
import type { PageToolSpec } from "./types";
import { getEnabledBuiltinTools, type PageToolPreferences } from "./preferences";

export function filterBuiltinTools(tools: PageToolSpec[], preferences: PageToolPreferences): PageToolSpec[] {
  return getEnabledBuiltinTools(tools, preferences);
}
