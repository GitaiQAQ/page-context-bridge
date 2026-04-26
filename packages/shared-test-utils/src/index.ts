/**
 * Shared test utilities for the browser-debug-extension monorepo.
 * Centralizes common factories, mocks, and helpers to reduce duplication across packages.
 */
import type { vi } from 'vitest';

// ── Re-export vitest for convenience ──
export { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';

// ── Deterministic ID / Timestamp factory ──

export interface DeterministicFactories {
  createId: (prefix: string) => string;
  now: () => string;
  reset: () => void;
}

export function createDeterministicFactories(): DeterministicFactories {
  let idCounter = 0;
  let timeCounter = 0;

  return {
    createId(prefix: string): string {
      return `${prefix}-${++idCounter}`;
    },
    now(): string {
      return `2026-01-01T00:00:${String(timeCounter++).padStart(2, '0')}.000Z`;
    },
    reset(): void {
      idCounter = 0;
      timeCounter = 0;
    },
  };
}

// ── Feedback domain factories ──

import type {
  FeedbackActor,
  FeedbackAnnotation,
  FeedbackUiAnchor,
  FeedbackCapabilityLinks,
  FeedbackContext,
  FeedbackTarget,
} from '@page-context/shared-protocol';

export const EXTENSION_USER_ACTOR: FeedbackActor = {
  source: 'extension',
  id: 'ext-user',
  displayName: 'Extension User',
};

export const AGENT_ACTOR: FeedbackActor = {
  source: 'agent',
  id: 'agent-1',
  displayName: 'Agent',
};

export function createTestActor(overrides?: Partial<FeedbackActor>): FeedbackActor {
  return { ...EXTENSION_USER_ACTOR, ...overrides };
}

export function createUiAnchor(overrides?: Partial<FeedbackUiAnchor>): FeedbackUiAnchor {
  return {
    elementId: 'test-element',
    cssSelector: '#test-element',
    textQuote: 'Test text',
    rect: { x: 10, y: 20, width: 100, height: 50 },
    ...overrides,
  };
}

export function createCapabilityLinks(
  overrides?: Partial<FeedbackCapabilityLinks>,
): FeedbackCapabilityLinks {
  return {
    namespaceHints: [],
    relatedToolNames: [],
    relatedResourceIds: [],
    relatedSkillIds: [],
    linkReasons: [],
    ...overrides,
  };
}

export function createContext(overrides?: Partial<FeedbackContext>): FeedbackContext {
  return {
    pageInfo: { tabId: 1, url: 'https://example.com' },
    linkedCapabilities: createCapabilityLinks(),
    ...overrides,
  };
}

export function createTarget(overrides?: Partial<FeedbackTarget>): FeedbackTarget {
  return {
    tabId: 1,
    url: 'https://example.com',
    ...overrides,
  };
}

// ── Page Tool Spec factory ──

import type { PageToolSpec } from '@page-context/mcp-bridge/dist/registry-types';

export function createPageToolSpec(
  overrides?: Partial<PageToolSpec> & { _namespace?: string; _instanceId?: string },
): PageToolSpec {
  return {
    name: 'test.tool',
    description: 'Test tool description',
    inputSchema: {},
    _pageTool: true,
    _namespace: 'test',
    _instanceId: 'default',
    ...overrides,
  } as PageToolSpec;
}

// ── Tab info factory ──

export interface TabLike {
  id: number;
  title: string;
  url: string;
  active?: boolean;
}

export function createTabInfo(overrides?: Partial<TabLike>): TabLike {
  return {
    id: 1,
    title: 'Test Tab',
    url: 'https://example.com',
    active: true,
    ...overrides,
  };
}

// ── Chrome API mock factory (for jsdom/browser tests) ──

export interface ChromeMockListeners {
  onMessage?: { addListener: ReturnType<typeof vi.fn>; removeListener?: ReturnType<typeof vi.fn> };
  onInstalled?: { addListener: ReturnType<typeof vi.fn> };
  onStartup?: { addListener: ReturnType<typeof vi.fn> };
  tabs?: {
    query: ReturnType<typeof vi.fn>;
    onActivated: {
      addListener: ReturnType<typeof vi.fn>;
      removeListener?: ReturnType<typeof vi.fn>;
    };
    onUpdated: { addListener: ReturnType<typeof vi.fn>; removeListener?: ReturnType<typeof vi.fn> };
    onRemoved: { addListener: ReturnType<typeof vi.fn>; removeListener?: ReturnType<typeof vi.fn> };
  };
  scripting?: { executeScript: ReturnType<typeof vi.fn> };
  storage?: { local: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } };
  runtime?: {
    id: string;
    getManifest: () => { version: string };
    sendMessage: ReturnType<typeof vi.fn>;
    onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener?: ReturnType<typeof vi.fn> };
    onInstalled: { addListener: ReturnType<typeof vi.fn> };
    onStartup: { addListener: ReturnType<typeof vi.fn> };
    getPlatformInfo: ReturnType<typeof vi.fn>;
  };
}

let savedChrome: unknown = undefined;

export function installChromeMock(overrides?: Partial<ChromeMockListeners>): ChromeMockListeners {
  const mock: ChromeMockListeners = {
    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ version: '0.0.0-test' }),
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      getPlatformInfo: vi.fn(),
    },
    storage: { local: { get: vi.fn(), set: vi.fn() } },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn() },
    ...overrides,
  };

  savedChrome = (globalThis as Record<string, unknown>).chrome;
  Object.defineProperty(globalThis, 'chrome', { value: mock, configurable: true, writable: true });

  return mock;
}

export function restoreChromeGlobal(): void {
  if (savedChrome !== undefined) {
    Object.defineProperty(globalThis, 'chrome', {
      value: savedChrome,
      configurable: true,
      writable: true,
    });
  } else {
    Reflect.deleteProperty(globalThis, 'chrome');
  }
  savedChrome = undefined;
}

// ── Async helper ──

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
