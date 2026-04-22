import { beforeEach, describe, expect, it } from "vitest";

import {
  FEEDBACK_UI_MODE_ATTR,
  FEEDBACK_UI_REASON_ATTR,
  FEEDBACK_UI_SELF_CHECK_RESULT_ATTR,
  FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR,
  FEEDBACK_UI_SELF_CHECK_STATUS_ATTR,
  markFeedbackUiMode,
} from "./feedback-ui-diagnostics";

describe("markFeedbackUiMode", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    clearFeedbackUiDiagnostics(document);
  });

  it("writes mode/reason and self-check attrs when probe passes", () => {
    const probe = document.createElement("div");
    probe.id = "react-host";
    document.body.appendChild(probe);

    markFeedbackUiMode("react-root", {
      reason: "  ready  ",
      selfCheck: {
        selector: "#react-host",
      },
    });

    expect(document.documentElement.getAttribute(FEEDBACK_UI_MODE_ATTR)).toBe("react-root");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_REASON_ATTR)).toBe("ready");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR)).toBe("ok");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR)).toBe("present");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR)).toBe("#react-host");
  });

  it("clears stale reason and self-check attrs when next mark omits optional fields", () => {
    markFeedbackUiMode("shell-fallback", {
      reason: "react-root-skipped",
      selfCheck: {
        selector: "#missing-node",
      },
    });
    expect(document.documentElement.getAttribute(FEEDBACK_UI_REASON_ATTR)).toBe("react-root-skipped");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR)).toBe("mismatch");

    markFeedbackUiMode("legacy-overlay");

    expect(document.documentElement.getAttribute(FEEDBACK_UI_MODE_ATTR)).toBe("legacy-overlay");
    expect(document.documentElement.hasAttribute(FEEDBACK_UI_REASON_ATTR)).toBe(false);
    expect(document.documentElement.hasAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR)).toBe(false);
    expect(document.documentElement.hasAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR)).toBe(false);
    expect(document.documentElement.hasAttribute(FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR)).toBe(false);
  });

  it("marks mismatch for absent or invalid selector", () => {
    markFeedbackUiMode("shell-fallback", {
      selfCheck: {
        selector: "#unknown-node",
      },
    });
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR)).toBe("mismatch");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR)).toBe("absent");

    markFeedbackUiMode("shell-fallback", {
      selfCheck: {
        selector: "##invalid-selector",
      },
    });
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR)).toBe("mismatch");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR)).toBe("invalid-selector");
  });

  it("supports doc injection and does not mutate global document when doc is specified", () => {
    const isolatedDoc = document.implementation.createHTMLDocument("isolated");
    isolatedDoc.body.innerHTML = '<div id="overlay-host"></div>';

    markFeedbackUiMode("legacy-overlay", {
      doc: isolatedDoc,
      reason: "agentation-shell-skipped",
      selfCheck: {
        selector: "#overlay-host",
      },
    });

    expect(isolatedDoc.documentElement.getAttribute(FEEDBACK_UI_MODE_ATTR)).toBe("legacy-overlay");
    expect(isolatedDoc.documentElement.getAttribute(FEEDBACK_UI_REASON_ATTR)).toBe("agentation-shell-skipped");
    expect(isolatedDoc.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR)).toBe("ok");
    expect(document.documentElement.hasAttribute(FEEDBACK_UI_MODE_ATTR)).toBe(false);
  });
});

function clearFeedbackUiDiagnostics(doc: Document): void {
  doc.documentElement.removeAttribute(FEEDBACK_UI_MODE_ATTR);
  doc.documentElement.removeAttribute(FEEDBACK_UI_REASON_ATTR);
  doc.documentElement.removeAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR);
  doc.documentElement.removeAttribute(FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR);
  doc.documentElement.removeAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR);
}
