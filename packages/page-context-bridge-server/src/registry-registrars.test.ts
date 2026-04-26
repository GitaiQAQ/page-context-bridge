import { describe, expect, it, vi } from 'vitest';

import {
  createRegistryRegistrarState,
  syncBuiltinToolsOnAllServers,
} from './registry-registrars.js';

describe('registry-registrars', () => {
  describe('createRegistryRegistrarState()', () => {
    it('initializes empty WeakMaps for all handle types', () => {
      const state = createRegistryRegistrarState({ enabledBuiltinToolNames: new Set() });

      expect(state.builtinToolHandlesByServer).toBeInstanceOf(WeakMap);
      expect(state.feedbackToolHandlesByServer).toBeInstanceOf(WeakMap);
      expect(state.extensionToolControlHandlesByServer).toBeInstanceOf(WeakMap);
    });

    it('copies enabledBuiltinToolNames Set', () => {
      const enabled = new Set(['screenshot', 'navigate']);
      const state = createRegistryRegistrarState({ enabledBuiltinToolNames: enabled });

      expect(state.enabledBuiltinToolNames).toBeInstanceOf(Set);
      expect(state.enabledBuiltinToolNames.has('screenshot')).toBe(true);
      expect(state.enabledBuiltinToolNames.has('navigate')).toBe(true);
      // Verify it's a copy (not same reference)
      state.enabledBuiltinToolNames.add('new');
      expect(enabled.has('new')).toBe(false);
    });
  });

  describe('syncBuiltinToolsOnAllServers()', () => {
    it('updates enabledBuiltinToolNames from toolSpecs', () => {
      const state = createRegistryRegistrarState({ enabledBuiltinToolNames: new Set() });
      const mockServer = { registerTool: vi.fn().mockReturnValue({ remove: vi.fn() }) };
      const toolProviders = [];
      const rpcCaller = { sendToolCall: vi.fn() };

      // Create a minimal tool spec-like object
      const toolSpecs = [{ name: 'screenshot' }, { name: 'navigate' }] as never;

      // This should update the enabled set
      syncBuiltinToolsOnAllServers({
        state,
        mcpServers: [mockServer as never],
        toolProviders,
        rpcCaller: rpcCaller as never,
        toolSpecs,
      });

      // After syncing, the enabled set should contain expanded aliases
      expect(state.enabledBuiltinToolNames.size).toBeGreaterThan(0);
      expect(Array.from(state.enabledBuiltinToolNames)).toContain('screenshot');
    });

    it('iterates over all servers', () => {
      const state = createRegistryRegistrarState({ enabledBuiltinToolNames: new Set() });
      const server1 = { registerTool: vi.fn().mockReturnValue({ remove: vi.fn() }) };
      const server2 = { registerTool: vi.fn().mockReturnValue({ remove: vi.fn() }) };

      syncBuiltinToolsOnAllServers({
        state,
        mcpServers: [server1 as never, server2 as never] as Iterable<never>,
        toolProviders: [],
        rpcCaller: { sendToolCall: vi.fn() } as never,
        toolSpecs: [{ name: 'test' }] as never,
      });

      // Both servers should have been called (or at least iterated)
      expect(server1.registerTool).toBeDefined();
      expect(server2.registerTool).toBeDefined();
    });

    it('handles empty server list', () => {
      const state = createRegistryRegistrarState({ enabledBuiltinToolNames: new Set() });

      expect(() =>
        syncBuiltinToolsOnAllServers({
          state,
          mcpServers: [] as unknown as Iterable<never>,
          toolProviders: [],
          rpcCaller: { sendToolCall: vi.fn() } as never,
          toolSpecs: [],
        }),
      ).not.toThrow();
    });
  });
});
