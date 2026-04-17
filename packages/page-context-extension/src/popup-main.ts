import "./popup.css";

import { BRIDGE_METHODS } from "@page-context/shared-protocol";

import { sendRuntimeRequest } from "./runtime-rpc";

interface StatusResponse {
  connected: boolean;
  wsUrl: string | null;
  pendingToolCalls: number;
}

const DEFAULT_WS_URL = "ws://127.0.0.1:22335/default";
const SIDE_PANEL_URL_KEY = "sidePanelUrl";

const statusDot = document.getElementById("statusDot") as HTMLSpanElement;
const statusText = document.getElementById("statusText") as HTMLDivElement;
const wsUrlInput = document.getElementById("wsUrlInput") as HTMLInputElement;
const pendingCalls = document.getElementById("pendingCalls") as HTMLDivElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const reconnectBtn = document.getElementById("reconnectBtn") as HTMLButtonElement;
const toast = document.getElementById("toast") as HTMLDivElement;
const openExampleBtn = document.getElementById("openExampleBtn") as HTMLButtonElement;
const openSidePanelBtn = document.getElementById("openSidePanelBtn") as HTMLButtonElement;

function showToast(message: string, type: "success" | "error" = "success"): void {
  toast.textContent = message;
  toast.className = `mt-2 alert ${type === "success" ? "alert-success" : "alert-error"}`;
  setTimeout(() => {
    toast.className = "mt-2 hidden";
  }, 2_000);
}

async function refreshStatus(): Promise<void> {
  try {
    const status = await sendRuntimeRequest<StatusResponse>(BRIDGE_METHODS.extensionStatusGet);
    statusDot.className = `w-2.5 h-2.5 rounded-full shrink-0 ${status.connected ? "bg-success" : "bg-error"}`;
    statusText.textContent = status.connected ? `Connected to ${status.wsUrl}` : "Disconnected";
    pendingCalls.textContent = String(status.pendingToolCalls ?? 0);
  } catch {
    statusDot.className = "w-2.5 h-2.5 rounded-full shrink-0 bg-error";
    statusText.textContent = "Extension not running";
  }
}

async function loadCurrentUrl(): Promise<void> {
  const result = await chrome.storage.local.get({ mcpWsUrl: DEFAULT_WS_URL });
  wsUrlInput.value = result.mcpWsUrl as string;
}

async function reconnect(): Promise<void> {
  await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect);
  showToast("Reconnecting...");
  setTimeout(() => void refreshStatus(), 1_200);
}

async function saveAndReconnect(): Promise<void> {
  const url = wsUrlInput.value.trim();
  if (!url) {
    showToast("Please enter a WebSocket URL", "error");
    return;
  }

  try {
    new URL(url);
  } catch {
    showToast("Invalid URL format", "error");
    return;
  }

  await chrome.storage.local.set({ mcpWsUrl: url });
  await reconnect();
}

saveBtn.addEventListener("click", () => void saveAndReconnect());
reconnectBtn.addEventListener("click", () => void reconnect());
openExampleBtn.addEventListener("click", () => {
  void chrome.tabs.create({ url: "https://unpkg.com/@page-context/example/dist/example.html" });
});
openSidePanelBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ [SIDE_PANEL_URL_KEY]: "http://127.0.0.1:22336/" });
  const currentWindow = await chrome.windows.getCurrent();
  if (currentWindow.id != null) {
    await chrome.sidePanel.open({ windowId: currentWindow.id });
  }
});

void loadCurrentUrl();
void refreshStatus();
setInterval(() => void refreshStatus(), 2_000);
