import { describe, expect, it } from "vitest";

import type { PageContextManifest } from "@page-context/shared-protocol";

import { buildContextManifestFilterDebug } from "./context-manifest-filter-debug.js";

const rawManifest: PageContextManifest = {
  version: "0.1.0",
  app: "demo",
  route: "/checkout",
  scene: "checkout",
  generatedAt: "2026-01-01T00:00:00.000Z",
  namespaces: [
    { namespace: "page", title: "Page" },
    { namespace: "catalog", title: "Catalog" },
  ],
  resources: [
    { id: "page.summary", namespace: "page", title: "Page summary" },
    { id: "catalog.items", namespace: "catalog", title: "Catalog items" },
  ],
  skills: [
    {
      id: "page.inspect",
      namespace: "page",
      title: "Inspect",
      description: "Inspect page",
      toolNames: ["get_page_info", "catalog.primary.getItems"],
    },
    {
      id: "catalog.manage",
      namespace: "catalog",
      title: "Catalog",
      description: "Manage catalog",
      toolNames: ["catalog.primary.getItems", "catalog.secondary.seedItems"],
    },
  ],
};

describe("buildContextManifestFilterDebug", () => {
  it("classifies namespace and tool trimming reasons", () => {
    const effectiveManifest: PageContextManifest = {
      ...rawManifest,
      namespaces: [{ namespace: "page", title: "Page" }],
      resources: [{ id: "page.summary", namespace: "page", title: "Page summary" }],
      skills: [
        {
          id: "page.inspect",
          namespace: "page",
          title: "Inspect",
          description: "Inspect page",
          toolNames: ["get_page_info"],
        },
      ],
    };

    const debug = buildContextManifestFilterDebug(
      rawManifest,
      effectiveManifest,
      new Set<string>(),
      new Set(["get_page_info"]),
    );

    expect(debug.hiddenNamespaces).toEqual([{ id: "catalog", reason: "namespace_disabled" }]);
    expect(debug.hiddenResources).toEqual([{ id: "catalog.items", reason: "namespace_disabled" }]);
    expect(debug.hiddenSkills).toEqual([{ id: "catalog.manage", reason: "namespace_disabled" }]);
    expect(debug.trimmedSkillTools).toEqual([
      {
        skillId: "page.inspect",
        removedTools: [{ id: "catalog.primary.getItems", reason: "page_tool_disabled" }],
      },
    ]);
  });
});
