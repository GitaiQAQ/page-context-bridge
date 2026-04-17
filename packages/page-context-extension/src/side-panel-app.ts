import {
  BRIDGE_METHODS,
  type ContextResourcePayload,
  type PageContextManifest,
} from "@page-context/shared-protocol";

import { LitElement, html, css, type PropertyValues, type TemplateResult, nothing } from "lit";
import { customElement, state, query } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { when } from "lit/directives/when.js";

import type { ContextManifestFilterDebug } from "./context-manifest-filter-debug";
import { sendRuntimeRequest } from "./runtime-rpc";
import {
  createArgsTemplate,
  filterBuiltins,
  filterTab,
  formatJson,
  renderBuiltinsNode,
  renderTabNode,
  renderToolsEmpty,
  safeParseJson,
} from "./sidepanel-tree-renderer";
import {
  buildContextManifestDiff,
  renderContextResourceCard,
  renderContextSkillCard,
} from "./sidepanel-context-panel";
import type { ContextManifestResponse, ContextSkillResponse, RuntimeStatus, ToolDebugResponse, ToolTestSelection, ToolTreeResponse } from "./sidepanel-types";

// Vite resolves this to the built CSS asset URL at runtime
import sidepanelCssUrl from "./sidepanel.css?url";

// Custom sidepanel-specific rules that were previously in <style> in the HTML
const customRules = css`
  /* tree indentation */
  .tree-indent-1 { padding-left: 1.5rem; }
  .tree-indent-2 { padding-left: 2.5rem; }
  .tree-indent-3 { padding-left: 3.5rem; }
  /* keep details/summary clean */
  details summary { list-style: none; cursor: pointer; }
  details summary::-webkit-details-marker { display: none; }
  /* iframe fill */
  .iframe-container iframe { width: 100%; height: 100%; border: none; }
  /* test panel toggle */
  .test-panel { display: none; }
  .test-panel.open { display: flex; }
  /* tab content visibility: override daisyUI's display:none */
  .tab-content { display: none; }
  .tab-content.active { display: flex; }
`;

@customElement("side-panel-app")
export class SidePanelApp extends LitElement {
  // Custom rules live in static styles; global CSS (Tailwind/DaisyUI) is fetched at runtime
  // and injected into shadow root so <link> tags work inside Shadow DOM.
  static override styles = [
    customRules,
    css`
      :host {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }
    `,
  ];

  // ─── State ──────────────────────────────────────────────────────
  @state() private _connected = false;
  @state() private _refreshing = false;
  @state() private _currentTabId: number | null = null;
  @state() private _toolTreeResponse: ToolTreeResponse | null = null;
  @state() private _currentFilter = "";
  @state() private _currentToolTestSelection: ToolTestSelection | null = null;
  @state() private _currentRawContextManifest: PageContextManifest | null = null;
  @state() private _currentEffectiveContextManifest: PageContextManifest | null = null;
  @state() private _currentContextDebug: ContextManifestFilterDebug | null = null;
  @state() private _activeTab: "tools" | "context" | "diagnosis" = "tools";
  @state() private _urlBarVisible = true;
  @state() private _currentUrl = "";
  @state() private _manifestStatus = "";
  @state() private _manifestStatusClass = "";
  @state() private _manifestOutput = "(manifest not loaded)";
  @state() private _diffStatus = "";
  @state() private _diffOutput: TemplateResult = html``;
  @state() private _resourceStatus = "";
  @state() private _resourceOutput = "(select a resource to read)";
  @state() private _skillStatus = "";
  @state() private _skillOutput = "(select a skill to render its prompt)";
  @state() private _contextAppValue = "-";
  @state() private _contextSceneValue = "-";
  @state() private _contextTabValue = "-";
  @state() private _contextRouteValue = "-";
  @state() private _contextResourcesListHtml: TemplateResult = html``;
  @state() private _contextSkillsListHtml: TemplateResult = html``;
  @state() private _toolTestArgs = "{}";
  @state() private _toolTestOutput = "(no output yet)";
  @state() private _toolTestStatusText = "Idle";
  @state() private _toolTestStatusClass = "text-xs font-semibold opacity-60";
  @state() private _toolTestRunning = false;
  @state() private _toolTestSchemaOutput = "{}";
  @state() private _toolTestTitle = "Tool Test";
  @state() private _toolTestSubtitle = "Select a tool to run an RPC debug call.";
  @state() private _toolTestTabIdValue = "";
  @state() private _toolTestTabIdDisabled = false;

  // ─── Query references (shadowRoot is guaranteed when using default createRenderRoot) ──
  @query("#iframeContainer") private _iframeContainer!: HTMLElement;

