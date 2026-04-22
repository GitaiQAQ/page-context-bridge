import { BRIDGE_METHODS } from "@page-context/shared-protocol";
import type {
  AgentationShellBridgeAdapter,
  AgentationShellCreateAnnotationInput,
  AgentationShellCreateAnnotationResult,
  AgentationShellDeps,
  AgentationShellDismissAnnotationInput,
  AgentationShellFeedbackDelta,
  AgentationShellFeedbackSnapshot,
  AgentationShellUpdateAnnotationInput,
} from "@page-context/agentation-shell";

import { sendRuntimeRequest } from "./runtime-rpc";
import { markFeedbackUiMode } from "./feedback-ui-diagnostics";

const AGENTATION_REACT_ROOT_ENTRY_KEY = "agentation-react-root";
// 三条链路都用“选择器探针”做同构自检，排障时直接看 documentElement 即可。
const AGENTATION_REACT_HOST_SELECTOR = "#__page_context_agentation_react_host__";
const AGENTATION_SHELL_HOST_SELECTOR = "#__page_context_agentation_shell_host__";
const FEEDBACK_OVERLAY_HOST_SELECTOR = "#__page_context_feedback_overlay_host__";
const AGENTATION_REACT_ROOT_COMPAT_ENTRY_KEYS = [
  AGENTATION_REACT_ROOT_ENTRY_KEY,
  "__PAGE_CONTEXT_AGENTATION_REACT_ROOT__",
  "__page_context_agentation_react_root__",
] as const;

type RuntimeRequest = <TResult>(method: string, params?: unknown) => Promise<TResult>;

export interface FeedbackUiAdapterDeps {
  sendRequest?: RuntimeRequest;
}

interface AgentationReactRootMountArgs {
  adapter: AgentationShellBridgeAdapter;
  doc: Document;
  win: Window;
  logger?: AgentationShellDeps["logger"];
}

type AgentationReactRootMountResult = boolean | void | { mounted?: boolean; installed?: boolean };
type AgentationReactRootMountFn = (args: AgentationReactRootMountArgs) => AgentationReactRootMountResult;

interface AgentationReactRootEntryObject {
  mount?: AgentationReactRootMountFn;
  install?: AgentationReactRootMountFn;
}

type AgentationReactRootEntry = AgentationReactRootMountFn | AgentationReactRootEntryObject;

export interface InstallAgentationReactRootDeps {
  adapter: AgentationShellBridgeAdapter;
  doc?: Document;
  win?: Window;
  logger?: AgentationShellDeps["logger"];
}

export interface FeedbackUiMountFallbackDeps {
  installReactRoot: () => boolean;
  installAgentationShell: () => boolean;
  installLegacyOverlay: () => void;
  log: (...args: unknown[]) => void;
}

/**
 * 适配层只负责“协议字段映射 + afterSeq 游标维护”，
 * 保持 shell 与 runtime 消息边界清晰、单一职责。
 */
export function createFeedbackUiAdapter(deps: FeedbackUiAdapterDeps = {}): AgentationShellBridgeAdapter {
  const sendRequest = deps.sendRequest ?? sendRuntimeRequest;
  // 游标状态只属于 content-script 这一端，不泄漏给 UI 壳。
  let feedbackLastSeq = 0;

  return {
    async createAnnotation(input: AgentationShellCreateAnnotationInput): Promise<AgentationShellCreateAnnotationResult> {
      // 只透传协议已确认字段，避免把 UI 层临时字段误发到 background。
      const payload = {
        body: input.body,
        priority: input.priority,
        selectedText: input.selectedText,
        uiAnchor: input.uiAnchor,
      };
      const raw = await sendRequest<unknown>(BRIDGE_METHODS.extensionFeedbackAnnotationCreate, payload);
      return normalizeCreateResult(raw);
    },

    async updateAnnotation(input: AgentationShellUpdateAnnotationInput): Promise<unknown> {
      const payload = {
        annotationId: input.annotationId,
        body: input.body,
        priority: input.priority,
      };
      return await sendRequest<unknown>(BRIDGE_METHODS.extensionFeedbackAnnotationUpdate, payload);
    },

    async dismissAnnotation(input: AgentationShellDismissAnnotationInput): Promise<unknown> {
      const payload = {
        annotationId: input.annotationId,
        dismissReason: input.dismissReason,
      };
      return await sendRequest<unknown>(BRIDGE_METHODS.extensionFeedbackAnnotationDismiss, payload);
    },

    async getFeedbackSnapshot(): Promise<AgentationShellFeedbackSnapshot> {
      // shell 启动后先拉全量快照，游标在这里推进。
      const snapshot = await sendRequest<AgentationShellFeedbackSnapshot>(BRIDGE_METHODS.extensionFeedbackStateSnapshot);
      feedbackLastSeq = normalizeFeedbackSeq(snapshot.lastSeq, feedbackLastSeq);
      return snapshot;
    },

    async getFeedbackStateDelta(): Promise<AgentationShellFeedbackDelta> {
      const delta = await sendRequest<AgentationShellFeedbackDelta>(BRIDGE_METHODS.extensionFeedbackStateDelta, {
        afterSeq: feedbackLastSeq,
      });
      feedbackLastSeq = normalizeFeedbackSeq(delta.lastSeq, feedbackLastSeq);
      return delta;
    },
  };
}

