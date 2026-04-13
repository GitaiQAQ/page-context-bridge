import {
  BRIDGE_METHODS,
  type ContextResourceDescriptor,
  type ContextResourcePayload,
  type ContextSkillDescriptor,
  type ContextSkillPrompt,
  type PageContextManifest,
} from "@page-context/shared-protocol";

import type { ContextManifestFilterDebug } from "./context-manifest-filter-debug.js";
import { buildContextManifestDiff } from "./context-manifest-diff.js";
import { sendRuntimeRequest } from "./runtime-rpc.js";

interface RuntimeStatus {
  connected: boolean;
}

interface ToolTreeTool {
  kind: "tool";
  tabId: number;
  namespace: string;
  instanceId: string;
  toolName: string;
  label: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  enabled: boolean;
  readOnly: boolean;
}

interface ToolTreeInstance {
  kind: "instance";
  tabId: number;
  namespace: string;
  instanceId: string;
  totalTools: number;
  enabledTools: number;
  tools: ToolTreeTool[];
}

interface ToolTreeNamespace {
  kind: "namespace";
  tabId: number;
  namespace: string;
  totalTools: number;
  enabledTools: number;
  instances: ToolTreeInstance[];
}

interface ToolTreeTab {
  kind: "tab";
  tabId: number;
  title: string;
  url: string;
  active: boolean;
  totalTools: number;
  enabledTools: number;
  namespaces: ToolTreeNamespace[];
}

interface ToolTreeResponse {
  builtins: ToolTreeBuiltins;
  tabs: ToolTreeTab[];
  totalTools: number;
  enabledTools: number;
}

interface ToolTreeBuiltins {
  kind: "builtins";
  totalTools: number;
  enabledTools: number;
  tools: ToolTreeBuiltinTool[];
}

interface ToolTreeBuiltinTool {
  kind: "builtin-tool";
  toolName: string;
  label: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  enabled: boolean;
  readOnly: boolean;
}

interface ToolDebugResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface ToolTestSelection {
  root: "builtin" | "page";
  toolName: string;
  label: string;
  tabId?: number;
  inputSchema?: Record<string, unknown>;
}

interface ContextManifestResponse {
  manifest: PageContextManifest | null;
  rawManifest?: PageContextManifest | null;
  debug?: ContextManifestFilterDebug;
}

interface ContextSkillResponse {
  prompt: ContextSkillPrompt | null;
}

const statusDot = document.getElementById("statusDot") as HTMLSpanElement;
const urlInput = document.getElementById("urlInput") as HTMLInputElement;
const goBtn = document.getElementById("goBtn") as HTMLButtonElement;
const reconnectBtn = document.getElementById("reconnectBtn") as HTMLButtonElement;
const openTabBtn = document.getElementById("openTabBtn") as HTMLButtonElement;
const iframeContainer = document.getElementById("iframeContainer") as HTMLDivElement;
const placeholder = document.getElementById("placeholder") as HTMLDivElement | null;
const toolsPanel = document.getElementById("toolsPanel") as HTMLDivElement;
const toolsCount = document.getElementById("toolsCount") as HTMLSpanElement;
const refreshToolsBtn = document.getElementById("refreshToolsBtn") as HTMLButtonElement;
const toolsFilterInput = document.getElementById("toolsFilterInput") as HTMLInputElement;
const toolTestPanel = document.getElementById("toolTestPanel") as HTMLDivElement;
const toolTestTitle = document.getElementById("toolTestTitle") as HTMLDivElement;
const toolTestSubtitle = document.getElementById("toolTestSubtitle") as HTMLDivElement;
const toolTestTabIdInput = document.getElementById("toolTestTabIdInput") as HTMLInputElement;
const toolTestSchemaOutput = document.getElementById("toolTestSchemaOutput") as HTMLPreElement;
const toolTestArgsInput = document.getElementById("toolTestArgsInput") as HTMLTextAreaElement;
const toolTestOutput = document.getElementById("toolTestOutput") as HTMLPreElement;
const toolTestStatus = document.getElementById("toolTestStatus") as HTMLDivElement;
const toolTestRunBtn = document.getElementById("toolTestRunBtn") as HTMLButtonElement;
const toolTestResetBtn = document.getElementById("toolTestResetBtn") as HTMLButtonElement;
const toolTestCloseBtn = document.getElementById("toolTestCloseBtn") as HTMLButtonElement;
const refreshContextBtn = document.getElementById("refreshContextBtn") as HTMLButtonElement;
const contextAppValue = document.getElementById("contextAppValue") as HTMLDivElement;
const contextSceneValue = document.getElementById("contextSceneValue") as HTMLDivElement;
const contextTabValue = document.getElementById("contextTabValue") as HTMLDivElement;
const contextRouteValue = document.getElementById("contextRouteValue") as HTMLDivElement;
const contextResourcesList = document.getElementById("contextResourcesList") as HTMLDivElement;
const contextSkillsList = document.getElementById("contextSkillsList") as HTMLDivElement;
const contextManifestStatus = document.getElementById("contextManifestStatus") as HTMLDivElement;
const contextManifestOutput = document.getElementById("contextManifestOutput") as HTMLPreElement;
const contextDiffStatus = document.getElementById("contextDiffStatus") as HTMLDivElement;
const contextDiffOutput = document.getElementById("contextDiffOutput") as HTMLDivElement;
const contextResourceStatus = document.getElementById("contextResourceStatus") as HTMLDivElement;
const contextResourceOutput = document.getElementById("contextResourceOutput") as HTMLPreElement;
const contextSkillStatus = document.getElementById("contextSkillStatus") as HTMLDivElement;
const contextSkillOutput = document.getElementById("contextSkillOutput") as HTMLPreElement;

