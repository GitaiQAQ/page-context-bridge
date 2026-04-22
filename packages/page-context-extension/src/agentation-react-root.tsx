import {
  mountAgentationShell,
  type AgentationShellBridgeAdapter,
  type AgentationShellCreateAnnotationInput,
  type AgentationShellDeps,
  type AgentationShellDismissAnnotationInput,
  type AgentationShellMountHandle,
  type AgentationShellUpdateAnnotationInput,
} from "@page-context/agentation-shell";
import type { FeedbackPriority, FeedbackUiAnchor } from "@page-context/shared-protocol";
import { Agentation, type Annotation as AgentationAnnotation } from "./agentation-source-runtime";
import { Component, StrictMode, type ErrorInfo, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  buildAgentationFeedbackDeltaPlan,
  dismissVendorAnnotationsFromStorage,
  type AgentationSnapshotReplayBinding,
  warmupAgentationSnapshotBeforeMount,
  type AgentationSnapshotWarmupResult,
} from "./agentation-bridge-snapshot-warmup";

export const AGENTATION_REACT_HOST_ID = "__page_context_agentation_react_host__";
export const AGENTATION_REACT_ROOT_ENTRY_KEY = "agentation-react-root";
const MOUNT_CONTAINER_ATTR = "data-page-context-react-mount-key";
const HOST_MARK_ATTR = "data-page-context-react-host";
const DEFAULT_MOUNT_KEY = "default";
const AGENTATION_PACKAGE_MOUNT_KEY = "agentation-package";
const NESTED_SHELL_HOST_ATTR = "data-agentation-react-shell-host";
const AGENTATION_PACKAGE_HOST_ATTR = "data-agentation-react-package-host";
const AGENTATION_SHELL_DISMISS_REASON = "marker deleted from agentation package";
const AGENTATION_PACKAGE_DELTA_SYNC_INTERVAL_MS = 350;
const AGENTATION_REACT_ROOT_COMPAT_ENTRY_KEYS = [
  AGENTATION_REACT_ROOT_ENTRY_KEY,
  "__PAGE_CONTEXT_AGENTATION_REACT_ROOT__",
  "__page_context_agentation_react_root__",
] as const;

const rootByContainer = new WeakMap<HTMLElement, Root>();
const entryByWindow = new WeakMap<Window, AgentationReactRootEntryObject>();

interface AgentationRemoteBinding {
  remoteId?: string;
  priority: FeedbackPriority;
}

interface AgentationPackageMountBridgeProps extends AgentationReactRootEntryMountArgs {
  snapshotWarmupPromise: Promise<AgentationSnapshotWarmupResult>;
}

interface AgentationPackageErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
  onError: (error: Error, info: ErrorInfo) => void;
}

interface AgentationPackageErrorBoundaryState {
  hasError: boolean;
}

/**
 * 真实 Agentation 包渲染失败时，立即降级到现有 shell。
 * 这样 PoC 即使遇到页面兼容问题，也不会中断原有链路。
 */
class AgentationPackageErrorBoundary extends Component<
  AgentationPackageErrorBoundaryProps,
  AgentationPackageErrorBoundaryState
