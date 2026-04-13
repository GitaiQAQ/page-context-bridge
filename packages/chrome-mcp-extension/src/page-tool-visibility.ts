import type { PageToolEntry, PageToolSpec } from "./page-tool-registry.js";

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

export interface ToolTreeBuiltins {
  kind: "builtins";
  totalTools: number;
  enabledTools: number;
  tools: ToolTreeBuiltinTool[];
}

export interface ToolTreeBuiltinTool {
  kind: "builtin-tool";
  toolName: string;
  label: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  enabled: boolean;
  readOnly: boolean;
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
  return tools.filter((tool) => isToolEnabled(preferences, { root: "builtin", toolName: tool.name }));
}

export function isToolEnabled(preferences: PageToolPreferences, scope: ToolScopeInput): boolean {
  if (scope.root === "builtin") {
    if (preferences.builtins?.enabled === false) {
      return false;
    }
    if (!scope.toolName) {
      return true;
    }
    return preferences.builtins?.tools?.[scope.toolName] !== false;
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

export function setScopeEnabled(preferences: PageToolPreferences, scope: ToolScopeInput, enabled: boolean): PageToolPreferences {
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
      next.builtins!.enabled = enabled;
      return next;
    }

    next.builtins!.tools![scope.toolName] = enabled;
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
    return next;
  }

  const namespacePreference: NamespacePreference = {
    ...(tabPreference.namespaces?.[scope.namespace] ?? {}),
    instances: { ...(tabPreference.namespaces?.[scope.namespace]?.instances ?? {}) },
  };
  tabPreference.namespaces![scope.namespace] = namespacePreference;

  if (!scope.instanceId) {
    namespacePreference.enabled = enabled;
    return next;
  }

  const instancePreference: InstancePreference = {
    ...(namespacePreference.instances?.[scope.instanceId] ?? {}),
    tools: { ...(namespacePreference.instances?.[scope.instanceId]?.tools ?? {}) },
  };
  namespacePreference.instances![scope.instanceId] = instancePreference;

  if (!scope.toolName) {
    instancePreference.enabled = enabled;
    return next;
  }

  instancePreference.tools![scope.toolName] = enabled;
  return next;
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
  const builtinTools = tools
    .map((tool) => ({
      kind: "builtin-tool" as const,
      toolName: tool.name,
      label: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      enabled: isToolEnabled(preferences, { root: "builtin", toolName: tool.name }),
      readOnly: isReadOnlyTool(tool),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  return {
    kind: "builtins",
    totalTools: builtinTools.length,
    enabledTools: builtinTools.filter((tool) => tool.enabled).length,
    tools: builtinTools,
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