let currentIframe: HTMLIFrameElement | null = null;
let currentTabId: number | null = null;
let toolTreeResponse: ToolTreeResponse | null = null;
let currentFilter = "";
let currentToolTestSelection: ToolTestSelection | null = null;
let currentContextManifest: PageContextManifest | null = null;
let currentRawContextManifest: PageContextManifest | null = null;
let currentContextDebug: ContextManifestFilterDebug | null = null;

async function refreshStatus(): Promise<void> {
  try {
    const status = await sendRuntimeRequest<RuntimeStatus>(BRIDGE_METHODS.extensionStatusGet);
    statusDot.className = `status-dot ${status.connected ? "connected" : "disconnected"}`;
  } catch {
    statusDot.className = "status-dot disconnected";
  }
}

async function getCurrentTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderToolsEmpty(message: string): void {
  toolsCount.textContent = "";
  toolsPanel.innerHTML = `<div class="tools-empty"><p>${escapeHtml(message)}</p></div>`;
}

function renderToolsTree(): void {
  if (!toolTreeResponse) {
    renderToolsEmpty("No tools loaded.");
    return;
  }

  const filteredTabs = toolTreeResponse.tabs
    .map((tab) => filterTab(tab, currentFilter))
    .filter((tab): tab is ToolTreeTab => tab !== null);

  toolsCount.textContent = `(${toolTreeResponse.enabledTools}/${toolTreeResponse.totalTools} enabled)`;

  if (filteredTabs.length === 0) {
    const builtinTools = filterBuiltins(toolTreeResponse.builtins, currentFilter);
    if (builtinTools.totalTools === 0) {
      renderToolsEmpty(currentFilter ? `No tools match '${currentFilter}'.` : "No tools discovered yet.");
      return;
    }
    toolsPanel.innerHTML = renderBuiltinsNode(builtinTools);
    syncIndeterminateCheckboxes();
    return;
  }

  const builtinTools = filterBuiltins(toolTreeResponse.builtins, currentFilter);
  toolsPanel.innerHTML = `${builtinTools.totalTools > 0 ? renderBuiltinsNode(builtinTools) : ""}${filteredTabs.map((tab) => renderTabNode(tab)).join("")}`;
  syncIndeterminateCheckboxes();
}

function syncIndeterminateCheckboxes(): void {
  toolsPanel.querySelectorAll<HTMLInputElement>("input[data-indeterminate='true']").forEach((input) => {
    input.indeterminate = true;
  });
}

async function loadPageTools(forceRediscover = false): Promise<void> {
  currentTabId = await getCurrentTabId();

  renderToolsEmpty("Loading tools...");
  try {
    if (forceRediscover && currentTabId) {
      await sendRuntimeRequest(BRIDGE_METHODS.extensionPageToolsDiscover, { tabId: currentTabId });
    }
    toolTreeResponse = await sendRuntimeRequest<ToolTreeResponse>(BRIDGE_METHODS.extensionPageToolsTreeGet);
    renderToolsTree();
  } catch (error) {
    renderToolsEmpty(error instanceof Error ? error.message : String(error));
  }
}

