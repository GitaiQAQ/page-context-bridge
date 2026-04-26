/**
 * MAIN world injection utilities for page-context extension.
 *
 * Provides typed wrappers around chrome.scripting.executeScript
 * for both bridge host installation and agentation React injection.
 */

export interface MainWorldBridgeHostInstaller {
  (): void;
}

export interface MainWorldInjectionTarget {
  tabId: number;
  frameId?: number;
}

/**
 * Inject a script function into a specific tab's MAIN world.
 */
export async function ensureMainWorldBridgeHostOnTab(
  tabId: number,
  installer: MainWorldBridgeHostInstaller,
  frameId?: number,
): Promise<{ ok: true }> {
  await chrome.scripting.executeScript({
    target: typeof frameId === 'number' ? { tabId, frameIds: [frameId] } : { tabId },
    world: 'MAIN',
    func: installer,
  });
  return { ok: true };
}

/**
 * Inject a script function into the sender tab's MAIN world.
 * Derives tabId from sender.tab, with optional frameId from sender.frameId.
 */
export async function ensureMainWorldBridgeHostOnSenderTab(
  sender: chrome.runtime.MessageSender,
  installer: MainWorldBridgeHostInstaller,
): Promise<{ ok: true }> {
  const tabId = sender.tab?.id;
  if (!tabId) {
    throw new Error('No sender tab available for MAIN world host injection.');
  }

  const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
  return await ensureMainWorldBridgeHostOnTab(tabId, installer, frameId);
}

/**
 * Inject agentation-main.js (built React bundle) into a specific tab's MAIN world.
 * The JS file must have been built by vite and available via web_accessible_resources.
 */
export async function ensureAgentationMainOnTab(
  tabId: number,
  frameId?: number,
): Promise<{ ok: true }> {
  await chrome.scripting.executeScript({
    target: typeof frameId === 'number' ? { tabId, frameIds: [frameId] } : { tabId },
    world: 'MAIN',
    files: ['agentation-main.js'],
  });
  return { ok: true };
}

/**
 * Inject agentation-main.js into the sender tab's MAIN world.
 * Derives tabId from sender.tab, with optional frameId from sender.frameId.
 */
export async function ensureAgentationMainOnSenderTab(
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: true }> {
  const tabId = sender.tab?.id;
  if (!tabId) {
    throw new Error('No sender tab available for Agentation MAIN world injection.');
  }

  const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
  return await ensureAgentationMainOnTab(tabId, frameId);
}

/**
 * Extract tabId/frameId from an unknown params object (e.g., RPC payload).
 * Used by consumers that receive params from content-script or sidepanel.
 */
export function getMainWorldInjectionTarget(params: unknown): MainWorldInjectionTarget {
  const payload = params as { tabId?: number; frameId?: number } | null | undefined;
  const tabId = Number(payload?.tabId ?? 0);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new Error('tabId must be a positive integer');
  }

  if (payload?.frameId == null) {
    return { tabId };
  }
  if (!Number.isInteger(payload.frameId) || payload.frameId < 0) {
    throw new Error('frameId must be a non-negative integer');
  }
  return { tabId, frameId: payload.frameId };
}
