import { describe, expect, it } from 'vitest';

import {
  createFeedbackActionState,
  reconcileFeedbackActionStates,
  readFeedbackActionState,
  updateFeedbackActionStates,
  feedbackStatusBadgeClass,
  feedbackPushAgentBadgeClass,
  feedbackPushAgentBadgeText,
  canClaimAnnotation,
  canReplyAnnotation,
  canResolveAnnotation,
  canDismissAnnotation,
  formatFeedbackTime,
} from './sidepanel-feedback.js';
import type {
  FeedbackAnnotationActionState,
  FeedbackActionFormMode,
} from './sidepanel-feedback.js';

describe('createFeedbackActionState', () => {
  it('returns default state with null mode and empty fields', () => {
    const state = createFeedbackActionState();
    expect(state.mode).toBeNull();
    expect(state.replyBody).toBe('');
    expect(state.resolveNote).toBe('');
    expect(state.dismissReason).toBe('');
    expect(state.submitting).toBe(false);
    expect(state.error).toBe('');
    expect(state.success).toBe('');
  });
});

describe('reconcileFeedbackActionStates', () => {
  it('returns empty map for empty annotations', () => {
    const result = reconcileFeedbackActionStates({}, []);
    expect(result).toEqual({});
  });

  it('creates default state for new annotations', () => {
    const current = { a1: createFeedbackActionState() };
    const result = reconcileFeedbackActionStates(current, [{ id: 'a1' } as never]);
    expect(result).toHaveProperty('a1');
    expect(result.a1.mode).toBeNull();
  });

  it('preserves existing state for known annotations', () => {
    const existing = createFeedbackActionState();
    existing.mode = 'reply';
    existing.replyBody = 'hello';
    const current = { a1: existing };
    const result = reconcileFeedbackActionStates(current, [{ id: 'a1' } as never]);
    expect(result.a1.mode).toBe('reply');
    expect(result.a1.replyBody).toBe('hello');
  });

  it('removes stale annotation states', () => {
    const current = { a1: createFeedbackActionState(), a2: createFeedbackActionState() };
    const result = reconcileFeedbackActionStates(current, [{ id: 'a1' } as never]);
    expect(result).toHaveProperty('a1');
    expect(result).not.toHaveProperty('a2');
  });
});

describe('readFeedbackActionState', () => {
  it('returns existing state for known id', () => {
    const existing = createFeedbackActionState();
    existing.mode = 'resolve';
    const current = { a1: existing };
    expect(readFeedbackActionState(current, 'a1').mode).toBe('resolve');
  });

  it('creates default state for unknown id', () => {
    expect(readFeedbackActionState({}, 'new-id').mode).toBeNull();
  });
});

describe('updateFeedbackActionStates', () => {
  it('updates state via updater function', () => {
    const current = { a1: createFeedbackActionState() };
    const result = updateFeedbackActionStates(current, 'a1', (s) => ({
      ...s,
      mode: 'dismiss' as FeedbackActionFormMode,
    }));
    expect(result.a1.mode).toBe('dismiss');
  });

  it('does not mutate other states', () => {
    const s1 = createFeedbackActionState();
    const s2 = createFeedbackActionState();
    const current = { a1: s1, a2: s2 };
    const result = updateFeedbackActionStates(current, 'a1', (s) => ({ ...s, error: 'oops' }));
    expect(result.a1.error).toBe('oops');
    expect(result.a2.error).toBe('');
  });
});

describe('feedbackStatusBadgeClass', () => {
  it('returns "badge-success" for resolved', () => {
    expect(feedbackStatusBadgeClass('resolved')).toContain('success');
  });

  it('returns "badge-info" for claimed', () => {
    expect(feedbackStatusBadgeClass('claimed')).toContain('info');
  });

  it('returns "badge-ghost" for dismissed', () => {
    expect(feedbackStatusBadgeClass('dismissed')).toContain('ghost');
  });

  it('returns "badge-warning" for open/default', () => {
    expect(feedbackStatusBadgeClass('open')).toContain('warning');
    expect(feedbackStatusBadgeClass('in_progress')).toContain('warning');
    expect(feedbackStatusBadgeClass('needs_info')).toContain('warning');
  });
});

