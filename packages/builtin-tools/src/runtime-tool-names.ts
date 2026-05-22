/**
 * Runtime builtin tool naming model.
 *
 * Canonical names are unified as `builtin.<category>.<action>`.
 * Bridge and extension runtimes still accept a small compatibility alias set
 * and resolve it back to the canonical name before execution.
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

const BUILTIN_TOOL_SUFFIXES_BY_CATEGORY: Record<BuiltinCategory, readonly string[]> = {
  [BUILTIN_CATEGORY.tabs]: ['list_tabs', 'open_tab', 'close_tab', 'screenshot_tab'],
  [BUILTIN_CATEGORY.page]: [
    'get_page_info',
    'navigate',
    'reload',
    'go_back',
    'go_forward',
    'wait_for_navigation',
    'screenshot_page',
  ],
  [BUILTIN_CATEGORY.dom]: [
    'get_selected_text',
    'click_element',
    'scroll_into_view',
    'get_element_text',
    'get_element_html',
    'query_elements',
    'fill_input',
    'execute_js',
    'wait_for_selector',
  ],
  [BUILTIN_CATEGORY.console]: ['get_console_logs'],
  [BUILTIN_CATEGORY.input]: ['press_key', 'type_text'],
};

const BUILTIN_SUFFIX_TO_CATEGORIES = Object.entries(BUILTIN_TOOL_SUFFIXES_BY_CATEGORY).reduce(
  (accumulator, [category, suffixes]) => {
    for (const suffix of suffixes) {
      const categories = accumulator.get(suffix) ?? [];
      categories.push(category as BuiltinCategory);
      accumulator.set(suffix, categories);
    }
    return accumulator;
  },
  new Map<string, BuiltinCategory[]>(),
);

/**
 * Helper for constructing canonical runtime builtin tool names with semantic category.
 *
 * Produces names like `builtin.tabs.list_tabs`, `builtin.dom.click_element`, etc.
 */
export function builtinToolName(category: BuiltinCategory, suffix: string): string {
  return `${BUILTIN_RUNTIME_NAMESPACE}.${category}.${suffix}`;
}

export function parseBuiltinToolName(
  toolName: string,
): { namespace: string; category: string; suffix: string } | null {
  const match = /^builtin\.([^.]+)\.(.+)$/.exec(toolName);
  if (!match) {
    return null;
  }
  return {
    namespace: BUILTIN_RUNTIME_NAMESPACE,
    category: match[1],
    suffix: match[2],
  };
}

/**
 * Backward-compatible aliases exposed on the bridge side.
 *
 * - `builtin.<category>.<suffix>` is canonical
 * - `builtin.<suffix>` supports older internal callers
 * - `<suffix>` supports legacy MCP clients that flatten server name prefixes
 */
export function getBuiltinToolNameAliases(toolName: string): string[] {
  const parsed = parseBuiltinToolName(toolName);
  if (!parsed) {
    return [toolName];
  }
  return [toolName, `${BUILTIN_RUNTIME_NAMESPACE}.${parsed.suffix}`, parsed.suffix];
}

/**
 * Resolve a builtin tool alias back to its canonical `builtin.<category>.<suffix>` name.
 *
 * Supported aliases:
 * - `builtin.<category>.<suffix>` (already canonical)
 * - `builtin.<suffix>`
 * - `<suffix>`
 * - `page-context_<suffix>` (observed from flattened MCP client prefixes)
 */