> {
  state: AgentationPackageErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AgentationPackageErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError(error, info);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

export interface AgentationReactRootContext {
  doc: Document;
  win: Window;
  host: HTMLDivElement;
  shadowRoot: ShadowRoot;
  container: HTMLDivElement;
  mountKey: string;
}

export interface AgentationReactRootMountOptions {
  doc?: Document;
  win?: Window;
  hostId?: string;
  mountKey?: string;
  render?: (context: AgentationReactRootContext) => ReactNode;
}

export interface AgentationReactRootHandle extends AgentationReactRootContext {
  root: Root;
  unmount: () => void;
}

export interface AgentationReactRootEntryMountArgs {
  adapter: AgentationShellBridgeAdapter;
  doc: Document;
  win: Window;
  logger?: AgentationShellDeps["logger"];
}

export interface AgentationReactRootEntryMountResult {
  mounted: boolean;
  unmount: () => void;
}

export interface AgentationReactRootEntryObject {
  mount: (args: AgentationReactRootEntryMountArgs) => AgentationReactRootEntryMountResult;
  install: (args: AgentationReactRootEntryMountArgs) => AgentationReactRootEntryMountResult;
  unmount: () => void;
}

/**
 * 把 React root 暴露为稳定 window 入口，供 content-script fallback 链路调用。
 */
export function registerAgentationReactRootEntry(options: { win?: Window } = {}): AgentationReactRootEntryObject {
  const win = options.win ?? globalThis.window;
  if (!win) {
    throw new Error("agentation react root entry requires browser window");
  }

  const existing = entryByWindow.get(win);
  if (existing) {
    installEntryOnWindow(win, existing);
    return existing;
  }

  const entry = createAgentationReactRootEntry();
  entryByWindow.set(win, entry);
  installEntryOnWindow(win, entry);
  return entry;
}

export function mountAgentationReactRoot(options: AgentationReactRootMountOptions = {}): AgentationReactRootHandle {
  // 允许测试注入 doc/win；线上默认使用当前页面环境。
  const doc = options.doc ?? globalThis.document;
  const win = options.win ?? globalThis.window;
  if (!doc || !win) {
    throw new Error("agentation react root requires browser document/window");
  }

  const hostId = options.hostId ?? AGENTATION_REACT_HOST_ID;
  const mountKey = normalizeMountKey(options.mountKey);
  const host = ensureShadowHost(doc, hostId);
  const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const container = ensureMountContainer(shadowRoot, mountKey);

  // 同一个 mountKey 重新挂载时，先卸载旧 root，避免 createRoot 重复绑定同一容器。
  const previousRoot = rootByContainer.get(container);
  if (previousRoot) {
    previousRoot.unmount();
    rootByContainer.delete(container);
  }

  const root = createRoot(container);
  rootByContainer.set(container, root);

  const context: AgentationReactRootContext = {
    doc,
    win,
    host,
    shadowRoot,
    container,
    mountKey,
  };
  const node = options.render?.(context) ?? <DefaultMountProbe mountKey={mountKey} />;
  // 统一使用同步提交，保证内容脚本里“挂载后立刻可见”，测试和业务都更稳定。
  flushSync(() => {
    root.render(<StrictMode>{node}</StrictMode>);
  });

  let disposed = false;
  return {
    ...context,
    root,
    unmount() {
      // 允许多次调用；第一次之后直接返回，保证清理逻辑幂等。
      if (disposed) {
        return;
      }
      disposed = true;

      // 旧句柄不应误伤新 root：只有当前 root 仍是 active 时才执行卸载和容器删除。
      if (rootByContainer.get(container) !== root) {
        return;
      }

      root.unmount();
      rootByContainer.delete(container);
      container.remove();
      cleanupHostIfEmpty(host, shadowRoot);
    },
  };
}

function ensureShadowHost(doc: Document, hostId: string): HTMLDivElement {
  const existing = doc.getElementById(hostId);
  if (existing) {
    if (!(existing instanceof HTMLDivElement)) {
      throw new Error(`agentation react host id conflicts with non-div element: ${hostId}`);
    }
    existing.setAttribute(HOST_MARK_ATTR, "true");
    return existing;
  }

  const host = doc.createElement("div");
  host.id = hostId;
  host.setAttribute(HOST_MARK_ATTR, "true");

  // body 还没准备好时，回退挂在 documentElement，避免丢挂载时机。
  const parent = doc.body ?? doc.documentElement;
  if (!parent) {
    throw new Error("agentation react host cannot be mounted: missing document root");
  }
  parent.appendChild(host);
  return host;
}

function ensureMountContainer(shadowRoot: ShadowRoot, mountKey: string): HTMLDivElement {
  for (const node of shadowRoot.querySelectorAll(`[${MOUNT_CONTAINER_ATTR}]`)) {
    if (node instanceof HTMLDivElement && node.getAttribute(MOUNT_CONTAINER_ATTR) === mountKey) {
      return node;
    }
  }

  const container = shadowRoot.ownerDocument.createElement("div");
  container.setAttribute(MOUNT_CONTAINER_ATTR, mountKey);
  shadowRoot.appendChild(container);
  return container;
}

function cleanupHostIfEmpty(host: HTMLDivElement, shadowRoot: ShadowRoot): void {
  const hasActiveMount = shadowRoot.querySelector(`[${MOUNT_CONTAINER_ATTR}]`);
  if (hasActiveMount) {
    return;
  }
  host.remove();
}

function normalizeMountKey(input: string | undefined): string {
  const key = input?.trim();
  return key ? key : DEFAULT_MOUNT_KEY;
}

function installEntryOnWindow(win: Window, entry: AgentationReactRootEntryObject): void {
  const globalScope = win as Window & Record<string, unknown>;
  for (const key of AGENTATION_REACT_ROOT_COMPAT_ENTRY_KEYS) {
    globalScope[key] = entry;
  }
}

function createAgentationReactRootEntry(): AgentationReactRootEntryObject {
  let activeHandle: AgentationReactRootHandle | null = null;

  const mount = (args: AgentationReactRootEntryMountArgs): AgentationReactRootEntryMountResult => {
    if (activeHandle) {
      return {
        mounted: true,
        // 复用句柄时直接走统一 unmount，避免多份清理逻辑漂移。
        unmount: () => {
          if (!activeHandle) {
            return;
          }
          const handle = activeHandle;
          activeHandle = null;
          handle.unmount();
        },
      };
    }

    const handle = mountAgentationReactRoot({
      doc: args.doc,
      win: args.win,
      mountKey: AGENTATION_PACKAGE_MOUNT_KEY,
      // snapshot 预热在 React root 挂载前就启动，减少空窗期。
      render: () => (
        <AgentationPackageMountBridge
          {...args}
          snapshotWarmupPromise={warmupAgentationSnapshotBeforeMount({
            adapter: args.adapter,
            win: args.win,
            logger: args.logger,
          })}
        />
      ),
    });
    activeHandle = handle;

    let disposed = false;
    return {
      mounted: true,
      unmount() {
        if (disposed) {
          return;
        }
        disposed = true;
        if (activeHandle !== handle) {
          return;
        }
        activeHandle = null;
        handle.unmount();
      },
    };
  };

  return {
    mount,
    install: mount,
    unmount() {
      if (!activeHandle) {
        return;
      }
      const handle = activeHandle;
      activeHandle = null;
      handle.unmount();
    },
  };
}

function AgentationPackageMountBridge(props: AgentationPackageMountBridgeProps) {
  const remoteBindingByLocalIdRef = useRef<Map<string, AgentationRemoteBinding>>(new Map());
  const feedbackDeltaSyncInFlightRef = useRef<Promise<void> | null>(null);
  const [warmupReady, setWarmupReady] = useState(false);
  const [packageRemountVersion, setPackageRemountVersion] = useState(0);

  useLayoutEffect(() => {
    let cancelled = false;
    void props.snapshotWarmupPromise.then((result) => {
      if (cancelled) {
        return;
      }
      // 预热阶段把 localId/remoteId 关系写入内存，后续增量同步可以直接沿用这份索引。
      replaceRemoteBindingsFromWarmup(remoteBindingByLocalIdRef.current, result.replayBindings);
      props.logger?.("debug", "agentation package snapshot warmup completed", {
        status: result.status,
        annotationCount: result.annotationCount,
      });
      setWarmupReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [props.logger, props.snapshotWarmupPromise]);

  useEffect(() => {
    const getFeedbackStateDelta = props.adapter.getFeedbackStateDelta;
    if (!warmupReady || !getFeedbackStateDelta) {
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;

    const runDeltaSyncOnce = async (): Promise<void> => {
      if (feedbackDeltaSyncInFlightRef.current) {
        await feedbackDeltaSyncInFlightRef.current;
        return;
      }

      const task = (async () => {
        const delta = await getFeedbackStateDelta();
        if (cancelled) {
          return;
        }

        const plan = buildAgentationFeedbackDeltaPlan(delta);
        if (plan.eventCount === 0) {
          return;
        }

        let removedCount = 0;
        let snapshotReloaded = false;
        let shouldRemountPackage = false;

        if (plan.dismissedAnnotationIds.size > 0) {
          // 优先用 bridge 已知映射把 remoteId 折算到本地 id，降低“删不干净”概率。
          const dismissLocalIds = resolveLocalAnnotationIdsForDismissedRemoteIds(
            remoteBindingByLocalIdRef.current,
            plan.dismissedAnnotationIds,
          );
          const dismissResult = dismissVendorAnnotationsFromStorage({
            win: props.win,
            annotationIds: dismissLocalIds,
          });
          removedCount = dismissResult.removedCount;
          if (dismissResult.removedCount > 0) {
            shouldRemountPackage = true;
          }
          removeRemoteBindingsByDismissedRemoteIds(remoteBindingByLocalIdRef.current, plan.dismissedAnnotationIds);
        }

        if (plan.shouldReloadSnapshot) {
          if (props.adapter.getFeedbackSnapshot) {
            const warmupResult = await warmupAgentationSnapshotBeforeMount({
              adapter: props.adapter,
              win: props.win,
              logger: props.logger,
            });
            if (cancelled) {
              return;
            }
            replaceRemoteBindingsFromWarmup(remoteBindingByLocalIdRef.current, warmupResult.replayBindings);
            snapshotReloaded = true;
            shouldRemountPackage = true;
          } else {
            props.logger?.("error", "agentation package delta requires snapshot reload but snapshot api is missing", {
              eventCount: plan.eventCount,
            });
          }
        }

        if (shouldRemountPackage) {
          // vendored 组件不监听 bridge 侧存储写入，安全做法是整体重挂载后再读 localStorage。
          setPackageRemountVersion((previous) => previous + 1);
        }
        props.logger?.("debug", "agentation package feedback delta sync completed", {
          eventCount: plan.eventCount,
          removedCount,
          snapshotReloaded,
          remounted: shouldRemountPackage,
          lastSeq: delta.lastSeq,
        });
      })().catch((error) => {
        props.logger?.("error", "agentation package feedback delta sync failed", {
          error,
        });
      });

      feedbackDeltaSyncInFlightRef.current = task.finally(() => {
        feedbackDeltaSyncInFlightRef.current = null;
      });
      await feedbackDeltaSyncInFlightRef.current;
    };

    const scheduleNextDeltaSync = (delayMs: number): void => {
      if (cancelled) {
        return;
      }
      timerId = props.win.setTimeout(() => {
        void syncLoop();
      }, delayMs);
    };

    const syncLoop = async (): Promise<void> => {
      await runDeltaSyncOnce();
      scheduleNextDeltaSync(AGENTATION_PACKAGE_DELTA_SYNC_INTERVAL_MS);
    };

    // 让 vendored 首轮 mount/持久化先稳定，再开始轮询，避免首屏 effect 竞争覆盖 delta 落盘。
    scheduleNextDeltaSync(AGENTATION_PACKAGE_DELTA_SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timerId !== null) {
        props.win.clearTimeout(timerId);
      }
    };
  }, [props.adapter, props.logger, props.win, warmupReady]);

  const handleAnnotationAdd = useCallback(
    (annotation: AgentationAnnotation) => {
      const localId = normalizeAnnotationId(annotation.id);
      if (!localId) {
        props.logger?.("error", "skip agentation annotation create because local id is invalid", {
          annotation,
        });
        return;
      }
      const payload = buildCreatePayloadFromAgentation(annotation, props.win);
      if (!payload) {
        props.logger?.("error", "skip agentation annotation create because payload is invalid", {
          localId,
          annotation,
        });
        return;
      }

      remoteBindingByLocalIdRef.current.set(localId, { priority: payload.priority });
      void props.adapter
        .createAnnotation(payload)
        .then((result) => {
          const remoteId = normalizeAnnotationId(result.id);
          if (!remoteId) {
            return;
          }
          const binding = remoteBindingByLocalIdRef.current.get(localId);
          if (!binding) {
            return;
          }
          binding.remoteId = remoteId;
        })
        .catch((error) => {
          props.logger?.("error", "agentation package create annotation failed", {
            localId,
            error,
          });
        });
    },
    [props.adapter, props.logger, props.win],
  );

  const handleAnnotationUpdate = useCallback(
    (annotation: AgentationAnnotation) => {
      const updateAnnotation = props.adapter.updateAnnotation;
      if (!updateAnnotation) {
        return;
      }

      const localId = normalizeAnnotationId(annotation.id);
      if (!localId) {
        return;
      }
      const binding = remoteBindingByLocalIdRef.current.get(localId);
      if (!binding?.remoteId) {
        return;
      }

      const body = annotation.comment.trim();
      if (!body) {
        return;
      }

      const payload: AgentationShellUpdateAnnotationInput = {
        annotationId: binding.remoteId,
        body,
        priority: binding.priority,
      };
      void updateAnnotation(payload).catch((error) => {
        props.logger?.("error", "agentation package update annotation failed", {
          localId,
          remoteId: binding.remoteId,
          error,
        });
      });
    },
    [props.adapter, props.logger],
  );

  const handleAnnotationDelete = useCallback(
    (annotation: AgentationAnnotation) => {
      const localId = normalizeAnnotationId(annotation.id);
      if (!localId) {
        return;
      }
      const binding = remoteBindingByLocalIdRef.current.get(localId);
      remoteBindingByLocalIdRef.current.delete(localId);

      const dismissAnnotation = props.adapter.dismissAnnotation;
      if (!dismissAnnotation || !binding?.remoteId) {
        return;
      }

      const payload: AgentationShellDismissAnnotationInput = {
        annotationId: binding.remoteId,
        dismissReason: AGENTATION_SHELL_DISMISS_REASON,
      };
      void dismissAnnotation(payload).catch((error) => {
        props.logger?.("error", "agentation package dismiss annotation failed", {
          localId,
          remoteId: binding.remoteId,
          error,
        });
      });
    },
    [props.adapter, props.logger],
  );

  return (
    <AgentationPackageErrorBoundary
      onError={(error, info) => {
        props.logger?.("error", "agentation package render failed, fallback to shell", {
          error,
          componentStack: info.componentStack,
        });
      }}
      fallback={<AgentationShellMountBridge {...props} fallbackReason="agentation-package-render-failed" />}
    >
      <div {...{ [AGENTATION_PACKAGE_HOST_ATTR]: "true" }}>
        {/* snapshot 未完成前不渲染 vendored UI，确保首屏读取到的是远端回放结果。 */}
        {warmupReady ? (
          <Agentation
            key={packageRemountVersion}
            copyToClipboard={false}
            onAnnotationAdd={handleAnnotationAdd}
            onAnnotationUpdate={handleAnnotationUpdate}
            onAnnotationDelete={handleAnnotationDelete}
          />
        ) : null}
      </div>
    </AgentationPackageErrorBoundary>
  );
}

function AgentationShellMountBridge(
  props: AgentationReactRootEntryMountArgs & { fallbackReason?: string },
) {
  const shellHostRef = useRef<HTMLDivElement | null>(null);
  const shellHandleRef = useRef<AgentationShellMountHandle | null>(null);

  useLayoutEffect(() => {
    const host = shellHostRef.current;
    if (!host) {
      return;
    }
    // StrictMode 会触发 mount/cleanup 循环，这里每轮都成对回收，保证无泄漏。
    const mounted = mountAgentationShell({
      adapter: props.adapter,
      doc: props.doc,
      win: props.win,
      logger: props.logger,
      host,
    });
    shellHandleRef.current = mounted;
    return () => {
      shellHandleRef.current?.unmount();
      shellHandleRef.current = null;
    };
  }, [props.adapter, props.doc, props.logger, props.win]);

  return (
    <div
      ref={shellHostRef}
      {...{
        [NESTED_SHELL_HOST_ATTR]: "true",
        "data-agentation-react-shell-fallback-reason": props.fallbackReason ?? "",
      }}
    />
  );
}

function resolveLocalAnnotationIdsForDismissedRemoteIds(
  remoteBindingByLocalId: Map<string, AgentationRemoteBinding>,
  dismissedRemoteIds: Set<string>,
): Set<string> {
  const localIds = new Set<string>(dismissedRemoteIds);
  for (const [localId, binding] of remoteBindingByLocalId) {
    if (dismissedRemoteIds.has(localId) || (binding.remoteId && dismissedRemoteIds.has(binding.remoteId))) {
      localIds.add(localId);
    }
  }
  return localIds;
}

function removeRemoteBindingsByDismissedRemoteIds(
  remoteBindingByLocalId: Map<string, AgentationRemoteBinding>,
  dismissedRemoteIds: Set<string>,
): void {
  for (const [localId, binding] of remoteBindingByLocalId) {
    if (dismissedRemoteIds.has(localId) || (binding.remoteId && dismissedRemoteIds.has(binding.remoteId))) {
      remoteBindingByLocalId.delete(localId);
    }
  }
}

function replaceRemoteBindingsFromWarmup(
  remoteBindingByLocalId: Map<string, AgentationRemoteBinding>,
  replayBindings: AgentationSnapshotReplayBinding[],
): void {
  remoteBindingByLocalId.clear();
  for (const binding of replayBindings) {
    remoteBindingByLocalId.set(binding.localId, {
      remoteId: binding.remoteId,
      priority: binding.priority,
    });
  }
}

/**
 * 把 agentation 注释对象映射成 bridge adapter 需要的最小 create 输入。
 * 这里只做稳定字段转换，避免把 UI 内部临时态泄漏到协议层。
 */
function buildCreatePayloadFromAgentation(
  annotation: AgentationAnnotation,
  win: Window,
): AgentationShellCreateAnnotationInput | null {
  const body = annotation.comment.trim();
  if (!body) {
    return null;
  }

  const targetRect = resolveTargetRect(annotation, win);
  const selectedText = normalizeText(annotation.selectedText);
  return {
    body,
    priority: toFeedbackPriority(annotation),
    selectedText,
    uiAnchor: buildUiAnchor(annotation, targetRect, selectedText),
    target: {
      elementName: normalizeText(annotation.element) ?? "element",
      elementPath: normalizeText(annotation.elementPath) ?? "",
      rect: targetRect,
    },
  };
}

function resolveTargetRect(annotation: AgentationAnnotation, win: Window): DOMRectReadOnly {
  const boundingBox = annotation.boundingBox;
  if (boundingBox) {
    const viewportY = annotation.isFixed ? boundingBox.y : boundingBox.y - win.scrollY;
    return new DOMRectReadOnly(
      boundingBox.x,
      viewportY,
      Math.max(1, boundingBox.width),
      Math.max(1, boundingBox.height),
    );
  }

  // x 在 agentation 中是 viewport 宽度百分比；y 为文档坐标（fixed 元素除外）。
  const viewportX = Number.isFinite(annotation.x) ? (annotation.x / 100) * win.innerWidth : win.innerWidth / 2;
  const rawY = Number.isFinite(annotation.y) ? annotation.y : win.innerHeight / 2;
  const viewportY = annotation.isFixed ? rawY : rawY - win.scrollY;
  return new DOMRectReadOnly(viewportX, viewportY, 1, 1);
}

function buildUiAnchor(
  annotation: AgentationAnnotation,
  rect: DOMRectReadOnly,
  selectedText?: string,
): FeedbackUiAnchor {
  const meta: Record<string, unknown> = {
    source: "agentation-react-root",
    element: normalizeText(annotation.element),
    elementPath: normalizeText(annotation.elementPath),
    fullPath: normalizeText(annotation.fullPath),
    reactComponents: normalizeText(annotation.reactComponents),
    sourceFile: normalizeText(annotation.sourceFile),
  };
  if (annotation.isMultiSelect) {
    meta.isMultiSelect = true;
  }
  if (annotation.isFixed) {
    meta.isFixed = true;
  }

  return {
    cssSelector: toCssSelectorCandidate(annotation.elementPath),
    textQuote: selectedText,
    framePath: [0],
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    meta,
  };
}

function toFeedbackPriority(annotation: AgentationAnnotation): FeedbackPriority {
  switch (annotation.severity) {
    case "blocking":
      return "critical";
    case "important":
      return "high";
    case "suggestion":
      return "normal";
    default:
      return "normal";
  }
}

function toCssSelectorCandidate(elementPath: string): string | undefined {
  const normalizedPath = elementPath.trim();
  if (!normalizedPath || normalizedPath.includes("⟨shadow⟩")) {
    return undefined;
  }
  const segments = normalizedPath
    .split(">")
    .map((item) => item.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }
  const leaf = segments.at(-1);
  if (!leaf) {
    return undefined;
  }
  if (/^#[A-Za-z0-9_-]+$/.test(leaf)) {
    return leaf;
  }
  if (/^\.[A-Za-z0-9_-]+$/.test(leaf)) {
    return leaf;
  }
  if (/^[A-Za-z][A-Za-z0-9-]*$/.test(leaf)) {
    return leaf.toLowerCase();
  }
  return undefined;
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeAnnotationId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const id = value.trim();
  return id ? id : undefined;
}

function DefaultMountProbe({ mountKey }: { mountKey: string }) {
  return (
    <div data-agentation-react-ready="true" data-page-context-react-ready-key={mountKey}>
      agentation react root ready: {mountKey}
    </div>
  );
}
