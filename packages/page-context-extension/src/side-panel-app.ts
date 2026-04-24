import {
  BRIDGE_METHODS,
  type ContextResourcePayload,
  type FeedbackAnnotation,
  type FeedbackPushAgentStatus,
  type FeedbackAnnotationClaimParams,
  type FeedbackAnnotationDismissParams,
  type FeedbackAnnotationReplyParams,
  type FeedbackAnnotationResolveParams,
  type FeedbackAnnotationStatus,
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
import type {
  ContextManifestResponse,
  ContextSkillResponse,
  FeedbackCreateInput,
  FeedbackSnapshotResponse,
  RuntimeStatus,
  ToolDebugResponse,
  ToolTestSelection,
  ToolTreeResponse,
} from "./sidepanel-types";

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

type FeedbackActionFormMode = "reply" | "resolve" | "dismiss" | null;
type FeedbackActionInputField = "replyBody" | "resolveNote" | "dismissReason";

// Sidepanel only maintains interaction state; business truth still comes from bridge snapshot.
interface FeedbackAnnotationActionState {
  mode: FeedbackActionFormMode;
  replyBody: string;
  resolveNote: string;
  dismissReason: string;
  submitting: boolean;
  error: string;
  success: string;
}

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
  @state() private _activeTab: "tools" | "context" | "feedback" | "diagnosis" = "tools";
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
  @state() private _feedbackBody = "";
  @state() private _feedbackPriority: FeedbackCreateInput["priority"] = "normal";
  @state() private _feedbackCreateStatus = "Idle";
  @state() private _feedbackCreateStatusClass = "text-xs font-semibold opacity-60";
  @state() private _feedbackSnapshot: FeedbackSnapshotResponse | null = null;
  @state() private _feedbackLoading = false;
  @state() private _feedbackError = "";
  @state() private _feedbackActionStateByAnnotationId: Record<string, FeedbackAnnotationActionState> = {};

  // ─── Query references (shadowRoot is guaranteed when using default createRenderRoot) ──
  @query("#iframeContainer") private _iframeContainer!: HTMLElement;

  // ─── Private state (non-reactive) ─────────────────────────────
  private _currentIframe: HTMLIFrameElement | null = null;
  private _statusIntervalId: ReturnType<typeof setInterval> | null = null;
  private _feedbackPollIntervalId: ReturnType<typeof setInterval> | null = null;
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
    if (this._feedbackPollIntervalId) {
      clearInterval(this._feedbackPollIntervalId);
      this._feedbackPollIntervalId = null;
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
    this._feedbackPollIntervalId = setInterval(() => {
      if (this._activeTab === "feedback") {
        void this._loadFeedbackSnapshot();
      }
    }, 10_000);
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
      if (this._activeTab === "feedback") {
        void this._loadFeedbackSnapshot();
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
          if (this._activeTab === "feedback") {
            void this._loadFeedbackSnapshot();
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

  // ─── Feedback ────────────────────────────────────────────────
  private async _loadFeedbackSnapshot(): Promise<void> {
    this._feedbackLoading = true;
    this._feedbackError = "";
    this.requestUpdate();

    try {
      this._feedbackSnapshot = await sendRuntimeRequest<FeedbackSnapshotResponse>(BRIDGE_METHODS.extensionFeedbackStateSnapshot);
      this._reconcileFeedbackActionStates(this._feedbackSnapshot.annotations);
      this._feedbackCreateStatus = "Snapshot loaded";
      this._feedbackCreateStatusClass = "text-xs font-semibold opacity-60";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._feedbackError = message;
      this._feedbackSnapshot = null;
    } finally {
      this._feedbackLoading = false;
    }
  }

  private async _submitFeedback(): Promise<void> {
    const body = this._feedbackBody.trim();
    if (!body) {
      this._feedbackCreateStatus = "Please enter feedback content";
      this._feedbackCreateStatusClass = "text-xs font-semibold text-error";
      return;
    }

    this._feedbackCreateStatus = "Submitting...";
    this._feedbackCreateStatusClass = "text-xs font-semibold opacity-60";
    this.requestUpdate();

    try {
      await sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationCreate, {
        body,
        priority: this._feedbackPriority,
      } satisfies FeedbackCreateInput);
      this._feedbackBody = "";
      this._feedbackCreateStatus = "Created";
      this._feedbackCreateStatusClass = "text-xs font-semibold text-success";
      await this._loadFeedbackSnapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._feedbackCreateStatus = message;
      this._feedbackCreateStatusClass = "text-xs font-semibold text-error";
    }
  }

  private _feedbackStatusBadgeClass(status: string): string {
    switch (status) {
      case "resolved":
        return "badge badge-success badge-sm";
      case "claimed":
        return "badge badge-info badge-sm";
      case "dismissed":
        return "badge badge-ghost badge-sm";
      default:
        return "badge badge-warning badge-sm";
    }
  }

  private _feedbackPushAgentBadgeClass(status: FeedbackPushAgentStatus | null): string {
    if (!status) {
      return "badge badge-ghost badge-sm";
    }
    if (!status.enabled) {
      return "badge badge-ghost badge-sm";
    }
    const lastResult = status.lastLaunch?.result;
    if (lastResult === "failed") {
      return "badge badge-error badge-sm";
    }
    if (lastResult === "success") {
      return "badge badge-success badge-sm";
    }
    return "badge badge-info badge-sm";
  }

  private _feedbackPushAgentBadgeText(status: FeedbackPushAgentStatus | null): string {
    if (!status) {
      return "unknown";
    }
    if (!status.enabled) {
      return "disabled";
    }
    const lastResult = status.lastLaunch?.result;
    if (lastResult === "failed") {
      return "last launch failed";
    }
    if (lastResult === "success") {
      return "last launch ok";
    }
    return "ready";
  }

  private _createFeedbackActionState(): FeedbackAnnotationActionState {
    return {
      mode: null,
      replyBody: "",
      resolveNote: "",
      dismissReason: "",
      submitting: false,
      error: "",
      success: "",
    };
  }

  private _reconcileFeedbackActionStates(annotations: FeedbackAnnotation[]): void {
    // Only keep annotation states from current snapshot to avoid retaining invalid local states after polling.
    const next: Record<string, FeedbackAnnotationActionState> = {};
    for (const annotation of annotations) {
      next[annotation.id] = this._feedbackActionStateByAnnotationId[annotation.id] ?? this._createFeedbackActionState();
    }
    this._feedbackActionStateByAnnotationId = next;
  }

  private _readFeedbackActionState(annotationId: string): FeedbackAnnotationActionState {
    return this._feedbackActionStateByAnnotationId[annotationId] ?? this._createFeedbackActionState();
  }

  private _updateFeedbackActionState(
    annotationId: string,
    updater: (current: FeedbackAnnotationActionState) => FeedbackAnnotationActionState,
  ): void {
    const current = this._readFeedbackActionState(annotationId);
    this._feedbackActionStateByAnnotationId = {
      ...this._feedbackActionStateByAnnotationId,
      [annotationId]: updater(current),
    };
  }

  private _setFeedbackActionMode(annotationId: string, mode: FeedbackActionFormMode): void {
    this._updateFeedbackActionState(annotationId, (current) => ({
      ...current,
      mode: current.mode === mode ? null : mode,
      error: "",
      success: "",
    }));
  }

  private _handleFeedbackActionInput(annotationId: string, field: FeedbackActionInputField, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this._updateFeedbackActionState(annotationId, (current) => ({
      ...current,
      [field]: value,
      error: "",
      success: "",
    }));
  }

  private async _runFeedbackMutation(
    annotationId: string,
    request: () => Promise<unknown>,
    successMessage: string,
    onSuccess: (state: FeedbackAnnotationActionState) => FeedbackAnnotationActionState,
  ): Promise<void> {
    // Unified mutation flow: first update local submission state, then make RPC call, force reload snapshot after success.
    this._updateFeedbackActionState(annotationId, (current) => ({
      ...current,
      submitting: true,
      error: "",
      success: "",
    }));

    try {
      await request();
      this._updateFeedbackActionState(annotationId, (current) => ({
        ...onSuccess(current),
        submitting: false,
        error: "",
        success: successMessage,
      }));
      await this._loadFeedbackSnapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._updateFeedbackActionState(annotationId, (current) => ({
        ...current,
        submitting: false,
        error: message,
      }));
    }
  }

  private async _claimFeedbackAnnotation(annotationId: string): Promise<void> {
    await this._runFeedbackMutation(
      annotationId,
      () => sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationClaim, {
        annotationId,
      } satisfies FeedbackAnnotationClaimParams),
      "Claimed",
      (state) => ({ ...state, mode: null }),
    );
  }

  private async _replyFeedbackAnnotation(annotationId: string): Promise<void> {
    const state = this._readFeedbackActionState(annotationId);
    const body = state.replyBody.trim();
    if (!body) {
      this._updateFeedbackActionState(annotationId, (current) => ({
        ...current,
        error: "Reply content cannot be empty",
      }));
      return;
    }

    await this._runFeedbackMutation(
      annotationId,
      () => sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationReply, {
        annotationId,
        body,
      } satisfies FeedbackAnnotationReplyParams),
      "Reply submitted",
      (current) => ({ ...current, mode: null, replyBody: "" }),
    );
  }

  private async _resolveFeedbackAnnotation(annotationId: string): Promise<void> {
    const state = this._readFeedbackActionState(annotationId);
    await this._runFeedbackMutation(
      annotationId,
      () => sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationResolve, {
        annotationId,
        resolution: state.resolveNote.trim() || undefined,
      } satisfies FeedbackAnnotationResolveParams),
      "Marked as resolved",
      (current) => ({ ...current, mode: null, resolveNote: "" }),
    );
  }

  private async _dismissFeedbackAnnotation(annotationId: string): Promise<void> {
    const state = this._readFeedbackActionState(annotationId);
    await this._runFeedbackMutation(
      annotationId,
      () => sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationDismiss, {
        annotationId,
        dismissReason: state.dismissReason.trim() || undefined,
      } satisfies FeedbackAnnotationDismissParams),
      "Dismissed",
      (current) => ({ ...current, mode: null, dismissReason: "" }),
    );
  }

  private _canClaimAnnotation(status: FeedbackAnnotationStatus): boolean {
    // Keep consistent with bridge-side state machine to avoid frontend initiating inevitably failed transitions.
    return status === "open" || status === "needs_info";
  }

  private _canReplyAnnotation(status: FeedbackAnnotationStatus): boolean {
    return status !== "resolved" && status !== "dismissed";
  }

  private _canResolveAnnotation(status: FeedbackAnnotationStatus): boolean {
    return status === "claimed" || status === "in_progress" || status === "needs_info";
  }

  private _canDismissAnnotation(status: FeedbackAnnotationStatus): boolean {
    return status !== "resolved" && status !== "dismissed";
  }

  private _formatFeedbackTime(timestamp: string): string {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString("en-US", { hour12: false });
  }

  private _renderFeedbackThread(annotation: FeedbackAnnotation): TemplateResult {
    // Thread details directly show actor/kind/time, facilitating basic collaborative communication within sidepanel.
    if (annotation.thread.length === 0) {
      return html`<div class="text-xs opacity-50">No thread messages</div>`;
    }

    return html`
      <div class="flex flex-col gap-1">
        ${annotation.thread.map((message) => html`
          <div class="border border-base-300 rounded-md p-2 bg-base-200/60 flex flex-col gap-1">
            <div class="flex items-center gap-1 text-[11px] opacity-70">
              <span class="font-semibold">${message.author.displayName}</span>
              <span class="badge badge-ghost badge-xs">${message.author.source}</span>
              <span class="badge badge-outline badge-xs">${message.kind}</span>
              <span class="ml-auto">${this._formatFeedbackTime(message.createdAt)}</span>
            </div>
            <div class="text-xs whitespace-pre-wrap break-words">${message.body}</div>
          </div>
        `)}
      </div>
    `;
  }

  private _renderFeedbackActionForm(annotation: FeedbackAnnotation, state: FeedbackAnnotationActionState): TemplateResult {
    // Inline forms are only responsible for collecting input; actual state changes are determined by snapshot refresh after successful RPC.
    if (state.mode === "reply") {
      return html`
        <div class="border border-base-300 rounded-md p-2 bg-base-200/50 flex flex-col gap-2">
          <textarea
            class="textarea textarea-sm textarea-bordered min-h-[4.5rem]"
            placeholder="Add processing progress or follow-up questions"
            .value=${state.replyBody}
            @input=${(event: Event) => this._handleFeedbackActionInput(annotation.id, "replyBody", event)}
          ></textarea>
          <div class="flex items-center gap-2">
            <button class="btn btn-xs btn-ghost" .disabled=${state.submitting} @click=${() => this._setFeedbackActionMode(annotation.id, null)}>Cancel</button>
            <button class="btn btn-xs btn-primary ml-auto" .disabled=${state.submitting} @click=${() => this._replyFeedbackAnnotation(annotation.id)}>
              ${state.submitting ? "Submitting..." : "Submit Reply"}
            </button>
          </div>
        </div>
      `;
    }

    if (state.mode === "resolve") {
      return html`
        <div class="border border-base-300 rounded-md p-2 bg-base-200/50 flex flex-col gap-2">
          <textarea
            class="textarea textarea-sm textarea-bordered min-h-[4.5rem]"
            placeholder="Optional: fill in resolution notes"
            .value=${state.resolveNote}
            @input=${(event: Event) => this._handleFeedbackActionInput(annotation.id, "resolveNote", event)}
          ></textarea>
          <div class="flex items-center gap-2">
            <button class="btn btn-xs btn-ghost" .disabled=${state.submitting} @click=${() => this._setFeedbackActionMode(annotation.id, null)}>Cancel</button>
            <button class="btn btn-xs btn-success ml-auto" .disabled=${state.submitting} @click=${() => this._resolveFeedbackAnnotation(annotation.id)}>
              ${state.submitting ? "Submitting..." : "Confirm Resolve"}
            </button>
          </div>
        </div>
      `;
    }

    if (state.mode === "dismiss") {
      return html`
        <div class="border border-base-300 rounded-md p-2 bg-base-200/50 flex flex-col gap-2">
          <input
            class="input input-sm input-bordered"
            placeholder="Optional: fill in dismiss reason"
            .value=${state.dismissReason}
            @input=${(event: Event) => this._handleFeedbackActionInput(annotation.id, "dismissReason", event)}
          />
          <div class="flex items-center gap-2">
            <button class="btn btn-xs btn-ghost" .disabled=${state.submitting} @click=${() => this._setFeedbackActionMode(annotation.id, null)}>Cancel</button>
            <button class="btn btn-xs btn-warning ml-auto" .disabled=${state.submitting} @click=${() => this._dismissFeedbackAnnotation(annotation.id)}>
              ${state.submitting ? "Submitting..." : "Confirm Dismiss"}
            </button>
          </div>
        </div>
      `;
    }

    return html``;
  }

  private _renderFeedbackActions(annotation: FeedbackAnnotation): TemplateResult {
    const state = this._readFeedbackActionState(annotation.id);
    const canClaim = this._canClaimAnnotation(annotation.status);
    const canReply = this._canReplyAnnotation(annotation.status);
    const canResolve = this._canResolveAnnotation(annotation.status);
    const canDismiss = this._canDismissAnnotation(annotation.status);

    return html`
      <div class="flex flex-wrap items-center gap-1.5">
        ${canClaim
          ? html`<button class="btn btn-xs btn-info" .disabled=${state.submitting} @click=${() => this._claimFeedbackAnnotation(annotation.id)}>${state.submitting ? "Submitting..." : "Claim"}</button>`
          : nothing}
        ${canReply
          ? html`<button class="btn btn-xs btn-ghost" .disabled=${state.submitting} @click=${() => this._setFeedbackActionMode(annotation.id, "reply")}>Reply</button>`
          : nothing}
        ${canResolve
          ? html`<button class="btn btn-xs btn-success btn-outline" .disabled=${state.submitting} @click=${() => this._setFeedbackActionMode(annotation.id, "resolve")}>Resolve</button>`
          : nothing}
        ${canDismiss
          ? html`<button class="btn btn-xs btn-warning btn-outline" .disabled=${state.submitting} @click=${() => this._setFeedbackActionMode(annotation.id, "dismiss")}>Dismiss</button>`
          : nothing}
        ${(!canClaim && !canReply && !canResolve && !canDismiss)
          ? html`<span class="text-xs opacity-50">No actions available in current state</span>`
          : nothing}
      </div>
      ${state.error ? html`<div class="text-xs text-error">${state.error}</div>` : nothing}
      ${state.success ? html`<div class="text-xs text-success">${state.success}</div>` : nothing}
      ${this._renderFeedbackActionForm(annotation, state)}
    `;
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
  private _handleTabClick(tab: "tools" | "context" | "feedback" | "diagnosis"): void {
    console.log("[side-panel] _handleTabClick called with:", tab, "current _activeTab:", this._activeTab);
    this._activeTab = tab;
    console.log("[side-panel] _activeTab set to:", this._activeTab, "about to requestUpdate");
    this.requestUpdate();
    console.log("[side-panel] requestUpdate done");
    if (tab === "tools") {
      void this._loadPageTools();
    } else if (tab === "context") {
      void this._loadContextManifest();
    } else if (tab === "feedback") {
      void this._loadFeedbackSnapshot();
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

    const { root, scope, tabId, namespace, instanceId, toolName } = target.dataset;
    if (!scope || !tabId) return;
    // builtin 树节点（namespace/instance/tool）统一走 builtin root，避免复用页面 scope 时误写到 page 偏好树。
    const resolvedRoot: "builtin" | "page" = (root === "builtin" || scope === "builtin") ? "builtin" : "page";

    void this._updateScopeEnabled({
      root: resolvedRoot,
      tabId: resolvedRoot === "builtin" ? undefined : Number(tabId),
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

  private _handleFeedbackBodyInput(event: Event): void {
    const input = event.target as HTMLTextAreaElement;
    this._feedbackBody = input.value;
  }

  private _handleFeedbackPriorityChange(event: Event): void {
    const input = event.target as HTMLSelectElement;
    this._feedbackPriority = input.value as FeedbackCreateInput["priority"];
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
    const currentFeedbackSession = this._feedbackSnapshot?.sessions[0] ?? null;
    const feedbackAnnotations = this._feedbackSnapshot?.annotations ?? [];
    const feedbackPushAgentStatus = this._feedbackSnapshot?.pushAgent ?? null;

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
          <button role="tab" class="tab tab-xs px-2 ${classMap({ "tab-active": this._activeTab === "feedback" })}" @click=${() => this._handleTabClick("feedback")} title="Feedback">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
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

      <!-- Feedback Tab -->
      <div class="tab-content ${classMap({ active: this._activeTab === "feedback" })} flex flex-col flex-1 min-h-0">
        <div class="flex items-center gap-2 px-3 py-2 bg-base-100 border-b border-base-300 shrink-0">
          <span class="text-xs font-bold uppercase tracking-wide opacity-60">Feedback</span>
          <button class="btn btn-xs btn-ghost ml-auto" @click=${() => this._loadFeedbackSnapshot()}>Refresh</button>
        </div>
        <div class="flex-1 overflow-y-auto p-3 bg-base-200 flex flex-col gap-3">
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-2">
              <div class="flex items-center gap-2">
                <div class="font-bold text-sm">Auto Push Agent</div>
                <span class="${this._feedbackPushAgentBadgeClass(feedbackPushAgentStatus)} ml-auto">${this._feedbackPushAgentBadgeText(feedbackPushAgentStatus)}</span>
              </div>
              ${!feedbackPushAgentStatus
                ? html`<div class="text-xs opacity-60">Current snapshot does not contain push-agent status.</div>`
                : html`
                  <div class="text-xs opacity-70">
                    enabled: <span class="font-mono">${String(feedbackPushAgentStatus.enabled)}</span>
                    · readiness: <span class="font-mono">${feedbackPushAgentStatus.readiness}</span>
                    · mode: <span class="font-mono">${feedbackPushAgentStatus.mode}</span>
                  </div>
                  ${feedbackPushAgentStatus.lastLaunch
                    ? html`
                      <div class="text-xs opacity-70">
                        last launch: <span class="font-mono">${feedbackPushAgentStatus.lastLaunch.result}</span>
                        · at ${this._formatFeedbackTime(feedbackPushAgentStatus.lastLaunch.attemptedAt)}
                        · annotation ${feedbackPushAgentStatus.lastLaunch.annotationId}
                      </div>
                      ${feedbackPushAgentStatus.lastLaunch.failureReason
                        ? html`<div class="text-xs text-error">failure: ${feedbackPushAgentStatus.lastLaunch.failureReason}</div>`
                        : nothing}
                    `
                    : html`<div class="text-xs opacity-60">last launch: (no records yet)</div>`}
                `}
            </div>
          </div>

          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-2">
              <div class="font-bold text-sm">Create Feedback</div>
              <textarea
                class="textarea textarea-sm textarea-bordered min-h-[6rem]"
                placeholder="Describe the problem, expected behavior, reproduction steps"
                .value=${this._feedbackBody}
                @input=${this._handleFeedbackBodyInput}
              ></textarea>
              <div class="flex gap-2 items-center">
                <label class="text-xs opacity-70" for="feedbackPriority">Priority</label>
                <select
                  id="feedbackPriority"
                  class="select select-sm select-bordered w-36"
                  .value=${this._feedbackPriority}
                  @change=${this._handleFeedbackPriorityChange}
                >
                  <option value="low">low</option>
                  <option value="normal">normal</option>
                  <option value="high">high</option>
                  <option value="critical">critical</option>
                </select>
                <button class="btn btn-sm btn-primary ml-auto" @click=${() => this._submitFeedback()}>Submit</button>
              </div>
              <div class="text-xs opacity-70">
                ${currentFeedbackSession
                  ? html`Active Tab: #${currentFeedbackSession.tabId} · ${currentFeedbackSession.title || currentFeedbackSession.url}`
                  : html`Active Tab: (session not created)`}
              </div>
              ${feedbackAnnotations[0]?.target.textQuote
                ? html`<div class="text-xs opacity-70">Selected Text: ${feedbackAnnotations[0].target.textQuote}</div>`
                : nothing}
              <div class="${this._feedbackCreateStatusClass}">${this._feedbackCreateStatus}</div>
            </div>
          </div>

          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-2">
              <div class="flex items-center justify-between">
                <div class="font-bold text-sm">Current Session</div>
                <div class="text-xs opacity-60">
                  ${this._feedbackLoading ? "Loading..." : `${feedbackAnnotations.length} annotations`}
                </div>
              </div>
              ${this._feedbackError
                ? html`<div class="text-xs text-error">${this._feedbackError}</div>`
                : nothing}
              ${!currentFeedbackSession
                ? html`<div class="text-xs opacity-60">No feedback records for current page yet.</div>`
                : html`
                  <div class="text-xs opacity-70">
                    Session ${currentFeedbackSession.id} · seq ${currentFeedbackSession.lastEventSeq}
                  </div>
                  <div class="flex flex-col gap-2">
                    ${feedbackAnnotations.length === 0
                      ? html`<div class="text-xs opacity-60">No annotations yet.</div>`
                      : html`${feedbackAnnotations.map((annotation) => html`
                        <div class="border border-base-300 rounded-lg p-2 bg-base-100 flex flex-col gap-1.5">
                          <div class="flex items-center gap-2">
                            <span class="${this._feedbackStatusBadgeClass(annotation.status)}">${annotation.status}</span>
                            <span class="badge badge-outline badge-sm">${annotation.priority}</span>
                            <span class="text-[11px] opacity-50 ml-auto">${this._formatFeedbackTime(annotation.updatedAt)}</span>
                          </div>
                          <div class="text-sm whitespace-pre-wrap break-words">${annotation.body}</div>
                          <div class="text-xs opacity-70">
                            #${annotation.id} · by ${annotation.author.displayName} ·
                            created ${this._formatFeedbackTime(annotation.createdAt)}
                          </div>
                          ${annotation.target.textQuote
                            ? html`<div class="text-xs opacity-80">Quote: ${annotation.target.textQuote}</div>`
                            : nothing}
                          ${annotation.claimedBy || annotation.resolvedBy || annotation.resolution || annotation.dismissReason
                            ? html`
                              <div class="text-xs opacity-70 flex flex-wrap gap-2">
                                ${annotation.claimedBy ? html`<span>Claimed by: ${annotation.claimedBy.displayName}</span>` : nothing}
                                ${annotation.resolvedBy ? html`<span>Resolved by: ${annotation.resolvedBy.displayName}</span>` : nothing}
                                ${annotation.resolution ? html`<span>Resolution: ${annotation.resolution}</span>` : nothing}
                                ${annotation.dismissReason ? html`<span>Dismiss reason: ${annotation.dismissReason}</span>` : nothing}
                              </div>
                            `
                            : nothing}
                          ${(annotation.linkedCapabilities.relatedToolNames.length
                            + annotation.linkedCapabilities.relatedResourceIds.length
                            + annotation.linkedCapabilities.relatedSkillIds.length) > 0
                            ? html`
                              <div class="flex flex-wrap gap-1">
                                ${annotation.linkedCapabilities.relatedToolNames.map((tool) => html`<span class="badge badge-ghost badge-xs">tool:${tool}</span>`)}
                                ${annotation.linkedCapabilities.relatedResourceIds.map((resource) => html`<span class="badge badge-ghost badge-xs">resource:${resource}</span>`)}
                                ${annotation.linkedCapabilities.relatedSkillIds.map((skill) => html`<span class="badge badge-ghost badge-xs">skill:${skill}</span>`)}
                              </div>
                            `
                            : html`<div class="text-xs opacity-50">No related capabilities</div>`}
                          ${this._renderFeedbackActions(annotation)}
                          ${this._renderFeedbackThread(annotation)}
                        </div>
                      `)}`
                    }
                  </div>
                `}
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
