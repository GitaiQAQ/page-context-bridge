import { storageLocalGet, storageLocalRemove, storageLocalSet } from './extension-api';

export const SIDEPANEL_SURFACE = {
  default: 'default',
  devtools: 'devtools',
} as const;

export type SidepanelSurface = (typeof SIDEPANEL_SURFACE)[keyof typeof SIDEPANEL_SURFACE];

export const DEFAULT_CONSOLE_URL = 'http://127.0.0.1:22336/';
const LEGACY_SIDE_PANEL_URL_KEY = 'sidePanelUrl';

function buildSurfaceStorageKey(surface: SidepanelSurface): string {
  return surface === SIDEPANEL_SURFACE.default
    ? LEGACY_SIDE_PANEL_URL_KEY
    : `${LEGACY_SIDE_PANEL_URL_KEY}:${surface}`;
}

export function readSidepanelSurface(search: string = window.location.search): SidepanelSurface {
  const searchParams = new URLSearchParams(search);
  return searchParams.get('surface') === SIDEPANEL_SURFACE.devtools
    ? SIDEPANEL_SURFACE.devtools
    : SIDEPANEL_SURFACE.default;
}

export async function setLaunchUrlForSurface(
  surface: SidepanelSurface,
  url: string = DEFAULT_CONSOLE_URL,
): Promise<void> {
  await storageLocalSet({ [buildSurfaceStorageKey(surface)]: url });
}

export async function consumeLaunchUrlForSurface(
  surface: SidepanelSurface,
): Promise<string | undefined> {
  const preferredKey = buildSurfaceStorageKey(surface);
  const result = await storageLocalGet<Record<string, unknown>>(
    surface === SIDEPANEL_SURFACE.default
      ? preferredKey
      : [preferredKey, LEGACY_SIDE_PANEL_URL_KEY],
  );

  const directValue = result[preferredKey];
  if (typeof directValue === 'string' && directValue.trim()) {
    await storageLocalRemove(preferredKey);
    return directValue;
  }

  if (surface !== SIDEPANEL_SURFACE.default) {
    const legacyValue = result[LEGACY_SIDE_PANEL_URL_KEY];
    if (typeof legacyValue === 'string' && legacyValue.trim()) {
      await storageLocalRemove(LEGACY_SIDE_PANEL_URL_KEY);
      return legacyValue;
    }
  }

  return undefined;
}
