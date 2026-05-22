import './browser-polyfill';

import { BRIDGE_METHODS } from '@page-context/shared-protocol';

import { sendRuntimeRequest } from './runtime-rpc';
import {
  dispatchReadonlyBrokerResponse,
  PAGE_CONTEXT_READONLY_REQUEST_EVENT,
  parseReadonlyBrokerRequest,
  runReadonlyBrokerRequest,
} from './content-script-readonly-broker';

// Inject host via chrome.scripting.executeScript(..., world:'MAIN') from the background.
// On Firefox, this may fail (world:'MAIN' unsupported before Fx128), but the readonly
// broker still works because getPageContextBridge() uses wrappedJSObject to bypass
// Xray vision and directly access MAIN world properties.
void sendRuntimeRequest(BRIDGE_METHODS.extensionMainWorldHostEnsure).catch(() => {
  // Silently ignore — Firefox fallback works via wrappedJSObject in getPageContextBridge()
});

// Readonly broker: handles manifest/resource/skill/discover/execute requests
// from content-script.ts (document_idle) via CustomEvent.
window.addEventListener(PAGE_CONTEXT_READONLY_REQUEST_EVENT, (event: Event) => {
  const detail = parseReadonlyBrokerRequest((event as CustomEvent<unknown>).detail);
  if (!detail) {
    return;
  }

  void runReadonlyBrokerRequest(window, detail).then((response) => {
    dispatchReadonlyBrokerResponse(window, response);
  });
});
