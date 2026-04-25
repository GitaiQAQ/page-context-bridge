import { describe, expect, it } from "vitest";

import { collectBridgeControlToolSpecs, type BridgeControlToolSpec } from "./control-tool-specs.js";

describe("collectBridgeControlToolSpecs", () => {
  it("returns sorted array of specs", () => {
    const specs = collectBridgeControlToolSpecs();
    expect(Array.isArray(specs)).toBe(true);
    expect(specs.length).toBeGreaterThan(0);

    // Verify sorting
    for (let i = 1; i < specs.length; i++) {
      expect(specs[i - 1].name.localeCompare(specs[i].name)).toBeLessThanOrEqual(0);
    }
  });

  it("marks all specs as bridge control tools", () => {
    const specs = collectBridgeControlToolSpecs();
    for (const spec of specs) {
      expect(spec._bridgeControlTool).toBe(true);
    }
  });

  it("includes extension control tools", () => {
    const specs = collectBridgeControlSpecs();
    const names = specs.map((s) => s.name);
    expect(names).toContain("extension.get_runtime_status");
    expect(names).toContain("extension.reconnect");
    expect(names).toContain("extension.get_context_manifest_debug");
    expect(names).toContain("extension.get_tool_tree");
    expect(names).toContain("extension.set_tools_enabled");
    expect(names).toContain("extension.refresh_page_tools");
    expect(names).toContain("extension.prepare_tab_for_debug");
    expect(names).toContain("extension.tool_debug_call");
    expect(names).toContain("extension.ensure_main_world_host");
    expect(names).toContain("extension.ensure_agentation_main");
  });

  it("includes feedback control tools", () => {
    const specs = collectBridgeControlSpecs();
    const names = specs.map((s) => s.name);
    expect(names).toContain("feedback.get_snapshot");
    expect(names).toContain("feedback.watch_events");
    expect(names).toContain("feedback.create_annotation");
    expect(names).toContain("feedback.update_annotation");
    expect(names).toContain("feedback.claim");
    expect(names).toContain("feedback.reply");
    expect(names).toContain("feedback.resolve");
    expect(names).toContain("feedback.dismiss");
  });

  it("excludes flat (non-namespaced) tool names", () => {
    const specs = collectBridgeControlSpecs();
    const names = specs.map((s) => s.name);
    // All bridge control tools should have dots (namespace.pattern)
    for (const name of names) {
      expect(name.includes(".")).toBe(true);
    }
  });

  it("each spec has required shape", () => {
    const specs = collectBridgeControlControlToolSpecs();
    for (const spec of specs) {
      expect(spec).toHaveProperty("name");
      expect(spec).toHaveProperty("description");
      expect(spec).toHaveProperty("inputSchema");
      expect(typeof spec.name).toBe("string");
      expect(typeof spec.description).toBe("string");
      expect(typeof spec.inputSchema).toBe("object");
    }
  });
});
