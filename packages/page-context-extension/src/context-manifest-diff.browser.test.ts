import { describe, expect, it } from "vitest";

import type { PageContextManifest } from "@page-context/shared-protocol";

import { buildContextManifestDiff } from "./context-manifest-diff";

const rawManifest: PageContextManifest = {
  version: "0.1.0",
  app: "demo",
  route: "/checkout",
  scene: "checkout",
  generatedAt: "2026-01-01T00:00:00.000Z",
  namespaces: [
    { namespace: "page", title: "Page" },
    { namespace: "catalog", title: "Catalog" },
    { namespace: "qa", title: "QA" },
  ],
  resources: [
    { id: "page.summary", namespace: "page", title: "Page" },
    { id: "catalog.items", namespace: "catalog", title: "Catalog" },
  ],
  skills: [
    { id: "page.inspect", namespace: "page", title: "Inspect", description: "Inspect page" },
    { id: "qa.run", namespace: "qa", title: "Run QA", description: "Run qa" },
  ],
};

describe("buildContextManifestDiff", () => {
  it("reports hidden namespaces, resources, and skills", () => {
    const effectiveManifest: PageContextManifest = {
      ...rawManifest,
      namespaces: [{ namespace: "page", title: "Page" }],
      resources: [{ id: "page.summary", namespace: "page", title: "Page" }],
      skills: [{ id: "page.inspect", namespace: "page", title: "Inspect", description: "Inspect page" }],
    };

    const diff = buildContextManifestDiff(rawManifest, effectiveManifest);

    expect(diff.hiddenNamespaces).toEqual(["catalog", "qa"]);
    expect(diff.hiddenResources).toEqual(["catalog.items"]);
    expect(diff.hiddenSkills).toEqual(["qa.run"]);
    expect(diff.rawNamespaces).toBe(3);
    expect(diff.effectiveNamespaces).toBe(1);
  });
});
