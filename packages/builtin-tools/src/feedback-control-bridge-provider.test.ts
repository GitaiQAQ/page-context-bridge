import { describe, expect, it, vi } from 'vitest';

import {
  FeedbackControlBridgeProvider,
  FEEDBACK_CONTROL_TOOL_SUFFIXES,
} from './feedback-control-bridge-provider.js';

describe('FeedbackControlBridgeProvider', () => {
  function createRpc(overrides?: Record<string, unknown>) {
    return {
      getFeedbackSnapshot: vi
        .fn()
        .mockResolvedValue({ sessions: [], annotations: [], snapshotVersion: 0 }),
      getFeedbackDelta: vi.fn().mockResolvedValue({ events: [] }),
      createFeedbackAnnotation: vi.fn().mockResolvedValue({ id: 'a1' }),
      updateFeedbackAnnotation: vi.fn().mockResolvedValue({ id: 'a1' }),
      claimFeedbackAnnotation: vi.fn().mockResolvedValue({ id: 'a1' }),
      replyFeedbackAnnotation: vi.fn().mockResolvedValue({ id: 'a1' }),
      resolveFeedbackAnnotation: vi.fn().mockResolvedValue({ id: 'a1' }),
      dismissFeedbackAnnotation: vi.fn().mockResolvedValue({ id: 'a1' }),
      ...overrides,
    };
  }

  describe('constructor options', () => {
    it("defaults namespace to 'feedback'", () => {
      const p = new FeedbackControlBridgeProvider();
      const names = p.getToolNames();
      expect(names.getSnapshot).toBe('feedback.get_snapshot');
    });

    it('uses custom namespace when provided', () => {
      const p = new FeedbackControlBridgeProvider({ namespace: 'fb' } as never);
      const names = p.getToolNames();
      expect(names.getSnapshot).toBe('fb.get_snapshot');
    });

    it('includes all 8 tool suffixes', () => {
      const p = new FeedbackControlBridgeProvider();
      const names = p.getToolNames();
      const suffixes = Object.values(FEEDBACK_CONTROL_TOOL_SUFFIXES);
      expect(Object.keys(names)).toHaveLength(suffixes.length);
      for (const [key, value] of Object.entries(FEEDBACK_CONTROL_TOOL_SUFFIXES)) {
        expect(names[key]).toBe(`feedback.${value}`);
      }
    });
  });

  describe('registerOnBridge', () => {
    it('registers all 8 primary', () => {
      const p = new FeedbackControlBridgeProvider();
      const registerTool = vi.fn((name) => ({ remove: vi.fn() }));
      const rpc = createRpc();
      const handles = p.registerOnBridge(registerTool, rpc);

      expect(handles.size).toBe(8);
      expect(handles.has('feedback.get_snapshot')).toBe(true);
      expect(handles.has('feedback.create_annotation')).toBe(true);
    });
  });
});
