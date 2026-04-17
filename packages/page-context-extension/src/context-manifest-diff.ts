import type { PageContextManifest } from "@page-context/shared-protocol";

export interface ContextManifestDiff {
  rawNamespaces: number;
  effectiveNamespaces: number;
  hiddenNamespaces: string[];
  rawResources: number;
  effectiveResources: number;
  hiddenResources: string[];
  rawSkills: number;
  effectiveSkills: number;
  hiddenSkills: string[];
  sceneChanged: boolean;
}

export function buildContextManifestDiff(rawManifest: PageContextManifest | null, effectiveManifest: PageContextManifest | null): ContextManifestDiff {
  const rawNamespaces = rawManifest?.namespaces.map((entry) => entry.namespace) ?? [];
  const effectiveNamespaces = effectiveManifest?.namespaces.map((entry) => entry.namespace) ?? [];
  const rawResources = rawManifest?.resources.map((entry) => entry.id) ?? [];
  const effectiveResources = effectiveManifest?.resources.map((entry) => entry.id) ?? [];
  const rawSkills = rawManifest?.skills.map((entry) => entry.id) ?? [];
  const effectiveSkills = effectiveManifest?.skills.map((entry) => entry.id) ?? [];

  return {
    rawNamespaces: rawNamespaces.length,
    effectiveNamespaces: effectiveNamespaces.length,
    hiddenNamespaces: diff(rawNamespaces, effectiveNamespaces),
    rawResources: rawResources.length,
    effectiveResources: effectiveResources.length,
    hiddenResources: diff(rawResources, effectiveResources),
    rawSkills: rawSkills.length,
    effectiveSkills: effectiveSkills.length,
    hiddenSkills: diff(rawSkills, effectiveSkills),
    sceneChanged: (rawManifest?.scene ?? "") !== (effectiveManifest?.scene ?? ""),
  };
}

function diff(rawItems: string[], effectiveItems: string[]): string[] {
  const effectiveSet = new Set(effectiveItems);
  return rawItems.filter((item) => !effectiveSet.has(item));
}