async function updateScopeEnabled(input: { root?: "builtin" | "page"; tabId?: number; namespace?: string; instanceId?: string; toolName?: string; enabled: boolean }): Promise<void> {
  toolTreeResponse = await sendRuntimeRequest<ToolTreeResponse>(BRIDGE_METHODS.extensionPageToolsSetEnabled, input);
  renderToolsTree();
  if (document.getElementById("tab-context")?.classList.contains("active")) {
    await loadContextManifest();
  }
}

async function loadContextManifest(): Promise<void> {
  currentTabId = await getCurrentTabId();
  if (!currentTabId) {
    currentContextManifest = null;
    renderContextEmpty("No active tab found.");
    return;
  }

  contextManifestStatus.textContent = "Loading...";
  contextManifestStatus.className = "context-output-status";
  try {
    const response = await sendRuntimeRequest<ContextManifestResponse>(BRIDGE_METHODS.extensionContextManifestGet, { tabId: currentTabId });
    currentContextManifest = response.manifest;
    currentRawContextManifest = response.rawManifest ?? response.manifest;
    currentContextDebug = response.debug ?? null;
    if (!currentContextManifest) {
      renderContextEmpty("No page context manifest available for this tab.");
      return;
    }

    renderContextManifest(currentRawContextManifest ?? currentContextManifest, currentContextManifest, currentTabId);
    contextManifestStatus.textContent = "Loaded";
    contextManifestStatus.className = "context-output-status ok";
    contextManifestOutput.textContent = formatJson(currentContextManifest);
  } catch (error) {
    currentContextManifest = null;
    currentContextDebug = null;
    const message = error instanceof Error ? error.message : String(error);
    renderContextEmpty(message, true);
  }
}

async function loadContextResource(resourceId: string): Promise<void> {
  if (!currentTabId) {
    return;
  }

  contextResourceStatus.textContent = `Reading ${resourceId}...`;
  contextResourceStatus.className = "context-output-status";
  try {
    const resource = await sendRuntimeRequest<ContextResourcePayload>(BRIDGE_METHODS.extensionContextResourceRead, { tabId: currentTabId, resourceId });
    contextResourceStatus.textContent = `Loaded ${resourceId}`;
    contextResourceStatus.className = "context-output-status ok";
    contextResourceOutput.textContent = resource.text;
  } catch (error) {
    contextResourceStatus.textContent = error instanceof Error ? error.message : String(error);
    contextResourceStatus.className = "context-output-status fail";
    contextResourceOutput.textContent = formatJson({ error: error instanceof Error ? error.message : String(error) });
  }
}

async function loadContextSkillPrompt(skillId: string): Promise<void> {
  if (!currentTabId) {
    return;
  }

  contextSkillStatus.textContent = `Rendering ${skillId}...`;
  contextSkillStatus.className = "context-output-status";
  try {
    const response = await sendRuntimeRequest<ContextSkillResponse>(BRIDGE_METHODS.extensionContextSkillGet, {
      tabId: currentTabId,
      skillId,
      input: { goal: "Explain how the agent should use this business skill safely." },
    });
    contextSkillStatus.textContent = response.prompt ? `Loaded ${skillId}` : `Skill ${skillId} unavailable`;
    contextSkillStatus.className = `context-output-status ${response.prompt ? "ok" : "fail"}`;
    contextSkillOutput.textContent = response.prompt ? formatJson(response.prompt) : formatJson({ error: "Prompt unavailable" });
  } catch (error) {
    contextSkillStatus.textContent = error instanceof Error ? error.message : String(error);
    contextSkillStatus.className = "context-output-status fail";
    contextSkillOutput.textContent = formatJson({ error: error instanceof Error ? error.message : String(error) });
  }
}

function openToolTestPanel(selection: ToolTestSelection): void {
  currentToolTestSelection = selection;
  toolTestPanel.classList.add("open");
  toolTestTitle.textContent = `Tool Test · ${selection.label}`;
  toolTestSubtitle.textContent = selection.root === "builtin"
    ? `Built-in tool: ${selection.toolName}`
    : `Context tool: ${selection.toolName}${selection.tabId != null ? ` · tab ${selection.tabId}` : ""}`;
  toolTestTabIdInput.value = selection.tabId != null ? String(selection.tabId) : "";
  toolTestTabIdInput.disabled = selection.root === "page" && selection.tabId != null;
  toolTestSchemaOutput.textContent = formatJson(selection.inputSchema ?? {});
  toolTestArgsInput.value = createArgsTemplate(selection.inputSchema);
  toolTestOutput.textContent = "(no output yet)";
  toolTestStatus.textContent = "Ready";
  toolTestStatus.className = "test-status";
}

function closeToolTestPanel(): void {
  currentToolTestSelection = null;
  toolTestPanel.classList.remove("open");
}

