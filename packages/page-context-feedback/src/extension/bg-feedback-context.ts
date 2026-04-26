/**
 * Lightweight context collection during feedback creation.
 * Only reads stable and low-cost information to avoid introducing fragile DOM anchor logic.
 */

export interface ActiveTabFeedbackContext {
  tabId: number;
  url: string;
  title?: string;
  selectedText?: string;
}

export async function resolveFeedbackTab(
  sender?: chrome.runtime.MessageSender,
): Promise<chrome.tabs.Tab | undefined> {
  const senderTab = sender?.tab;
  const senderTabId = senderTab?.id;
  if (typeof senderTabId === 'number') {
    if (senderTab?.url) return senderTab;
    return await chrome.tabs.get(senderTabId);
  }
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab;
}

export async function captureActiveTabFeedbackContext(
  sender?: chrome.runtime.MessageSender,
): Promise<ActiveTabFeedbackContext> {
  const tab = await resolveFeedbackTab(sender);
  if (!tab?.id || !tab.url) {
    throw new Error('No tab available for feedback');
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
      world: 'MAIN',
      func: () => {
        const win = window as Window & { document: Document };
        const fromSelection = win.getSelection()?.toString?.() ?? '';
        if (fromSelection.trim()) return fromSelection;
        const activeElement = win.document.activeElement;
        if (
          !(
            activeElement instanceof HTMLInputElement ||
            activeElement instanceof HTMLTextAreaElement
          )
        )
          return '';
        const start = activeElement.selectionStart ?? 0;
        const end = activeElement.selectionEnd ?? 0;
        if (start === end) return '';
        return activeElement.value.slice(start, end);
      },
    });
    const text = String(results[0]?.result ?? '').trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}
