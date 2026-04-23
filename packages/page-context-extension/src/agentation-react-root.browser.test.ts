import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installAgentationShell, type AgentationShellFeedbackDelta, type AgentationShellFeedbackSnapshot } from "@page-context/agentation-shell";
import type { Annotation as AgentationAnnotation } from "./agentation-source-runtime";
import {
  AGENTATION_REACT_HOST_ID,
  AGENTATION_REACT_ROOT_ENTRY_KEY,
  mountAgentationReactRoot,
  registerAgentationReactRootEntry,
} from "./agentation-react-root";
import { installAgentationReactRoot, installFeedbackUiWithFallback } from "./feedback-ui-adapter";
import {
  FEEDBACK_UI_MODE_ATTR,
  FEEDBACK_UI_REASON_ATTR,
  FEEDBACK_UI_SELF_CHECK_RESULT_ATTR,
  FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR,
  FEEDBACK_UI_SELF_CHECK_STATUS_ATTR,
} from "./feedback-ui-diagnostics";
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
    clearFeedbackUiDiagnostics();
    cleanupReactRootEntry();
  });

  afterEach(() => {
    cleanupReactRootEntry();
    clearFeedbackUiDiagnostics();
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
    clearFeedbackUiDiagnostics();
    cleanupReactRootEntry();
  });

  afterEach(() => {
    cleanupReactRootEntry();
    clearFeedbackUiDiagnostics();
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

  it("keeps react-root mode on normal path and does not expose shell fallback marker", async () => {
    registerAgentationReactRootEntry({ win: window });

    const mounted = installAgentationReactRoot({
      adapter: createAdapterMock(),
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute(FEEDBACK_UI_MODE_ATTR)).toBe("react-root");
    });
    expect(document.documentElement.hasAttribute(FEEDBACK_UI_REASON_ATTR)).toBe(false);
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR)).toBe("ok");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR)).toBe("present");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR)).toBe(
      `#${AGENTATION_REACT_HOST_ID}`,
    );

    const reactHost = document.getElementById(AGENTATION_REACT_HOST_ID);
    expect(reactHost?.shadowRoot?.querySelector('[data-agentation-feedback-ui-mode="shell-fallback"]')).toBeNull();
    expect(reactHost?.shadowRoot?.querySelector('[data-agentation-react-shell-host="true"]')).toBeNull();
  });

  it("keeps vendored path when document.body is temporarily missing at mount time", async () => {
    registerAgentationReactRootEntry({ win: window });

    // 模拟真实页面短暂 DOM 重建：挂载瞬间 body 不可用。
    document.body.remove();
    expect(document.body).toBeNull();

    const mounted = installAgentationReactRoot({
      adapter: createAdapterMock(),
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    // body 恢复前不应误降级出 shell host。
    const reactHostBeforeRestore = document.getElementById(AGENTATION_REACT_HOST_ID);
    expect(reactHostBeforeRestore?.shadowRoot?.querySelector('[data-agentation-react-shell-host="true"]')).toBeNull();

    // 恢复 body，验证 vendored UI 能继续正常挂载。
    const restoredBody = document.createElement("body");
    document.documentElement.appendChild(restoredBody);

    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute(FEEDBACK_UI_MODE_ATTR)).toBe("react-root");
      expect(document.body?.querySelector("[data-agentation-root]")).not.toBeNull();
    });
    expect(document.documentElement.hasAttribute(FEEDBACK_UI_REASON_ATTR)).toBe(false);
  });

  it("falls back to shell with visible reason when vendored render throws", async () => {
    vi.resetModules();
    vi.doMock("./agentation-source-runtime", async () => {
      const actual = await vi.importActual<typeof import("./agentation-source-runtime")>("./agentation-source-runtime");
      return {
        ...actual,
        Agentation: () => {
          throw new Error("forced vendored render failure in test");
        },
      };
    });

    try {
      const [{ registerAgentationReactRootEntry: registerEntry }, { installAgentationReactRoot: installReactRoot }] = await Promise.all([
        import("./agentation-react-root"),
        import("./feedback-ui-adapter"),
      ]);

      registerEntry({ win: window });
      const mounted = installReactRoot({
        adapter: createAdapterMock(),
        doc: document,
        win: window,
      });
      expect(mounted).toBe(true);

      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute(FEEDBACK_UI_MODE_ATTR)).toBe("shell-fallback");
      });
      expect(document.documentElement.getAttribute(FEEDBACK_UI_REASON_ATTR)).toBe("agentation-package-render-failed");
      expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR)).toBe("ok");
      expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR)).toBe("present");
      expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR)).toBe(
        `#${AGENTATION_REACT_HOST_ID}`,
      );

      const reactHost = document.getElementById(AGENTATION_REACT_HOST_ID);
      const shellHost = reactHost?.shadowRoot?.querySelector('[data-agentation-react-shell-host="true"]');
      expect(shellHost).not.toBeNull();
      expect(shellHost?.getAttribute("data-agentation-react-shell-fallback-reason")).toBe(
        "agentation-package-render-failed",
      );
    } finally {
      vi.doUnmock("./agentation-source-runtime");
      vi.resetModules();
    }
  });

  it("marks shell fallback mode and reason when top-level installer skips react root", () => {
    const installLegacyOverlay = vi.fn();

    installFeedbackUiWithFallback({
      installReactRoot: () => false,
      installAgentationShell: () => {
        ensureTopLevelShellHost();
        return true;
      },
      installLegacyOverlay,
      log: vi.fn(),
    });

    expect(document.documentElement.getAttribute(FEEDBACK_UI_MODE_ATTR)).toBe("shell-fallback");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_REASON_ATTR)).toBe("react-root-skipped");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR)).toBe("ok");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR)).toBe("present");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR)).toBe(
      `#${AGENTATION_SHELL_HOST_ID}`,
    );
    expect(installLegacyOverlay).not.toHaveBeenCalled();
  });

  it("marks shell fallback mode and reason when top-level react root throws", () => {
    const installLegacyOverlay = vi.fn();

    installFeedbackUiWithFallback({
      installReactRoot: () => {
        throw new Error("react root install failed");
      },
      installAgentationShell: () => {
        ensureTopLevelShellHost();
        return true;
      },
      installLegacyOverlay,
      log: vi.fn(),
    });

    expect(document.documentElement.getAttribute(FEEDBACK_UI_MODE_ATTR)).toBe("shell-fallback");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_REASON_ATTR)).toBe("react-root-install-failed");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR)).toBe("ok");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR)).toBe("present");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR)).toBe(
      `#${AGENTATION_SHELL_HOST_ID}`,
    );
    expect(installLegacyOverlay).not.toHaveBeenCalled();
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

  it("reflects remote dismissed delta in mounted package with storage patch and remount", async () => {
    registerAgentationReactRootEntry({ win: window });
    const getFeedbackSnapshot = vi.fn().mockResolvedValue(buildFeedbackSnapshotForWarmup());
    const getFeedbackStateDelta = vi
      .fn()
      .mockResolvedValueOnce(
        buildFeedbackDeltaResult([
          buildFeedbackDeltaEvent({
            eventType: "annotation.dismissed",
            annotationId: "snapshot-1",
            seq: 2,
          }),
        ], 2),
      )
      .mockResolvedValue(buildFeedbackDeltaResult([], 2));

    const mounted = installAgentationReactRoot({
      adapter: {
        createAnnotation: vi.fn().mockResolvedValue({ id: "created-1" }),
        getFeedbackSnapshot,
        getFeedbackStateDelta,
      },
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    await vi.waitFor(() => {
      expect(document.body.querySelector("[data-agentation-root]")).not.toBeNull();
    });
    const firstRoot = document.body.querySelector("[data-agentation-root]");
    const storageKey = getStorageKey(window.location.pathname);

    await vi.waitFor(() => {
      expect(getFeedbackStateDelta).toHaveBeenCalledTimes(1);
      const ids = readStoredAnnotationIds(storageKey);
      expect(ids).not.toContain("snapshot-1");
    });

    await vi.waitFor(() => {
      const currentRoot = document.body.querySelector("[data-agentation-root]");
      expect(currentRoot).not.toBeNull();
      // delta 生效后会重挂载 vendored 包，确保当前挂载实例看到 storage 更新。
      expect(currentRoot).not.toBe(firstRoot);
    });
    // dismiss + annotationId 只做本地最小删除，不触发 snapshot reload。
    expect(getFeedbackSnapshot).toHaveBeenCalledTimes(1);
  });

  it("reloads snapshot warmup and remounts package for non-dismissed annotation delta", async () => {
    registerAgentationReactRootEntry({ win: window });
    const getFeedbackSnapshot = vi
      .fn()
      .mockResolvedValueOnce(buildFeedbackSnapshotForWarmup({ body: "before delta reload" }))
      .mockResolvedValueOnce(buildFeedbackSnapshotForWarmup({ body: "after delta reload" }));
    const getFeedbackStateDelta = vi
      .fn()
      .mockResolvedValueOnce(
        buildFeedbackDeltaResult([
          buildFeedbackDeltaEvent({
            eventType: "annotation.updated",
            annotationId: "snapshot-1",
            seq: 2,
          }),
        ], 2),
      )
      .mockResolvedValue(buildFeedbackDeltaResult([], 2));

    const mounted = installAgentationReactRoot({
      adapter: {
        createAnnotation: vi.fn().mockResolvedValue({ id: "created-1" }),
        getFeedbackSnapshot,
        getFeedbackStateDelta,
      },
      doc: document,
      win: window,
    });
    expect(mounted).toBe(true);

    await vi.waitFor(() => {
      expect(document.body.querySelector("[data-agentation-root]")).not.toBeNull();
    });
    const firstRoot = document.body.querySelector("[data-agentation-root]");
    const storageKey = getStorageKey(window.location.pathname);
    await vi.waitFor(() => {
      expect(readStoredAnnotationBodies(storageKey)).toContain("before delta reload");
    });

    await vi.waitFor(() => {
      expect(getFeedbackSnapshot).toHaveBeenCalledTimes(2);
      expect(readStoredAnnotationBodies(storageKey)).toContain("after delta reload");
    });
    await vi.waitFor(() => {
      const currentRoot = document.body.querySelector("[data-agentation-root]");
      expect(currentRoot).not.toBeNull();
      expect(currentRoot).not.toBe(firstRoot);
    });
  });

  it("queues marker update before create returns and flushes to remote id afterwards", async () => {
    vi.resetModules();
    const callbacks: {
      onAnnotationAdd?: (annotation: AgentationAnnotation) => void;
      onAnnotationUpdate?: (annotation: AgentationAnnotation) => void;
    } = {};

    vi.doMock("./agentation-source-runtime", async () => {
      const React = await vi.importActual<typeof import("react")>("react");
      return {
        Agentation: (props: {
          onAnnotationAdd?: (annotation: AgentationAnnotation) => void;
          onAnnotationUpdate?: (annotation: AgentationAnnotation) => void;
        }) => {
          callbacks.onAnnotationAdd = props.onAnnotationAdd;
          callbacks.onAnnotationUpdate = props.onAnnotationUpdate;
          return React.createElement("div", { "data-agentation-root": "true" });
        },
      };
    });

    try {
      const [{ registerAgentationReactRootEntry: registerEntry }, { installAgentationReactRoot: installReactRoot }] = await Promise.all([
        import("./agentation-react-root"),
        import("./feedback-ui-adapter"),
      ]);

      registerEntry({ win: window });
      let resolveCreate: ((result: { id: string }) => void) | null = null;
      const createAnnotation = vi.fn().mockImplementation(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveCreate = resolve;
          }),
      );
      const updateAnnotation = vi.fn().mockResolvedValue({ ok: true });

      const mounted = installReactRoot({
        adapter: {
          createAnnotation,
          updateAnnotation,
        },
        doc: document,
        win: window,
      });
      expect(mounted).toBe(true);

      await vi.waitFor(() => {
        expect(typeof callbacks.onAnnotationAdd).toBe("function");
        expect(typeof callbacks.onAnnotationUpdate).toBe("function");
      });

      callbacks.onAnnotationAdd?.(buildMockAgentationAnnotation({
        id: "local-queue-update-1",
        comment: "before update",
        severity: "important",
      }));
      callbacks.onAnnotationUpdate?.(buildMockAgentationAnnotation({
        id: "local-queue-update-1",
        comment: "after update",
        severity: "blocking",
      }));

      expect(createAnnotation).toHaveBeenCalledTimes(1);
      // create 还没返回 remoteId 前，update 只入队，不应提前发 RPC。
      expect(updateAnnotation).toHaveBeenCalledTimes(0);

      resolveCreate?.({ id: "remote-update-1" });
      await vi.waitFor(() => {
        expect(updateAnnotation).toHaveBeenCalledTimes(1);
      });
      expect(updateAnnotation).toHaveBeenCalledWith({
        annotationId: "remote-update-1",
        body: "after update",
        priority: "critical",
      });
    } finally {
      vi.doUnmock("./agentation-source-runtime");
      vi.resetModules();
    }
  });

  it("queues marker delete before create returns and flushes dismiss after remote id is known", async () => {
    vi.resetModules();
    const callbacks: {
      onAnnotationAdd?: (annotation: AgentationAnnotation) => void;
      onAnnotationDelete?: (annotation: AgentationAnnotation) => void;
    } = {};

    vi.doMock("./agentation-source-runtime", async () => {
      const React = await vi.importActual<typeof import("react")>("react");
      return {
        Agentation: (props: {
          onAnnotationAdd?: (annotation: AgentationAnnotation) => void;
          onAnnotationDelete?: (annotation: AgentationAnnotation) => void;
        }) => {
          callbacks.onAnnotationAdd = props.onAnnotationAdd;
          callbacks.onAnnotationDelete = props.onAnnotationDelete;
          return React.createElement("div", { "data-agentation-root": "true" });
        },
      };
    });

    try {
      const [{ registerAgentationReactRootEntry: registerEntry }, { installAgentationReactRoot: installReactRoot }] = await Promise.all([
        import("./agentation-react-root"),
        import("./feedback-ui-adapter"),
      ]);

      registerEntry({ win: window });
      let resolveCreate: ((result: { id: string }) => void) | null = null;
      const createAnnotation = vi.fn().mockImplementation(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveCreate = resolve;
          }),
      );
      const dismissAnnotation = vi.fn().mockResolvedValue({ ok: true });

      const mounted = installReactRoot({
        adapter: {
          createAnnotation,
          dismissAnnotation,
        },
        doc: document,
        win: window,
      });
      expect(mounted).toBe(true);

      await vi.waitFor(() => {
        expect(typeof callbacks.onAnnotationAdd).toBe("function");
        expect(typeof callbacks.onAnnotationDelete).toBe("function");
      });

      callbacks.onAnnotationAdd?.(buildMockAgentationAnnotation({
        id: "local-queue-dismiss-1",
        comment: "dismiss me",
      }));
      callbacks.onAnnotationDelete?.(buildMockAgentationAnnotation({
        id: "local-queue-dismiss-1",
        comment: "dismiss me",
      }));

      expect(createAnnotation).toHaveBeenCalledTimes(1);
      // create 结果未返回前先记账，避免删除动作丢失。
      expect(dismissAnnotation).toHaveBeenCalledTimes(0);

      resolveCreate?.({ id: "remote-dismiss-1" });
      await vi.waitFor(() => {
        expect(dismissAnnotation).toHaveBeenCalledTimes(1);
      });
      expect(dismissAnnotation).toHaveBeenCalledWith({
        annotationId: "remote-dismiss-1",
        dismissReason: "marker deleted from agentation package",
      });
    } finally {
      vi.doUnmock("./agentation-source-runtime");
      vi.resetModules();
    }
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