describe('feedbackPushAgentBadgeClass', () => {
  it('returns ghost badge for null status', () => {
    expect(feedbackPushAgentBadgeClass(null)).toContain('ghost');
  });

  it('returns ghost badge when disabled', () => {
    expect(
      feedbackPushAgentBadgeClass({ enabled: false, readiness: 'disabled', mode: 'disabled' }),
    ).toContain('ghost');
  });

  it('returns error badge when last launch failed', () => {
    expect(
      feedbackPushAgentBadgeClass({
        enabled: true,
        readiness: 'ready',
        mode: 'auto',
        lastLaunch: { result: 'failed', attemptedAt: 'x', annotationId: 'y' },
      }),
    ).toContain('error');
  });

  it('returns success badge when last launch succeeded', () => {
    expect(
      feedbackPushAgentBadgeClass({
        enabled: true,
        readiness: 'ready',
        mode: 'auto',
        lastLaunch: { result: 'success', attemptedAt: 'x', annotationId: 'y' },
      }),
    ).toContain('success');
  });

  it('returns info badge when ready but no launch yet', () => {
    expect(
      feedbackPushAgentBadgeClass({
        enabled: true,
        readiness: 'ready',
        mode: 'auto',
      }),
    ).toContain('info');
  });
});

describe('feedbackPushAgentBadgeText', () => {
  it('returns "unknown" for null', () => {
    expect(feedbackPushAgentBadgeText(null)).toBe('unknown');
  });

  it('returns "disabled" when not enabled', () => {
    expect(
      feedbackPushAgentBadgeText({ enabled: false, readiness: 'disabled', mode: 'disabled' }),
    ).toBe('disabled');
  });

  it('returns "last launch failed" on failure', () => {
    expect(
      feedbackPushAgentBadgeText({
        enabled: true,
        readiness: 'ready',
        mode: 'auto',
        lastLaunch: { result: 'failed', attemptedAt: 'x', annotationId: 'y' },
      }),
    ).toContain('failed');
  });

  it('returns "last launch ok" on success', () => {
    expect(
      feedbackPushAgentBadgeText({
        enabled: true,
        readiness: 'ready',
        mode: 'auto',
        lastLaunch: { result: 'success', attemptedAt: 'x', annotationId: 'y' },
      }),
    ).toContain('ok');
  });

  it('returns "ready" when ready with no launch record', () => {
    expect(feedbackPushAgentBadgeText({ enabled: true, readiness: 'ready', mode: 'auto' })).toBe(
      'ready',
    );
  });
});

describe('canClaimAnnotation', () => {
  it('allows claim on open status', () => {
    expect(canClaimAnnotation('open')).toBe(true);
    expect(canClaimAnnotation('needs_info')).toBe(true);
  });

  it('blocks claim on non-claimable statuses', () => {
    expect(canClaimAnnotation('claimed')).toBe(false);
    expect(canClaimAnnotation('in_progress')).toBe(false);
    expect(canClaimAnnotation('resolved')).toBe(false);
    expect(canClaimAnnotation('dismissed')).toBe(false);
  });
});

describe('canReplyAnnotation', () => {
  it('allows reply on open/claimed/needs_info/in_progress', () => {
    expect(canReplyAnnotation('open')).toBe(true);
    expect(canReplyAnnotation('claimed')).toBe(true);
    expect(canReplyAnnotation('needs_info')).toBe(true);
    expect(canReplyAnnotation('in_progress')).toBe(true);
  });

  it('blocks reply on terminal states', () => {
    expect(canReplyAnnotation('resolved')).toBe(false);
    expect(canReplyAnnotation('dismissed')).toBe(false);
  });
});

describe('canResolveAnnotation', () => {
  it('allows resolve on claimed/in_progress/needs_info', () => {
    expect(canResolveAnnotation('claimed')).toBe(true);
    expect(canResolveAnnotation('in_progress')).toBe(true);
    expect(canResolveAnnotation('needs_info')).toBe(true);
  });

  it('blocks resolve on open/resolved/dismissed', () => {
    expect(canResolveAnnotation('open')).toBe(false);
    expect(canResolveAnnotation('resolved')).toBe(false);
    expect(canResolveAnnotation('dismissed')).toBe(false);
  });
});

describe('canDismissAnnotation', () => {
  it('allows dismiss on non-terminal states', () => {
    expect(canDismissAnnotation('open')).toBe(true);
    expect(canDismissAnnotation('claimed')).toBe(true);
    expect(canDismissAnnotation('in_progress')).toBe(true);
    expect(canDismissAnnotation('needs_info')).toBe(true);
  });

  it('blocks dismiss on terminal states', () => {
    expect(canDismissAnnotation('resolved')).toBe(false);
    expect(canDismissAnnotation('dismissed')).toBe(false);
  });
});

describe('formatFeedbackTime', () => {
  it('formats valid ISO timestamp', () => {
    const result = formatFeedbackTime('2024-01-15T10:30:00Z');
    expect(result).toBeTruthy();
    expect(result).not.toBe('2024-01-15T10:30:00Z'); // should be localized
  });

  it('returns original string for invalid timestamp', () => {
    expect(formatFeedbackTime('not-a-date')).toBe('not-a-date');
  });

  it('handles empty string', () => {
    expect(formatFeedbackTime('')).toBe('');
  });
});
