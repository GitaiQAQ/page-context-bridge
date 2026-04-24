import { describe, expect, it } from "vitest";

import { filterBuiltinTools } from "./builtin-tool-filtering";
import { setScopeEnabled } from "./page-tool-visibility";

describe("builtin tool filtering", () => {
  it("removes disabled built-in tools from injection set", () => {
    const tools = [
      { name: "builtin.list_tabs", description: "List tabs" },
      { name: "builtin.navigate", description: "Navigate" },
      { name: "builtin.get_page_info", description: "Page info" },
    ];

    let preferences = setScopeEnabled({}, { root: "builtin", toolName: "builtin.navigate" }, false);
    preferences = setScopeEnabled(preferences, { root: "builtin", toolName: "builtin.list_tabs" }, false);

    expect(filterBuiltinTools(tools, preferences).map((tool) => tool.name)).toEqual(["builtin.get_page_info"]);
  });
});
