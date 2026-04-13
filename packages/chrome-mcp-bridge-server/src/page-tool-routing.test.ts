import { describe, expect, it } from "vitest";

import { buildRegisteredPageToolName, createRoutedPageTool } from "./page-tool-routing.js";

describe("page tool routing", () => {
  it("adds tab scope to registered tool names", () => {
    expect(buildRegisteredPageToolName(12, "alpha.inspect")).toBe("tab.12.alpha.inspect");
  });

  it("keeps same actual tool name while disambiguating registrations across tabs", () => {
    const first = createRoutedPageTool(1, "alpha.inspect");
    const second = createRoutedPageTool(2, "alpha.inspect");

    expect(first.actualToolName).toBe("alpha.inspect");
    expect(second.actualToolName).toBe("alpha.inspect");
    expect(first.registeredToolName).not.toBe(second.registeredToolName);
  });
});
