import { BRIDGE_METHODS } from '@page-context/shared-protocol';

import { sendRuntimeRequest } from './runtime-rpc';

// Inject host via chrome.scripting.executeScript(..., world:'MAIN') from the background to bypass page CSP restrictions on inline scripts.
void sendRuntimeRequest(BRIDGE_METHODS.extensionMainWorldHostEnsure).catch((error) => {
  console.warn('[PAGE-CONTEXT-CS] failed to request MAIN world host injection', error);
});
