import { beforeEach, describe, expect, it, vi } from "vitest";

import { installAgentationShell } from "@page-context/agentation-shell";

const AGENTATION_SHELL_HOST_ID = "__page_context_agentation_shell_host__";

describe("agentation shell marker edit flow", () => {
  beforeEach(() => {
    document.body.innerHTML = `<button id="target">target action</button>`;
    const target = queryRequired<HTMLElement>(document, "#target");
    mockRect(target, 60, 80, 140, 44);

    // jsdom 没有真实布局引擎，这里固定命中目标元素，让点击链路稳定可测。
    Object.defineProperty(document, "elementFromPoint", {
      value: () => target,
      configurable: true,
      writable: true,
    });
  });

  it("supports marker reopen edit and local delete without extra create call", async () => {
    const createAnnotation = vi.fn().mockResolvedValue({ id: "marker-1" });
    const mounted = installAgentationShell({
      adapter: { createAnnotation },
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    const shadow = getAgentationShellShadowRoot();
    queryRequired<HTMLButtonElement>(shadow, "[data-toolbar-toggle]").click();

    dispatchMouse(document.body, "click", 120, 96);

    const popup = queryRequired<HTMLFormElement>(shadow, "[data-popup]");
    const popupBody = queryRequired<HTMLTextAreaElement>(shadow, "[data-popup-body]");
    const popupPriority = queryRequired<HTMLSelectElement>(shadow, "[data-popup-priority]");
    expect(popup.hidden).toBe(false);

    popupBody.value = "initial feedback";
    popupPriority.value = "high";
    popup.requestSubmit();
    await flushMicrotasks();

    expect(createAnnotation).toHaveBeenCalledTimes(1);
    let marker = queryRequired<HTMLButtonElement>(shadow, '[data-marker-id="marker-1"]');
    expect(readMarkerTooltip(marker)).toContain("initial feedback");

    marker.click();
    expect(queryRequired<HTMLButtonElement>(shadow, "[data-popup-delete]").hidden).toBe(false);
    expect(popupBody.value).toBe("initial feedback");
    expect(popupPriority.value).toBe("high");

    popupBody.value = "updated feedback";
    popupPriority.value = "critical";
    popup.requestSubmit();
    await flushMicrotasks();

    // 编辑只改本地 marker，不应再次触发 create。
    expect(createAnnotation).toHaveBeenCalledTimes(1);
    marker = queryRequired<HTMLButtonElement>(shadow, '[data-marker-id="marker-1"]');
    expect(readMarkerTooltip(marker)).toContain("updated feedback");

    marker.click();
    queryRequired<HTMLButtonElement>(shadow, "[data-popup-delete]").click();

    expect(shadow.querySelector('[data-marker-id="marker-1"]')).toBeNull();
    expect(popup.hidden).toBe(true);
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

function readMarkerTooltip(marker: HTMLButtonElement): string {
  const tooltip = marker.querySelector(".pc-agent-marker-tooltip");
  return tooltip?.textContent ?? "";
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
