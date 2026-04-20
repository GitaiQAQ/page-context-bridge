import { beforeEach, describe, expect, it, vi } from "vitest";

import { installAgentationShell } from "@page-context/agentation-shell";

const AGENTATION_SHELL_HOST_ID = "__page_context_agentation_shell_host__";

describe("agentation shell drag selection", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="first">first action</button>
      <button id="second">second action</button>
    `;
    mockRect(queryRequired<HTMLElement>(document, "#first"), 48, 64, 120, 36);
    mockRect(queryRequired<HTMLElement>(document, "#second"), 220, 140, 140, 40);
  });

  it("creates one merged annotation after drag selecting multiple elements", async () => {
    const createAnnotation = vi.fn().mockResolvedValue({ id: "drag-annotation-1" });
    const mounted = installAgentationShell({
      adapter: { createAnnotation },
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    const shadow = getAgentationShellShadowRoot();
    queryRequired<HTMLButtonElement>(shadow, "[data-toolbar-toggle]").click();

    // 模拟一次拖框：起点/终点覆盖两个按钮，触发“聚合提交”路径。
    dispatchMouse(document.body, "mousedown", 32, 32);
    dispatchMouse(document.body, "mousemove", 384, 240);
    dispatchMouse(document.body, "mouseup", 384, 240);

    const popup = queryRequired<HTMLFormElement>(shadow, "[data-popup]");
    expect(popup.hidden).toBe(false);
    expect(queryRequired<HTMLParagraphElement>(shadow, "[data-popup-selection]").textContent).toContain("已聚合 2 个元素");

    queryRequired<HTMLTextAreaElement>(shadow, "[data-popup-body]").value = "drag selection feedback";
    popup.requestSubmit();
    await flushMicrotasks();

    expect(createAnnotation).toHaveBeenCalledTimes(1);
    const input = createAnnotation.mock.calls[0]?.[0];
    expect((input as { target?: { elementName?: string } }).target?.elementName).toBe("multi-select (2)");

    const multiSelect = readMultiSelectMeta(input);
    expect(multiSelect?.count).toBe(2);
    expect(multiSelect?.items).toHaveLength(2);
  });
});

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

function dispatchMouse(target: EventTarget, type: "mousedown" | "mousemove" | "mouseup", clientX: number, clientY: number): void {
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

function readMultiSelectMeta(input: unknown): { count: number; items: unknown[] } | null {
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
  const multiSelect = (meta as { multiSelect?: unknown }).multiSelect;
  if (!multiSelect || typeof multiSelect !== "object") {
    return null;
  }
  const count = (multiSelect as { count?: unknown }).count;
  const items = (multiSelect as { items?: unknown }).items;
  if (typeof count !== "number" || !Array.isArray(items)) {
    return null;
  }
  return { count, items };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
