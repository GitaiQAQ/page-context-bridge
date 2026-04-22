import { beforeEach, describe, expect, it, vi } from "vitest";

import { installAgentationShell } from "@page-context/agentation-shell";

const AGENTATION_SHELL_HOST_ID = "__page_context_agentation_shell_host__";

describe("agentation shell uiAnchor meta", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="wrap" class="panel shell">
        <span id="left">left helper text</span>
        <button
          id="target"
          class="btn primary HASHED12345"
          aria-label="submit order"
          aria-describedby="hint"
        >
          Pay now
        </button>
        <span id="right">right helper text</span>
        <small id="hint">This action creates an order.</small>
      </div>
    `;

    const target = queryRequired<HTMLElement>(document, "#target");
    mockRect(target, 120, 180, 160, 40);

    // jsdom 无布局能力，固定命中目标元素，确保点击链路稳定。
    Object.defineProperty(document, "elementFromPoint", {
      value: () => target,
      configurable: true,
      writable: true,
    });
  });

  it("writes lightweight element context into uiAnchor.meta before create", async () => {
    const createAnnotation = vi.fn().mockResolvedValue({ id: "meta-1" });
    const mounted = installAgentationShell({
      adapter: { createAnnotation },
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    const shadow = getAgentationShellShadowRoot();
    queryRequired<HTMLButtonElement>(shadow, "[data-toolbar-toggle]").click();
    dispatchMouse(document.body, "click", 160, 200);

    const popup = queryRequired<HTMLFormElement>(shadow, "[data-popup]");
    queryRequired<HTMLTextAreaElement>(shadow, "[data-popup-body]").value = "meta coverage";
    popup.requestSubmit();
    await flushMicrotasks();

    expect(createAnnotation).toHaveBeenCalledTimes(1);
    const payload = createAnnotation.mock.calls[0]?.[0];
    const elementContext = readElementContext(payload);
    expect(elementContext).not.toBeNull();
    expect(elementContext?.tagName).toBe("button");
    expect(elementContext?.fullPath).toContain("#target");
    expect(elementContext?.classes).toEqual(expect.arrayContaining(["btn", "primary"]));
    expect(elementContext?.classes).not.toContain("HASHED12345");
    expect(elementContext?.accessibility?.ariaLabel).toBe("submit order");
    expect(elementContext?.accessibility?.describedByText).toContain("creates an order");
    expect(elementContext?.nearbyText?.previous).toContain("left helper text");
    expect(elementContext?.nearbyText?.next).toContain("right helper text");
  });
});

interface ElementContextSnapshot {
  tagName?: string;
  fullPath?: string;
  classes?: string[];
  accessibility?: {
    ariaLabel?: string;
    describedByText?: string;
  };
  nearbyText?: {
    previous?: string;
    next?: string;
  };
}

function readElementContext(input: unknown): ElementContextSnapshot | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const uiAnchor = (input as { uiAnchor?: unknown }).uiAnchor;
  if (!uiAnchor || typeof uiAnchor !== "object") {
    return null;
  }
  const meta = (uiAnchor as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object") {
    return null;
  }
  const elementContext = (meta as { elementContext?: unknown }).elementContext;
  if (!elementContext || typeof elementContext !== "object") {
    return null;
  }
  return elementContext as ElementContextSnapshot;
}

function getAgentationShellShadowRoot(): ShadowRoot {
  const host = document.getElementById(AGENTATION_SHELL_HOST_ID);
  if (!(host instanceof HTMLDivElement) || !host.shadowRoot) {
    throw new Error("Agentation shell host missing");
  }
  return host.shadowRoot;
}

function queryRequired<T extends Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector(selector);
  if (!node) {
    throw new Error(`Missing node for selector: ${selector}`);
  }
  return node as T;
}

function mockRect(element: HTMLElement, left: number, top: number, width: number, height: number): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => new DOMRect(left, top, width, height),
    configurable: true,
    writable: true,
  });
}

function dispatchMouse(target: EventTarget, type: "click", clientX: number, clientY: number): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      clientX,
      clientY,
    }),
  );
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
