import './browser-polyfill';
import './popup.css';

import { BRIDGE_METHODS } from '@page-context/shared-protocol';

import {
  getExtensionApi,
  runtimeGetUrl,
  storageLocalGet,
  storageLocalSet,
  tabsCreate,
  tabsQuery,
  windowsGetCurrent,
} from './extension-api';
import { sendRuntimeRequest } from './runtime-rpc';
import {
  DEFAULT_CONSOLE_URL,
  SIDEPANEL_SURFACE,
  setLaunchUrlForSurface,
} from './sidepanel-launch-state';
import type { RuntimeExplicitTabBinding, SidepanelUrlTabBinding } from './sidepanel-types';

interface StatusResponse {
  connected: boolean;
  wsUrl: string | null;
  pendingToolCalls: number;
}

const DEFAULT_WS_URL = 'ws://127.0.0.1:22335/default';
const FALLBACK_CONSOLE_UI_PATH = 'sidepanel.html';

const statusDot = document.getElementById('statusDot') as HTMLSpanElement;
const statusText = document.getElementById('statusText') as HTMLDivElement;
const wsUrlInput = document.getElementById('wsUrlInput') as HTMLInputElement;
const pendingCalls = document.getElementById('pendingCalls') as HTMLDivElement;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
const reconnectBtn = document.getElementById('reconnectBtn') as HTMLButtonElement;
const toast = document.getElementById('toast') as HTMLDivElement;
const openExampleBtn = document.getElementById('openExampleBtn') as HTMLButtonElement;
const openSidePanelBtn = document.getElementById('openSidePanelBtn') as HTMLButtonElement;

type ChromeWithOptionalSidePanel = typeof chrome & {
  sidePanel?: {
    open(options: { windowId: number }): Promise<void>;
  };
};

type BrowserWithOptionalSidebarAction = typeof chrome & {
  sidebarAction?: {
    open(): Promise<void>;
    close(): Promise<void>;
  };
};

function showToast(message: string, type: 'success' | 'error' = 'success'): void {
  toast.textContent = message;
  toast.className = `mt-2 alert ${type === 'success' ? 'alert-success' : 'alert-error'}`;
  setTimeout(() => {
    toast.className = 'mt-2 hidden';
  }, 2_000);
}

async function refreshStatus(): Promise<void> {
  try {
    const status = await sendRuntimeRequest<StatusResponse>(BRIDGE_METHODS.extensionStatusGet);
    statusDot.className = `w-2.5 h-2.5 rounded-full shrink-0 ${status.connected ? 'bg-success' : 'bg-error'}`;
    statusText.textContent = status.connected ? `Connected to ${status.wsUrl}` : 'Disconnected';
    pendingCalls.textContent = String(status.pendingToolCalls ?? 0);
  } catch {
    statusDot.className = 'w-2.5 h-2.5 rounded-full shrink-0 bg-error';
    statusText.textContent = 'Extension not running';
  }
}

async function loadCurrentUrl(): Promise<void> {
  const result = await storageLocalGet({ mcpWsUrl: DEFAULT_WS_URL });
  wsUrlInput.value = result.mcpWsUrl as string;
}

async function reconnect(): Promise<void> {
  try {
    await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect);
    showToast('Reconnecting...');
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    setTimeout(() => void refreshStatus(), 1_200);
  }
}

async function saveAndReconnect(): Promise<void> {
  const url = wsUrlInput.value.trim();
  if (!url) {
    showToast('Please enter a WebSocket URL', 'error');
    return;
  }

  try {
    new URL(url);
  } catch {
    showToast('Invalid URL format', 'error');
    return;
  }

  await storageLocalSet({ mcpWsUrl: url });
  await reconnect();
}

/**
 * Read explicit launcher bindings.
 * Return only present fields at the boundary to avoid mixing null/undefined into one path.
 */
async function getLauncherRuntimeBinding(): Promise<RuntimeExplicitTabBinding> {
  const [activeTab] = await tabsQuery({ active: true, currentWindow: true });
  return {
    ...(activeTab?.id != null ? { tabId: activeTab.id } : {}),
    ...(activeTab?.windowId != null ? { windowId: activeTab.windowId } : {}),
  };
}

/** Runtime binding -> launcher URL query binding, keeping boundTabId for compatibility. */
function toSidepanelUrlTabBinding(binding: RuntimeExplicitTabBinding): SidepanelUrlTabBinding {
  return {
    ...(binding.tabId != null ? { boundTabId: binding.tabId } : {}),
    ...(binding.windowId != null ? { windowId: binding.windowId } : {}),
  };
}

/** Fallback pages still emit boundTabId/windowId to keep legacy query protocol compatibility. */
function buildFallbackConsoleUiUrl(binding: RuntimeExplicitTabBinding): string {
  const url = new URL(runtimeGetUrl(FALLBACK_CONSOLE_UI_PATH));
  const queryBinding = toSidepanelUrlTabBinding(binding);
  if (queryBinding.boundTabId != null) {
    url.searchParams.set('boundTabId', String(queryBinding.boundTabId));
  }
  if (queryBinding.windowId != null) {
    url.searchParams.set('windowId', String(queryBinding.windowId));
  }
  return url.toString();
}

async function launchConsoleUi(): Promise<void> {
  await setLaunchUrlForSurface(SIDEPANEL_SURFACE.default, DEFAULT_CONSOLE_URL);
  const binding = await getLauncherRuntimeBinding();

  // Firefox: use sidebarAction.open() (available since Firefox 121)
  const sidebarApi = (getExtensionApi() as BrowserWithOptionalSidebarAction).sidebarAction;
  if (sidebarApi?.open) {
    await sidebarApi.open();
    return;
  }

  // Chrome: use sidePanel.open()
  const sidePanelApi = (getExtensionApi() as ChromeWithOptionalSidePanel).sidePanel;
  if (sidePanelApi != null) {
    const currentWindow = await windowsGetCurrent();
    if (currentWindow.id != null) {
      await sidePanelApi.open({ windowId: currentWindow.id });
      return;
    }
  }

  await tabsCreate({ url: buildFallbackConsoleUiUrl(binding) });
}

saveBtn.addEventListener('click', () => void saveAndReconnect());
reconnectBtn.addEventListener('click', () => void reconnect());
openExampleBtn.addEventListener('click', () => {
  void tabsCreate({ url: 'https://unpkg.com/@page-context/example/dist/example.html' });
});
openSidePanelBtn.addEventListener('click', async () => {
  await launchConsoleUi();
});

void loadCurrentUrl();
void refreshStatus();
setInterval(() => void refreshStatus(), 2_000);
