import {
  mountAgentationShell,
  type AgentationShellBridgeAdapter,
  type AgentationShellDeps,
  type AgentationShellMountHandle,
} from "@page-context/agentation-shell";
import { StrictMode, type ReactNode, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

export const AGENTATION_REACT_HOST_ID = "__page_context_agentation_react_host__";
export const AGENTATION_REACT_ROOT_ENTRY_KEY = "agentation-react-root";
const MOUNT_CONTAINER_ATTR = "data-page-context-react-mount-key";
const HOST_MARK_ATTR = "data-page-context-react-host";
const DEFAULT_MOUNT_KEY = "default";
const AGENTATION_SHELL_MOUNT_KEY = "agentation-shell";
const NESTED_SHELL_HOST_ATTR = "data-agentation-react-shell-host";
const AGENTATION_REACT_ROOT_COMPAT_ENTRY_KEYS = [
  AGENTATION_REACT_ROOT_ENTRY_KEY,
  "__PAGE_CONTEXT_AGENTATION_REACT_ROOT__",
  "__page_context_agentation_react_root__",
] as const;

const rootByContainer = new WeakMap<HTMLElement, Root>();
const entryByWindow = new WeakMap<Window, AgentationReactRootEntryObject>();

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
      mountKey: AGENTATION_SHELL_MOUNT_KEY,
      render: () => <AgentationShellMountBridge {...args} />,
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

function AgentationShellMountBridge(props: AgentationReactRootEntryMountArgs) {
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
  }, [props.adapter, props.doc, props.win, props.logger]);

  return <div ref={shellHostRef} {...{ [NESTED_SHELL_HOST_ATTR]: "true" }} />;
}

function DefaultMountProbe({ mountKey }: { mountKey: string }) {
  return (
    <div data-agentation-react-ready="true" data-page-context-react-ready-key={mountKey}>
      agentation react root ready: {mountKey}
    </div>
  );
}