  // ─── Private state (non-reactive) ─────────────────────────────
  private _currentIframe: HTMLIFrameElement | null = null;
  private _statusIntervalId: ReturnType<typeof setInterval> | null = null;
  private _tabActivatedListener?: (activeInfo: { tabId: number; windowId: number }) => void;
  private _tabUpdatedListener?: (tabId: number, changeInfo: { status?: string }, tab: chrome.tabs.Tab) => void;

  // ─── Lifecycle ─────────────────────────────────────────────────
  override connectedCallback(): void {
    super.connectedCallback();
    // Inject global CSS (Tailwind + DaisyUI) into shadow root via <link>
    // This is needed because Vite's injectCssLinks plugin adds <link> to <head>,
    // which is outside our shadow boundary.
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = sidepanelCssUrl;
    this.shadowRoot!.appendChild(link);
    this._init();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("message", this._boundMessageHandler);
    if (this._statusIntervalId) {
      clearInterval(this._statusIntervalId);
      this._statusIntervalId = null;
    }
    if (this._tabActivatedListener) {
      chrome.tabs.onActivated.removeListener(this._tabActivatedListener);
    }
    if (this._tabUpdatedListener) {
      chrome.tabs.onUpdated.removeListener(this._tabUpdatedListener);
    }
  }

