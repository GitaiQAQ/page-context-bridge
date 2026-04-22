import { StrictMode, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

export const AGENTATION_REACT_HOST_ID = "__page_context_agentation_react_host__";
const MOUNT_CONTAINER_ATTR = "data-page-context-react-mount-key";
const HOST_MARK_ATTR = "data-page-context-react-host";
const DEFAULT_MOUNT_KEY = "default";

const rootByContainer = new WeakMap<HTMLElement, Root>();

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

function DefaultMountProbe({ mountKey }: { mountKey: string }) {
  return (
    <div data-agentation-react-ready="true" data-page-context-react-ready-key={mountKey}>
      agentation react root ready: {mountKey}
    </div>
  );
}
