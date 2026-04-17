import type { PageToolSpec } from "./page-tool-registry";
import { getEnabledBuiltinTools, type PageToolPreferences } from "./page-tool-visibility";

export function filterBuiltinTools(tools: PageToolSpec[], preferences: PageToolPreferences): PageToolSpec[] {
  return getEnabledBuiltinTools(tools, preferences);
}
