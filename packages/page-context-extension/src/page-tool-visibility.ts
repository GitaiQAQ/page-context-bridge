import type { PageToolEntry, PageToolSpec } from "./page-tool-registry";
import { listBuiltinRuntimeToolPreferenceKeys, toCanonicalBuiltinRuntimeToolName } from "@page-context/builtin-tools";

export interface PageToolPreferences {
  builtins?: BuiltinPreference;
  tabs?: Record<string, TabPreference>;
}

export interface BuiltinPreference {
  enabled?: boolean;
  tools?: Record<string, boolean>;
}

export interface TabPreference {
  enabled?: boolean;
  namespaces?: Record<string, NamespacePreference>;
}

export interface NamespacePreference {
  enabled?: boolean;
  instances?: Record<string, InstancePreference>;
}

export interface InstancePreference {
  enabled?: boolean;
  tools?: Record<string, boolean>;
}

export interface ToolTreeTab {
  kind: "tab";
  tabId: number;
  title: string;
  url: string;
  active: boolean;
  totalTools: number;
  enabledTools: number;
  namespaces: ToolTreeNamespace[];
}

export interface ToolTreeNamespace {
  kind: "namespace";
  tabId: number;
  namespace: string;
  totalTools: number;
  enabledTools: number;
  instances: ToolTreeInstance[];
}

export interface ToolTreeInstance {
  kind: "instance";
  tabId: number;
  namespace: string;
  instanceId: string;
  totalTools: number;
  enabledTools: number;
  tools: ToolTreeTool[];
}

export interface ToolTreeTool {
  kind: "tool";
  tabId: number;
  namespace: string;
  instanceId: string;
  toolName: string;
  label: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  enabled: boolean;
  readOnly: boolean;
}

export interface ToolTreeResponse {
  builtins: ToolTreeBuiltins;
  tabs: ToolTreeTab[];
  totalTools: number;
  enabledTools: number;
}

export interface ToolScopeInput {
  root?: "builtin" | "page";
  tabId?: number;
  namespace?: string;
  instanceId?: string;
  toolName?: string;
}

export interface ToolScopeEntriesInput {
  builtinTools?: PageToolSpec[];
  pageEntries?: PageToolEntry[];
}

export interface ToolTreeBuiltins {
  kind: "builtins";
  totalTools: number;
  enabledTools: number;
  namespaces: ToolTreeBuiltinNamespace[];
  tools: ToolTreeBuiltinTool[];
}

export interface ToolTreeBuiltinNamespace {
  kind: "builtin-namespace";
  namespace: string;
  totalTools: number;
  enabledTools: number;
  instances: ToolTreeBuiltinInstance[];
}

export interface ToolTreeBuiltinInstance {
  kind: "builtin-instance";
  namespace: string;
  instanceId: string;
  totalTools: number;
  enabledTools: number;
  tools: ToolTreeBuiltinTool[];
}

export interface ToolTreeBuiltinTool {
  kind: "builtin-tool";
  namespace: string;
  instanceId: string;
  toolName: string;
  label: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  enabled: boolean;
  readOnly: boolean;
  bridgeControl: boolean;
}

interface TabLike {
  id?: number;
  title?: string;
  url?: string;
  active?: boolean;
}

export function getEnabledToolsForTab(entries: PageToolEntry[] | undefined, preferences: PageToolPreferences, tabId: number): PageToolSpec[] {
  return (entries ?? [])
    .flatMap((entry) => entry.tools.filter((tool) => isToolEnabled(preferences, {
      root: "page",
      tabId,
      namespace: tool._namespace ?? entry.namespace,
      instanceId: tool._instanceId ?? entry.instanceId,
      toolName: tool.name,
    })));
}

