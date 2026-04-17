/**
 * 反馈创建时的轻量上下文采集。
 * 只读取稳定且低成本的信息，避免引入脆弱的 DOM 锚点逻辑。
 */

export interface ActiveTabFeedbackContext {
  tabId: number;
  url: string;
  title?: string;
  selectedText?: string;
}

export async function captureActiveTabFeedbackContext(): Promise<ActiveTabFeedbackContext> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("No active tab available for feedback");
  }

  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    selectedText: await readSelectedText(tab.id),
  };
}

async function readSelectedText(tabId: number): Promise<string | undefined> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const win = window as Window & { document: Document };
        const fromSelection = win.getSelection?.()?.toString?.() ?? "";
        if (fromSelection.trim()) {
          return fromSelection;
        }

        const activeElement = win.document.activeElement;
        if (!(activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement)) {
          return "";
        }

        const start = activeElement.selectionStart ?? 0;
        const end = activeElement.selectionEnd ?? 0;
        if (start === end) {
          return "";
        }
        return activeElement.value.slice(start, end);
      },
    });

    const text = String(results[0]?.result ?? "").trim();
    return text || undefined;
  } catch {
    // 某些页面（如 chrome://）无法注入脚本，这里静默降级为无选中文本。
    return undefined;
  }
}
