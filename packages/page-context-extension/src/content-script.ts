import { BRIDGE_METHODS } from "@page-context/shared-protocol";
import { createConsoleCapture, executeContentScriptTool, type ConsoleEntry } from "@page-context/builtin-tools";

import { installFeedbackOverlay } from "./content-script-feedback-overlay";
import { createRuntimeListener, sendRuntimeRequest } from "./runtime-rpc";

const consoleEntries: ConsoleEntry[] = [];

function log(...args: unknown[]): void {
  console.log("[PAGE-CONTEXT-CS]", ...args);
}

createConsoleCapture(window, consoleEntries);
installFeedbackOverlay();

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

declare global {
  interface Window {
    __PAGE_CONTEXT_BRIDGE_DEMO__?: () => void;
  }
}
