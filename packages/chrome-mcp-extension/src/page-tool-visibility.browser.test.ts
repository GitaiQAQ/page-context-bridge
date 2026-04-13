import { describe, expect, it } from "vitest";

import type { PageToolEntry } from "./page-tool-registry.js";
import { buildToolTree, getEnabledBuiltinTools, getEnabledToolsForTab, setScopeEnabled } from "./page-tool-visibility.js";

const builtinTools = [
  { name: "get_page_info", description: "Get page info" },
  { name: "navigate", description: "Navigate tab" },
];

const sampleEntries = new Map<number, PageToolEntry[]>([
  [
    11,
    [
      {
        namespace: "alpha",
        instanceId: "default",
        tools: [{ name: "alpha.inspect" }, { name: "alpha.read" }],
      },
      {
        namespace: "beta",
        instanceId: "instA",
        tools: [{ name: "beta.instA.run" }],
      },
      {
        namespace: "beta",
        instanceId: "instB",
        tools: [{ name: "beta.instB.inspect" }],
      },
    ],
  ],
]);

describe("page tool visibility", () => {
  it("filters enabled tools by tab / namespace / instance / tool scope", () => {
    let preferences = setScopeEnabled({}, { tabId: 11, namespace: "alpha", instanceId: "default", toolName: "alpha.read" }, false);
    preferences = setScopeEnabled(preferences, { tabId: 11, namespace: "beta" }, false);

    const enabled = getEnabledToolsForTab(sampleEntries.get(11), preferences, 11).map((tool) => tool.name);
    expect(enabled).toEqual(["alpha.inspect"]);
  });

  it("builds tree counts with enabled totals", () => {
    const preferences = setScopeEnabled({}, { tabId: 11, namespace: "beta" }, false);
    const tree = buildToolTree(
      [{ id: 11, title: "Demo", url: "https://example.com", active: true }],
      sampleEntries,
      builtinTools,
      preferences,
    );

    expect(tree.totalTools).toBe(6);
    expect(tree.enabledTools).toBe(4);
    expect(tree.builtins.totalTools).toBe(2);
    expect(tree.builtins.enabledTools).toBe(2);
    expect(tree.tabs[0]?.namespaces[1]?.enabledTools).toBe(0);
    expect(tree.tabs[0]?.namespaces[1]?.instances).toHaveLength(2);
  });

  it("filters built-in tools independently from page tools", () => {
    let preferences = setScopeEnabled({}, { root: "builtin", toolName: "navigate" }, false);
    preferences = setScopeEnabled(preferences, { root: "builtin" }, true);

    const enabledBuiltins = getEnabledBuiltinTools(builtinTools, preferences).map((tool) => tool.name);
    expect(enabledBuiltins).toEqual(["get_page_info"]);
  });
});
