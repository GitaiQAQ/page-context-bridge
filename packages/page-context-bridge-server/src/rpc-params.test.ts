import { describe, it, expect } from 'vitest';
import {
  validateParams,
  sessionRegisterParamsSchema,
  bridgePageToolsRegisteredParamsSchema,
  bridgePageToolsUnregisteredParamsSchema,
  extensionPageToolsSetEnabledParamsSchema,
  bridgeToolCallParamsSchema,
  feedbackStateDeltaParamsSchema,
  feedbackAnnotationCreateParamsSchema,
  feedbackAnnotationUpdateParamsSchema,
  feedbackAnnotationClaimParamsSchema,
} from './rpc-params.js';

describe('rpc-params: validateParams', () => {
  it('validates and returns parsed params for valid input', () => {
    const result = validateParams(
      sessionRegisterParamsSchema,
      { extensionId: 'ext-123', version: '0.1.0' },
      'session.register',
    );
    expect(result).toEqual({ extensionId: 'ext-123', version: '0.1.0' });
  });

  it('allows optional fields to be missing', () => {
    const result = validateParams(sessionRegisterParamsSchema, {}, 'session.register');
    expect(result).toEqual({});
  });

  it('throws descriptive error for invalid field type', () => {
    expect(() =>
      validateParams(
        bridgePageToolsUnregisteredParamsSchema,
        { tabId: 'not-a-number' },
        'bridge.pageTools.unregistered',
      ),
    ).toThrow(/Invalid params for bridge.pageTools.unregistered/);
  });

  it('validates bridgePageToolsRegisteredParamsSchema with tools array', () => {
    const result = validateParams(
      bridgePageToolsRegisteredParamsSchema,
      { tabId: 42, tools: [{ name: 'getItems' }] },
      'bridge.pageTools.registered',
    );
    expect(result.tabId).toBe(42);
    expect(result.tools).toEqual([{ name: 'getItems' }]);
  });

  it('validates extensionPageToolsSetEnabledParamsSchema', () => {
    const result = validateParams(
      extensionPageToolsSetEnabledParamsSchema,
      { root: 'builtin', enabled: true },
      'extension.pageTools.setEnabled',
    );
    expect(result.root).toBe('builtin');
    expect(result.enabled).toBe(true);
  });

  it('rejects invalid enum value', () => {
    expect(() =>
      validateParams(
        extensionPageToolsSetEnabledParamsSchema,
        { root: 'invalid', enabled: true },
        'extension.pageTools.setEnabled',
      ),
    ).toThrow(/Invalid params/);
  });

  it('validates bridgeToolCallParamsSchema with required tool field', () => {
    const result = validateParams(
      bridgeToolCallParamsSchema,
      { tool: 'get_page_info', args: { selector: 'h1' }, tabId: 5 },
      'bridge.tool.call',
    );
    expect(result.tool).toBe('get_page_info');
  });

  it('rejects missing required field', () => {
    expect(() =>
      validateParams(bridgeToolCallParamsSchema, { args: {} }, 'bridge.tool.call'),
    ).toThrow(/Invalid params/);
  });

  it('handles null params gracefully', () => {
    expect(() =>
      validateParams(
        bridgePageToolsUnregisteredParamsSchema,
        null,
        'bridge.pageTools.unregistered',
      ),
    ).toThrow(/Invalid params/);
  });

  it('validates feedback create params with required tab context', () => {
    const result = validateParams(
      feedbackAnnotationCreateParamsSchema,
      { body: 'Need fix', tabId: 9, url: 'https://example.com', priority: 'high' },
      'feedback.annotation.create',
    );
    expect(result.tabId).toBe(9);
    expect(result.priority).toBe('high');
  });

  it('validates feedback create params with optional uiAnchor', () => {
    const result = validateParams(
      feedbackAnnotationCreateParamsSchema,
      {
        body: 'Need fix',
        tabId: 9,
        url: 'https://example.com',
        uiAnchor: {
          cssSelector: '#submit',
          framePath: [0, 1],
          rect: { x: 10, y: 20, width: 100, height: 40 },
          textRange: { start: 2, end: 8 },
          meta: { source: 'overlay', score: 0.98 },
        },
      },
      'feedback.annotation.create',
    );
    expect(result.uiAnchor?.cssSelector).toBe('#submit');
    expect(result.uiAnchor?.textRange).toEqual({ start: 2, end: 8 });
  });

  it('validates feedback update params', () => {
    const result = validateParams(
      feedbackAnnotationUpdateParamsSchema,
      { annotationId: 'annotation-7', body: 'updated body', priority: 'critical' },
      'feedback.annotation.update',
    );
    expect(result.annotationId).toBe('annotation-7');
    expect(result.priority).toBe('critical');
  });

  it('applies default cursor for feedback delta params', () => {
    const result = validateParams(feedbackStateDeltaParamsSchema, {}, 'feedback.state.delta');
    expect(result.afterSeq).toBe(0);
  });

  it('rejects feedback claim request when annotationId is missing', () => {
    expect(() =>
      validateParams(feedbackAnnotationClaimParamsSchema, {}, 'feedback.annotation.claim'),
    ).toThrow(/Invalid params/);
  });
});