function buildFeedbackSnapshotForWarmup(options?: { body?: string }): AgentationShellFeedbackSnapshot {
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
        body: options?.body ?? "remote snapshot annotation",
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

function buildFeedbackDeltaResult(events: AgentationShellFeedbackDelta["events"], lastSeq: number): AgentationShellFeedbackDelta {
  return {
    events,
    lastSeq,
  };
}

function buildFeedbackDeltaEvent(options: {
  eventType: AgentationShellFeedbackDelta["events"][number]["eventType"];
  annotationId?: string;
  seq: number;
}): AgentationShellFeedbackDelta["events"][number] {
  return {
    eventId: `event-${options.seq}`,
    tenantId: "default",
    sessionId: "session-1",
    annotationId: options.annotationId,
    seq: options.seq,
    eventType: options.eventType,
    occurredAt: "2026-04-22T00:00:00.000Z",
    source: "bridge",
    payload: {},
  };
}

function buildMockAgentationAnnotation(overrides: Partial<AgentationAnnotation> = {}): AgentationAnnotation {
  return {
    id: overrides.id ?? "mock-local-annotation",
    x: overrides.x ?? 40,
    y: overrides.y ?? 120,
    comment: overrides.comment ?? "mock comment",
    element: overrides.element ?? "button",
    elementPath: overrides.elementPath ?? "#target",
    timestamp: overrides.timestamp ?? 1_234_567_890,
    selectedText: overrides.selectedText,
    boundingBox: overrides.boundingBox,
    fullPath: overrides.fullPath,
    reactComponents: overrides.reactComponents,
    sourceFile: overrides.sourceFile,
    isMultiSelect: overrides.isMultiSelect,
    isFixed: overrides.isFixed,
    severity: overrides.severity,
  };
}

function readStoredAnnotationIds(storageKey: string): string[] {
  const stored = localStorage.getItem(storageKey);
  if (!stored) {
    return [];
  }
  const parsed = JSON.parse(stored) as Array<{ id?: unknown }>;
  return parsed.map((item) => (typeof item.id === "string" ? item.id : "")).filter(Boolean);
}

function readStoredAnnotationBodies(storageKey: string): string[] {
  const stored = localStorage.getItem(storageKey);
  if (!stored) {
    return [];
  }
  const parsed = JSON.parse(stored) as Array<{ comment?: unknown }>;
  return parsed.map((item) => (typeof item.comment === "string" ? item.comment : "")).filter(Boolean);
}

function clearFeedbackUiDiagnostics(): void {
  document.documentElement.removeAttribute(FEEDBACK_UI_MODE_ATTR);
  document.documentElement.removeAttribute(FEEDBACK_UI_REASON_ATTR);
  document.documentElement.removeAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR);
  document.documentElement.removeAttribute(FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR);
  document.documentElement.removeAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR);
}

function ensureTopLevelShellHost(): void {
  if (document.getElementById(AGENTATION_SHELL_HOST_ID)) {
    return;
  }
  const host = document.createElement("div");
  host.id = AGENTATION_SHELL_HOST_ID;
  document.body.appendChild(host);
}