async function runToolDebugCall(): Promise<void> {
  if (!currentToolTestSelection) {
    return;
  }

  let parsedArgs: Record<string, unknown>;
  try {
    const raw = toolTestArgsInput.value.trim() || "{}";
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("RPC args must be a JSON object");
    }
    parsedArgs = parsed as Record<string, unknown>;
  } catch (error) {
    toolTestStatus.textContent = error instanceof Error ? error.message : String(error);
    toolTestStatus.className = "test-status fail";
    toolTestOutput.textContent = "(invalid JSON args)";
    return;
  }

  toolTestRunBtn.disabled = true;
  toolTestStatus.textContent = "Running...";
  toolTestStatus.className = "test-status";

  try {
    const tabId = toolTestTabIdInput.value ? Number(toolTestTabIdInput.value) : undefined;
    const response = await sendRuntimeRequest<ToolDebugResponse>(BRIDGE_METHODS.extensionToolDebugCall, {
      toolName: currentToolTestSelection.toolName,
      tabId,
      args: parsedArgs,
    });

    toolTestStatus.textContent = response.ok ? "Success" : "Failed";
    toolTestStatus.className = `test-status ${response.ok ? "ok" : "fail"}`;
    toolTestOutput.textContent = formatJson(response.ok ? response.result ?? {} : { error: response.error ?? "Unknown error" });
  } catch (error) {
    toolTestStatus.textContent = error instanceof Error ? error.message : String(error);
    toolTestStatus.className = "test-status fail";
    toolTestOutput.textContent = formatJson({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    toolTestRunBtn.disabled = false;
  }
}

function navigateTo(url: string): void {
  const normalized = /^https?:\/\//.test(url) ? url : `http://${url}`;
  urlInput.value = normalized;
  placeholder?.remove();
  currentIframe?.remove();
  currentIframe = document.createElement("iframe");
  currentIframe.src = normalized;
  currentIframe.allow = "clipboard-read; clipboard-write";
  iframeContainer.appendChild(currentIframe);
}

document.querySelectorAll<HTMLButtonElement>(".tab-bar button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>(".tab-bar button").forEach((entry) => entry.classList.remove("active"));
    button.classList.add("active");
    document.querySelectorAll<HTMLElement>(".tab-content").forEach((content) => content.classList.remove("active"));
    document.getElementById(`tab-${button.dataset.tab}`)?.classList.add("active");
    if (button.dataset.tab === "tools") {
      void loadPageTools();
    } else if (button.dataset.tab === "context") {
      void loadContextManifest();
    }
  });
});

goBtn.addEventListener("click", () => navigateTo(urlInput.value.trim()));
urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    navigateTo(urlInput.value.trim());
  }
});
reconnectBtn.addEventListener("click", async () => {
  await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect);
  setTimeout(() => void refreshStatus(), 1_000);
});
openTabBtn.addEventListener("click", () => {
  const url = urlInput.value.trim();
  if (url) {
    void chrome.tabs.create({ url });
  }
});
refreshToolsBtn.addEventListener("click", () => void loadPageTools(true));
toolsFilterInput.addEventListener("input", () => {
  currentFilter = toolsFilterInput.value.trim().toLowerCase();
  renderToolsTree();
});

toolsPanel.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
    return;
  }

  const { scope, tabId, namespace, instanceId, toolName } = target.dataset;
  if (!scope || !tabId) {
    return;
  }

  void updateScopeEnabled({
    root: scope === "builtin" ? "builtin" : "page",
    tabId: scope === "builtin" ? undefined : Number(tabId),
    namespace,
    instanceId,
    toolName,
    enabled: target.checked,
  });
});

toolsPanel.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || target.dataset.action !== "test-tool") {
    return;
  }

  openToolTestPanel({
    root: (target.dataset.root as "builtin" | "page") ?? "page",
    toolName: target.dataset.toolName ?? "",
    label: target.dataset.label ?? target.dataset.toolName ?? "Tool",
    tabId: target.dataset.tabId ? Number(target.dataset.tabId) : undefined,
    inputSchema: target.dataset.schema ? safeParseJson(target.dataset.schema) : {},
  });
});

toolTestRunBtn.addEventListener("click", () => void runToolDebugCall());
toolTestResetBtn.addEventListener("click", () => {
  toolTestArgsInput.value = createArgsTemplate(currentToolTestSelection?.inputSchema);
  toolTestOutput.textContent = "(no output yet)";
  toolTestStatus.textContent = "Ready";
  toolTestStatus.className = "test-status";
});
toolTestCloseBtn.addEventListener("click", () => closeToolTestPanel());
refreshContextBtn.addEventListener("click", () => void loadContextManifest());

