import './browser-polyfill';
import './popup.css';

import { BRIDGE_METHODS } from '@page-context/shared-protocol';

import {
  getExtensionApi,
  runtimeGetUrl,
  tabsCreate,
  tabsQuery,
  windowsGetCurrent,
} from './extension-api';
import {
  getCurrentLocale,
  getLocalePreference,
  setLocalePreference,
  t,
  type LocalePreference,
} from './i18n';
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

const FALLBACK_CONSOLE_UI_PATH = 'sidepanel.html';

const statusDot = document.getElementById('statusDot') as HTMLSpanElement;
const statusText = document.getElementById('statusText') as HTMLDivElement;
const pendingCalls = document.getElementById('pendingCalls') as HTMLDivElement;
const reconnectBtn = document.getElementById('reconnectBtn') as HTMLButtonElement;
const toast = document.getElementById('toast') as HTMLDivElement;
const openExampleBtn = document.getElementById('openExampleBtn') as HTMLButtonElement;
const openSidePanelBtn = document.getElementById('openSidePanelBtn') as HTMLButtonElement;
const openSetupBtn = document.getElementById('openSetupBtn') as HTMLButtonElement;
const localeSelect = document.getElementById('localeSelect') as HTMLSelectElement;
const appTitle = document.getElementById('appTitle') as HTMLSpanElement | null;
const popupSubtitle = document.getElementById('popupSubtitle') as HTMLDivElement | null;
const statusLabel = document.getElementById('statusLabel') as HTMLDivElement | null;
const pendingCallsLabel = document.getElementById('pendingCallsLabel') as HTMLDivElement | null;
const languageLabel = document.getElementById('languageLabel') as HTMLLabelElement | null;

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

function localizeStaticText(): void {
  document.documentElement.lang = getCurrentLocale();
  document.title = t('appName');
  if (appTitle) appTitle.textContent = t('appName');
  if (popupSubtitle) popupSubtitle.textContent = t('popupSubtitle');
  if (statusLabel) statusLabel.textContent = t('status');
  if (pendingCallsLabel) pendingCallsLabel.textContent = t('pendingToolCalls');
  if (languageLabel) languageLabel.textContent = t('language');
  openSidePanelBtn.textContent = t('workspaceAction');
  openSetupBtn.textContent = t('setup');
  reconnectBtn.textContent = t('reconnect');
  openExampleBtn.textContent = t('contextTestPage');
  localeSelect.value = getLocalePreference();
  localeSelect.options[0].textContent = t('systemLanguage');
  localeSelect.options[1].textContent = t('english');
  localeSelect.options[2].textContent = t('simplifiedChinese');
  localeSelect.options[3].textContent = t('japanese');
}

async function refreshStatus(): Promise<void> {
  try {
    const status = await sendRuntimeRequest<StatusResponse>(BRIDGE_METHODS.extensionStatusGet);
    statusDot.className = `w-2.5 h-2.5 rounded-full shrink-0 ${status.connected ? 'bg-success' : 'bg-error'}`;
    statusText.textContent = status.connected
      ? `${t('connected')} ${status.wsUrl}`
      : t('disconnected');
    pendingCalls.textContent = String(status.pendingToolCalls ?? 0);
  } catch {
    statusDot.className = 'w-2.5 h-2.5 rounded-full shrink-0 bg-error';
    statusText.textContent = t('extensionNotRunning');
  }
}

async function reconnect(): Promise<void> {
  try {
    await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect);
    showToast(t('reconnecting'));
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    setTimeout(() => void refreshStatus(), 1_200);
  }
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

async function launchConsoleUi(initialTab?: 'connections'): Promise<void> {
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

  const url = new URL(buildFallbackConsoleUiUrl(binding));
  if (initialTab) {
    url.searchParams.set('tab', initialTab);
  }
  await tabsCreate({ url: url.toString() });
}

reconnectBtn.addEventListener('click', () => void reconnect());
localeSelect.addEventListener('change', () => {
  setLocalePreference(localeSelect.value as LocalePreference);
  localizeStaticText();
  void refreshStatus();
});
openExampleBtn.addEventListener('click', () => {
  void tabsCreate({ url: 'https://unpkg.com/@page-context/example/dist/example.html' });
});
openSidePanelBtn.addEventListener('click', async () => {
  await launchConsoleUi();
});
openSetupBtn.addEventListener('click', async () => {
  await launchConsoleUi('connections');
});

localizeStaticText();
void refreshStatus();
setInterval(() => void refreshStatus(), 2_000);