export function getEnabledBuiltinTools(tools: PageToolSpec[], preferences: PageToolPreferences): PageToolSpec[] {
  return tools.filter((tool) => {
    if (isBridgeControlBuiltinTool(tool)) {
      return true;
    }
    // 偏好判断统一按 canonical 名称执行，兼容 legacy alias。
    return isToolEnabled(preferences, { root: "builtin", toolName: toCanonicalBuiltinRuntimeToolName(tool.name) });
  });
}

export function isToolEnabled(preferences: PageToolPreferences, scope: ToolScopeInput): boolean {
  if (scope.root === "builtin") {
    if (scope.toolName && isBridgeControlBuiltinToolName(scope.toolName)) {
      return true;
    }
    if (preferences.builtins?.enabled === false) {
      return false;
    }
    if (!scope.toolName) {
      return true;
    }
    const toolOverrides = preferences.builtins?.tools ?? {};
    return listBuiltinRuntimeToolPreferenceKeys(scope.toolName).every((name) => toolOverrides[name] !== false);
  }

  if (scope.tabId == null) {
    return true;
  }

  const tabPreference = preferences.tabs?.[String(scope.tabId)];
  if (tabPreference?.enabled === false) {
    return false;
  }

  if (!scope.namespace) {
    return true;
  }

  const namespacePreference = tabPreference?.namespaces?.[scope.namespace];
  if (namespacePreference?.enabled === false) {
    return false;
  }

  if (!scope.instanceId) {
    return true;
  }

  const instancePreference = namespacePreference?.instances?.[scope.instanceId];
  if (instancePreference?.enabled === false) {
    return false;
  }

  if (!scope.toolName) {
    return true;
  }

  return instancePreference?.tools?.[scope.toolName] !== false;
}

export function setScopeEnabled(
  preferences: PageToolPreferences,
  scope: ToolScopeInput,
  enabled: boolean,
  entries?: ToolScopeEntriesInput,
): PageToolPreferences {
  if (scope.root === "builtin") {
    const next: PageToolPreferences = {
      ...preferences,
      builtins: {
        ...(preferences.builtins ?? {}),
        tools: { ...(preferences.builtins?.tools ?? {}) },
      },
      tabs: { ...(preferences.tabs ?? {}) },
    };

    if (!scope.toolName) {
      if (!scope.namespace) {
        next.builtins!.enabled = enabled;
        next.builtins!.tools = enabled ? {} : buildBuiltinToolOverrides(entries?.builtinTools);
        return next;
      }
      applyBuiltinScopeOverrides(next.builtins!.tools!, entries?.builtinTools, scope, enabled);
      return next;
    }

    if (isBridgeControlBuiltinToolName(scope.toolName)) {
      // bridge 控制类 builtin 不提供本地开关，避免 sidepanel 误导用户以为可在 extension 侧关闭。
      return next;
    }

    applyBuiltinToolOverride(next.builtins!.tools!, scope.toolName, enabled);
    return next;
  }

  if (scope.tabId == null) {
    return preferences;
  }

  const next: PageToolPreferences = {
    builtins: preferences.builtins ? { ...preferences.builtins, tools: { ...(preferences.builtins.tools ?? {}) } } : undefined,
    tabs: { ...(preferences.tabs ?? {}) },
  };
  const tabId = String(scope.tabId);
  const tabPreference: TabPreference = {
    ...(next.tabs?.[tabId] ?? {}),
    namespaces: { ...(next.tabs?.[tabId]?.namespaces ?? {}) },
  };
  next.tabs![tabId] = tabPreference;

  if (!scope.namespace) {
    tabPreference.enabled = enabled;
    tabPreference.namespaces = enabled ? {} : buildTabNamespaceOverrides(entries?.pageEntries);
    return next;
  }

  const namespacePreference: NamespacePreference = {
    ...(tabPreference.namespaces?.[scope.namespace] ?? {}),
    instances: { ...(tabPreference.namespaces?.[scope.namespace]?.instances ?? {}) },
  };
  tabPreference.namespaces![scope.namespace] = namespacePreference;

  if (!scope.instanceId) {
    namespacePreference.enabled = enabled;
    namespacePreference.instances = enabled ? {} : buildNamespaceInstanceOverrides(entries?.pageEntries);
    return next;
  }

  const instancePreference: InstancePreference = {
    ...(namespacePreference.instances?.[scope.instanceId] ?? {}),
    tools: { ...(namespacePreference.instances?.[scope.instanceId]?.tools ?? {}) },
  };
  namespacePreference.instances![scope.instanceId] = instancePreference;

  if (!scope.toolName) {
    instancePreference.enabled = enabled;
    instancePreference.tools = enabled ? {} : buildInstanceToolOverrides(entries?.pageEntries?.[0]);
    return next;
  }

  if (enabled) {
    delete instancePreference.tools![scope.toolName];
  } else {
    instancePreference.tools![scope.toolName] = false;
  }
  return next;
}

