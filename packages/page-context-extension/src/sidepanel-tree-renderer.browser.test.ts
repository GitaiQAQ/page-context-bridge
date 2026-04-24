import { describe, expect, it } from "vitest";

import { filterBuiltins } from "./sidepanel-tree-renderer";
import type { ToolTreeBuiltins } from "./sidepanel-types";

describe("sidepanel builtin filtering", () => {
  it("keeps namespaced builtin/control tools discoverable via unified filter", () => {
    const builtins: ToolTreeBuiltins = {
      kind: "builtins",
      totalTools: 3,
      enabledTools: 3,
      tools: [
        { kind: "builtin-tool", toolName: "builtin.get_page_info", label: "builtin.get_page_info", enabled: true, readOnly: true, bridgeControl: false },
        { kind: "builtin-tool", toolName: "extension.get_runtime_status", label: "extension.get_runtime_status", enabled: true, readOnly: true, bridgeControl: true },
        { kind: "builtin-tool", toolName: "feedback.get_snapshot", label: "feedback.get_snapshot", enabled: true, readOnly: true, bridgeControl: true },
      ],
    };

    const filtered = filterBuiltins(builtins, "feedback.get_snapshot");
    expect(filtered.totalTools).toBe(1);
    expect(filtered.tools[0]?.toolName).toBe("feedback.get_snapshot");
  });

  it("returns all builtin entries when query is empty", () => {
    const builtins: ToolTreeBuiltins = {
      kind: "builtins",
      totalTools: 2,
      enabledTools: 2,
      tools: [
        { kind: "builtin-tool", toolName: "builtin.navigate", label: "builtin.navigate", enabled: true, readOnly: false, bridgeControl: false },
        { kind: "builtin-tool", toolName: "extension.reconnect", label: "extension.reconnect", enabled: true, readOnly: false, bridgeControl: true },
      ],
    };

    const filtered = filterBuiltins(builtins, "");
    expect(filtered.totalTools).toBe(2);
    expect(filtered.tools.map((tool) => tool.toolName)).toEqual(["builtin.navigate", "extension.reconnect"]);
  });
});
