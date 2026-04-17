import { beforeEach, describe, expect, it } from "vitest";

import { executeContentScriptTool } from "@page-context/builtin-tools";
import { bootstrapExamplePage } from "./example-page-core";

function mountFixture(): void {
  document.body.innerHTML = `
    <div id="tools-status"></div>
    <div id="registry-summary"></div>
    <div id="fixture-status"></div>
    <div id="items-count"></div>
    <div id="counter-value"></div>
    <div id="selection-preview"></div>
    <div id="test-result"></div>
    <div id="qa-results"></div>
    <div id="log-area"></div>
    <ul id="items-list"></ul>
    <input id="new-item-input" />
    <button id="add-item-btn"></button>
    <button id="clear-items-btn"></button>
    <button id="counter-inc"></button>
    <button id="counter-dec"></button>
    <button id="counter-reset"></button>
    <button id="counter-set"></button>
    <input id="full-name-input" value="Page Context Demo User" />
    <input id="email-input" value="demo@example.com" />
    <select id="role-select"><option value="analyst">analyst</option><option value="developer">developer</option><option value="reviewer">reviewer</option></select>
    <textarea id="notes-input">Selection target and form fixture.</textarea>
    <pre id="profile-preview"></pre>
    <button id="profile-apply-btn"></button>
    <button id="fixture-reset-btn"></button>
    <button id="qa-run-suite-btn"></button>
    <button id="test-page-info"></button>
    <button id="test-selected-text"></button>
    <button id="test-query-h1"></button>
    <button id="test-execute-js"></button>
    <button id="test-console-logs"></button>
    <button id="test-screenshot"></button>
    <button id="test-page-tool-suite"></button>
    <h1>Page Context Bridge - Test Page</h1>
    <h2>Interactive Controls</h2>
    <p id="selection-target">Selection target text for bridge tests.</p>
  `;
  document.title = "Page Context Bridge - Test Page";
}

describe("example page", () => {
  beforeEach(() => {
    mountFixture();
  });

  it("registers versioned page tools with multiple namespaces and instances", () => {
    const { pageTools, runSelfTestSuite } = bootstrapExamplePage(window, document);

    expect(pageTools.listNamespaces()).toEqual(["page", "catalog", "form", "metrics", "qa"]);
    expect(pageTools.getNamespace("catalog")?.listInstances()).toEqual(["primary", "secondary"]);
    expect(pageTools.getNamespace("catalog")?.getInstance("primary")?.listTools().map((tool) => tool.name)).toContain("getItems");
    expect(pageTools.getNamespace("catalog")?.getInstance("secondary")?.listTools().map((tool) => tool.name)).toContain("getItems");

    const summary = runSelfTestSuite();
    expect(summary.ok).toBe(true);
    expect(summary.total).toBeGreaterThanOrEqual(7);
  });

  it("routes same-namespace same-tool-name calls to the correct instance", () => {
    const { pageTools } = bootstrapExamplePage(window, document);
    const secondaryGetItems = (window as Window & { __PAGE_CONTEXT_BRIDGE_TEST__?: (tool: string, args?: Record<string, unknown>) => unknown }).__PAGE_CONTEXT_BRIDGE_TEST__;

    const primary = secondaryGetItems?.("catalog.primary.getItems") as { items: string[]; total: number };
    const secondary = secondaryGetItems?.("catalog.secondary.getItems") as { instanceId: string; items: string[]; total: number };
    const summary = secondaryGetItems?.("catalog.secondary.getInstanceSummary") as { instanceId: string; canSeed: boolean };

    expect(pageTools.getNamespace("catalog")?.listInstances()).toEqual(["primary", "secondary"]);
    expect(primary.total).toBe(2);
    expect(secondary.total).toBe(2);
    expect(secondary.instanceId).toBe("secondary");
    expect(summary).toMatchObject({ instanceId: "secondary", canSeed: true });
  });

  it("supports built-in tools against the example fixture", () => {
    bootstrapExamplePage(window, document);

    const environment = { win: window, doc: document, consoleEntries: [] };
    expect(executeContentScriptTool("get_page_info", {}, environment)).toMatchObject({ title: "Page Context Bridge - Test Page" });
    expect(executeContentScriptTool("query_elements", { selector: "#items-list li" }, environment)).toMatchObject({ count: 2 });
    expect(executeContentScriptTool("fill_input", { selector: "#full-name-input", value: "Trae QA" }, environment)).toMatchObject({ filled: true });
    expect(executeContentScriptTool("get_element_text", { selector: "#selection-target" }, environment)).toMatchObject({ text: "Selection target text for bridge tests." });
  });

  it("exposes manifest, resources, and skill prompts for bridge compilation", () => {
    const { pageTools } = bootstrapExamplePage(window, document);

    const manifest = pageTools.getManifest();
    expect(manifest.scene).toBe("example-fixture");
    expect(manifest.resources.map((resource) => resource.id)).toContain("page.summary");
    expect(manifest.skills.map((skill) => skill.id)).toContain("catalog.manage-items");

    const resource = pageTools.readResource("catalog.items");
    expect(resource.id).toBe("catalog.items");
    expect(resource.text).toContain("Initial item 1");

    const prompt = pageTools.getSkill("form.update-profile", { goal: "Update form and confirm preview" });
    expect(prompt?.skill.namespace).toBe("form");
    expect(prompt?.text).toContain("Goal: Update form and confirm preview");
    expect(prompt?.text).toContain("Allowed tools");
  });
});
