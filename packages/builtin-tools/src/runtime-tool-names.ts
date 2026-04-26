/**
 * Runtime builtin tool naming model.
 *
 * Canonical names are unified as `builtin.<category>.<action>`.
 * Historical aliases are intentionally NOT supported.
 */

export const BUILTIN_RUNTIME_NAMESPACE = 'builtin';

/** Semantic categories for builtin tools — each becomes a namespace in the tool tree UI. */
export const BUILTIN_CATEGORY = {
  tabs: 'tabs',
  page: 'page',
  dom: 'dom',
  console: 'console',
  input: 'input',
} as const;

export type BuiltinCategory = (typeof BUILTIN_CATEGORY)[keyof typeof BUILTIN_CATEGORY];

/**
 * Helper for constructing canonical runtime builtin tool names with semantic category.
 *
 * Produces names like `builtin.tabs.list_tabs`, `builtin.dom.click_element`, etc.
 */
export function builtinToolName(category: BuiltinCategory, suffix: string): string {
  return `${BUILTIN_RUNTIME_NAMESPACE}.${category}.${suffix}`;
}

/**
 * Legacy helper — kept for backward compatibility during migration.
 * Prefer `builtinToolName(category, suffix)` for new code.
 *
 * @deprecated Use `builtinToolName` with a semantic category instead.
 */
export function builtinRuntimeToolName(suffix: string): string {
  return `${BUILTIN_RUNTIME_NAMESPACE}.${suffix}`;
}
