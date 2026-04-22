import { beforeEach, describe, expect, it, vi } from "vitest";

import { installAgentationShell } from "@page-context/agentation-shell";

const AGENTATION_SHELL_HOST_ID = "__page_context_agentation_shell_host__";

describe("agentation shell popup keyboard flow", () => {
  beforeEach(() => {
    document.body.innerHTML = `<button id="target">target action</button>`;
    const target = queryRequired<HTMLElement>(document, "#target");
    mockRect(target, 60, 80, 140, 44);

    // jsdom 没有真实命中测试能力，这里固定鼠标点击命中目标元素。
    Object.defineProperty(document, "elementFromPoint", {
      value: () => target,
      configurable: true,
      writable: true,
    });
  });

  it("submits with Ctrl+Enter inside popup body", async () => {
    const createAnnotation = vi.fn().mockResolvedValue({ id: "marker-keyboard-1" });
    const mounted = installAgentationShell({
      adapter: { createAnnotation, updateAnnotation: vi.fn(), dismissAnnotation: vi.fn() },
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    const shadow = getAgentationShellShadowRoot();
    queryRequired<HTMLButtonElement>(shadow, "[data-toolbar-toggle]").click();
    dispatchMouse(document.body, "click", 120, 96);

    const popupBody = queryRequired<HTMLTextAreaElement>(shadow, "[data-popup-body]");
    popupBody.value = "submit from ctrl+enter";
    dispatchKeyboard(popupBody, "Enter", { ctrlKey: true });
    await flushMicrotasks();

    expect(createAnnotation).toHaveBeenCalledTimes(1);
    expect(createAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "submit from ctrl+enter",
      }),
    );
    // 结束前主动退出标注态，避免把全局监听残留给下一个用例。
    queryRequired<HTMLButtonElement>(shadow, "[data-toolbar-toggle]").click();
  });

  it("traps focus in popup and closes by Esc when editing marker", async () => {
    const createAnnotation = vi.fn().mockResolvedValue({ id: "marker-focus-1" });
    const mounted = installAgentationShell({
      adapter: { createAnnotation, updateAnnotation: vi.fn(), dismissAnnotation: vi.fn() },
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    const shadow = getAgentationShellShadowRoot();
    const toolbarToggle = queryRequired<HTMLButtonElement>(shadow, "[data-toolbar-toggle]");
    toolbarToggle.click();
    dispatchMouse(document.body, "click", 120, 96);

    const popup = queryRequired<HTMLFormElement>(shadow, "[data-popup]");
    const popupBody = queryRequired<HTMLTextAreaElement>(shadow, "[data-popup-body]");
    expect(popup.hidden).toBe(false);
    popupBody.value = "seed marker";
    popup.requestSubmit();
    await flushMicrotasks();
    expect(createAnnotation).toHaveBeenCalledTimes(1);

    // 切回非标注态，模拟“只看 marker 并编辑”的真实路径。
    toolbarToggle.click();
    expect(toolbarToggle.dataset.active).toBe("false");

    const marker = queryRequired<HTMLButtonElement>(shadow, "[data-marker-id]");
    const popupSubmit = queryRequired<HTMLButtonElement>(shadow, "[data-popup-submit]");

    marker.focus();
    marker.click();
    await waitForMacrotask();
    expect(popup.hidden).toBe(false);
    expect(shadow.activeElement).toBe(popupBody);

    // 在第一个焦点元素上 Shift+Tab，应该回环到最后一个按钮。
    dispatchKeyboard(popupBody, "Tab", { shiftKey: true });
    expect(shadow.activeElement).toBe(popupSubmit);

    // 在最后一个焦点元素上 Tab，应该回环到第一个输入框。
    dispatchKeyboard(popupSubmit, "Tab");
    expect(shadow.activeElement).toBe(popupBody);

    dispatchKeyboard(popupBody, "Escape");
    expect(popup.hidden).toBe(true);
    expect(shadow.activeElement).toBe(marker);
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

function dispatchKeyboard(
  target: EventTarget,
  key: string,
  options: Partial<Pick<KeyboardEventInit, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">> = {},
): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      key,
      ...options,
    }),
  );
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}
