/**
 * Registry utilities for page-tool entries.
 */
import type { PageToolEntry, PageToolSpec } from "./types";

export function normalizePageToolEntries(rawEntries: Array<{ namespace: string; instanceId: string; tools: PageToolSpec[] }>): PageToolEntry[] {
  return rawEntries.map((entry) => {
    const prefix = entry.instanceId !== "default" ? `${entry.namespace}.${entry.instanceId}` : entry.namespace;
    return {
      namespace: entry.namespace,
      instanceId: entry.instanceId,
      tools: entry.tools.map((tool) => ({
        ...tool,
        name: `${prefix}.${stripExistingPrefix(tool.name, entry.namespace, entry.instanceId)}`,
        _pageTool: true,
        _namespace: entry.namespace,
        _instanceId: entry.instanceId,
      })),
    };
  });
}

export function mergePageToolEntry(entries: PageToolEntry[], nextEntry: PageToolEntry): PageToolEntry[] {
  const filtered = entries.filter((entry) => !(entry.namespace === nextEntry.namespace && entry.instanceId === nextEntry.instanceId));
  return [...filtered, nextEntry];
}

export function flattenPageTools(entries: PageToolEntry[] | undefined): PageToolSpec[] {
  return (entries ?? []).flatMap((entry) =>
    entry.tools.map((tool) => {
      const { _pageTool, _namespace, _instanceId, ...cleanTool } = tool;
      return {
        ...cleanTool,
        namespace: _namespace ?? entry.namespace,
        instanceId: _instanceId ?? entry.instanceId,
      } as PageToolSpec;
    }),
  );
}

function stripExistingPrefix(name: string, namespace: string, instanceId: string): string {
  const instancePrefix = `${namespace}.${instanceId}.`;
  if (instanceId !== "default" && name.startsWith(instancePrefix)) {
    return name.slice(instancePrefix.length);
  }

  const namespacePrefix = `${namespace}.`;
  if (name.startsWith(namespacePrefix)) {
    return name.slice(namespacePrefix.length);
  }

  return name;
}