contextResourcesList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || target.dataset.action !== "read-resource") {
    return;
  }
  const resourceId = target.dataset.resourceId;
  if (resourceId) {
    void loadContextResource(resourceId);
  }
});

contextSkillsList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || target.dataset.action !== "preview-skill") {
    return;
  }
  const skillId = target.dataset.skillId;
  if (skillId) {
    void loadContextSkillPrompt(skillId);
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (activeInfo.tabId !== currentTabId && document.getElementById("tab-tools")?.classList.contains("active")) {
    void loadPageTools();
  }
  if (document.getElementById("tab-context")?.classList.contains("active")) {
    void loadContextManifest();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === currentTabId && changeInfo.status === "complete" && document.getElementById("tab-tools")?.classList.contains("active")) {
    setTimeout(() => void loadPageTools(), 1_000);
  }
  if (tabId === currentTabId && changeInfo.status === "complete" && document.getElementById("tab-context")?.classList.contains("active")) {
    setTimeout(() => void loadContextManifest(), 1_000);
  }
});

async function init(): Promise<void> {
  await refreshStatus();
  setInterval(() => void refreshStatus(), 5_000);
  await loadPageTools();
  const result = await chrome.storage.local.get("sidePanelUrl");
  if (result.sidePanelUrl) {
    navigateTo(String(result.sidePanelUrl));
    await chrome.storage.local.remove("sidePanelUrl");
  }
}

void init();

function renderContextManifest(rawManifest: PageContextManifest, effectiveManifest: PageContextManifest, tabId: number): void {
  contextAppValue.textContent = effectiveManifest.app;
  contextSceneValue.textContent = effectiveManifest.scene;
  contextTabValue.textContent = String(tabId);
  contextRouteValue.textContent = effectiveManifest.route || "/";
  contextResourcesList.innerHTML = effectiveManifest.resources.length > 0
    ? effectiveManifest.resources.map((resource) => renderContextResourceCard(resource)).join("")
    : '<div class="tools-empty"><p>No resources declared.</p></div>';
  contextSkillsList.innerHTML = effectiveManifest.skills.length > 0
    ? effectiveManifest.skills.map((skill) => renderContextSkillCard(skill)).join("")
    : '<div class="tools-empty"><p>No skills declared.</p></div>';
  renderContextDiff(rawManifest, effectiveManifest);
}

function renderContextEmpty(message: string, isError = false): void {
  contextAppValue.textContent = "-";
  contextSceneValue.textContent = "-";
  contextTabValue.textContent = currentTabId != null ? String(currentTabId) : "-";
  contextRouteValue.textContent = "-";
  contextResourcesList.innerHTML = `<div class="tools-empty"><p>${escapeHtml(message)}</p></div>`;
  contextSkillsList.innerHTML = `<div class="tools-empty"><p>${escapeHtml(message)}</p></div>`;
  contextManifestStatus.textContent = message;
  contextManifestStatus.className = `context-output-status ${isError ? "fail" : ""}`.trim();
  contextManifestOutput.textContent = isError ? formatJson({ error: message }) : "(manifest not loaded)";
  contextDiffStatus.textContent = "Idle";
  contextDiffStatus.className = "context-output-status";
  contextDiffOutput.innerHTML = '<div class="context-diff-item"><p>(manifest diff not available)</p></div>';
  contextResourceStatus.textContent = "Idle";
  contextResourceStatus.className = "context-output-status";
  contextResourceOutput.textContent = "(select a resource to read)";
  contextSkillStatus.textContent = "Idle";
  contextSkillStatus.className = "context-output-status";
  contextSkillOutput.textContent = "(select a skill to render its prompt)";
}