export function resolveBuiltinToolNameAlias(toolName: string): string | null {
  const canonical = parseBuiltinToolName(toolName);
  if (canonical) {
    return toolName;
  }

  const strippedToolName = toolName.startsWith('page-context_')
    ? toolName.slice('page-context_'.length)
    : toolName;
  const legacyBuiltinMatch = /^builtin\.([^.]+)$/.exec(strippedToolName);
  const suffix = legacyBuiltinMatch?.[1] ?? strippedToolName;
  const categories = BUILTIN_SUFFIX_TO_CATEGORIES.get(suffix);
  if (!categories || categories.length !== 1) {
    return null;
  }
  return builtinToolName(categories[0], suffix);
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

export type BuiltinBrowserRuntimeTarget = 'chromium' | 'firefox' | 'unknown';

export interface BuiltinRuntimeCapabilities {
  target: BuiltinBrowserRuntimeTarget;
  supportsChromeDebuggerCdp: boolean;
}

export interface BuiltinRuntimeCapabilityProbe {
  manifest?: unknown;
  userAgent?: string;
  hasChromeDebuggerCdp?: boolean;
  hasBrowserRuntimeGetBrowserInfo?: boolean;
}

export const CDP_DEBUGGER_BUILTIN_TOOL_NAMES = [
  builtinToolName(BUILTIN_CATEGORY.page, 'screenshot_page'),
  builtinToolName(BUILTIN_CATEGORY.input, 'press_key'),
  builtinToolName(BUILTIN_CATEGORY.input, 'type_text'),
] as const;

const CDP_DEBUGGER_BUILTIN_TOOL_NAME_SET = new Set<string>(CDP_DEBUGGER_BUILTIN_TOOL_NAMES);

export function isCdpDebuggerBuiltinToolName(toolName: string): boolean {
  return CDP_DEBUGGER_BUILTIN_TOOL_NAME_SET.has(toolName);
}

export function filterBuiltinToolsByRuntimeCapabilities<T extends { name: string }>(
  tools: readonly T[],
  capabilities: BuiltinRuntimeCapabilities = detectBuiltinRuntimeCapabilities(),
): T[] {
  if (capabilities.supportsChromeDebuggerCdp) {
    return [...tools];
  }
  return tools.filter((tool) => !isCdpDebuggerBuiltinToolName(tool.name));
}

export function detectBuiltinRuntimeCapabilities(
  probe: BuiltinRuntimeCapabilityProbe = {},
): BuiltinRuntimeCapabilities {
  const manifest = probe.manifest ?? safeGetRuntimeManifest();
  const userAgent = probe.userAgent ?? safeGetRuntimeUserAgent();
  const hasFirefoxSignal =
    detectManifestTarget(manifest) === 'firefox' ||
    /Firefox\/\d+/i.test(userAgent) ||
    (probe.hasBrowserRuntimeGetBrowserInfo ?? safeHasBrowserRuntimeGetBrowserInfo());
  const hasChromeDebuggerCdp = probe.hasChromeDebuggerCdp ?? safeHasChromeDebuggerCdp();

  if (hasFirefoxSignal) {
    return {
      target: 'firefox',
      supportsChromeDebuggerCdp: false,
    };
  }

  return {
    target: hasChromeDebuggerCdp ? 'chromium' : 'unknown',
    supportsChromeDebuggerCdp: hasChromeDebuggerCdp,
  };
}

function safeGetRuntimeManifest(): Record<string, unknown> | null {
  const maybeChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
  if (!isRecord(maybeChrome)) {
    return null;
  }
  const runtime = maybeChrome.runtime;
  if (!isRecord(runtime) || typeof runtime.getManifest !== 'function') {
    return null;
  }
  try {
    const manifest = runtime.getManifest() as unknown;
    return isRecord(manifest) ? manifest : null;
  } catch {
    return null;
  }
}

function safeGetRuntimeUserAgent(): string {
  const maybeNavigator = (globalThis as typeof globalThis & { navigator?: unknown }).navigator;
  if (!isRecord(maybeNavigator)) {
    return '';
  }
  return typeof maybeNavigator.userAgent === 'string' ? maybeNavigator.userAgent : '';
}

function safeHasChromeDebuggerCdp(): boolean {
  const maybeChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
  if (!isRecord(maybeChrome)) {
    return false;
  }
  const maybeDebugger = maybeChrome.debugger;
  if (!isRecord(maybeDebugger)) {
    return false;
  }
  return (
    typeof maybeDebugger.attach === 'function' &&
    typeof maybeDebugger.detach === 'function' &&
    typeof maybeDebugger.sendCommand === 'function'
  );
}

function safeHasBrowserRuntimeGetBrowserInfo(): boolean {
  const maybeBrowser = (globalThis as typeof globalThis & { browser?: unknown }).browser;
  if (!isRecord(maybeBrowser)) {
    return false;
  }
  const runtime = maybeBrowser.runtime;
  if (!isRecord(runtime)) {
    return false;
  }
  return typeof runtime.getBrowserInfo === 'function';
}

function detectManifestTarget(manifest: unknown): BuiltinBrowserRuntimeTarget | 'unknown' {
  if (!isRecord(manifest)) {
    return 'unknown';
  }
  const browserSpecificSettings = manifest.browser_specific_settings;
  if (isRecord(browserSpecificSettings) && isRecord(browserSpecificSettings.gecko)) {
    return 'firefox';
  }
  const applications = manifest.applications;
  if (isRecord(applications) && isRecord(applications.gecko)) {
    return 'firefox';
  }
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