function buildBuiltinToolOverrides(tools: PageToolSpec[] | undefined): Record<string, boolean> {
  return Object.fromEntries(
    (tools ?? [])
      .filter((tool) => !isBridgeControlBuiltinTool(tool))
      .map((tool) => [toCanonicalBuiltinRuntimeToolName(tool.name), false]),
  );
}

function applyBuiltinScopeOverrides(
  overrides: Record<string, boolean>,
  tools: PageToolSpec[] | undefined,
  scope: ToolScopeInput,
  enabled: boolean,
): void {
  for (const tool of tools ?? []) {
    if (isBridgeControlBuiltinTool(tool)) {
      continue;
    }
    const path = parseBuiltinToolPath(tool.name);
    if (scope.namespace && path.namespace !== scope.namespace) {
      continue;
    }
    if (scope.instanceId && path.instanceId !== scope.instanceId) {
      continue;
    }
    applyBuiltinToolOverride(overrides, tool.name, enabled);
  }
}

function applyBuiltinToolOverride(overrides: Record<string, boolean>, toolName: string, enabled: boolean): void {
  const preferenceKeys = listBuiltinRuntimeToolPreferenceKeys(toolName);
  const canonicalName = toCanonicalBuiltinRuntimeToolName(toolName);
  if (enabled) {
    for (const name of preferenceKeys) {
      delete overrides[name];
    }
    return;
  }
  overrides[canonicalName] = false;
}

function buildTabNamespaceOverrides(entries: PageToolEntry[] | undefined): Record<string, NamespacePreference> {
  const overrides: Record<string, NamespacePreference> = {};
  const entriesByNamespace = new Map<string, PageToolEntry[]>();

  for (const entry of entries ?? []) {
    entriesByNamespace.set(entry.namespace, [...(entriesByNamespace.get(entry.namespace) ?? []), entry]);
  }

  for (const [namespace, namespaceEntries] of entriesByNamespace.entries()) {
    overrides[namespace] = {
      enabled: false,
      instances: buildNamespaceInstanceOverrides(namespaceEntries),
    };
  }

  return overrides;
}

function buildNamespaceInstanceOverrides(entries: PageToolEntry[] | undefined): Record<string, InstancePreference> {
  return Object.fromEntries(
    (entries ?? []).map((entry) => [
      entry.instanceId,
      {
        enabled: false,
        tools: buildInstanceToolOverrides(entry),
      } satisfies InstancePreference,
    ]),
  );
}

function buildInstanceToolOverrides(entry: PageToolEntry | undefined): Record<string, boolean> {
  return Object.fromEntries((entry?.tools ?? []).map((tool) => [tool.name, false]));
}

