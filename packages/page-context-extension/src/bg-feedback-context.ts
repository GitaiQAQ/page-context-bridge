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

export async function captureActiveTabFeedbackContext(sender?: chrome.runtime.MessageSender): Promise<ActiveTabFeedbackContext> {
  const tab = await resolveFeedbackTab(sender);
  if (!tab?.id || !tab.url) {
    throw new Error("No tab available for feedback");
  }

  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    selectedText: await readSelectedText(tab.id),
  };
}

async function resolveFeedbackTab(sender?: chrome.runtime.MessageSender): Promise<chrome.tabs.Tab | undefined> {
  const senderTab = sender?.tab;
  const senderTabId = senderTab?.id;
  if (typeof senderTabId === "number") {
    // content-script 发来的消息必须绑定原始 tab，避免误用当前活动 tab。
    if (senderTab?.url) {
      return senderTab;
    }
    // 某些场景 sender 只带 tabId，不带 url/title；补一次 tabs.get 保持数据完整。
    return await chrome.tabs.get(senderTabId);
  }

  // sidepanel 等旧调用路径没有 sender.tab，保持历史行为回退到当前活动 tab。
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab;
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
