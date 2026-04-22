import { BRIDGE_METHODS } from "@page-context/shared-protocol";
import { createConsoleCapture, executeContentScriptTool, type ConsoleEntry } from "@page-context/builtin-tools";
import { installAgentationShell, type AgentationShellDeps } from "@page-context/agentation-shell";
import { registerAgentationReactRootEntry } from "./agentation-react-root";
import { installFeedbackOverlay } from "./content-script-feedback-overlay";
import { createFeedbackUiAdapter, installAgentationReactRoot, installFeedbackUiWithFallback } from "./feedback-ui-adapter";
import { createRuntimeListener, sendRuntimeRequest } from "./runtime-rpc";

const consoleEntries: ConsoleEntry[] = [];

function log(...args: unknown[]): void {
  console.log("[PAGE-CONTEXT-CS]", ...args);
}

createConsoleCapture(window, consoleEntries);
const feedbackUiAdapter = createFeedbackUiAdapter();
const agentationLogger = createAgentationLogger();

// 先注册 React root 入口，再启动 fallback 链路，确保第一分支能命中真实实现。
registerAgentationReactRootEntry({ win: window });

// 统一走“React root -> shell -> legacy overlay”链路，保证新旧实现平滑切换。
installFeedbackUiWithFallback({
  log,
  installReactRoot: () =>
    installAgentationReactRoot({
      adapter: feedbackUiAdapter,
      doc: document,
      win: window,
      logger: agentationLogger,
    }),
  installAgentationShell: () =>
    installAgentationShell({
      adapter: feedbackUiAdapter,
      doc: document,
      win: window,
      logger: agentationLogger,
    }),
  installLegacyOverlay: () => {
    installFeedbackOverlay();
  },
});

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

function createAgentationLogger(): AgentationShellDeps["logger"] {
  // 让 React root 与 shell 复用同一日志格式，排障时只看一条前缀链。
  return (level, message, extra) => {
    if (level === "error") {
      log(`[agentation-shell] ${message}`, extra);
      return;
    }
    log(`[agentation-shell] ${message}`, extra);
  };
}

declare global {
  interface Window {
    __PAGE_CONTEXT_BRIDGE_DEMO__?: () => void;
  }
}
