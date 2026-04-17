import type { PageContextManifest } from "@page-context/shared-protocol";

export type ContextFilterReason = "namespace_disabled" | "builtin_tool_disabled" | "page_tool_disabled" | "scene_filtered" | "unknown";

export interface ContextFilterDebugItem {
  id: string;
  reason: ContextFilterReason;
}

export interface ContextSkillToolTrimDebug {
  skillId: string;
  removedTools: ContextFilterDebugItem[];
}

export interface ContextManifestFilterDebug {
  hiddenNamespaces: ContextFilterDebugItem[];
  hiddenResources: ContextFilterDebugItem[];
  hiddenSkills: ContextFilterDebugItem[];
  trimmedSkillTools: ContextSkillToolTrimDebug[];
  sceneChanged: boolean;
}

export function buildContextManifestFilterDebug(
  rawManifest: PageContextManifest | null,
  effectiveManifest: PageContextManifest | null,
  enabledPageToolNames: Set<string>,
  enabledBuiltinToolNames: Set<string>,
): ContextManifestFilterDebug {
  const rawNamespaces = rawManifest?.namespaces ?? [];
  const effectiveNamespaces = new Set((effectiveManifest?.namespaces ?? []).map((entry) => entry.namespace));
  const hiddenNamespaces = rawNamespaces
    .filter((entry) => !effectiveNamespaces.has(entry.namespace))
    .map((entry) => ({ id: entry.namespace, reason: "namespace_disabled" as const }));
  const hiddenNamespaceSet = new Set(hiddenNamespaces.map((entry) => entry.id));

  const rawResources = rawManifest?.resources ?? [];
  const effectiveResources = new Set((effectiveManifest?.resources ?? []).map((entry) => entry.id));
  const hiddenResources = rawResources
    .filter((entry) => !effectiveResources.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      reason: hiddenNamespaceSet.has(entry.namespace) ? "namespace_disabled" as const : "unknown" as const,
    }));

  const rawSkills = rawManifest?.skills ?? [];
  const effectiveSkills = new Map((effectiveManifest?.skills ?? []).map((entry) => [entry.id, entry]));
  const hiddenSkills = rawSkills
    .filter((entry) => !effectiveSkills.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      reason: hiddenNamespaceSet.has(entry.namespace) ? "namespace_disabled" as const : "unknown" as const,
    }));

  const trimmedSkillTools = rawSkills
    .map((entry) => {
      const effective = effectiveSkills.get(entry.id);
      if (!effective) {
        return null;
      }
      const effectiveTools = new Set(effective.toolNames ?? []);
      const removedTools = (entry.toolNames ?? [])
        .filter((toolName) => !effectiveTools.has(toolName))
        .map((toolName) => ({
          id: toolName,
          reason: classifyToolReason(toolName, enabledPageToolNames, enabledBuiltinToolNames),
        }));
      if (removedTools.length === 0) {
        return null;
      }
      return {
        skillId: entry.id,
        removedTools,
      };
    })
    .filter((entry): entry is ContextSkillToolTrimDebug => entry !== null);

  return {
    hiddenNamespaces,
    hiddenResources,
    hiddenSkills,
    trimmedSkillTools,
    sceneChanged: (rawManifest?.scene ?? "") !== (effectiveManifest?.scene ?? ""),
  };
}

function classifyToolReason(toolName: string, enabledPageToolNames: Set<string>, enabledBuiltinToolNames: Set<string>): ContextFilterReason {
  if (toolName.includes(".")) {
    return enabledPageToolNames.has(toolName) ? "unknown" : "page_tool_disabled";
  }
  return enabledBuiltinToolNames.has(toolName) ? "unknown" : "builtin_tool_disabled";
}
