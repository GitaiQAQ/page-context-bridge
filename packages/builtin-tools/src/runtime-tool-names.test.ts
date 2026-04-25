import { describe, expect, it } from "vitest";

import {
  BUILTIN_RUNTIME_NAMESPACE,
  builtinRuntimeToolName,
} from "./runtime-tool-names.js";

describe("BUILTIN_RUNTIME_NAMESPACE", () => {
  it('is "builtin"', () => {
    expect(BUILTIN_RUNTIME_NAMESPACE).toBe("builtin");
  });
});

describe("builtinRuntimeToolName", () => {
  it("produces canonical namespaced tool names", () => {
    expect(builtinRuntimeToolName("list_tabs")).toBe("builtin.list_tabs");
    expect(builtinRuntimeToolName("navigate")).toBe("builtin.navigate");
    expect(builtinRuntimeToolName("screenshot_tab")).toBe("builtin.screenshot_tab");
    expect(builtinRuntimeToolName("press_key")).toBe("builtin.press_key");
  });

  it("prefixes all names with builtin.', () => {
    expect(builtinRuntimeToolName("custom")).toBe("builtin.custom");
    expect(builtinRuntimeToolName("")).toBe("builtin.");
    expect(builtinRuntimeToolName("tool.name")).toBe("builtin.tool.name");
  });

  it("covers all expected tool categories", () => {
    const navigationTools = ["navigate", "wait_for_navigation", "reload", "go_back", "go_forward"];
    const tabTools = ["open_tab", "close_tab"];
    const domTools = ["click_element", "fill_input", "execute_js", "query_elements",
      "get_element_text", "get_element_html", "scroll_into_view", "wait_for_selector"];
    const inputTools = ["press_key", "type_text"];
    const infoTools = ["list_tabs", "get_page_info", "get_selected_text"];
    const captureTools = ["screenshot_tab", "screenshot_page", "get_console_logs"];

    for (const tool of [...navigationTools, ...tabTools, ...domTools, ...inputTools, ...infoTools, ...captureTools]) {
      expect(builtinRuntimeToolName(tool)).toBe(`builtin.${tool}`);
    }
  });
});
