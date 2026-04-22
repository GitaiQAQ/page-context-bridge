import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installAgentationShell, type AgentationShellFeedbackSnapshot } from "@page-context/agentation-shell";
import {
  AGENTATION_REACT_HOST_ID,
  AGENTATION_REACT_ROOT_ENTRY_KEY,
  mountAgentationReactRoot,
  registerAgentationReactRootEntry,
} from "./agentation-react-root";
import { installAgentationReactRoot } from "./feedback-ui-adapter";
import { getStorageKey } from "./vendor/agentation/utils/storage";

const AGENTATION_SHELL_HOST_ID = "__page_context_agentation_shell_host__";
const REACT_ROOT_ENTRY_KEYS = [
  AGENTATION_REACT_ROOT_ENTRY_KEY,
  "__PAGE_CONTEXT_AGENTATION_REACT_ROOT__",
  "__page_context_agentation_react_root__",
] as const;

describe("mountAgentationReactRoot", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    cleanupReactRootEntry();
  });

  afterEach(() => {
    cleanupReactRootEntry();
    localStorage.clear();
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
    localStorage.clear();
    cleanupReactRootEntry();
  });

  afterEach(() => {
    cleanupReactRootEntry();
    localStorage.clear();
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

  it("warms vendored annotation storage from snapshot before first package render", async () => {
    registerAgentationReactRootEntry({ win: window });
    const getFeedbackSnapshot = vi.fn().mockResolvedValue(buildFeedbackSnapshotForWarmup());

    const mounted = installAgentationReactRoot({
      adapter: {
        createAnnotation: vi.fn().mockResolvedValue({ id: "created-1" }),
        getFeedbackSnapshot,
      },
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    // 预热完成前先写 localStorage，vendored UI 首屏读取的就是这份快照映射。
    const storageKey = getStorageKey(window.location.pathname);
    await vi.waitFor(() => {
      expect(getFeedbackSnapshot).toHaveBeenCalledTimes(1);
      const stored = localStorage.getItem(storageKey);
      expect(stored).not.toBeNull();
      const annotations = JSON.parse(stored ?? "[]") as Array<{ id: string; comment: string; elementPath: string }>;
      expect(annotations).toEqual([
        expect.objectContaining({
          id: "snapshot-1",
          comment: "remote snapshot annotation",
          elementPath: "#target",
        }),
      ]);
    });
    await vi.waitFor(() => {
      expect(document.body.querySelector("[data-agentation-root]")).not.toBeNull();
    });
  });

  it("mounts package normally when adapter does not expose snapshot API", async () => {
    registerAgentationReactRootEntry({ win: window });
    const mounted = installAgentationReactRoot({
      adapter: createAdapterMock(),
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);
    await vi.waitFor(() => {
      expect(document.body.querySelector("[data-agentation-root]")).not.toBeNull();
    });
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

function buildFeedbackSnapshotForWarmup(): AgentationShellFeedbackSnapshot {
  return {
    sessions: [
      {
        id: "session-1",
        tenantId: "default",
        tabId: 1,
        url: "https://example.com",
        title: "example",
        status: "active",
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
        lastEventSeq: 1,
      },
    ],
    annotations: [
      {
        id: "snapshot-1",
        sessionId: "session-1",
        author: { source: "extension", id: "u-1", displayName: "Ext User" },
        body: "remote snapshot annotation",
        status: "open",
        priority: "high",
        target: {
          tabId: 1,
          url: "https://example.com",
          title: "example",
          textQuote: "target text",
          uiAnchor: {
            cssSelector: "#target",
            rect: { x: 80, y: 120, width: 140, height: 36 },
            meta: {
              source: "agentation-shell",
              elementName: "button",
              elementPath: "#target",
            },
          },
        },
        context: {
          pageInfo: {
            tabId: 1,
            url: "https://example.com",
            title: "example",
          },
          selectedText: "target text",
        },
        linkedCapabilities: {
          namespaceHints: [],
          relatedToolNames: [],
          relatedResourceIds: [],
          relatedSkillIds: [],
          linkReasons: [],
        },
        thread: [],
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
    ],
    snapshotVersion: 2,
    lastSeq: 1,
  };
}
