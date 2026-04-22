import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installAgentationShell } from "@page-context/agentation-shell";
import {
  AGENTATION_REACT_HOST_ID,
  AGENTATION_REACT_ROOT_ENTRY_KEY,
  mountAgentationReactRoot,
  registerAgentationReactRootEntry,
} from "./agentation-react-root";
import { installAgentationReactRoot } from "./feedback-ui-adapter";

const AGENTATION_SHELL_HOST_ID = "__page_context_agentation_shell_host__";
const REACT_ROOT_ENTRY_KEYS = [
  AGENTATION_REACT_ROOT_ENTRY_KEY,
  "__PAGE_CONTEXT_AGENTATION_REACT_ROOT__",
  "__page_context_agentation_react_root__",
] as const;

describe("mountAgentationReactRoot", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    cleanupReactRootEntry();
  });

  afterEach(() => {
    cleanupReactRootEntry();
    document.body.innerHTML = "";
  });

  it("mounts default marker into a shadow host", () => {
    const mounted = mountAgentationReactRoot();

    const host = document.getElementById(AGENTATION_REACT_HOST_ID);
    expect(host).toBe(mounted.host);
    expect(host?.shadowRoot).toBe(mounted.shadowRoot);
    const readyNode = mounted.shadowRoot.querySelector('[data-agentation-react-ready="true"]');
    expect(readyNode).not.toBeNull();
    expect(readyNode?.textContent).toContain("default");

    mounted.unmount();
    expect(document.getElementById(AGENTATION_REACT_HOST_ID)).toBeNull();
  });

  it("supports two mount keys in one shadow host and cleans independently", () => {
    const primary = mountAgentationReactRoot({
      mountKey: "primary",
      // 用 createElement 写最小渲染，避免测试自身依赖 JSX 转换细节。
      render: () => createElement("span", { "data-mount-label": "primary" }, "primary"),
    });
    const secondary = mountAgentationReactRoot({
      mountKey: "secondary",
      render: () => createElement("span", { "data-mount-label": "secondary" }, "secondary"),
    });

    const host = document.getElementById(AGENTATION_REACT_HOST_ID);
    expect(host).not.toBeNull();
    expect(host?.shadowRoot?.querySelector('[data-mount-label="primary"]')).not.toBeNull();
    expect(host?.shadowRoot?.querySelector('[data-mount-label="secondary"]')).not.toBeNull();

    primary.unmount();
    expect(host?.shadowRoot?.querySelector('[data-mount-label="primary"]')).toBeNull();
    expect(host?.shadowRoot?.querySelector('[data-mount-label="secondary"]')).not.toBeNull();

    secondary.unmount();
    expect(document.getElementById(AGENTATION_REACT_HOST_ID)).toBeNull();
  });

  it("keeps latest mount alive when same key is remounted", () => {
    const first = mountAgentationReactRoot({
      mountKey: "stable",
      render: () => createElement("span", { "data-react-version": "v1" }, "v1"),
    });
    const second = mountAgentationReactRoot({
      mountKey: "stable",
      render: () => createElement("span", { "data-react-version": "v2" }, "v2"),
    });

    const host = document.getElementById(AGENTATION_REACT_HOST_ID);
    expect(host?.shadowRoot?.querySelector('[data-react-version="v1"]')).toBeNull();
    expect(host?.shadowRoot?.querySelector('[data-react-version="v2"]')).not.toBeNull();

    // first 已失效，调用 first.unmount 不应把 second 的挂载结果删掉。
    first.unmount();
    expect(host?.shadowRoot?.querySelector('[data-react-version="v2"]')).not.toBeNull();

    second.unmount();
    expect(document.getElementById(AGENTATION_REACT_HOST_ID)).toBeNull();
  });
});

describe("agentation react root entry integration", () => {
  beforeEach(() => {
    document.body.innerHTML = "<main><h1>demo page</h1></main>";
    cleanupReactRootEntry();
  });

  afterEach(() => {
    cleanupReactRootEntry();
    document.body.innerHTML = "";
  });

  it("registers stable window entry key for react root mount", () => {
    const entry = registerAgentationReactRootEntry({ win: window });
    expect(window["agentation-react-root"]).toBe(entry);
    expect(window.__PAGE_CONTEXT_AGENTATION_REACT_ROOT__).toBe(entry);
  });

  it("mounts real agentation package through installAgentationReactRoot and cleans host on unmount", async () => {
    registerAgentationReactRootEntry({ win: window });

    const mounted = installAgentationReactRoot({
      adapter: createAdapterMock(),
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    const reactHost = document.getElementById(AGENTATION_REACT_HOST_ID);
    expect(reactHost).not.toBeNull();
    // React root 应优先命中真实 agentation 包挂载点，而不是旧 shell host。
    const packageHost = reactHost?.shadowRoot?.querySelector('[data-agentation-react-package-host="true"]');
    expect(packageHost).not.toBeNull();
    expect(reactHost?.shadowRoot?.querySelector('[data-agentation-react-shell-host="true"]')).toBeNull();
    // agentation 包主体通过 portal 渲染到 document.body，首次渲染需要等一个 effect tick。
    await vi.waitFor(() => {
      expect(document.body.querySelector("[data-agentation-root]")).not.toBeNull();
    });

    const entry = window["agentation-react-root"];
    if (entry && typeof entry === "object" && "unmount" in entry && typeof entry.unmount === "function") {
      entry.unmount();
    }
    expect(document.getElementById(AGENTATION_REACT_HOST_ID)).toBeNull();
    expect(document.body.querySelector("[data-agentation-root]")).toBeNull();
  });

  it("keeps direct installAgentationShell path available", () => {
    const mounted = installAgentationShell({
      adapter: createAdapterMock(),
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    const shellHost = document.getElementById(AGENTATION_SHELL_HOST_ID);
    expect(shellHost).not.toBeNull();
    expect(shellHost?.shadowRoot?.querySelector("[data-toolbar]")).not.toBeNull();
  });
});

function cleanupReactRootEntry(): void {
  const entry = window["agentation-react-root"];
  if (entry && typeof entry === "object" && "unmount" in entry && typeof entry.unmount === "function") {
    entry.unmount();
  }
  for (const key of REACT_ROOT_ENTRY_KEYS) {
    delete (window as Window & Record<string, unknown>)[key];
  }
}

function createAdapterMock() {
  return {
    createAnnotation: vi.fn().mockResolvedValue({ id: "mock-id" }),
  };
}