export function buildToolTree(
  tabs: TabLike[],
  pageToolsByTab: Map<number, PageToolEntry[]>,
  builtinTools: PageToolSpec[],
  preferences: PageToolPreferences,
): ToolTreeResponse {
  const treeTabs = tabs
    .filter((tab) => tab.id != null && (pageToolsByTab.get(tab.id) ?? []).length > 0)
    .map((tab) => buildTabNode(tab as Required<Pick<TabLike, "id">> & TabLike, pageToolsByTab.get(tab.id!) ?? [], preferences))
    .filter((tab) => tab.totalTools > 0)
    .sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)) || left.title.localeCompare(right.title));

  const builtins = buildBuiltinNode(builtinTools, preferences);

  return {
    builtins,
    tabs: treeTabs,
    totalTools: builtins.totalTools + treeTabs.reduce((sum, tab) => sum + tab.totalTools, 0),
    enabledTools: builtins.enabledTools + treeTabs.reduce((sum, tab) => sum + tab.enabledTools, 0),
  };
}

function buildBuiltinNode(tools: PageToolSpec[], preferences: PageToolPreferences): ToolTreeBuiltins {
  const dedupedByName = new Map<string, PageToolSpec>();
  for (const tool of tools) {
    const normalizedName = toCanonicalBuiltinRuntimeToolName(tool.name);
    // 统一收敛 canonical 名称，避免 legacy alias 与 canonical 在树里重复展示。
    if (!dedupedByName.has(normalizedName)) {
      dedupedByName.set(normalizedName, {
        ...tool,
        name: normalizedName,
      });
    }
  }

  const builtinTools = Array.from(dedupedByName.values())
    .map((tool) => {
      const path = parseBuiltinToolPath(tool.name);
      return {
        kind: "builtin-tool" as const,
        namespace: path.namespace,
        instanceId: path.instanceId,
        toolName: tool.name,
        label: path.label,
        description: tool.description,
        inputSchema: tool.inputSchema,
        enabled: isToolEnabled(preferences, { root: "builtin", toolName: tool.name }),
        readOnly: isReadOnlyTool(tool),
        // bridge 控制类工具只在 sidepanel 做可见化提示，不走 extension 本地执行链路。
        bridgeControl: isBridgeControlBuiltinTool(tool),
      };
    })
    .sort((left, right) => left.namespace.localeCompare(right.namespace) || left.label.localeCompare(right.label));

  const namespacesMap = new Map<string, Map<string, ToolTreeBuiltinTool[]>>();
  for (const tool of builtinTools) {
    const byInstance = namespacesMap.get(tool.namespace) ?? new Map<string, ToolTreeBuiltinTool[]>();
    byInstance.set(tool.instanceId, [...(byInstance.get(tool.instanceId) ?? []), tool]);
    namespacesMap.set(tool.namespace, byInstance);
  }

  const namespaces = Array.from(namespacesMap.entries())
    .map(([namespace, byInstance]) => {
      const instances = Array.from(byInstance.entries())
        .map(([instanceId, instanceTools]) => ({
          kind: "builtin-instance" as const,
          namespace,
          instanceId,
          totalTools: instanceTools.length,
          enabledTools: instanceTools.filter((tool) => tool.enabled).length,
          tools: [...instanceTools].sort((left, right) => left.label.localeCompare(right.label)),
        }))
        .sort((left, right) => left.instanceId.localeCompare(right.instanceId));

      return {
        kind: "builtin-namespace" as const,
        namespace,
        totalTools: instances.reduce((sum, instance) => sum + instance.totalTools, 0),
        enabledTools: instances.reduce((sum, instance) => sum + instance.enabledTools, 0),
        instances,
      };
    })
    .sort((left, right) => left.namespace.localeCompare(right.namespace));

  return {
    kind: "builtins",
    totalTools: namespaces.reduce((sum, namespace) => sum + namespace.totalTools, 0),
    enabledTools: namespaces.reduce((sum, namespace) => sum + namespace.enabledTools, 0),
    namespaces,
    // 兼容旧字段，避免 bridge/control 链路一次性断裂。
    tools: builtinTools,
  };
}

