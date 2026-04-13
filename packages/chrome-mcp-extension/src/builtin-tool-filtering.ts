import type { PageToolSpec } from "./page-tool-registry.js";
import { getEnabledBuiltinTools, type PageToolPreferences } from "./page-tool-visibility.js";

export function filterBuiltinTools(tools: PageToolSpec[], preferences: PageToolPreferences): PageToolSpec[] {
  return getEnabledBuiltinTools(tools, preferences);
}
