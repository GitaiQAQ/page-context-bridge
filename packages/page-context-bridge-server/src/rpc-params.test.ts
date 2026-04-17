import { describe, it, expect } from "vitest";
import {
  validateParams,
  sessionRegisterParamsSchema,
  bridgePageToolsRegisteredParamsSchema,
  bridgePageToolsUnregisteredParamsSchema,
  extensionPageToolsSetEnabledParamsSchema,
  bridgeToolCallParamsSchema,
} from "./rpc-params.js";

describe("rpc-params: validateParams", () => {
  it("validates and returns parsed params for valid input", () => {
    const result = validateParams(
      sessionRegisterParamsSchema,
      { extensionId: "ext-123", version: "0.1.0" },
      "session.register"
    );
    expect(result).toEqual({ extensionId: "ext-123", version: "0.1.0" });
  });

  it("allows optional fields to be missing", () => {
    const result = validateParams(
      sessionRegisterParamsSchema,
      {},
      "session.register"
    );
    expect(result).toEqual({});
  });

  it("throws descriptive error for invalid field type", () => {
    expect(() =>
      validateParams(
        bridgePageToolsUnregisteredParamsSchema,
        { tabId: "not-a-number" },
        "bridge.pageTools.unregistered"
      )
    ).toThrow(/Invalid params for bridge.pageTools.unregistered/);
  });

  it("validates bridgePageToolsRegisteredParamsSchema with tools array", () => {
    const result = validateParams(
      bridgePageToolsRegisteredParamsSchema,
      { tabId: 42, tools: [{ name: "getItems" }] },
      "bridge.pageTools.registered"
    );
    expect(result.tabId).toBe(42);
    expect(result.tools).toEqual([{ name: "getItems" }]);
  });

  it("validates extensionPageToolsSetEnabledParamsSchema", () => {
    const result = validateParams(
      extensionPageToolsSetEnabledParamsSchema,
      { root: "builtin", enabled: true },
      "extension.pageTools.setEnabled"
    );
    expect(result.root).toBe("builtin");
    expect(result.enabled).toBe(true);
  });

  it("rejects invalid enum value", () => {
    expect(() =>
      validateParams(
        extensionPageToolsSetEnabledParamsSchema,
        { root: "invalid", enabled: true },
        "extension.pageTools.setEnabled"
      )
    ).toThrow(/Invalid params/);
  });

  it("validates bridgeToolCallParamsSchema with required tool field", () => {
    const result = validateParams(
      bridgeToolCallParamsSchema,
      { tool: "get_page_info", args: { selector: "h1" }, tabId: 5 },
      "bridge.tool.call"
    );
    expect(result.tool).toBe("get_page_info");
  });

  it("rejects missing required field", () => {
    expect(() =>
      validateParams(
        bridgeToolCallParamsSchema,
        { args: {} },
        "bridge.tool.call"
      )
    ).toThrow(/Invalid params/);
  });

  it("handles null params gracefully", () => {
    expect(() =>
      validateParams(
        bridgePageToolsUnregisteredParamsSchema,
        null,
        "bridge.pageTools.unregistered"
      )
    ).toThrow(/Invalid params/);
  });
});
