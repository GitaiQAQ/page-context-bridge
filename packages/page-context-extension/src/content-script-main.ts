import { BRIDGE_METHODS } from "@page-context/shared-protocol";

import { sendRuntimeRequest } from "./runtime-rpc";

// 通过 background 的 chrome.scripting.executeScript(..., world:'MAIN') 注入 host，绕开页面 CSP 对 inline script 的拦截。
void sendRuntimeRequest(BRIDGE_METHODS.extensionMainWorldHostEnsure).catch((error) => {
  console.warn("[PAGE-CONTEXT-CS] failed to request MAIN world host injection", error);
});
