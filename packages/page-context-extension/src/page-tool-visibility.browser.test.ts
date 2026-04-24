import { describe, expect, it } from "vitest";

import type { PageToolEntry } from "./page-tool-registry";
import { buildToolTree, getEnabledBuiltinTools, getEnabledToolsForTab, setScopeEnabled } from "./page-tool-visibility";

const builtinTools = [
  { name: "builtin.get_page_info", description: "Get page info" },
  { name: "builtin.navigate", description: "Navigate tab" },
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
    const preferences = setScopeEnabled({}, { tabId: 11, namespace: "beta" }, false, { pageEntries: sampleEntries.get(11)?.filter((entry) => entry.namespace === "beta") });
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
    expect(tree.builtins.namespaces.map((namespace) => namespace.namespace)).toEqual(["builtin"]);
    expect(tree.builtins.namespaces[0]?.instances[0]?.tools.map((tool) => tool.toolName)).toEqual([
      "builtin.get_page_info",
      "builtin.navigate",
    ]);
    expect(tree.tabs[0]?.namespaces[1]?.enabledTools).toBe(0);
    expect(tree.tabs[0]?.namespaces[1]?.instances).toHaveLength(2);
  });

  it("filters built-in tools independently from page tools", () => {
    let preferences = setScopeEnabled({}, { root: "builtin", toolName: "builtin.navigate" }, false);
    preferences = setScopeEnabled(preferences, { root: "builtin" }, true);

    const enabledBuiltins = getEnabledBuiltinTools(builtinTools, preferences).map((tool) => tool.name);
    expect(enabledBuiltins).toEqual(["builtin.get_page_info", "builtin.navigate"]);
  });

  it("marks extension/feedback control tools as bridge-control builtins for sidepanel display hints", () => {
    const tree = buildToolTree(
      [],
      new Map(),
      [
        { name: "extension.get_tool_tree", description: "bridge control", _bridgeControlTool: true },
        { name: "feedback.get_snapshot", description: "bridge control" },
        { name: "builtin.get_page_info", description: "builtin runtime tool" },
      ],
      {},
    );

    expect(tree.builtins.tools.find((tool) => tool.toolName === "extension.get_tool_tree")?.bridgeControl).toBe(true);
    expect(tree.builtins.tools.find((tool) => tool.toolName === "feedback.get_snapshot")?.bridgeControl).toBe(true);
    expect(tree.builtins.tools.find((tool) => tool.toolName === "builtin.get_page_info")?.bridgeControl).toBe(false);
    expect(tree.builtins.namespaces.map((namespace) => namespace.namespace)).toEqual(["builtin", "extension", "feedback"]);
  });

  it("keeps bridge control builtins enabled even when builtin root is disabled", () => {
    const preferences = setScopeEnabled({}, { root: "builtin" }, false, {
      builtinTools: [
        { name: "builtin.get_page_info" },
        { name: "extension.get_tool_tree", _bridgeControlTool: true },
      ],
    });

    const enabledBuiltins = getEnabledBuiltinTools(
      [
        { name: "builtin.get_page_info" },
        { name: "extension.get_tool_tree", _bridgeControlTool: true },
      ],
      preferences,
    ).map((tool) => tool.name);

    expect(enabledBuiltins).toEqual(["extension.get_tool_tree"]);
  });

  it("normalizes legacy builtin aliases to canonical names in builtin tree", () => {
    const tree = buildToolTree(
      [],
      new Map(),
      [
        { name: "navigate", description: "legacy alias" },
        { name: "builtin.navigate", description: "canonical name" },
        { name: "builtin.get_page_info", description: "builtin runtime tool" },
      ],
      {},
    );

    // 期望树中只保留 canonical 名称，避免 alias 与 canonical 重复展示。
    expect(tree.builtins.tools.map((tool) => tool.toolName)).toEqual([
      "builtin.get_page_info",
      "builtin.navigate",
    ]);
    expect(tree.builtins.namespaces.map((namespace) => namespace.namespace)).toEqual(["builtin"]);
    expect(tree.builtins.namespaces[0]?.instances[0]?.tools.map((tool) => tool.toolName)).toEqual([
      "builtin.get_page_info",
      "builtin.navigate",
    ]);
  });

  it("re-enables all descendants when a page parent scope is toggled back on", () => {
    let preferences = setScopeEnabled({}, { tabId: 11, namespace: "alpha", instanceId: "default", toolName: "alpha.read" }, false);
    preferences = setScopeEnabled(preferences, { tabId: 11, namespace: "beta" }, false, { pageEntries: sampleEntries.get(11)?.filter((entry) => entry.namespace === "beta") });
    preferences = setScopeEnabled(preferences, { tabId: 11 }, true, { pageEntries: sampleEntries.get(11) });

    const enabled = getEnabledToolsForTab(sampleEntries.get(11), preferences, 11).map((tool) => tool.name);
    expect(enabled).toEqual(["alpha.inspect", "alpha.read", "beta.instA.run", "beta.instB.inspect"]);
  });

  it("clears nested disabled overrides when toggling namespace scope", () => {
    let preferences = setScopeEnabled({}, { tabId: 11, namespace: "beta", instanceId: "instA", toolName: "beta.instA.run" }, false);
    const betaEntries = sampleEntries.get(11)?.filter((entry) => entry.namespace === "beta");
    preferences = setScopeEnabled(preferences, { tabId: 11, namespace: "beta" }, false, { pageEntries: betaEntries });
    preferences = setScopeEnabled(preferences, { tabId: 11, namespace: "beta" }, true, { pageEntries: betaEntries });

    const enabled = getEnabledToolsForTab(sampleEntries.get(11), preferences, 11).map((tool) => tool.name);
    expect(enabled).toEqual(["alpha.inspect", "alpha.read", "beta.instA.run", "beta.instB.inspect"]);
  });

  it("writes descendant overrides when disabling a namespace with multiple instances", () => {
    const betaEntries = sampleEntries.get(11)?.filter((entry) => entry.namespace === "beta");
    const preferences = setScopeEnabled({}, { tabId: 11, namespace: "beta" }, false, { pageEntries: betaEntries });

    expect(preferences.tabs?.["11"]?.namespaces?.beta).toEqual({
      enabled: false,
      instances: {
        instA: {
          enabled: false,
          tools: {
            "beta.instA.run": false,
          },
        },
        instB: {
          enabled: false,
          tools: {
            "beta.instB.inspect": false,
          },
        },
      },
    });
  });
});
