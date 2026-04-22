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

  it("supports marker reopen edit/delete with update + dismiss sync", async () => {
    const createAnnotation = vi.fn().mockResolvedValue({ id: "marker-1" });
    const updateAnnotation = vi.fn().mockResolvedValue({ ok: true });
    const dismissAnnotation = vi.fn().mockResolvedValue({ ok: true });
    const mounted = installAgentationShell({
      adapter: { createAnnotation, updateAnnotation, dismissAnnotation },
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

    // 编辑不应再次 create，而是走 update 同步远端。
    expect(createAnnotation).toHaveBeenCalledTimes(1);
    expect(updateAnnotation).toHaveBeenCalledTimes(1);
    expect(updateAnnotation).toHaveBeenCalledWith({
      annotationId: "marker-1",
      body: "updated feedback",
      priority: "critical",
    });
    marker = queryRequired<HTMLButtonElement>(shadow, '[data-marker-id="marker-1"]');
    expect(readMarkerTooltip(marker)).toContain("updated feedback");

    marker.click();
    queryRequired<HTMLButtonElement>(shadow, "[data-popup-delete]").click();
    await flushMicrotasks();

    expect(dismissAnnotation).toHaveBeenCalledTimes(1);
    expect(dismissAnnotation).toHaveBeenCalledWith({
      annotationId: "marker-1",
      dismissReason: "marker deleted from agentation shell",
    });
    expect(shadow.querySelector('[data-marker-id="marker-1"]')).toBeNull();
    await waitForPopupExitAnimation();
    expect(popup.hidden).toBe(true);
    // 收尾退出标注态，避免把全局监听残留给后续用例。
    queryRequired<HTMLButtonElement>(shadow, "[data-toolbar-toggle]").click();
  });

  it("supports marker contextmenu delete entry with dismiss sync", async () => {
    const createAnnotation = vi.fn().mockResolvedValue({ id: "marker-contextmenu-1" });
    const dismissAnnotation = vi.fn().mockResolvedValue({ ok: true });
    const mounted = installAgentationShell({
      adapter: { createAnnotation, updateAnnotation: vi.fn(), dismissAnnotation },
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    const shadow = getAgentationShellShadowRoot();
    queryRequired<HTMLButtonElement>(shadow, "[data-toolbar-toggle]").click();

    dispatchMouse(document.body, "click", 120, 96);
    queryRequired<HTMLTextAreaElement>(shadow, "[data-popup-body]").value = "contextmenu delete";
    queryRequired<HTMLFormElement>(shadow, "[data-popup]").requestSubmit();
    await flushMicrotasks();

    const marker = queryRequired<HTMLButtonElement>(shadow, '[data-marker-id="marker-contextmenu-1"]');
    dispatchMouse(marker, "contextmenu", 120, 96);

    const menu = queryRequired<HTMLDivElement>(shadow, "[data-marker-context-menu]");
    expect(menu.hidden).toBe(false);
    queryRequired<HTMLButtonElement>(shadow, "[data-marker-context-menu-delete]").click();
    await flushMicrotasks();

    expect(dismissAnnotation).toHaveBeenCalledTimes(1);
    expect(dismissAnnotation).toHaveBeenCalledWith({
      annotationId: "marker-contextmenu-1",
      dismissReason: "marker deleted from agentation shell",
    });
    expect(shadow.querySelector('[data-marker-id="marker-contextmenu-1"]')).toBeNull();
    expect(menu.hidden).toBe(true);
    queryRequired<HTMLButtonElement>(shadow, "[data-toolbar-toggle]").click();
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

function dispatchMouse(target: EventTarget, type: "click" | "contextmenu", clientX: number, clientY: number): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: type === "contextmenu" ? 2 : 0,
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

async function waitForPopupExitAnimation(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 180);
  });
}
