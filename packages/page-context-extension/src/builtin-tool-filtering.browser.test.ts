import { describe, expect, it } from "vitest";

import { filterBuiltinTools } from "./builtin-tool-filtering";
import { setScopeEnabled } from "./page-tool-visibility";

describe("builtin tool filtering", () => {
  it("removes disabled built-in tools from injection set", () => {
    const tools = [
      { name: "list_tabs", description: "List tabs" },
      { name: "navigate", description: "Navigate" },
      { name: "get_page_info", description: "Page info" },
    ];

    let preferences = setScopeEnabled({}, { root: "builtin", toolName: "navigate" }, false);
    preferences = setScopeEnabled(preferences, { root: "builtin", toolName: "list_tabs" }, false);

    expect(filterBuiltinTools(tools, preferences).map((tool) => tool.name)).toEqual(["get_page_info"]);
  });
});