function parseBuiltinToolPath(toolName: string): { namespace: string; instanceId: string; label: string } {
  const firstDot = toolName.indexOf(".");
  if (firstDot < 0) {
    return { namespace: "builtin", instanceId: "default", label: toolName };
  }
  const namespace = toolName.slice(0, firstDot) || "builtin";
  const suffix = toolName.slice(firstDot + 1);
  return {
    namespace,
    // 当前 builtin 体系默认单实例；保留 instance 字段，后续可平滑扩展多实例。
    instanceId: "default",
    label: suffix || toolName,
  };
}

function buildTabNode(tab: Required<Pick<TabLike, "id">> & TabLike, entries: PageToolEntry[], preferences: PageToolPreferences): ToolTreeTab {
  const entriesByNamespace = new Map<string, PageToolEntry[]>();
  for (const entry of entries) {
    entriesByNamespace.set(entry.namespace, [...(entriesByNamespace.get(entry.namespace) ?? []), entry]);
  }

  const namespaces = [...entriesByNamespace.entries()]
    .map(([namespace, namespaceEntries]) => buildNamespaceNode(tab.id, namespace, namespaceEntries, preferences))
    .sort((left, right) => left.namespace.localeCompare(right.namespace));

  return {
    kind: "tab",
    tabId: tab.id,
    title: tab.title || `Tab ${tab.id}`,
    url: tab.url || "",
    active: Boolean(tab.active),
    totalTools: namespaces.reduce((sum, namespace) => sum + namespace.totalTools, 0),
    enabledTools: namespaces.reduce((sum, namespace) => sum + namespace.enabledTools, 0),
    namespaces,
  };
}

function buildNamespaceNode(tabId: number, namespace: string, entries: PageToolEntry[], preferences: PageToolPreferences): ToolTreeNamespace {
  const instances = entries
    .map((entry) => buildInstanceNode(tabId, entry, preferences))
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));

  return {
    kind: "namespace",
    tabId,
    namespace,
    totalTools: instances.reduce((sum, instance) => sum + instance.totalTools, 0),
    enabledTools: instances.reduce((sum, instance) => sum + instance.enabledTools, 0),
    instances,
  };
}

function buildInstanceNode(tabId: number, entry: PageToolEntry, preferences: PageToolPreferences): ToolTreeInstance {
  const tools = entry.tools
    .map((tool) => ({
      kind: "tool" as const,
      tabId,
      namespace: entry.namespace,
      instanceId: entry.instanceId,
      toolName: tool.name,
      label: getDisplayName(tool, entry.namespace, entry.instanceId),
      description: tool.description,
      inputSchema: tool.inputSchema,
      enabled: isToolEnabled(preferences, {
        root: "page",
        tabId,
        namespace: entry.namespace,
        instanceId: entry.instanceId,
        toolName: tool.name,
      }),
      readOnly: isReadOnlyTool(tool),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  return {
    kind: "instance",
    tabId,
    namespace: entry.namespace,
    instanceId: entry.instanceId,
    totalTools: tools.length,
    enabledTools: tools.filter((tool) => tool.enabled).length,
    tools,
  };
}

function getDisplayName(tool: PageToolSpec, namespace: string, instanceId: string): string {
  const prefix = instanceId === "default" ? `${namespace}.` : `${namespace}.${instanceId}.`;
  return tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name;
}

function isReadOnlyTool(tool: PageToolSpec): boolean {
  return Boolean((tool.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint || (tool._meta as { readOnly?: boolean } | undefined)?.readOnly);
}

function isBridgeControlBuiltinTool(tool: PageToolSpec): boolean {
  if ((tool as { _bridgeControlTool?: boolean })._bridgeControlTool === true) {
    return true;
  }
  // Fallback to namespace-based identification to ensure bridge semantics can still be displayed when marker fields are missing in historical data structures.
  return isBridgeControlBuiltinToolName(tool.name);
}

function isBridgeControlBuiltinToolName(name: string): boolean {
  return name.startsWith("extension.") || name.startsWith("feedback.");
}
