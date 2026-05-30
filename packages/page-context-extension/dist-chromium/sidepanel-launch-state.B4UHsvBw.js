import {
  a as storageLocalRemove,
  i as storageLocalGet,
  o as storageLocalSet,
} from './extension-api.BMHS3pcA.js';
//#region src/sidepanel-launch-state.ts
var SIDEPANEL_SURFACE = {
  default: 'default',
  devtools: 'devtools',
};
var DEFAULT_CONSOLE_URL = 'http://127.0.0.1:22336/';
var LEGACY_SIDE_PANEL_URL_KEY = 'sidePanelUrl';
function buildSurfaceStorageKey(surface) {
  return surface === SIDEPANEL_SURFACE.default
    ? LEGACY_SIDE_PANEL_URL_KEY
    : `${LEGACY_SIDE_PANEL_URL_KEY}:${surface}`;
}
function readSidepanelSurface(search = window.location.search) {
  return new URLSearchParams(search).get('surface') === SIDEPANEL_SURFACE.devtools
    ? SIDEPANEL_SURFACE.devtools
    : SIDEPANEL_SURFACE.default;
}
async function setLaunchUrlForSurface(surface, url = DEFAULT_CONSOLE_URL) {
  await storageLocalSet({ [buildSurfaceStorageKey(surface)]: url });
}
async function consumeLaunchUrlForSurface(surface) {
  const preferredKey = buildSurfaceStorageKey(surface);
  const result = await storageLocalGet(
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
}
//#endregion
export {
  setLaunchUrlForSurface as a,
  readSidepanelSurface as i,
  SIDEPANEL_SURFACE as n,
  consumeLaunchUrlForSurface as r,
  DEFAULT_CONSOLE_URL as t,
};
