/**
 * runtime builtin 工具命名模型。
 *
 * 规范名统一为 `builtin.*`；旧的平铺名称继续保留为兼容别名。
 */

export const BUILTIN_RUNTIME_NAMESPACE = "builtin";

export const BUILTIN_RUNTIME_LEGACY_TO_CANONICAL = {
  list_tabs: `${BUILTIN_RUNTIME_NAMESPACE}.list_tabs`,
  get_page_info: `${BUILTIN_RUNTIME_NAMESPACE}.get_page_info`,
  get_selected_text: `${BUILTIN_RUNTIME_NAMESPACE}.get_selected_text`,
  click_element: `${BUILTIN_RUNTIME_NAMESPACE}.click_element`,
  get_element_text: `${BUILTIN_RUNTIME_NAMESPACE}.get_element_text`,
  get_element_html: `${BUILTIN_RUNTIME_NAMESPACE}.get_element_html`,
  query_elements: `${BUILTIN_RUNTIME_NAMESPACE}.query_elements`,
  fill_input: `${BUILTIN_RUNTIME_NAMESPACE}.fill_input`,
  execute_js: `${BUILTIN_RUNTIME_NAMESPACE}.execute_js`,
  screenshot_tab: `${BUILTIN_RUNTIME_NAMESPACE}.screenshot_tab`,
  get_console_logs: `${BUILTIN_RUNTIME_NAMESPACE}.get_console_logs`,
  navigate: `${BUILTIN_RUNTIME_NAMESPACE}.navigate`,
} as const;

export type BuiltinRuntimeLegacyToolName = keyof typeof BUILTIN_RUNTIME_LEGACY_TO_CANONICAL;
export type BuiltinRuntimeCanonicalToolName = (typeof BUILTIN_RUNTIME_LEGACY_TO_CANONICAL)[BuiltinRuntimeLegacyToolName];

const BUILTIN_RUNTIME_CANONICAL_TO_LEGACY: Record<string, string> = Object.fromEntries(
  Object.entries(BUILTIN_RUNTIME_LEGACY_TO_CANONICAL).map(([legacyName, canonicalName]) => [canonicalName, legacyName]),
);

export function toCanonicalBuiltinRuntimeToolName(name: string): string {
  return BUILTIN_RUNTIME_LEGACY_TO_CANONICAL[name as BuiltinRuntimeLegacyToolName] ?? name;
}

export function toLegacyBuiltinRuntimeToolName(name: string): string | null {
  const canonicalName = toCanonicalBuiltinRuntimeToolName(name);
  return BUILTIN_RUNTIME_CANONICAL_TO_LEGACY[canonicalName] ?? null;
}

export function listBuiltinRuntimeToolPreferenceKeys(name: string): string[] {
  const canonicalName = toCanonicalBuiltinRuntimeToolName(name);
  const legacyName = BUILTIN_RUNTIME_CANONICAL_TO_LEGACY[canonicalName];
  return legacyName ? [canonicalName, legacyName] : [canonicalName];
}
