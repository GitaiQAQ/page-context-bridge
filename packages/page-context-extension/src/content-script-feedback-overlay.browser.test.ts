import { beforeEach, describe, expect, it, vi } from "vitest";

import { installFeedbackOverlay } from "./content-script-feedback-overlay";

const FEEDBACK_OVERLAY_HOST_ID = "__page_context_feedback_overlay_host__";

describe("installFeedbackOverlay", () => {
  beforeEach(() => {
    document.body.innerHTML = `<p id="target">这是一段可选中文本</p>`;
    window.getSelection()?.removeAllRanges();
  });

  it("opens panel and renders current selected text", () => {
    selectTargetText();

    installFeedbackOverlay({
      submitFeedback: vi.fn().mockResolvedValue({ ok: true }),
    });

    const shadow = getOverlayShadowRoot();
    const entryButton = queryRequired<HTMLButtonElement>(shadow, "[data-entry]");
    entryButton.click();

    const selectionView = queryRequired<HTMLParagraphElement>(shadow, "[data-selection]");
    expect(selectionView.textContent).toContain("这是一段可选中文本");
  });

  it("submits feedback through injected submit handler", async () => {
    selectTargetText();
    const submitFeedback = vi.fn().mockResolvedValue({ ok: true });

    installFeedbackOverlay({ submitFeedback });

    const shadow = getOverlayShadowRoot();
    queryRequired<HTMLButtonElement>(shadow, "[data-entry]").click();

    const bodyInput = queryRequired<HTMLTextAreaElement>(shadow, "[data-body]");
    const prioritySelect = queryRequired<HTMLSelectElement>(shadow, "[data-priority]");
    bodyInput.value = "这里需要补充错误态提示";
    prioritySelect.value = "high";

    queryRequired<HTMLFormElement>(shadow, "[data-panel]").requestSubmit();
    await flushMicrotasks();

    expect(submitFeedback).toHaveBeenCalledWith({
      body: "这里需要补充错误态提示",
      priority: "high",
      selectedText: "这是一段可选中文本",
    });
  });
});

function getOverlayShadowRoot(): ShadowRoot {
  const host = document.getElementById(FEEDBACK_OVERLAY_HOST_ID);
  if (!(host instanceof HTMLDivElement) || !host.shadowRoot) {
    throw new Error("Feedback overlay host missing");
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

function selectTargetText(): void {
  // jsdom 下手动创建 Range，模拟页面用户已有选区。
  const target = document.getElementById("target");
  const textNode = target?.firstChild;
  if (!textNode) {
    throw new Error("Missing target text node");
  }
  const range = document.createRange();
  range.selectNodeContents(textNode);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
