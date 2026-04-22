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

  it("supports Enter submit, Shift+Enter newline, Escape cancel and IME guard", async () => {
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

    const popup = queryRequired<HTMLFormElement>(shadow, "[data-popup]");
    const popupBody = queryRequired<HTMLTextAreaElement>(shadow, "[data-popup-body]");
    popupBody.value = "draft keyboard flow";

    // Shift+Enter 应保留换行语义，这里只校验不会触发提交。
    dispatchKeyboard(popupBody, "Enter", { shiftKey: true });
    await flushMicrotasks();
    expect(createAnnotation).toHaveBeenCalledTimes(0);

    // 中文输入法候选态下 Enter 不应触发提交。
    dispatchKeyboard(popupBody, "Enter", { isComposing: true });
    await flushMicrotasks();
    expect(createAnnotation).toHaveBeenCalledTimes(0);

    dispatchKeyboard(popupBody, "Escape");
    expect(popup.hidden).toBe(true);
    expect(createAnnotation).toHaveBeenCalledTimes(0);

    dispatchMouse(document.body, "click", 120, 96);
    expect(popup.hidden).toBe(false);
    popupBody.value = "submit from enter";
    dispatchKeyboard(popupBody, "Enter");
    await flushMicrotasks();

    expect(createAnnotation).toHaveBeenCalledTimes(1);
    expect(createAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "submit from enter",
      }),
    );
    // 结束前主动退出标注态，避免把全局监听残留给下一个用例。
    queryRequired<HTMLButtonElement>(shadow, "[data-toolbar-toggle]").click();
  });

  it("shows marker hover edit/delete affordance hints", async () => {
    const createAnnotation = vi.fn().mockResolvedValue({ id: "marker-affordance-1" });
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
    popupBody.value = "seed affordance marker";
    popup.requestSubmit();
    await flushMicrotasks();
    expect(createAnnotation).toHaveBeenCalledTimes(1);

    const marker = queryRequired<HTMLButtonElement>(shadow, '[data-marker-id="marker-affordance-1"]');
    expect(marker.title).toBe("点击编辑；弹窗内可删除");
    const affordance = queryRequired<HTMLSpanElement>(marker, ".pc-agent-marker-affordance");
    expect(affordance.textContent).toBe("编辑 / 删除");
    // marker tooltip 改成 quote + note 结构，便于后续和 agentation 样式层对齐。
    const tooltip = queryRequired<HTMLSpanElement>(marker, ".pc-agent-marker-tooltip");
    expect(queryRequired<HTMLSpanElement>(tooltip, ".pc-agent-marker-quote").textContent).toBe("无选中文本");
    expect(queryRequired<HTMLSpanElement>(tooltip, ".pc-agent-marker-note").textContent).toContain("seed affordance marker");

    // 主动关掉标注态，避免全局监听影响其它用例。
    toolbarToggle.click();
  });

  it("uses popup copy and action grouping closer to agentation shell product shape", async () => {
    const createAnnotation = vi.fn().mockResolvedValue({ id: "marker-popup-copy-1" });
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
    const popupTitle = queryRequired<HTMLParagraphElement>(shadow, "[data-popup-title]");
    const popupSubmit = queryRequired<HTMLButtonElement>(shadow, "[data-popup-submit]");
    const popupCancel = queryRequired<HTMLButtonElement>(shadow, "[data-popup-cancel]");
    const popupDelete = queryRequired<HTMLButtonElement>(shadow, "[data-popup-delete]");
    const popupSelectionLabel = queryRequired<HTMLLabelElement>(shadow, "[data-popup-selection-label]");
    const actionSecondary = queryRequired<HTMLDivElement>(shadow, ".pc-agent-popup-actions-secondary");

    // create 态先校验文案与按钮分组，保证壳层结构不再回退到旧版布局。
    expect(popupTitle.textContent).toBe("新建标注");
    expect(popupSubmit.textContent).toBe("提交标注");
    expect(popupCancel.textContent).toBe("取消");
    expect(popupDelete.textContent).toBe("删除标注");
    expect(popupDelete.hidden).toBe(true);
    expect(popupSelectionLabel.textContent).toBe("当前选中文本");
    expect(actionSecondary.contains(popupCancel)).toBe(true);
    expect(actionSecondary.contains(popupDelete)).toBe(true);

    queryRequired<HTMLTextAreaElement>(shadow, "[data-popup-body]").value = "seed popup copy marker";
    popup.requestSubmit();
    await flushMicrotasks();
    expect(createAnnotation).toHaveBeenCalledTimes(1);

    // marker 回开后应切到 edit 态文案，并显式展示删除入口。
    queryRequired<HTMLButtonElement>(shadow, '[data-marker-id="marker-popup-copy-1"]').click();
    expect(popupTitle.textContent).toBe("编辑标注");
    expect(popupSubmit.textContent).toBe("保存修改");
    expect(popupDelete.hidden).toBe(false);

    toolbarToggle.click();
  });

  it("restores focus to toolbar toggle after closing popup with Escape", () => {
    const mounted = installAgentationShell({
      adapter: { createAnnotation: vi.fn(), updateAnnotation: vi.fn(), dismissAnnotation: vi.fn() },
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    const shadow = getAgentationShellShadowRoot();
    const toolbarToggle = queryRequired<HTMLButtonElement>(shadow, "[data-toolbar-toggle]");
    toolbarToggle.click();
    toolbarToggle.focus();

    dispatchMouse(document.body, "click", 120, 96);
    const popup = queryRequired<HTMLFormElement>(shadow, "[data-popup]");
    const popupBody = queryRequired<HTMLTextAreaElement>(shadow, "[data-popup-body]");
    popupBody.focus();
    expect(shadow.activeElement).toBe(popupBody);

    // Esc 收口后焦点应回到触发来源，保证键盘路径连续。
    dispatchKeyboard(popupBody, "Escape");
    expect(popup.hidden).toBe(true);
    expect(shadow.activeElement).toBe(toolbarToggle);

    // 收尾退出标注态，避免监听器泄露到后续用例。
    toolbarToggle.click();
  });

  it("keeps Tab and Shift+Tab focus loop inside popup", () => {
    const mounted = installAgentationShell({
      adapter: { createAnnotation: vi.fn(), updateAnnotation: vi.fn(), dismissAnnotation: vi.fn() },
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    const shadow = getAgentationShellShadowRoot();
    const toolbarToggle = queryRequired<HTMLButtonElement>(shadow, "[data-toolbar-toggle]");
    toolbarToggle.click();
    dispatchMouse(document.body, "click", 120, 96);

    const popupBody = queryRequired<HTMLTextAreaElement>(shadow, "[data-popup-body]");
    const popupSubmit = queryRequired<HTMLButtonElement>(shadow, "[data-popup-submit]");

    popupSubmit.focus();
    // create 态下 submit 是最后一个可聚焦控件，Tab 应回卷到 body。
    dispatchKeyboard(popupSubmit, "Tab");
    expect(shadow.activeElement).toBe(popupBody);

    // 反向循环同理：body + Shift+Tab 应回到 submit。
    popupBody.focus();
    dispatchKeyboard(popupBody, "Tab", { shiftKey: true });
    expect(shadow.activeElement).toBe(popupSubmit);

    toolbarToggle.click();
  });

  it("adjusts marker tooltip placement near viewport edges", async () => {
    const createAnnotation = vi.fn().mockResolvedValue({ id: "marker-tooltip-edge-1" });
    const mounted = installAgentationShell({
      adapter: { createAnnotation, updateAnnotation: vi.fn(), dismissAnnotation: vi.fn() },
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    const shadow = getAgentationShellShadowRoot();
    const toolbarToggle = queryRequired<HTMLButtonElement>(shadow, "[data-toolbar-toggle]");
    toolbarToggle.click();

    // 在右下角附近创建 marker，tooltip 应自动切到左上方向，减少出屏裁切。
    dispatchMouse(document.body, "click", window.innerWidth - 2, window.innerHeight - 2);
    const popup = queryRequired<HTMLFormElement>(shadow, "[data-popup]");
    queryRequired<HTMLTextAreaElement>(shadow, "[data-popup-body]").value = "tooltip edge case";
    popup.requestSubmit();
    await flushMicrotasks();

    const marker = queryRequired<HTMLButtonElement>(shadow, '[data-marker-id="marker-tooltip-edge-1"]');
    expect(marker.dataset.tooltipX).toBe("right");
    expect(marker.dataset.tooltipY).toBe("top");

    toolbarToggle.click();
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
  options: Partial<Pick<KeyboardEventInit, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">> & { isComposing?: boolean } = {},
): void {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    key,
    ctrlKey: options.ctrlKey,
    metaKey: options.metaKey,
    shiftKey: options.shiftKey,
    altKey: options.altKey,
  });
  if (options.isComposing) {
    // jsdom 里 KeyboardEventInit 不总是支持 isComposing，这里手工打桩更稳。
    Object.defineProperty(event, "isComposing", {
      value: true,
      configurable: true,
    });
  }
  target.dispatchEvent(event);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
