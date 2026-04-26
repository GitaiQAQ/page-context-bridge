import { describe, expect, it, vi } from 'vitest';

import { BuiltinBridgeProvider } from './bridge-provider.js';

describe('BuiltinBridgeProvider', () => {
  let provider: BuiltinBridgeProvider;
  let sendToExtension: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendToExtension = vi.fn().mockResolvedValue({ text: 'ok' });
    provider = new BuiltinBridgeProvider(sendToExtension);
  });

  it("has id 'builtin'", () => {
    expect(provider.id).toBe('builtin');
  });

  it('returns tool specs via getToolSpecs()', () => {
    const specs = provider.getToolSpecs();
    expect(Array.isArray(specs)).toBe(true);
    expect(specs.length).toBeGreaterThan(20);

    // All specs should use canonical namespaced names
    for (const spec of specs) {
      expect(spec.name).toMatch(/^builtin\./);
    }
  });

  it('registers canonical handles via registerOnBridge()', () => {
    const registerTool = vi.fn((name) => ({ remove: vi.fn() }));
    const rpc = {
      sendToExtension: vi.fn().mockResolvedValue({ text: 'result' }),
    } as never;

    const handles = provider.registerOnBridge(registerTool, rpc);

    // Should register canonical names only
    expect(handles.has('builtin.list_tabs')).toBe(true);
    expect(handles.has('builtin.navigate')).toBe(true);
  });
});
