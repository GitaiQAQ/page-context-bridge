/**
 * Runtime builtin tool naming model.
 *
 * Canonical names are unified as `builtin.*`.
 * Historical aliases are intentionally NOT supported.
 */

export const BUILTIN_RUNTIME_NAMESPACE = "builtin";

/**
 * Helper for constructing canonical runtime builtin tool names.
 *
 * Note: this is a constructor utility, not an alias normalizer.
 */
export function builtinRuntimeToolName(suffix: string): string {
  return `${BUILTIN_RUNTIME_NAMESPACE}.${suffix}`;
}