function renderContextDiff(rawManifest: PageContextManifest | null, effectiveManifest: PageContextManifest | null): void {
  const diff = buildContextManifestDiff(rawManifest, effectiveManifest);
  const debug = currentContextDebug;
  const hasDiff = diff.hiddenNamespaces.length > 0 || diff.hiddenResources.length > 0 || diff.hiddenSkills.length > 0 || diff.sceneChanged;

  contextDiffStatus.textContent = hasDiff ? "Diff detected" : "No diff";
  contextDiffStatus.className = `context-output-status ${hasDiff ? "ok" : ""}`.trim();
  contextDiffOutput.innerHTML = [
    renderDiffCard("Namespaces", diff.rawNamespaces, diff.effectiveNamespaces, debug?.hiddenNamespaces ?? diff.hiddenNamespaces.map((id) => ({ id, reason: "unknown" }))),
    renderDiffCard("Resources", diff.rawResources, diff.effectiveResources, debug?.hiddenResources ?? diff.hiddenResources.map((id) => ({ id, reason: "unknown" }))),
    renderDiffCard("Skills", diff.rawSkills, diff.effectiveSkills, debug?.hiddenSkills ?? diff.hiddenSkills.map((id) => ({ id, reason: "unknown" }))),
    renderTrimmedToolsCard(debug),
    `<div class="context-diff-item"><h4>Scene</h4><p>${diff.sceneChanged ? "Scene changed between raw and effective manifest." : "Scene is unchanged."}</p></div>`,
  ].join("");
}

function renderDiffCard(title: string, rawCount: number, effectiveCount: number, hiddenItems: Array<{ id: string; reason: string }>): string {
  return `
    <div class="context-diff-item">
      <h4>${escapeHtml(title)}</h4>
      <p>Raw: ${rawCount} · Effective: ${effectiveCount}</p>
      ${hiddenItems.length > 0
        ? `<ul>${hiddenItems.map((item) => `<li><strong>${escapeHtml(item.id)}</strong> · ${escapeHtml(formatReason(item.reason))}</li>`).join("")}</ul>`
        : "<p>No hidden items.</p>"}
    </div>
  `;
}

function renderTrimmedToolsCard(debug: ContextManifestFilterDebug | null): string {
  const trimmed = debug?.trimmedSkillTools ?? [];
  return `
    <div class="context-diff-item">
      <h4>Skill Tool Trimming</h4>
      ${trimmed.length > 0
        ? `<ul>${trimmed.map((entry) => `${entry.removedTools.map((item) => `<li><strong>${escapeHtml(entry.skillId)}</strong> · ${escapeHtml(item.id)} · ${escapeHtml(formatReason(item.reason))}</li>`).join("")}`).join("")}</ul>`
        : "<p>No skill tool recommendations were trimmed.</p>"}
    </div>
  `;
}

function formatReason(reason: string): string {
  switch (reason) {
    case "namespace_disabled":
      return "disabled by namespace";
    case "builtin_tool_disabled":
      return "disabled by built-in tool filter";
    case "page_tool_disabled":
      return "disabled by page tool filter";
    case "scene_filtered":
      return "filtered by scene";
    default:
      return "unknown reason";
  }
}

function renderContextResourceCard(resource: ContextResourceDescriptor): string {
  return `
    <div class="context-card">
      <div class="context-card-title">${escapeHtml(resource.title)}</div>
      <div class="context-card-subtitle">${escapeHtml(resource.description ?? resource.id)}</div>
      <div class="context-card-meta">
        <span class="context-badge">${escapeHtml(resource.namespace)}</span>
        <span class="context-badge">${escapeHtml(resource.kind ?? "resource")}</span>
      </div>
      <div class="context-card-actions">
        <button class="primary" type="button" data-action="read-resource" data-resource-id="${escapeHtml(resource.id)}">Read Resource</button>
      </div>
    </div>
  `;
}

function renderContextSkillCard(skill: ContextSkillDescriptor): string {
  return `
    <div class="context-card">
      <div class="context-card-title">${escapeHtml(skill.title)}</div>
      <div class="context-card-subtitle">${escapeHtml(skill.description)}</div>
      <div class="context-card-meta">
        <span class="context-badge">${escapeHtml(skill.namespace)}</span>
        <span class="context-badge">${escapeHtml(skill.mode ?? "analysis")}</span>
      </div>
      <div class="context-card-actions">
        <button class="primary" type="button" data-action="preview-skill" data-skill-id="${escapeHtml(skill.id)}">Preview Prompt</button>
      </div>
    </div>
  `;
}

function filterTab(tab: ToolTreeTab, query: string): ToolTreeTab | null {
  const namespaces = tab.namespaces
    .map((namespace) => filterNamespace(namespace, query))
    .filter((namespace): namespace is ToolTreeNamespace => namespace !== null);

  const selfMatches = !query || [tab.title, tab.url, String(tab.tabId)].some((value) => value.toLowerCase().includes(query));
  if (!selfMatches && namespaces.length === 0) {
    return null;
  }

  return {
    ...tab,
    namespaces: selfMatches ? tab.namespaces : namespaces,
  };
}

