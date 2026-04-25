import { describe, expect, it, vi } from "vitest";

import { ExtensionControlBridgeProvider, EXTENSION_CONTROL_TOOL_SUFFIXES } from "./extension-control-bridge-provider.js";

describe("ExtensionControlBridgeProvider", () => {
  function createRpc(overrides?: Record<string, unknown>) {
    return {
      getRuntimeStatus: vi.fn().mockResolvedValue({ ok: true, connected: true }),
      reconnectExtension: vi.fn().mockResolvedValue({ ok: true }),
      getContextManifestDebug: vi.fn().mockResolvedValue({}),
      getPageToolsTree: vi.fn().mockResolvedValue({}),
      setPageToolsEnabledBatch: vi.fn().mockResolvedValue({}),
      refreshPageToolsForTab: vi.fn().mockResolvedValue({ tools: [], manifest: null }),
      debugToolCall: vi.fn().mockResolvedValue({ ok: true, result: {} }),
      ensureMainWorldHost: vi.fn().mockResolvedValue({ ok: true }),
      ensureAgentationMain: vi.fn().mockResolvedValue({ ok: true }),
      normalizePageToolName: vi.fn(),
      ...overrides,
    };
  }

  describe("constructor options", () => {
    it("defaults namespace to 'extension'", () => {
      const p = new ExtensionControlBridgeProvider();
      const names = p.getToolNames();
      expect(names.getRuntimeStatus).toBe("extension.get_runtime_status");
    });

    it("uses custom namespace when provided", () => {
      const p = new ExtensionControlBridgeProvider({ namespace: "custom" } as never);
      const names = p.getToolNames();
      expect(names.getRuntimeStatus).toBe("custom.get_runtime_status");
    });
  });

    it("includes all 10 tool suffixes", () => {
      const p = new ExtensionControlBridgeProvider();
      const names = p.getToolNames();
      const suffixes = Object.values(EXTENSION_CONTROL_TOOL_SUFFIXES);
      expect(Object.keys(names)).toHaveLength(suffixes.length);
      for (const [key, value] of Object.entries(EXTENSION_CONTROL_TOOL_SUFFIXES)) {
        expect(names[key]).toBe(`extension.${value}`);
      }
    });
  });

  describe("registerOnBridge", () => {
    it("registers all 10 primary", () => {
      const p = new ExtensionControlBridgeProvider();
      const registerTool = vi.fn((name) => ({ remove: vi.fn() }));
      const rpc = createRpc();
      const handles = p.registerOnBridge(registerTool, rpc);

      expect(handles.size).toBe(10);
      expect(handles.has("extension.get_runtime_status")).toBe(true);
      expect(handles.has("extension.reconnect")).toBe(true);
    });
  });
});