  override updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);
    if (changedProperties.has("_toolTreeResponse") || changedProperties.has("_currentFilter")) {
      this.updateComplete.then(() => this._syncIndeterminateCheckboxes());
    }
    if (changedProperties.has("_currentUrl")) {
      this.updateComplete.then(() => this._manageIframe());
    }
  }

  // ─── Initialization ────────────────────────────────────────────
  private async _init(): Promise<void> {
    await this._refreshStatus();
    this._statusIntervalId = setInterval(() => this._refreshStatus(), 5000);
    await this._loadPageTools();

    const result = await chrome.storage.local.get("sidePanelUrl");
    const url = result.sidePanelUrl ? String(result.sidePanelUrl) : "http://127.0.0.1:22338/";
    this._navigateTo(url);
    this.updateComplete.then(() => this._manageIframe());

    if (result.sidePanelUrl) {
      await chrome.storage.local.remove("sidePanelUrl");
    }

    // Register extension API listeners
    this._tabActivatedListener = (activeInfo: { tabId: number; windowId: number }) => {
      if (activeInfo.tabId !== this._currentTabId && this._activeTab === "tools") {
        void this._loadPageTools();
      }
      if (this._activeTab === "context") {
        void this._loadContextManifest();
      }
    };
    chrome.tabs.onActivated.addListener(this._tabActivatedListener!);

    this._tabUpdatedListener = (_tabId: number, changeInfo: { status?: string }) => {
      if (_tabId === this._currentTabId && changeInfo.status === "complete") {
        setTimeout(() => {
          if (this._activeTab === "tools") {
            void this._loadPageTools();
          }
          if (this._activeTab === "context") {
            void this._loadContextManifest();
          }
        }, 1000);
      }
    };
    chrome.tabs.onUpdated.addListener(this._tabUpdatedListener!);
  }

  // ─── Status & Tab Management ───────────────────────────────────
  private async _refreshStatus(): Promise<void> {
    try {
      const status = await sendRuntimeRequest<RuntimeStatus>(BRIDGE_METHODS.extensionStatusGet);
      this._connected = status.connected;
    } catch {
      this._connected = false;
    }
  }

  private async _getCurrentTabId(): Promise<number | null> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id ?? null;
  }

  // ─── Tools Tree Rendering ──────────────────────────────────────
  private _syncIndeterminateCheckboxes(): void {
    const toolsPanel = this.shadowRoot!.getElementById("toolsPanel");
    if (!toolsPanel) return;
    toolsPanel.querySelectorAll<HTMLInputElement>("input[data-indeterminate='true']").forEach((input) => {
      input.indeterminate = true;
    });
  }

  private async _loadPageTools(forceRediscover = false): Promise<void> {
    this._currentTabId = await this._getCurrentTabId();

    try {
      if (forceRediscover && this._currentTabId) {
        await sendRuntimeRequest(BRIDGE_METHODS.extensionPageToolsDiscover, { tabId: this._currentTabId });
      }
      this._toolTreeResponse = await sendRuntimeRequest<ToolTreeResponse>(BRIDGE_METHODS.extensionPageToolsTreeGet);
    } catch (error) {
      this._toolTreeResponse = null;
    }
    this.requestUpdate();
  }

  private async _updateScopeEnabled(input: { root?: "builtin" | "page"; tabId?: number; namespace?: string; instanceId?: string; toolName?: string; enabled: boolean }): Promise<void> {
    this._toolTreeResponse = await sendRuntimeRequest<ToolTreeResponse>(BRIDGE_METHODS.extensionPageToolsSetEnabled, input);
    this.requestUpdate();
    if (this._activeTab === "context") {
      await this._loadContextManifest();
    }
  }

  // ─── Context Manifest ──────────────────────────────────────────
  private async _loadContextManifest(): Promise<void> {
    this._currentTabId = await this._getCurrentTabId();
    if (!this._currentTabId) {
      this._renderContextEmpty("No active tab found.", null, false);
      return;
    }

    this._manifestStatus = "Loading...";
    this._manifestStatusClass = "text-xs font-semibold opacity-60";
    this.requestUpdate();

    try {
      const response = await sendRuntimeRequest<ContextManifestResponse>(BRIDGE_METHODS.extensionContextManifestGet, { tabId: this._currentTabId });
      const manifest = response.manifest;
      const rawManifest = response.rawManifest ?? response.manifest;
      this._currentContextDebug = response.debug ?? null;

      if (!manifest) {
        this._renderContextEmpty("No page context manifest available for this tab.", this._currentTabId, false);
        return;
      }

      this._currentRawContextManifest = rawManifest ?? manifest;
      this._currentEffectiveContextManifest = manifest;

      this._contextAppValue = manifest.app;
      this._contextSceneValue = manifest.scene;
      this._contextTabValue = String(this._currentTabId);
      this._contextRouteValue = manifest.route || "/";

      this._contextResourcesListHtml = manifest.resources.length > 0
        ? html`${manifest.resources.map((resource) => renderContextResourceCard(resource))}`
        : html`<div class="flex flex-col items-center justify-center p-4 text-base-content/40"><p class="text-xs">No resources declared.</p></div>`;
      this._contextSkillsListHtml = manifest.skills.length > 0
        ? html`${manifest.skills.map((skill) => renderContextSkillCard(skill))}`
        : html`<div class="flex flex-col items-center justify-center p-4 text-base-content/40"><p class="text-xs">No skills declared.</p></div>`;

      this._renderContextDiff(rawManifest, manifest);

      this._manifestStatus = "Loaded";
      this._manifestStatusClass = "text-xs font-semibold text-success";
      this._manifestOutput = formatJson(manifest);
    } catch (error) {
      this._currentContextDebug = null;
      const message = error instanceof Error ? error.message : String(error);
      this._renderContextEmpty(message, this._currentTabId, true);
    }
  }

  private _renderContextEmpty(message: string, currentTabId: number | null, isError: boolean): void {
    this._contextAppValue = "-";
    this._contextSceneValue = "-";
    this._contextTabValue = currentTabId != null ? String(currentTabId) : "-";
    this._contextRouteValue = "-";
    this._contextResourcesListHtml = html`<div class="flex flex-col items-center justify-center p-4 text-base-content/40"><p class="text-xs">${message}</p></div>`;
    this._contextSkillsListHtml = html`<div class="flex flex-col items-center justify-center p-4 text-base-content/40"><p class="text-xs">${message}</p></div>`;
    this._manifestStatus = message;
    this._manifestStatusClass = `text-xs font-semibold ${isError ? "text-error" : "opacity-60"}`.trim();
    this._manifestOutput = isError ? formatJson({ error: message }) : "(manifest not loaded)";
    this._diffStatus = "Idle";
    this._diffStatusClass = "text-xs font-semibold opacity-60";
    this._diffOutput = html`<div class="border border-base-300 rounded-lg bg-base-100 p-2.5"><p class="text-xs opacity-60">(manifest diff not available)</p></div>`;
    this._resourceStatus = "Idle";
    this._resourceStatusClass = "text-xs font-semibold opacity-60";
    this._resourceOutput = "(select a resource to read)";
    this._skillStatus = "Idle";
    this._skillStatusClass = "text-xs font-semibold opacity-60";
    this._skillOutput = "(select a skill to render its prompt)";
    this.requestUpdate();
  }

  @state() private _diffStatusClass = "text-xs font-semibold opacity-60";
  @state() private _resourceStatusClass = "text-xs font-semibold opacity-60";
  @state() private _skillStatusClass = "text-xs font-semibold opacity-60";

  private _renderContextDiff(rawManifest: PageContextManifest | null, effectiveManifest: PageContextManifest): void {
    const diff = buildContextManifestDiff(rawManifest, effectiveManifest);
    const hasDiff = diff.hiddenNamespaces.length > 0 || diff.hiddenResources.length > 0 || diff.hiddenSkills.length > 0 || diff.sceneChanged;

    this._diffStatus = hasDiff ? "Diff detected" : "No diff";
    this._diffStatusClass = `text-xs font-semibold ${hasDiff ? "text-success" : "opacity-60"}`.trim();

    const debug = this._currentContextDebug;
    this._diffOutput = html`
      ${this._renderDiffCard("Namespaces", diff.rawNamespaces, diff.effectiveNamespaces, debug?.hiddenNamespaces ?? diff.hiddenNamespaces.map((id) => ({ id, reason: "unknown" })))}
      ${this._renderDiffCard("Resources", diff.rawResources, diff.effectiveResources, debug?.hiddenResources ?? diff.hiddenResources.map((id) => ({ id, reason: "unknown" })))}
      ${this._renderDiffCard("Skills", diff.rawSkills, diff.effectiveSkills, debug?.hiddenSkills ?? diff.hiddenSkills.map((id) => ({ id, reason: "unknown" })))}
      ${this._renderTrimmedToolsCard(debug)}
      <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
        <h4 class="text-xs font-bold mb-1">Scene</h4>
        <p class="text-xs opacity-70">${diff.sceneChanged ? "Scene changed between raw and effective manifest." : "Scene is unchanged."}</p>
      </div>
    `;
  }

  private _renderDiffCard(title: string, rawCount: number, effectiveCount: number, hiddenItems: Array<{ id: string; reason: string }>): TemplateResult {
    const formatReason = (reason: string): string => {
      switch (reason) {
        case "namespace_disabled": return "disabled by namespace";
        case "builtin_tool_disabled": return "disabled by built-in tool filter";
        case "page_tool_disabled": return "disabled by page tool filter";
        case "scene_filtered": return "filtered by scene";
        default: return "unknown reason";
      }
    };
    return html`
      <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
        <h4 class="text-xs font-bold mb-1">${title}</h4>
        <p class="text-xs opacity-70">Raw: ${rawCount} · Effective: ${effectiveCount}</p>
        ${hiddenItems.length > 0
          ? html`<ul class="mt-1.5 pl-4 text-xs opacity-70 list-disc">${hiddenItems.map((item) => html`<li class="break-words"><strong>${item.id}</strong> · ${formatReason(item.reason)}</li>`)}</ul>`
          : html`<p class="text-xs opacity-50 mt-1">No hidden items.</p>`}
      </div>
    `;
  }

  private _renderTrimmedToolsCard(debug: ContextManifestFilterDebug | null): TemplateResult {
    const trimmed = debug?.trimmedSkillTools ?? [];
    const formatReason = (reason: string): string => {
      switch (reason) {
        case "namespace_disabled": return "disabled by namespace";
        case "builtin_tool_disabled": return "disabled by built-in tool filter";
        case "page_tool_disabled": return "disabled by page tool filter";
        case "scene_filtered": return "filtered by scene";
        default: return "unknown reason";
      }
    };
    return html`
      <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
        <h4 class="text-xs font-bold mb-1">Skill Tool Trimming</h4>
        ${trimmed.length > 0
          ? html`<ul class="mt-1.5 pl-4 text-xs opacity-70 list-disc">${trimmed.flatMap((entry) => entry.removedTools.map((item) => html`<li class="break-words"><strong>${entry.skillId}</strong> · ${item.id} · ${formatReason(item.reason)}</li>`))}</ul>`
          : html`<p class="text-xs opacity-50 mt-1">No skill tool recommendations were trimmed.</p>`}
      </div>
    `;
  }

  private async _loadContextResource(resourceId: string): Promise<void> {
    if (!this._currentTabId) return;

    this._resourceStatus = `Reading ${resourceId}...`;
    this._resourceStatusClass = "text-xs font-semibold opacity-60";
    this.requestUpdate();

    try {
      const resource = await sendRuntimeRequest<ContextResourcePayload>(BRIDGE_METHODS.extensionContextResourceRead, { tabId: this._currentTabId, resourceId });
      this._resourceStatus = `Loaded ${resourceId}`;
      this._resourceStatusClass = "text-xs font-semibold text-success";
      this._resourceOutput = resource.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._resourceStatus = message;
      this._resourceStatusClass = "text-xs font-semibold text-error";
      this._resourceOutput = formatJson({ error: message });
    }
  }

  private async _loadContextSkillPrompt(skillId: string): Promise<void> {
    if (!this._currentTabId) return;

    this._skillStatus = `Rendering ${skillId}...`;
    this._skillStatusClass = "text-xs font-semibold opacity-60";
    this.requestUpdate();

    try {
      const response = await sendRuntimeRequest<ContextSkillResponse>(BRIDGE_METHODS.extensionContextSkillGet, {
        tabId: this._currentTabId,
        skillId,
        input: { goal: "Explain how the agent should use this business skill safely." },
      });
      this._skillStatus = response.prompt ? `Loaded ${skillId}` : `Skill ${skillId} unavailable`;
      this._skillStatusClass = `text-xs font-semibold ${response.prompt ? "text-success" : "text-error"}`;
      this._skillOutput = response.prompt ? formatJson(response.prompt) : formatJson({ error: "Prompt unavailable" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._skillStatus = message;
      this._skillStatusClass = "text-xs font-semibold text-error";
      this._skillOutput = formatJson({ error: message });
    }
  }

  // ─── Tool Test Panel ───────────────────────────────────────────
  private _openToolTestPanel(selection: ToolTestSelection): void {
    this._currentToolTestSelection = selection;
    this._toolTestTitle = `Tool Test · ${selection.label}`;
    this._toolTestSubtitle = selection.root === "builtin"
      ? `Built-in tool: ${selection.toolName}`
      : `Context tool: ${selection.toolName}${selection.tabId != null ? ` · tab ${selection.tabId}` : ""}`;
    this._toolTestTabIdValue = selection.tabId != null ? String(selection.tabId) : "";
    this._toolTestTabIdDisabled = selection.root === "page" && selection.tabId != null;
    this._toolTestSchemaOutput = formatJson(selection.inputSchema ?? {});
    this._toolTestArgs = createArgsTemplate(selection.inputSchema);
    this._toolTestOutput = "(no output yet)";
    this._toolTestStatusText = "Ready";
    this._toolTestStatusClass = "text-xs font-semibold opacity-60";
    this.requestUpdate();
  }

  private _closeToolTestPanel(): void {
    this._currentToolTestSelection = null;
    this.requestUpdate();
  }

  private async _runToolDebugCall(): Promise<void> {
    if (!this._currentToolTestSelection) return;

    let parsedArgs: Record<string, unknown>;
    try {
      const raw = this._toolTestArgs.trim() || "{}";
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("RPC args must be a JSON object");
      }
      parsedArgs = parsed as Record<string, unknown>;
    } catch (error) {
      this._toolTestStatusText = error instanceof Error ? error.message : String(error);
      this._toolTestStatusClass = "text-xs font-semibold text-error";
      this._toolTestOutput = "(invalid JSON args)";
      return;
    }

    this._toolTestRunning = true;
    this._toolTestStatusText = "Running...";
    this._toolTestStatusClass = "text-xs font-semibold opacity-60";
    this.requestUpdate();

    try {
      const tabId = this._toolTestTabIdValue ? Number(this._toolTestTabIdValue) : undefined;
      const response = await sendRuntimeRequest<ToolDebugResponse>(BRIDGE_METHODS.extensionToolDebugCall, {
        toolName: this._currentToolTestSelection.toolName,
        tabId,
        args: parsedArgs,
      });

      this._toolTestStatusText = response.ok ? "Success" : "Failed";
      this._toolTestStatusClass = `text-xs font-semibold ${response.ok ? "text-success" : "text-error"}`;
      this._toolTestOutput = formatJson(response.ok ? response.result ?? {} : { error: response.error ?? "Unknown error" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._toolTestStatusText = message;
      this._toolTestStatusClass = "text-xs font-semibold text-error";
      this._toolTestOutput = formatJson({ error: message });
    } finally {
      this._toolTestRunning = false;
    }
  }

  private _resetToolTestArgs(): void {
    this._toolTestArgs = createArgsTemplate(this._currentToolTestSelection?.inputSchema);
    this._toolTestOutput = "(no output yet)";
    this._toolTestStatusText = "Ready";
    this._toolTestStatusClass = "text-xs font-semibold opacity-60";
  }

  // ─── Navigation / Iframe ───────────────────────────────────────
  private _navigateTo(url: string): void {
    const normalized = /^https?:\/\//.test(url) ? url : `http://${url}`;
    this._currentUrl = normalized;
    this._urlBarVisible = true;
  }

  private _manageIframe(): void {
    const container = this._iframeContainer ?? this.shadowRoot?.querySelector<HTMLElement>("#iframeContainer");
    if (!container) {
      console.warn("[side-panel] _manageIframe: #iframeContainer not found in shadow DOM");
      return;
    }

    // Clean up previous
    window.removeEventListener("message", this._boundMessageHandler);
    this._currentIframe?.remove();
    this._currentIframe = null;

    // Load extension's built-in loader page — it probes target and shows UI internally
    const loaderUrl = chrome.runtime.getURL("loader.html") + "#" + this._currentUrl;

    this._currentIframe = document.createElement("iframe");
    this._currentIframe.src = loaderUrl;
    this._currentIframe.allow = "clipboard-read; clipboard-write";
    this._urlBarVisible = false;

    window.addEventListener("message", this._boundMessageHandler);
    container.appendChild(this._currentIframe);
  }

  /** Handler for messages from the loader iframe */
  private _boundMessageHandler = (e: MessageEvent): void => {
    if (!e.data?.type) return;

    switch (e.data.type) {
      case "sidepanel-action":
        if (e.data.action === "open-opencode") {
          void chrome.tabs.create({ url: "opencode://v1/web?port=22338" });
        }
        break;
      // sidepanel-probe messages are informational — loader handles its own UI
    }
  };

  // ─── Event Handlers ────────────────────────────────────────────
  private _handleTabClick(tab: "tools" | "context" | "diagnosis"): void {
    console.log("[side-panel] _handleTabClick called with:", tab, "current _activeTab:", this._activeTab);
    this._activeTab = tab;
    console.log("[side-panel] _activeTab set to:", this._activeTab, "about to requestUpdate");
    this.requestUpdate();
    console.log("[side-panel] requestUpdate done");
    if (tab === "tools") {
      void this._loadPageTools();
    } else if (tab === "context") {
      void this._loadContextManifest();
    }
  }

  private _handleGoClick(): void {
    const input = this.shadowRoot!.querySelector<HTMLInputElement>("#urlInput");
    if (input) {
      this._navigateTo(input.value.trim());
      this.updateComplete.then(() => this._manageIframe());
    }
  }

  private _handleUrlKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      const input = event.target as HTMLInputElement;
      this._navigateTo(input.value.trim());
      this.updateComplete.then(() => this._manageIframe());
    }
  }

  private async _handleReconnect(): Promise<void> {
    this._refreshing = true;
    await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect);
    setTimeout(() => { this._refreshing = false; void this._refreshStatus(); }, 800);
  }

  private _handleOpenTab(): void {
    const input = this.shadowRoot!.querySelector<HTMLInputElement>("#urlInput");
    const url = input?.value.trim();
    if (url) {
      void chrome.tabs.create({ url });
    }
  }

  private _handleToolsFilterInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this._currentFilter = input.value.trim().toLowerCase();
  }

  private _handleToolsPanelChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;

    const { scope, tabId, namespace, instanceId, toolName } = target.dataset;
    if (!scope || !tabId) return;

    void this._updateScopeEnabled({
      root: scope === "builtin" ? "builtin" : "page",
      tabId: scope === "builtin" ? undefined : Number(tabId),
      namespace,
      instanceId,
      toolName,
      enabled: target.checked,
    });
  }

  private _handleToolsPanelClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.dataset.action !== "test-tool") return;

    this._openToolTestPanel({
      root: (target.dataset.root as "builtin" | "page") ?? "page",
      toolName: target.dataset.toolName ?? "",
      label: target.dataset.label ?? target.dataset.toolName ?? "Tool",
      tabId: target.dataset.tabId ? Number(target.dataset.tabId) : undefined,
      inputSchema: target.dataset.schema ? safeParseJson(target.dataset.schema) : {},
    });
  }

  private _handleContextResourceClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.dataset.action !== "read-resource") return;
    const resourceId = target.dataset.resourceId;
    if (resourceId) {
      void this._loadContextResource(resourceId);
    }
  }

  private _handleContextSkillClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.dataset.action !== "preview-skill") return;
    const skillId = target.dataset.skillId;
    if (skillId) {
      void this._loadContextSkillPrompt(skillId);
    }
  }

  private _handleToolTestArgsInput(event: Event): void {
    const input = event.target as HTMLTextAreaElement;
    this._toolTestArgs = input.value;
  }

  private _handleToolTestTabIdInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this._toolTestTabIdValue = input.value;
  }

  // ─── Render Tools Tree Content ─────────────────────────────────
  private _renderToolsTreeContent(): TemplateResult {
    if (!this._toolTreeResponse) {
      return renderToolsEmpty("No tools loaded.");
    }

    const filteredTabs = this._toolTreeResponse.tabs
      .map((tab) => filterTab(tab, this._currentFilter))
      .filter((tab): tab is ToolTreeResponse["tabs"][number] => tab !== null);

    if (filteredTabs.length === 0) {
      const builtinTools = filterBuiltins(this._toolTreeResponse.builtins, this._currentFilter);
      if (builtinTools.totalTools === 0) {
        return renderToolsEmpty(this._currentFilter ? `No tools match '${this._currentFilter}'.` : "No tools discovered yet.");
      }
      return renderBuiltinsNode(builtinTools);
    }

    const builtinTools = filterBuiltins(this._toolTreeResponse.builtins, this._currentFilter);
    return html`
      ${builtinTools.totalTools > 0 ? renderBuiltinsNode(builtinTools) : nothing}
      ${filteredTabs.map((tab) => renderTabNode(tab))}
    `;
  }

  // ─── Main Render ───────────────────────────────────────────────
  override render() {
    console.log("[side-panel] render() called, _activeTab =", this._activeTab);
    const toolsCount = this._toolTreeResponse
      ? `(${this._toolTreeResponse.enabledTools}/${this._toolTreeResponse.totalTools} enabled)`
      : "";

    return html`
      <!-- Header: status-dot (clickable refresh) / title / icon-nav (right) -->
      <div class="flex items-center gap-2 px-3 py-1.5 bg-base-100 border-b border-base-300 shrink-0">
        <button class="w-4 h-4 rounded-full shrink-0 flex items-center justify-center ${this._refreshing ? "bg-base-300" : (this._connected ? "bg-success" : "bg-error")} hover:opacity-80 transition-all duration-200 cursor-pointer border-none p-0 overflow-hidden" @click=${this._handleReconnect} title="${this._refreshing ? "Refreshing..." : "Click to refresh"}">
          <svg class="w-3 h-3 text-white transition-opacity duration-200 ${this._refreshing ? "animate-spin opacity-100" : "opacity-0"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            <polyline points="21 3 21 9 15 9"/>
          </svg>
        </button>
        <span class="font-semibold text-sm truncate">Page Context Bridge</span>
        <div role="tablist" class="tabs tabs-boxed ml-auto bg-transparent border-none gap-0.5">
          <button role="tab" class="tab tab-xs px-2 ${classMap({ "tab-active": this._activeTab === "tools" })}" @click=${() => this._handleTabClick("tools")} title="Tools">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
          </button>
          <button role="tab" class="tab tab-xs px-2 ${classMap({ "tab-active": this._activeTab === "context" })}" @click=${() => this._handleTabClick("context")} title="Context">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          </button>
          <button role="tab" class="tab tab-xs px-2 ${classMap({ "tab-active": this._activeTab === "diagnosis" })}" @click=${() => this._handleTabClick("diagnosis")} title="Diagnosis">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </button>
        </div>
      </div>

      <!-- Tools Tab -->
      <div class="tab-content ${classMap({ active: this._activeTab === "tools" })} flex flex-col flex-1 min-h-0">
        <div class="flex items-center gap-2 px-3 py-2 bg-base-100 border-b border-base-300 sticky top-0 z-10">
          <span class="text-xs font-bold uppercase tracking-wide opacity-60">Context Tools</span>
          <span class="text-xs opacity-50">${toolsCount}</span>
          <button class="btn btn-xs btn-ghost ml-auto" @click=${() => this._loadPageTools(true)}>Refresh</button>
        </div>
        <div class="px-3 py-1.5 border-b border-base-300 bg-base-200 sticky top-[2.75rem] z-20">
          <input type="search" .value=${this._currentFilter} @input=${this._handleToolsFilterInput} placeholder="Filter by tab / namespace / instance / tool" class="input input-sm input-bordered w-full" />
        </div>
        <div class="flex-1 overflow-y-auto" id="toolsPanel" @change=${this._handleToolsPanelChange} @click=${this._handleToolsPanelClick}>
          ${this._renderToolsTreeContent()}
        </div>

        <!-- Tool Test Panel -->
        ${when(this._currentToolTestSelection, () => html`
          <div class="test-panel open border-t border-base-300 bg-base-100 p-3 flex-col gap-2 shrink-0 max-h-[48%] overflow-auto">
            <div class="flex items-center justify-between gap-2">
              <div>
                <div class="text-sm font-bold">${this._toolTestTitle}</div>
                <div class="text-xs opacity-60 break-all">${this._toolTestSubtitle}</div>
              </div>
              <button class="btn btn-xs btn-ghost" @click=${this._closeToolTestPanel}>Close</button>
            </div>
            <div class="flex flex-col gap-1">
              <label class="label text-xs font-semibold" for="toolTestTabIdInput">Tab ID</label>
              <input id="toolTestTabIdInput" type="number" .value=${this._toolTestTabIdValue} .disabled=${this._toolTestTabIdDisabled} @input=${this._handleToolTestTabIdInput} placeholder="Optional for built-in tools" class="input input-sm input-bordered" />
            </div>
            <div class="flex flex-col gap-1">
              <label class="label text-xs font-semibold" for="toolTestSchemaOutput">Input Schema</label>
              <pre class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words min-h-[3rem]">${this._toolTestSchemaOutput}</pre>
            </div>
            <div class="flex flex-col gap-1">
              <label class="label text-xs font-semibold" for="toolTestArgsInput">RPC Args (JSON)</label>
              <textarea id="toolTestArgsInput" class="textarea textarea-sm textarea-bordered font-mono min-h-[5.5rem]" .value=${this._toolTestArgs} @input=${this._handleToolTestArgsInput}></textarea>
            </div>
            <div class="flex gap-2 justify-end">
              <button class="btn btn-xs btn-ghost" @click=${this._resetToolTestArgs}>Reset Args</button>
              <button class="btn btn-xs btn-primary" .disabled=${this._toolTestRunning} @click=${() => this._runToolDebugCall()}>Run RPC Call</button>
            </div>
            <div class="text-xs font-semibold ${this._toolTestStatusClass}">${this._toolTestStatusText}</div>
            <div class="flex flex-col gap-1">
              <label class="label text-xs font-semibold" for="toolTestOutput">Output</label>
              <pre class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words min-h-[3rem]">${this._toolTestOutput}</pre>
            </div>
          </div>
        `)}
      </div>

      <!-- Context Tab -->
      <div class="tab-content ${classMap({ active: this._activeTab === "context" })} flex flex-col flex-1 min-h-0">
        <div class="flex items-center gap-2 px-3 py-2 bg-base-100 border-b border-base-300 shrink-0">
          <span class="text-xs font-bold uppercase tracking-wide opacity-60">Capability Context</span>
          <button class="btn btn-xs btn-ghost ml-auto" @click=${() => this._loadContextManifest()}>Refresh</button>
        </div>
        <div class="grid grid-cols-[minmax(240px,320px)_1fr] flex-1 min-h-0">
          <!-- Sidebar -->
          <div class="border-r border-base-300 bg-base-100 overflow-auto">
            <div class="border-b border-base-200 p-3">
              <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-2">Manifest Summary</div>
              <div class="grid grid-cols-2 gap-2">
                <div class="stat bg-base-200 rounded-lg p-2">
                  <div class="stat-title text-[10px]">App</div>
                  <div class="stat-value text-sm font-bold">${this._contextAppValue}</div>
                </div>
                <div class="stat bg-base-200 rounded-lg p-2">
                  <div class="stat-title text-[10px]">Scene</div>
                  <div class="stat-value text-sm font-bold">${this._contextSceneValue}</div>
                </div>
                <div class="stat bg-base-200 rounded-lg p-2">
                  <div class="stat-title text-[10px]">Tab</div>
                  <div class="stat-value text-sm font-bold">${this._contextTabValue}</div>
                </div>
                <div class="stat bg-base-200 rounded-lg p-2">
                  <div class="stat-title text-[10px]">Route</div>
                  <div class="stat-value text-sm font-bold">${this._contextRouteValue}</div>
                </div>
              </div>
            </div>
            <div class="border-b border-base-200 p-3">
              <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-2">Resources</div>
              <div id="contextResourcesList" @click=${this._handleContextResourceClick}>
                ${this._contextResourcesListHtml}
              </div>
            </div>
            <div class="p-3">
              <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-2">Skills</div>
              <div id="contextSkillsList" @click=${this._handleContextSkillClick}>
                ${this._contextSkillsListHtml}
              </div>
            </div>
          </div>
          <!-- Main -->
          <div class="bg-base-200 overflow-auto p-3 flex flex-col gap-3">
            <div class="card bg-base-100 border border-base-300 shadow-sm">
              <div class="card-body p-3 gap-1">
                <div class="flex items-center justify-between">
                  <span class="font-bold text-sm">Manifest</span>
                  <span class="text-xs font-semibold ${this._manifestStatusClass}">${this._manifestStatus}</span>
                </div>
                <pre class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto">${this._manifestOutput}</pre>
              </div>
            </div>
            <div class="card bg-base-100 border border-base-300 shadow-sm">
              <div class="card-body p-3 gap-1">
                <div class="flex items-center justify-between">
                  <span class="font-bold text-sm">Namespace / Scene Diff</span>
                  <span class="text-xs font-semibold ${this._diffStatusClass}">${this._diffStatus}</span>
                </div>
                <div id="contextDiffOutput" class="flex flex-col gap-2">
                  ${this._diffOutput}
                </div>
              </div>
            </div>
            <div class="card bg-base-100 border border-base-300 shadow-sm">
              <div class="card-body p-3 gap-1">
                <div class="flex items-center justify-between">
                  <span class="font-bold text-sm">Selected Resource</span>
                  <span class="text-xs font-semibold ${this._resourceStatusClass}">${this._resourceStatus}</span>
                </div>
                <pre class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto">${this._resourceOutput}</pre>
              </div>
            </div>
            <div class="card bg-base-100 border border-base-300 shadow-sm">
              <div class="card-body p-3 gap-1">
                <div class="flex items-center justify-between">
                  <span class="font-bold text-sm">Selected Skill Prompt</span>
                  <span class="text-xs font-semibold ${this._skillStatusClass}">${this._skillStatus}</span>
                </div>
                <pre class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto">${this._skillOutput}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Diagnosis Tab -->
      <div class="tab-content ${classMap({ active: this._activeTab === "diagnosis" })} flex flex-col flex-1 min-h-0">
        ${when(this._urlBarVisible, () => html`
          <div class="flex items-center gap-1.5 px-3 py-1.5 bg-base-100 border-b border-base-300 shrink-0">
            <input type="text" id="urlInput" .value=${this._currentUrl} @keydown=${this._handleUrlKeydown} placeholder="Enter URL to embed..." class="input input-sm input-bordered flex-1 font-mono" />
            <button class="btn btn-sm btn-primary" @click=${this._handleGoClick}>Go</button>
          </div>
        `)}
        <div class="iframe-container flex-1 relative bg-base-100" id="iframeContainer">
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "side-panel-app": SidePanelApp;
  }
}