function filterNamespace(namespace: ToolTreeNamespace, query: string): ToolTreeNamespace | null {
  const instances = namespace.instances
    .map((instance) => filterInstance(instance, query))
    .filter((instance): instance is ToolTreeInstance => instance !== null);

  const selfMatches = !query || namespace.namespace.toLowerCase().includes(query);
  if (!selfMatches && instances.length === 0) {
    return null;
  }

  return {
    ...namespace,
    instances: selfMatches ? namespace.instances : instances,
  };
}

function filterInstance(instance: ToolTreeInstance, query: string): ToolTreeInstance | null {
  const tools = instance.tools.filter((tool) => matchesTool(tool, query));
  const selfMatches = !query || instance.instanceId.toLowerCase().includes(query);
  if (!selfMatches && tools.length === 0) {
    return null;
  }

  return {
    ...instance,
    tools: selfMatches ? instance.tools : tools,
  };
}

function matchesTool(tool: ToolTreeTool, query: string): boolean {
  if (!query) {
    return true;
  }
  return [tool.toolName, tool.label, tool.description ?? ""].some((value) => value.toLowerCase().includes(query));
}

function filterBuiltins(builtins: ToolTreeBuiltins, query: string): ToolTreeBuiltins {
  if (!query) {
    return builtins;
  }
  const tools = builtins.tools.filter((tool) => [tool.label, tool.toolName, tool.description ?? "", "builtin"].some((value) => value.toLowerCase().includes(query)));
  return {
    ...builtins,
    totalTools: tools.length,
    enabledTools: tools.filter((tool) => tool.enabled).length,
    tools,
  };
}

function renderBuiltinsNode(builtins: ToolTreeBuiltins): string {
  return `
    <details class="tree-node" open>
      <summary>${renderTreeRow({
        level: "tab",
        checked: builtins.enabledTools === builtins.totalTools && builtins.totalTools > 0,
        indeterminate: builtins.enabledTools > 0 && builtins.enabledTools < builtins.totalTools,
        data: { scope: "builtin", tabId: "builtin-root" },
        label: "Built-in Tools",
        subtitle: "Extension provided tools",
        meta: `${builtins.enabledTools}/${builtins.totalTools} enabled`,
        badges: ['<span class="tree-badge">builtin</span>'],
      })}</summary>
      ${builtins.tools.map((tool) => renderBuiltinToolNode(tool)).join("")}
    </details>
  `;
}

function renderBuiltinToolNode(tool: ToolTreeBuiltinTool): string {
  return renderTreeRow({
    level: "tool",
    checked: tool.enabled,
    indeterminate: false,
    data: { scope: "builtin", tabId: "builtin-root", toolName: tool.toolName },
    label: escapeHtml(tool.label),
    subtitle: tool.description ? escapeHtml(tool.description) : escapeHtml(tool.toolName),
    meta: tool.toolName,
    badges: [tool.readOnly ? '<span class="tree-badge readonly">readonly</span>' : ''],
    actions: renderTestButton({
      root: "builtin",
      toolName: tool.toolName,
      label: tool.label,
      inputSchema: tool.inputSchema,
    }),
  });
}

function renderTabNode(tab: ToolTreeTab): string {
  return `
    <details class="tree-node" open>
      <summary>${renderTreeRow({
        level: "tab",
        checked: tab.enabledTools === tab.totalTools && tab.totalTools > 0,
        indeterminate: tab.enabledTools > 0 && tab.enabledTools < tab.totalTools,
        data: { scope: "tab", tabId: String(tab.tabId) },
        label: escapeHtml(tab.title),
        subtitle: tab.url ? escapeHtml(tab.url) : "",
        meta: `${tab.enabledTools}/${tab.totalTools} enabled`,
        badges: [tab.active ? '<span class="tree-badge active">active</span>' : '', `<span class="tree-badge">tab ${tab.tabId}</span>`],
      })}</summary>
      ${tab.namespaces.map((namespace) => renderNamespaceNode(namespace)).join("")}
    </details>
  `;
}

function renderNamespaceNode(namespace: ToolTreeNamespace): string {
  return `
    <details class="tree-node" open>
      <summary>${renderTreeRow({
        level: "namespace",
        checked: namespace.enabledTools === namespace.totalTools && namespace.totalTools > 0,
        indeterminate: namespace.enabledTools > 0 && namespace.enabledTools < namespace.totalTools,
        data: { scope: "namespace", tabId: String(namespace.tabId), namespace: namespace.namespace },
        label: escapeHtml(namespace.namespace),
        subtitle: "Namespace",
        meta: `${namespace.enabledTools}/${namespace.totalTools} enabled`,
        badges: ['<span class="tree-badge">namespace</span>'],
      })}</summary>
      ${namespace.instances.map((instance) => renderInstanceNode(instance)).join("")}
    </details>
  `;
}

