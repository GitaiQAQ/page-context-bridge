import {
  DEFAULT_CONSOLE_URL,
  SIDEPANEL_SURFACE,
  setLaunchUrlForSurface,
} from './sidepanel-launch-state';

type DevtoolsPanel = {
  onShown?: { addListener(listener: (panelWindow: Window) => void): void };
  onHidden?: { addListener(listener: () => void): void };
};

type DevtoolsApi = {
  devtools?: {
    inspectedWindow?: { tabId?: number };
    panels?: {
      create(
        title: string,
        iconPath: string,
        pagePath: string,
        callback?: (panel: DevtoolsPanel) => void,
      ): Promise<DevtoolsPanel> | void;
    };
  };
  storage?: {
    local?: {
      set(values: Record<string, unknown>): Promise<void> | void;
    };
  };
};

function getDevtoolsApi(): DevtoolsApi | null {
  const globalApi = globalThis as typeof globalThis & {
    browser?: DevtoolsApi;
    chrome?: DevtoolsApi;
  };
  return globalApi.browser ?? globalApi.chrome ?? null;
}

function buildPanelUrl(inspectedTabId: number | undefined): string {
  const params = new URLSearchParams();
  if (
    typeof inspectedTabId === 'number' &&
    Number.isInteger(inspectedTabId) &&
    inspectedTabId > 0
  ) {
    params.set('boundTabId', String(inspectedTabId));
  }
  params.set('surface', 'devtools');
  return `sidepanel.html${params.toString() ? `?${params.toString()}` : ''}`;
}

async function registerPageContextDevtoolsPanel(): Promise<void> {
  const extensionApi = getDevtoolsApi();
  if (!extensionApi) {
    console.warn('[page-context-devtools] extension API is unavailable');
    return;
  }
  const panelsApi = extensionApi?.devtools?.panels;
  if (!panelsApi?.create) {
    console.warn('[page-context-devtools] devtools.panels.create is unavailable');
    return;
  }

  if (extensionApi.storage?.local?.set) {
    await setLaunchUrlForSurface(SIDEPANEL_SURFACE.devtools, DEFAULT_CONSOLE_URL);
  }

  const inspectedTabId = extensionApi.devtools?.inspectedWindow?.tabId;
  await Promise.resolve(
    panelsApi.create(
      'Page Context Bridge',
      'icons/icon128.png',
      buildPanelUrl(inspectedTabId),
      () => undefined,
    ),
  );
}

void registerPageContextDevtoolsPanel();
