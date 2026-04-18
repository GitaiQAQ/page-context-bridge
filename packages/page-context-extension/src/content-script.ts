import { BRIDGE_METHODS } from "@page-context/shared-protocol";
import { createConsoleCapture, executeContentScriptTool, type ConsoleEntry } from "@page-context/builtin-tools";

import { installAgentationShell } from "./agentation-shell";
import type { AgentationShellCreateAnnotationInput } from "./agentation-shell/types";
import { installFeedbackOverlay } from "./content-script-feedback-overlay";
import { createRuntimeListener, sendRuntimeRequest } from "./runtime-rpc";

const consoleEntries: ConsoleEntry[] = [];

function log(...args: unknown[]): void {
  console.log("[PAGE-CONTEXT-CS]", ...args);
}

createConsoleCapture(window, consoleEntries);
installFeedbackUiWithFallback();

chrome.runtime.onMessage.addListener(
  createRuntimeListener(async (message) => {
    switch (message.method) {
      case BRIDGE_METHODS.extensionToolExecute: {
        const payload = (message.params ?? {}) as { tool: string; args?: Record<string, unknown> };
        return executeContentScriptTool(payload.tool, payload.args ?? {}, {
          win: window,
          doc: document,
          consoleEntries,
        });
      }
      default:
        throw new Error(`Unknown content-script method: ${message.method}`);
    }
  }),
);

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }
  const data = event.data;
  if (!data || typeof data !== "object") {
    return;
  }

  if ((data as { type?: string }).type === "PAGE_CONTEXT_REQUEST") {
    log("Forwarding page context request from page to background");
    void sendRuntimeRequest(BRIDGE_METHODS.extensionPageEvent, {
      payload: (data as { payload?: unknown }).payload,
    }).catch((error) => {
      log("Failed to forward page event", error);
    });
  }
});

window.__PAGE_CONTEXT_BRIDGE_DEMO__ = () => {
  const selection = window.getSelection();
  const text = selection ? selection.toString() : "";

  window.postMessage(
    {
      type: "PAGE_CONTEXT_REQUEST",
      payload: {
        type: "demo.selection",
        text,
      },
    },
    "*",
  );
};

function installFeedbackUiWithFallback(): void {
  try {
    const installed = installAgentationShell({
      adapter: {
        createAnnotation: createAnnotationFromShell,
      },
      // 统一复用 content-script 日志前缀，便于定位现场问题。
      logger(level, message, extra) {
        if (level === "error") {
          log(`[agentation-shell] ${message}`, extra);
          return;
        }
        log(`[agentation-shell] ${message}`, extra);
      },
    });

    if (installed) {
      log("Agentation shell installed");
      return;
    }

    // 非 http/https 或非顶层窗口会走到这里，保底回退老 overlay。
    log("Agentation shell skipped, fallback to legacy overlay");
    installFeedbackOverlay();
  } catch (error) {
    // 壳体挂载是增强能力，不应拖垮原有反馈入口。
    log("Agentation shell install failed, fallback to legacy overlay", error);
    installFeedbackOverlay();
  }
}

async function createAnnotationFromShell(
  input: AgentationShellCreateAnnotationInput,
): Promise<{ id?: string; raw?: unknown }> {
  // 只发送当前协议确认过的字段，避免跨 worker 边界引入耦合。
  const payload = {
    body: input.body,
    priority: input.priority,
    selectedText: input.selectedText,
    // uiAnchor 在 shell 里已做最小映射，这里只负责透传，避免重复协议逻辑。
    uiAnchor: input.uiAnchor,
  };
  const raw = await sendRuntimeRequest<unknown>(BRIDGE_METHODS.extensionFeedbackAnnotationCreate, payload);
  return normalizeCreateResult(raw);
}

function normalizeCreateResult(raw: unknown): { id?: string; raw?: unknown } {
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
    __PAGE_CONTEXT_BRIDGE_DEMO__?: () => void;
  }
}