function renderInstanceNode(instance: ToolTreeInstance): string {
  return `
    <details class="tree-node" open>
      <summary>${renderTreeRow({
        level: "instance",
        checked: instance.enabledTools === instance.totalTools && instance.totalTools > 0,
        indeterminate: instance.enabledTools > 0 && instance.enabledTools < instance.totalTools,
        data: { scope: "instance", tabId: String(instance.tabId), namespace: instance.namespace, instanceId: instance.instanceId },
        label: escapeHtml(instance.instanceId),
        subtitle: instance.instanceId === "default" ? "Default instance" : "Instance",
        meta: `${instance.enabledTools}/${instance.totalTools} enabled`,
        badges: ['<span class="tree-badge">instance</span>'],
      })}</summary>
      ${instance.tools.map((tool) => renderToolNode(tool)).join("")}
    </details>
  `;
}

function renderToolNode(tool: ToolTreeTool): string {
  return renderTreeRow({
    level: "tool",
    checked: tool.enabled,
    indeterminate: false,
    data: {
      scope: "tool",
      tabId: String(tool.tabId),
      namespace: tool.namespace,
      instanceId: tool.instanceId,
      toolName: tool.toolName,
    },
    label: escapeHtml(tool.label),
    subtitle: tool.description ? escapeHtml(tool.description) : escapeHtml(tool.toolName),
    meta: tool.toolName,
    badges: [tool.readOnly ? '<span class="tree-badge readonly">readonly</span>' : ''],
    actions: renderTestButton({
      root: "page",
      toolName: tool.toolName,
      label: tool.label,
      tabId: tool.tabId,
      inputSchema: tool.inputSchema,
    }),
  });
}

function renderTreeRow(input: {
  level: "tab" | "namespace" | "instance" | "tool";
  checked: boolean;
  indeterminate: boolean;
  data: Record<string, string>;
  label: string;
  subtitle: string;
  meta: string;
  badges: string[];
  actions?: string;
}): string {
  const attributes = Object.entries(input.data)
    .map(([key, value]) => `data-${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}="${escapeHtml(value)}"`)
    .join(" ");
  const badges = input.badges.filter(Boolean).join("");

  return `
    <div class="tree-row level-${input.level}">
      <input type="checkbox" ${input.checked ? "checked" : ""} data-indeterminate="${input.indeterminate ? "true" : "false"}" ${attributes} />
      <div class="tree-body">
        <div class="tree-label">${input.label}<span class="tree-count">${escapeHtml(input.meta)}</span>${badges}</div>
        ${input.subtitle ? `<div class="tree-subtitle">${input.subtitle}</div>` : ""}
      </div>
      ${input.actions ? `<div class="tree-actions">${input.actions}</div>` : ""}
    </div>
  `;
}

function renderTestButton(input: { root: "builtin" | "page"; toolName: string; label: string; tabId?: number; inputSchema?: Record<string, unknown> }): string {
  const data = [
    `data-action="test-tool"`,
    `data-root="${escapeHtml(input.root)}"`,
    `data-tool-name="${escapeHtml(input.toolName)}"`,
    `data-label="${escapeHtml(input.label)}"`,
    `data-schema="${escapeHtml(JSON.stringify(input.inputSchema ?? {}))}"`,
  ];
  if (input.tabId != null) {
    data.push(`data-tab-id="${String(input.tabId)}"`);
  }
  return `<button type="button" class="tree-test-btn" ${data.join(" ")}>Test</button>`;
}

function createArgsTemplate(schema?: Record<string, unknown>): string {
  if (!schema || typeof schema !== "object") {
    return "{}";
  }

  const properties = (schema.properties as Record<string, { type?: string; default?: unknown }> | undefined) ?? {};
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const template: Record<string, unknown> = {};

  for (const [key, property] of Object.entries(properties)) {
    if (!required.has(key) && property.default === undefined) {
      continue;
    }
    if (property.default !== undefined) {
      template[key] = property.default;
      continue;
    }
    switch (property.type) {
      case "number":
      case "integer":
        template[key] = 0;
        break;
      case "boolean":
        template[key] = false;
        break;
      case "array":
        template[key] = [];
        break;
      case "object":
        template[key] = {};
        break;
      default:
        template[key] = "";
        break;
    }
  }

  return formatJson(template);
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
