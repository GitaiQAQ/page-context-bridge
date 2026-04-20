import { beforeEach, describe, expect, it, vi } from "vitest";

import { installAgentationShell } from "@page-context/agentation-shell";

const AGENTATION_SHELL_HOST_ID = "__page_context_agentation_shell_host__";
const TOOLBAR_STATE_STORAGE_KEY = "__page_context_agentation_shell_toolbar_state_v1__";

describe("agentation shell toolbar persistence", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main><h1>demo page</h1></main>`;
    window.localStorage.clear();
  });

  it("restores hidden dock position from persisted state", () => {
    window.localStorage.setItem(
      TOOLBAR_STATE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        hidden: true,
        left: 180,
        top: 220,
      }),
    );

    const mounted = installAgentationShell({
      adapter: {
        createAnnotation: vi.fn().mockResolvedValue({ id: "mock-id" }),
      },
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    const shadow = getAgentationShellShadowRoot();
    const toolbar = queryRequired<HTMLDivElement>(shadow, "[data-toolbar]");
    const dock = queryRequired<HTMLButtonElement>(shadow, "[data-toolbar-dock]");

    expect(toolbar.hidden).toBe(true);
    expect(dock.hidden).toBe(false);
    expect(toolbar.style.left).toBe("180px");
    expect(toolbar.style.top).toBe("220px");
    expect(dock.style.left).toBe("180px");
    expect(dock.style.top).toBe("220px");
  });

  it("falls back to default visibility when persisted payload is invalid", () => {
    // 老数据或脏数据必须安全降级，不能把浮窗卡在不可见状态。
    window.localStorage.setItem(
      TOOLBAR_STATE_STORAGE_KEY,
      JSON.stringify({
        version: 999,
        hidden: true,
        left: "bad",
        top: null,
      }),
    );

    installAgentationShell({
      adapter: {
        createAnnotation: vi.fn().mockResolvedValue({ id: "mock-id" }),
      },
      doc: document,
      win: window,
    });

    const shadow = getAgentationShellShadowRoot();
    const toolbar = queryRequired<HTMLDivElement>(shadow, "[data-toolbar]");
    const dock = queryRequired<HTMLButtonElement>(shadow, "[data-toolbar-dock]");

    expect(toolbar.hidden).toBe(false);
    expect(dock.hidden).toBe(true);
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