/**
 * React 版本壳体的稳定入口为 `window["agentation-react-root"]`。
 * 兼容期同时探测旧命名，入口不存在时明确返回 false，让上层继续回退链路。
 */
export function installAgentationReactRoot(deps: InstallAgentationReactRootDeps): boolean {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const entry = resolveAgentationReactRootEntry(win);
  if (!entry) {
    return false;
  }

  const mountArgs: AgentationReactRootMountArgs = {
    adapter: deps.adapter,
    doc,
    win,
    logger: deps.logger,
  };

  if (typeof entry === "function") {
    return normalizeReactRootMountResult(entry(mountArgs));
  }
  if (typeof entry.mount === "function") {
    return normalizeReactRootMountResult(entry.mount(mountArgs));
  }
  if (typeof entry.install === "function") {
    return normalizeReactRootMountResult(entry.install(mountArgs));
  }
  return false;
}

/**
 * 双挂载顺序：
 * 1) React root（新实现）
 * 2) installAgentationShell（当前稳定实现）
 * 3) legacy overlay（兜底）
 */
export function installFeedbackUiWithFallback(deps: FeedbackUiMountFallbackDeps): void {
  let shellFallbackReason = "react-root-skipped";

  try {
    const mountedByReact = deps.installReactRoot();
    if (mountedByReact) {
      // 顶层分支只知道“返回值=已挂载”，这里追加 host 自检，避免假阳性。
      markFeedbackUiMode("react-root", {
        selfCheck: {
          selector: AGENTATION_REACT_HOST_SELECTOR,
        },
      });
      deps.log("Agentation React root installed");
      return;
    }
    deps.log("Agentation React root skipped, fallback to agentation shell");
  } catch (error) {
    shellFallbackReason = "react-root-install-failed";
    deps.log("Agentation React root install failed, fallback to agentation shell", error);
  }

  let legacyOverlayReason = "agentation-shell-skipped";
  try {
    const mountedByShell = deps.installAgentationShell();
    if (mountedByShell) {
      markFeedbackUiMode("shell-fallback", {
        reason: shellFallbackReason,
        selfCheck: {
          selector: AGENTATION_SHELL_HOST_SELECTOR,
        },
      });
      deps.log("Agentation shell installed");
      return;
    }
    deps.log("Agentation shell skipped, fallback to legacy overlay");
  } catch (error) {
    legacyOverlayReason = "agentation-shell-install-failed";
    deps.log("Agentation shell install failed, fallback to legacy overlay", error);
  }

  try {
    deps.installLegacyOverlay();
  } catch (error) {
    legacyOverlayReason = "legacy-overlay-install-failed";
    // 兜底安装失败也要落盘诊断，保证现场有最后一次失败信息。
    markFeedbackUiMode("legacy-overlay", {
      reason: legacyOverlayReason,
      selfCheck: {
        selector: FEEDBACK_OVERLAY_HOST_SELECTOR,
      },
    });
    deps.log("Legacy overlay install failed", error);
    throw error;
  }
  markFeedbackUiMode("legacy-overlay", {
    reason: legacyOverlayReason,
    selfCheck: {
      selector: FEEDBACK_OVERLAY_HOST_SELECTOR,
    },
  });
}

function resolveAgentationReactRootEntry(win: Window): AgentationReactRootEntry | null {
  const globalScope = win as Window & Record<string, unknown>;
  for (const key of AGENTATION_REACT_ROOT_COMPAT_ENTRY_KEYS) {
    const candidate = globalScope[key];
    if (isAgentationReactRootEntry(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isAgentationReactRootEntry(value: unknown): value is AgentationReactRootEntry {
  if (typeof value === "function") {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.mount === "function" || typeof record.install === "function";
}

function normalizeReactRootMountResult(result: AgentationReactRootMountResult): boolean {
  if (typeof result === "boolean") {
    return result;
  }
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record.mounted === "boolean") {
      return record.mounted;
    }
    if (typeof record.installed === "boolean") {
      return record.installed;
    }
  }
  // 兼容老入口：无返回值但未抛错，按已挂载处理，避免重复注入。
  return true;
}

function normalizeFeedbackSeq(next: unknown, fallback: number): number {
  const value = Number(next);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function normalizeCreateResult(raw: unknown): AgentationShellCreateAnnotationResult {
  if (!raw || typeof raw !== "object") {
    return { raw };
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.id === "string") {
    return { id: record.id, raw };
  }
  const annotation = record.annotation;
  if (annotation && typeof annotation === "object" && typeof (annotation as { id?: unknown }).id === "string") {
    return { id: (annotation as { id: string }).id, raw };
  }
  return { raw };
}

declare global {
  interface Window {
    "agentation-react-root"?: AgentationReactRootEntry;
    __PAGE_CONTEXT_AGENTATION_REACT_ROOT__?: AgentationReactRootEntry;
    __page_context_agentation_react_root__?: AgentationReactRootEntry;
  }
}
