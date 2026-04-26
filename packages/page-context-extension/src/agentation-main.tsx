/**
 * Agentation MAIN World Entry
 *
 * Injected via chrome.scripting.executeScript({ world: "MAIN", files: ["agentation-main.js"] }).
 * Renders Agentation UI in the page main world, allowing react-detection.ts to directly read React fiber.
 *
 * Architecture:
 * - Shadow DOM host for style isolation
 * - React 18 createRoot mount
 * - Callbacks bridge across worlds via CustomEvent to ISOLATED world's content-script
 */

import { Agentation, type Annotation as AgentationAnnotation } from './agentation-source-runtime';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

// ── Constants ──

const HOST_ID = '__pc_agentation_main__';
const CONTAINER_ATTR = 'data-pc-agentation-main-container';
const EVENT_PREFIX = 'page-context:agentation';

// ── Types ──

// ── Types ──

interface AnnotationBridgePayload {
  annotation: AgentationAnnotation;
  timestamp: number;
}

// ── Global Installation Marker ──

declare global {
  interface Window {
    __pageContextAgentationMainInstalled__?: boolean;
  }
}

// ── Main Function ──

export function installAgentationInMainWorld(): void {
  if (window.__pageContextAgentationMainInstalled__) {
    return;
  }
  window.__pageContextAgentationMainInstalled__ = true;

  // Wait for body to be ready (Agentation internally uses createPortal → document.body)
  const waitForBody = (): Promise<HTMLElement> =>
    new Promise((resolve) => {
      const check = () => {
        if (document.body) {
          resolve(document.body);
        } else {
          setTimeout(check, 30);
        }
      };
      check();
    });

  void waitForBody().then((body) => mountAgentation(body));
}

// ── Mount Logic ──

function mountAgentation(body: HTMLElement): void {
  // 1. Create Shadow DOM host for style isolation
  const host = document.createElement('div');
  host.id = HOST_ID;
  // host itself doesn't participate in layout, pointer-events allow portal'd toolbar to be interactive
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;';
  body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const container = document.createElement('div');
  container.setAttribute(CONTAINER_ATTR, '');
  shadow.appendChild(container);

  // CSS is inlined into JS by post-build script, injected automatically via MutationObserver after host appears
  // (Cannot inject synchronously in mountAgentation because CSS data is embedded by vite post-build plugin)

  // 3. Create React Root and render
  const root = createRoot(container);

  flushSync(() => {
    root.render(
      <AgentationMainErrorBoundary
        onError={(error, info) => {
          console.error('[AGENTATION-MAIN] render failed', error, info);
        }}
      >
        <AgentationMainBridge />
      </AgentationMainErrorBoundary>,
    );
  });
}

// ── Callback Bridge: MAIN world → ISOLATED world ──
//
// CustomEvent can cross Chrome Extension World boundaries,
// because both worlds share the same DOM event system.

function dispatchToIsolatedWorld(action: string, payload: unknown): void {
  window.dispatchEvent(
    new CustomEvent(`${EVENT_PREFIX}:${action}`, {
      detail: payload,
    }),
  );
}

function handleAnnotationAdd(annotation: AgentationAnnotation): void {
  dispatchToIsolatedWorld('annotation:add', {
    annotation,
    timestamp: Date.now(),
  } satisfies AnnotationBridgePayload);
}

function handleAnnotationUpdate(annotation: AgentationAnnotation): void {
  dispatchToIsolatedWorld('annotation:update', {
    annotation,
    timestamp: Date.now(),
  } satisfies AnnotationBridgePayload);
}

function handleAnnotationDelete(annotation: AgentationAnnotation): void {
  dispatchToIsolatedWorld('annotation:delete', {
    annotation,
    timestamp: Date.now(),
  } satisfies AnnotationBridgePayload);
}

// ── React Components ──

function AgentationMainBridge(): ReactNode {
  return (
    <Agentation
      copyToClipboard={true}
      onAnnotationAdd={handleAnnotationAdd}
      onAnnotationUpdate={handleAnnotationUpdate}
      onAnnotationDelete={handleAnnotationDelete}
    />
  );
}

class AgentationMainErrorBoundary extends Component<
  { children: ReactNode; onError: (error: Error, info: ErrorInfo) => void },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError(error, info);
  }

  render() {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}

// ── Auto-execution ──
// Execute installation immediately after script injection
installAgentationInMainWorld();
