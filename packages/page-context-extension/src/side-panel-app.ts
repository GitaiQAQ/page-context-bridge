import './browser-polyfill';

import {
  BRIDGE_METHODS,
  type ContextResourcePayload,
  type FeedbackAnnotationClaimParams,
  type FeedbackAnnotationDismissParams,
  type FeedbackAnnotationReplyParams,
  type FeedbackAnnotationResolveParams,
  type FeedbackPriority,
  type FeedbackStateSnapshotResult,
  type PageContextManifest,
} from '@page-context/shared-protocol';

import { LitElement, html, css, type PropertyValues, type TemplateResult, nothing } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';

/**
 * Simple structured logger for side-panel debugging.
 * Prefixes all messages with [side-panel] for easy filtering.
 * Levels: log (default), warn, error.
 */
function spLog(message: string, level: 'log' | 'warn' | 'error' = 'log') {
  const prefix = '[side-panel]';
  if (level === 'error') console.error(prefix, message);
  else if (level === 'warn') console.warn(prefix, message);
  else console.log(prefix, message);
}

/** Minimal debounce utility for event handlers. */
function createDebounce<T extends unknown[]>(
  fn: (...args: T) => void,
  ms: number,
): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: T) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
      timer = null;
    }, ms);
  };
}

function formatBuildTimeLabel(buildTime: string): string {
  if (buildTime === 'dev') {
    return '开发环境 / 未注入构建时间';
  }

  const parsed = new Date(buildTime);
  if (Number.isNaN(parsed.getTime())) {
    return buildTime;
  }

  return parsed.toISOString().replace('.000Z', 'Z');
}

function parseOptionalQueryNumber(searchParams: URLSearchParams, name: string): number | undefined {
  const value = searchParams.get(name);
  if (value == null) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 读取 sidepanel URL query 绑定。
 * 这里只解析 launcher/fallback 约定的字段，避免把 runtime payload 语义掺进来。
 */
function readSidepanelUrlTabBinding(): SidepanelUrlTabBinding {
  const searchParams = new URLSearchParams(window.location.search);
  const boundTabId = parseOptionalQueryNumber(searchParams, 'boundTabId');
  const windowId = parseOptionalQueryNumber(searchParams, 'windowId');
  return {
    ...(boundTabId != null ? { boundTabId } : {}),
    ...(windowId != null ? { windowId } : {}),
  };
}

function readCurrentSidepanelSurface(): SidepanelSurface {
  return readSidepanelSurface(window.location.search);
}

/**
 * 归一化 runtime 显式绑定。
 * 规则固定为 tabId > boundTabId，windowId 仅在存在时透传。
 */
function normalizeRuntimeExplicitTabBinding(
  input?: RuntimeExplicitTabBindingInput | null,
): RuntimeExplicitTabBinding {
  if (input == null) {
    return {};
  }

  return {
    ...(input.tabId != null
      ? { tabId: input.tabId }
      : input.boundTabId != null
        ? { tabId: input.boundTabId }
        : {}),
    ...(input.windowId != null ? { windowId: input.windowId } : {}),
  };
}

import { classMap } from 'lit/directives/class-map.js';
import { when } from 'lit/directives/when.js';

import type { ContextManifestFilterDebug } from './context-manifest-filter-debug';
import { tabsCreate, tabsQuery } from './extension-api';
import { sendRuntimeRequest } from './runtime-rpc';
import {
  type SidepanelSurface,
  consumeLaunchUrlForSurface,
  readSidepanelSurface,
} from './sidepanel-launch-state';
import {
  createArgsTemplate,
  filterBuiltins,
  filterTab,
  formatJson,
  renderBuiltinsNode,
  renderTabNode,
  renderToolsEmpty,
  safeParseJson,
} from './sidepanel-tree-renderer';
import {
  buildContextManifestDiff,
  formatReason,
  renderContextNamespaceCard,
  renderContextResourceCard,
  renderContextSkillCard,
} from './sidepanel-context-panel';
import {
  createFeedbackActionState,
  type FeedbackAnnotationActionState,
  type FeedbackActionFormMode,
  type FeedbackActionInputField,
  readFeedbackActionState,
  reconcileFeedbackActionStates,
  renderFeedbackTab,
  updateFeedbackActionStates,
} from './sidepanel-feedback';
import { renderToolsTab } from './sidepanel-tools-view';
import { renderContextTab, type RenderContextTabInput } from './sidepanel-context-controller';
import { initializeToolTestState, resetToolTestArgsState } from './sidepanel-tool-test-controller';
import { normalizeUrl, createBoundMessageHandler, buildLoaderUrl } from './sidepanel-navigation';
import {
  type ContextManifestResponse,
  type ContextSkillResponse,
  type RuntimeExplicitTabBinding,
  type RuntimeExplicitTabBindingInput,
  type RuntimeStatus,
  type SidepanelFeedbackDraft,
  type SidepanelUrlTabBinding,
  type ToolDebugResponse,
  type ToolTestSelection,
  type ToolTreeResponse,
} from './sidepanel-types';

// Vite resolves this to the built CSS asset URL at runtime
import sidepanelCssUrl from './sidepanel.css?url';

// Custom sidepanel-specific rules that were previously in <style> in the HTML
const customRules = css`
  /* tree indentation */
  .tree-indent-1 {
    padding-left: 1.5rem;
  }
  .tree-indent-2 {
    padding-left: 2.5rem;
  }
  .tree-indent-3 {
    padding-left: 3.5rem;
  }
  /* keep details/summary clean */
  details summary {
    list-style: none;
    cursor: pointer;
  }
  details summary::-webkit-details-marker {
    display: none;
  }
  /* iframe fill */
  .iframe-container iframe {
    width: 100%;
    height: 100%;
    border: none;
  }
  /* test panel toggle */
  .test-panel {
    display: none;
  }
  .test-panel.open {
    display: flex;
  }
  /* tab content visibility: override daisyUI's display:none */
  .tab-content {
    display: none;
  }
  .tab-content.active {
    display: flex;
  }
`;

@customElement('side-panel-app')
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
  @state() private _currentFilter = '';
  @state() private _currentToolTestSelection: ToolTestSelection | null = null;
  @state() private _currentRawContextManifest: PageContextManifest | null = null;
  @state() private _currentEffectiveContextManifest: PageContextManifest | null = null;
  @state() private _currentContextDebug: ContextManifestFilterDebug | null = null;
  @state() private _activeTab: 'tools' | 'context' | 'feedback' | 'diagnosis' = 'tools';
  @state() private _urlBarVisible = true;
  @state() private _currentUrl = '';
  @state() private _manifestStatus = '';
  @state() private _manifestStatusClass = '';
  @state() private _manifestOutput = '(manifest not loaded)';
  @state() private _diffStatus = '';
  @state() private _diffOutput: TemplateResult = html``;
  @state() private _resourceStatus = '';
  @state() private _resourceOutput = '(select a resource to read)';
  @state() private _skillStatus = '';
  @state() private _skillOutput = '(select a skill to render its prompt)';
  @state() private _contextAppValue = '-';
  @state() private _contextSceneValue = '-';
  @state() private _contextTabValue = '-';
  @state() private _contextRouteValue = '-';
  @state() private _contextNamespaceCount = '0';
  @state() private _contextResourceCount = '0';
  @state() private _contextSkillCount = '0';
  @state() private _contextNamespacesListHtml: TemplateResult = html``;
  @state() private _contextResourcesListHtml: TemplateResult = html``;
  @state() private _contextSkillsListHtml: TemplateResult = html``;
  @state() private _toolTestArgs = '{}';
  @state() private _toolTestOutput = '(no output yet)';
  @state() private _toolTestStatusText = 'Idle';
  @state() private _toolTestStatusClass = 'text-xs font-semibold opacity-60';
  @state() private _toolTestRunning = false;
  @state() private _toolTestSchemaOutput = '{}';
  @state() private _toolTestTitle = 'Tool Test';
  @state() private _toolTestSubtitle = 'Select a tool to run an RPC debug call.';
  @state() private _toolTestTabIdValue = '';
  @state() private _toolTestTabIdDisabled = false;
  @state() private _feedbackBody = '';
  @state() private _feedbackPriority: SidepanelFeedbackDraft['priority'] = 'normal';
  @state() private _feedbackCreateStatus = 'Idle';
  @state() private _feedbackCreateStatusClass = 'text-xs font-semibold opacity-60';
  @state() private _feedbackSnapshot: FeedbackStateSnapshotResult | null = null;
  @state() private _feedbackLoading = false;
  @state() private _feedbackError = '';
  @state() private _feedbackActionStateByAnnotationId: Record<
    string,
    FeedbackAnnotationActionState
  > = {};
  @state() private _agentationInjecting = false;
  @state() private _agentationInjectStatus = '';
  @state() private _agentationInjectStatusClass = 'text-xs opacity-60';

  // ─── Query references (shadowRoot is guaranteed when using default createRenderRoot) ──
  @query('#iframeContainer') private _iframeContainer!: HTMLElement;

  // ─── Private state (non-reactive) ─────────────────────────────
  private _currentIframe: HTMLIFrameElement | null = null;
  private _statusIntervalId: ReturnType<typeof setInterval> | null = null;
  private _feedbackPollIntervalId: ReturnType<typeof setInterval> | null = null;
  private _tabActivatedListener?: (activeInfo: { tabId: number; windowId: number }) => void;
  private _tabUpdatedListener?: (
    tabId: number,
    changeInfo: { status?: string },
    tab: chrome.tabs.Tab,
  ) => void;
  /** Debounced filter handler (150ms) to avoid re-rendering on every keystroke. */
  private _debouncedFilterInput = createDebounce((value: string) => {
    this._currentFilter = value;
  }, 150);
  /**
   * URL query 绑定和 runtime 显式绑定分开存，避免字段名（boundTabId/tabId）混用。
   */
  private readonly _urlTabBinding: SidepanelUrlTabBinding = readSidepanelUrlTabBinding();
  private readonly _runtimeTabBinding: RuntimeExplicitTabBinding =
    normalizeRuntimeExplicitTabBinding(this._urlTabBinding);
  private readonly _surface: SidepanelSurface = readCurrentSidepanelSurface();
  private readonly _boundTabId = this._runtimeTabBinding.tabId;
  private readonly _boundWindowId = this._runtimeTabBinding.windowId;

  // ─── Lifecycle ─────────────────────────────────────────────────
  override connectedCallback(): void {
    super.connectedCallback();
    // Inject global CSS (Tailwind + DaisyUI) into shadow root via <link>
    // This is needed because Vite's injectCssLinks plugin adds <link> to <head>,
    // which is outside our shadow boundary.
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = sidepanelCssUrl;
    this.shadowRoot!.appendChild(link);
    this._init();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('message', this._boundMessageHandler);
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
    if (changedProperties.has('_toolTreeResponse') || changedProperties.has('_currentFilter')) {
      this.updateComplete.then(() => this._syncIndeterminateCheckboxes());
    }
    if (changedProperties.has('_currentUrl')) {
      this.updateComplete.then(() => this._manageIframe());
    }
  }

  // ─── Initialization ────────────────────────────────────────────
  private async _init(): Promise<void> {
    await this._refreshStatus();
    this._statusIntervalId = setInterval(() => this._refreshStatus(), 5000);
    this._feedbackPollIntervalId = setInterval(() => {
      if (this._activeTab === 'feedback') {
        void this._loadFeedbackSnapshot();
      }
    }, 10_000);
    await this._loadPageTools();

    const launchUrl = await consumeLaunchUrlForSurface(this._surface);
    const url = launchUrl ? String(launchUrl) : 'http://127.0.0.1:22338/';
    this._navigateTo(url);
    this.updateComplete.then(() => this._manageIframe());

    // Register extension API listeners
    this._tabActivatedListener = (activeInfo: { tabId: number; windowId: number }) => {
      if (this._boundTabId != null && activeInfo.tabId !== this._boundTabId) {
        return;
      }
      if (activeInfo.tabId !== this._currentTabId && this._activeTab === 'tools') {
        void this._loadPageTools();
      }
      if (this._activeTab === 'context') {
        void this._loadContextManifest();
      }
      if (this._activeTab === 'feedback') {
        void this._loadFeedbackSnapshot();
      }
    };
    chrome.tabs.onActivated.addListener(this._tabActivatedListener!);

    this._tabUpdatedListener = (_tabId: number, changeInfo: { status?: string }) => {
      if (_tabId === this._currentTabId && changeInfo.status === 'complete') {
        setTimeout(() => {
          if (this._activeTab === 'tools') {
            void this._loadPageTools();
          }
          if (this._activeTab === 'context') {
            void this._loadContextManifest();
          }
          if (this._activeTab === 'feedback') {
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
    if (this._boundTabId != null) {
      return this._boundTabId;
    }

    const [tab] = await tabsQuery(
      this._boundWindowId != null
        ? { active: true, windowId: this._boundWindowId }
        : { active: true, currentWindow: true },
    );
    return tab?.id ?? null;
  }

  /**
   * 构建 feedback/runtime 请求使用的显式绑定。
   * 规则：
   * - 能确定 tabId 时优先带 tabId；
   * - 没有 tabId 但有 windowId 时只带 windowId；
   * - 两者都没有则不传绑定字段。
   */
  private _buildRuntimeBindingPayload(tabId: number | null): RuntimeExplicitTabBinding | undefined {
    const runtimeBinding = normalizeRuntimeExplicitTabBinding({
      ...(tabId != null ? { tabId } : {}),
      ...(this._boundWindowId != null ? { windowId: this._boundWindowId } : {}),
    });
    return Object.keys(runtimeBinding).length > 0 ? runtimeBinding : undefined;
  }

  // ─── Tools Tree Rendering ──────────────────────────────────────
  private _syncIndeterminateCheckboxes(): void {
    const toolsPanel = this.shadowRoot!.getElementById('toolsPanel');
    if (!toolsPanel) return;
    toolsPanel
      .querySelectorAll<HTMLInputElement>("input[data-indeterminate='true']")
      .forEach((input) => {
        input.indeterminate = true;
      });
  }

  private async _loadPageTools(forceRediscover = false): Promise<void> {
    this._currentTabId = await this._getCurrentTabId();

    try {
      const currentTabId = this._currentTabId;
      const shouldForceDiscover = forceRediscover && currentTabId != null;
      if (shouldForceDiscover) {
        await sendRuntimeRequest(BRIDGE_METHODS.extensionPageToolsDiscover, {
          tabId: currentTabId,
        });
      }
      this._toolTreeResponse = await sendRuntimeRequest<ToolTreeResponse>(
        BRIDGE_METHODS.extensionPageToolsTreeGet,
      );

      const currentTabMissingFromTree =
        currentTabId != null &&
        !this._toolTreeResponse.tabs.some(
          (tab) => tab.tabId === currentTabId && tab.totalTools > 0,
        );
      if (!shouldForceDiscover && currentTabMissingFromTree) {
        try {
          await sendRuntimeRequest(BRIDGE_METHODS.extensionPageToolsDiscover, {
            tabId: currentTabId,
          });
          this._toolTreeResponse = await sendRuntimeRequest<ToolTreeResponse>(
            BRIDGE_METHODS.extensionPageToolsTreeGet,
          );
        } catch {
          // Keep the already loaded tree (typically builtins) if the Firefox backfill probe fails.
        }
      }
    } catch (error) {
      this._toolTreeResponse = null;
    }
    this.requestUpdate();
  }

  private async _updateScopeEnabled(input: {
    root?: 'builtin' | 'page';
    tabId?: number;
    namespace?: string;
    instanceId?: string;
    toolName?: string;
    enabled: boolean;
  }): Promise<void> {
    this._toolTreeResponse = await sendRuntimeRequest<ToolTreeResponse>(
      BRIDGE_METHODS.extensionPageToolsSetEnabled,
      input,
    );
    this.requestUpdate();
    if (this._activeTab === 'context') {
      await this._loadContextManifest();
    }
  }

  // ─── Context Manifest（页面能力清单） ──────────────────────

  /** 加载当前 tab 的上下文清单，填充左侧摘要 + 右侧详情面板 */
  private async _loadContextManifest(): Promise<void> {
    this._currentTabId = await this._getCurrentTabId();
    if (!this._currentTabId) {
      this._renderContextEmpty('No active tab found.', null, false);
      return;
    }

    this._manifestStatus = 'Loading...';
    this._manifestStatusClass = 'text-xs font-semibold opacity-60';
    this.requestUpdate();

    try {
      const response = await sendRuntimeRequest<ContextManifestResponse>(
        BRIDGE_METHODS.extensionContextManifestGet,
        { tabId: this._currentTabId },
      );
      const manifest = response.manifest;
      const rawManifest = response.rawManifest ?? response.manifest;
      this._currentContextDebug = response.debug ?? null;

      if (!manifest) {
        this._renderContextEmpty(
          'No page context manifest available for this tab.',
          this._currentTabId,
          false,
        );
        return;
      }

      this._currentRawContextManifest = rawManifest ?? manifest;
      this._currentEffectiveContextManifest = manifest;

      this._contextAppValue = manifest.app;
      this._contextSceneValue = manifest.scene;
      this._contextTabValue = String(this._currentTabId);
      this._contextRouteValue = manifest.route || '/';
      this._contextNamespaceCount = String(manifest.namespaces.length);
      this._contextResourceCount = String(manifest.resources.length);
      this._contextSkillCount = String(manifest.skills.length);

      this._contextNamespacesListHtml =
        manifest.namespaces.length > 0
          ? html`${manifest.namespaces.map((namespace) => renderContextNamespaceCard(namespace))}`
          : html`<div class="flex flex-col items-center justify-center p-4 text-base-content/40">
              <p class="text-xs">No business domains declared.</p>
            </div>`;
      this._contextResourcesListHtml =
        manifest.resources.length > 0
          ? html`${manifest.resources.map((resource) => renderContextResourceCard(resource))}`
          : html`<div class="flex flex-col items-center justify-center p-4 text-base-content/40">
              <p class="text-xs">No resources declared.</p>
            </div>`;
      this._contextSkillsListHtml =
        manifest.skills.length > 0
          ? html`${manifest.skills.map((skill) => renderContextSkillCard(skill))}`
          : html`<div class="flex flex-col items-center justify-center p-4 text-base-content/40">
              <p class="text-xs">No skills declared.</p>
            </div>`;

      this._renderContextDiff(rawManifest, manifest);

      this._manifestStatus = 'Loaded';
      this._manifestStatusClass = 'text-xs font-semibold text-success';
      this._manifestOutput = formatJson(manifest);
    } catch (error) {
      this._currentContextDebug = null;
      const message = error instanceof Error ? error.message : String(error);
      this._renderContextEmpty(message, this._currentTabId, true);
    }
  }

  /**
   * 清空所有 context 面板状态，显示占位消息。
   * 在无活跃 tab 或清单加载失败时调用。
   */
  private _renderContextEmpty(
    message: string,
    currentTabId: number | null,
    isError: boolean,
  ): void {
    this._contextAppValue = '-';
    this._contextSceneValue = '-';
    this._contextTabValue = currentTabId != null ? String(currentTabId) : '-';
    this._contextRouteValue = '-';
    this._contextNamespaceCount = '0';
    this._contextResourceCount = '0';
    this._contextSkillCount = '0';
    this._contextNamespacesListHtml = html`<div
      class="flex flex-col items-center justify-center p-4 text-base-content/40"
    >
      <p class="text-xs">${message}</p>
    </div>`;
    this._contextResourcesListHtml = html`<div
      class="flex flex-col items-center justify-center p-4 text-base-content/40"
    >
      <p class="text-xs">${message}</p>
    </div>`;
    this._contextSkillsListHtml = html`<div
      class="flex flex-col items-center justify-center p-4 text-base-content/40"
    >
      <p class="text-xs">${message}</p>
    </div>`;
    this._manifestStatus = message;
    this._manifestStatusClass =
      `text-xs font-semibold ${isError ? 'text-error' : 'opacity-60'}`.trim();
    this._manifestOutput = isError ? formatJson({ error: message }) : '(manifest not loaded)';
    this._diffStatus = 'Idle';
    this._diffStatusClass = 'text-xs font-semibold opacity-60';
    this._diffOutput = html`<div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
      <p class="text-xs opacity-60">(manifest diff not available)</p>
    </div>`;
    this._resourceStatus = 'Idle';
    this._resourceStatusClass = 'text-xs font-semibold opacity-60';
    this._resourceOutput = '(select a data card to inspect its payload)';
    this._skillStatus = 'Idle';
    this._skillStatusClass = 'text-xs font-semibold opacity-60';
    this._skillOutput = '(select a skill card to preview its prompt)';
    this.requestUpdate();
  }

  @state() private _diffStatusClass = 'text-xs font-semibold opacity-60';
  @state() private _resourceStatusClass = 'text-xs font-semibold opacity-60';
  @state() private _skillStatusClass = 'text-xs font-semibold opacity-60';

  /**
   * 构建原始清单与过滤后清单的 diff 卡片（隐藏项 + 裁剪工具）。
   */
  private _renderContextDiff(
    rawManifest: PageContextManifest | null,
    effectiveManifest: PageContextManifest,
  ): void {
    const diff = buildContextManifestDiff(rawManifest, effectiveManifest);
    const hasDiff =
      diff.hiddenNamespaces.length > 0 ||
      diff.hiddenResources.length > 0 ||
      diff.hiddenSkills.length > 0 ||
      diff.sceneChanged;

    this._diffStatus = hasDiff ? 'Diff detected' : 'No diff';
    this._diffStatusClass =
      `text-xs font-semibold ${hasDiff ? 'text-success' : 'opacity-60'}`.trim();

    const debug = this._currentContextDebug;
    this._diffOutput = html`
      ${this._renderDiffCard(
        'Namespaces',
        diff.rawNamespaces,
        diff.effectiveNamespaces,
        debug?.hiddenNamespaces ?? diff.hiddenNamespaces.map((id) => ({ id, reason: 'unknown' })),
      )}
      ${this._renderDiffCard(
        'Resources',
        diff.rawResources,
        diff.effectiveResources,
        debug?.hiddenResources ?? diff.hiddenResources.map((id) => ({ id, reason: 'unknown' })),
      )}
      ${this._renderDiffCard(
        'Skills',
        diff.rawSkills,
        diff.effectiveSkills,
        debug?.hiddenSkills ?? diff.hiddenSkills.map((id) => ({ id, reason: 'unknown' })),
      )}
      ${this._renderTrimmedToolsCard(debug)}
      <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
        <h4 class="text-xs font-bold mb-1">Scene</h4>
        <p class="text-xs opacity-70">
          ${diff.sceneChanged
            ? 'Scene changed between raw and effective manifest.'
            : 'Scene is unchanged.'}
        </p>
      </div>
    `;
  }

  /**
   * 渲染单个 diff 分类卡片（Namespaces / Resources / Skills）。
   */
  private _renderDiffCard(
    title: string,
    rawCount: number,
    effectiveCount: number,
    hiddenItems: Array<{ id: string; reason: string }>,
  ): TemplateResult {
    return html`
      <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
        <h4 class="text-xs font-bold mb-1">${title}</h4>
        <p class="text-xs opacity-70">Raw: ${rawCount} · Effective: ${effectiveCount}</p>
        ${hiddenItems.length > 0
          ? html`<ul class="mt-1.5 pl-4 text-xs opacity-70 list-disc">
              ${hiddenItems.map(
                (item) =>
                  html`<li class="break-words">
                    <strong>${item.id}</strong> · ${formatReason(item.reason)}
                  </li>`,
              )}
            </ul>`
          : html`<p class="text-xs opacity-50 mt-1">No hidden items.</p>`}
      </div>
    `;
  }

  /** 渲染 skill 工具裁剪卡片（被过滤掉的推荐工具列表） */
  private _renderTrimmedToolsCard(debug: ContextManifestFilterDebug | null): TemplateResult {
    const trimmed = debug?.trimmedSkillTools ?? [];
    return html`
      <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
        <h4 class="text-xs font-bold mb-1">Skill Tool Trimming</h4>
        ${trimmed.length > 0
          ? html`<ul class="mt-1.5 pl-4 text-xs opacity-70 list-disc">
              ${trimmed.flatMap((entry) =>
                entry.removedTools.map(
                  (item) =>
                    html`<li class="break-words">
                      <strong>${entry.skillId}</strong> · ${item.id} · ${formatReason(item.reason)}
                    </li>`,
                ),
              )}
            </ul>`
          : html`<p class="text-xs opacity-50 mt-1">
              No skill tool recommendations were trimmed.
            </p>`}
      </div>
    `;
  }

  /** 通过 RPC 读取指定资源 payload，填充右侧 Data Payload 卡片 */
  private async _loadContextResource(resourceId: string): Promise<void> {
    if (!this._currentTabId) return;

    this._resourceStatus = `Reading ${resourceId}...`;
    this._resourceStatusClass = 'text-xs font-semibold opacity-60';
    this.requestUpdate();

    try {
      const resource = await sendRuntimeRequest<ContextResourcePayload>(
        BRIDGE_METHODS.extensionContextResourceRead,
        { tabId: this._currentTabId, resourceId },
      );
      this._resourceStatus = `Loaded ${resourceId}`;
      this._resourceStatusClass = 'text-xs font-semibold text-success';
      this._resourceOutput = resource.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._resourceStatus = message;
      this._resourceStatusClass = 'text-xs font-semibold text-error';
      this._resourceOutput = formatJson({ error: message });
    }
  }

  /** 通过 RPC 获取 skill 的 prompt 合同文本，填充右侧 Skill Prompt 卡片 */
  private async _loadContextSkillPrompt(skillId: string): Promise<void> {
    if (!this._currentTabId) return;

    this._skillStatus = `Rendering ${skillId}...`;
    this._skillStatusClass = 'text-xs font-semibold opacity-60';
    this.requestUpdate();

    try {
      const response = await sendRuntimeRequest<ContextSkillResponse>(
        BRIDGE_METHODS.extensionContextSkillGet,
        {
          tabId: this._currentTabId,
          skillId,
          input: { goal: 'Explain how the agent should use this business skill safely.' },
        },
      );
      this._skillStatus = response.prompt ? `Loaded ${skillId}` : `Skill ${skillId} unavailable`;
      this._skillStatusClass = `text-xs font-semibold ${response.prompt ? 'text-success' : 'text-error'}`;
      this._skillOutput = response.prompt
        ? formatJson(response.prompt)
        : formatJson({ error: 'Prompt unavailable' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._skillStatus = message;
      this._skillStatusClass = 'text-xs font-semibold text-error';
      this._skillOutput = formatJson({ error: message });
    }
  }

  // ─── Feedback ────────────────────────────────────────────────
  private async _loadFeedbackSnapshot(): Promise<void> {
    this._currentTabId = await this._getCurrentTabId();
    this._feedbackLoading = true;
    this._feedbackError = '';
    this.requestUpdate();

    try {
      const runtimeBinding = this._buildRuntimeBindingPayload(this._currentTabId);
      this._feedbackSnapshot = await sendRuntimeRequest<FeedbackStateSnapshotResult>(
        BRIDGE_METHODS.extensionFeedbackStateSnapshot,
        runtimeBinding,
      );
      // After polling, keep only annotation form states present in the current snapshot to avoid leaking stale local input into new snapshots.
      this._feedbackActionStateByAnnotationId = reconcileFeedbackActionStates(
        this._feedbackActionStateByAnnotationId,
        this._feedbackSnapshot.annotations,
      );
      this._feedbackCreateStatus = 'Snapshot loaded';
      this._feedbackCreateStatusClass = 'text-xs font-semibold opacity-60';
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
      this._feedbackCreateStatus = 'Please enter feedback content';
      this._feedbackCreateStatusClass = 'text-xs font-semibold text-error';
      return;
    }

    this._feedbackCreateStatus = 'Submitting...';
    this._feedbackCreateStatusClass = 'text-xs font-semibold opacity-60';
    this.requestUpdate();

    try {
      this._currentTabId = await this._getCurrentTabId();
      const runtimeBinding = this._buildRuntimeBindingPayload(this._currentTabId);
      await sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationCreate, {
        body,
        priority: this._feedbackPriority,
        ...(runtimeBinding ?? {}),
      } satisfies SidepanelFeedbackDraft);
      this._feedbackBody = '';
      this._feedbackCreateStatus = 'Created';
      this._feedbackCreateStatusClass = 'text-xs font-semibold text-success';
      await this._loadFeedbackSnapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._feedbackCreateStatus = message;
      this._feedbackCreateStatusClass = 'text-xs font-semibold text-error';
    }
  }

  private _readFeedbackActionState(annotationId: string): FeedbackAnnotationActionState {
    return readFeedbackActionState(this._feedbackActionStateByAnnotationId, annotationId);
  }

  private _updateFeedbackActionState(
    annotationId: string,
    updater: (current: FeedbackAnnotationActionState) => FeedbackAnnotationActionState,
  ): void {
    this._feedbackActionStateByAnnotationId = updateFeedbackActionStates(
      this._feedbackActionStateByAnnotationId,
      annotationId,
      updater,
    );
  }

  private _setFeedbackActionMode(annotationId: string, mode: FeedbackActionFormMode): void {
    this._updateFeedbackActionState(annotationId, (current) => ({
      ...current,
      mode: current.mode === mode ? null : mode,
      error: '',
      success: '',
    }));
  }

  private _handleFeedbackActionInput(
    annotationId: string,
    field: FeedbackActionInputField,
    event: Event,
  ): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this._updateFeedbackActionState(annotationId, (current) => ({
      ...current,
      [field]: value,
      error: '',
      success: '',
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
      error: '',
      success: '',
    }));

    try {
      await request();
      this._updateFeedbackActionState(annotationId, (current) => ({
        ...onSuccess(current),
        submitting: false,
        error: '',
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
      () =>
        sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationClaim, {
          annotationId,
        } satisfies FeedbackAnnotationClaimParams),
      'Claimed',
      (state) => ({ ...state, mode: null }),
    );
  }

  private async _replyFeedbackAnnotation(annotationId: string): Promise<void> {
    const state = this._readFeedbackActionState(annotationId);
    const body = state.replyBody.trim();
    if (!body) {
      this._updateFeedbackActionState(annotationId, (current) => ({
        ...current,
        error: 'Reply content cannot be empty',
      }));
      return;
    }

    await this._runFeedbackMutation(
      annotationId,
      () =>
        sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationReply, {
          annotationId,
          body,
        } satisfies FeedbackAnnotationReplyParams),
      'Reply submitted',
      (current) => ({ ...current, mode: null, replyBody: '' }),
    );
  }

  private async _resolveFeedbackAnnotation(annotationId: string): Promise<void> {
    const state = this._readFeedbackActionState(annotationId);
    await this._runFeedbackMutation(
      annotationId,
      () =>
        sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationResolve, {
          annotationId,
          resolution: state.resolveNote.trim() || undefined,
        } satisfies FeedbackAnnotationResolveParams),
      'Marked as resolved',
      (current) => ({ ...current, mode: null, resolveNote: '' }),
    );
  }

  private async _dismissFeedbackAnnotation(annotationId: string): Promise<void> {
    const state = this._readFeedbackActionState(annotationId);
    await this._runFeedbackMutation(
      annotationId,
      () =>
        sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationDismiss, {
          annotationId,
          dismissReason: state.dismissReason.trim() || undefined,
        } satisfies FeedbackAnnotationDismissParams),
      'Dismissed',
      (current) => ({ ...current, mode: null, dismissReason: '' }),
    );
  }

  // ─── Tool Test Panel ───────────────────────────────────────────
  private _openToolTestPanel(selection: ToolTestSelection): void {
    this._currentToolTestSelection = selection;
    const init = initializeToolTestState(selection);
    this._toolTestTitle = init.toolTestTitle;
    this._toolTestSubtitle = init.toolTestSubtitle;
    this._toolTestTabIdValue = init.toolTestTabIdValue;
    this._toolTestTabIdDisabled = init.toolTestTabIdDisabled;
    this._toolTestSchemaOutput = init.toolTestSchemaOutput;
    this._toolTestArgs = init.toolTestArgs;
    this._toolTestOutput = init.toolTestOutput;
    this._toolTestStatusText = init.toolTestStatusText;
    this._toolTestStatusClass = init.toolTestStatusClass;
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
      const raw = this._toolTestArgs.trim() || '{}';
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('RPC args must be a JSON object');
      }
      parsedArgs = parsed as Record<string, unknown>;
    } catch (error) {
      this._toolTestStatusText = error instanceof Error ? error.message : String(error);
      this._toolTestStatusClass = 'text-xs font-semibold text-error';
      this._toolTestOutput = '(invalid JSON args)';
      return;
    }

    this._toolTestRunning = true;
    this._toolTestStatusText = 'Running...';
    this._toolTestStatusClass = 'text-xs font-semibold opacity-60';
    this.requestUpdate();

    try {
      const tabId = this._toolTestTabIdValue ? Number(this._toolTestTabIdValue) : undefined;
      const response = await sendRuntimeRequest<ToolDebugResponse>(
        BRIDGE_METHODS.extensionToolDebugCall,
        {
          toolName: this._currentToolTestSelection.toolName,
          tabId,
          args: parsedArgs,
        },
      );

      this._toolTestStatusText = response.ok ? 'Success' : 'Failed';
      this._toolTestStatusClass = `text-xs font-semibold ${response.ok ? 'text-success' : 'text-error'}`;
      this._toolTestOutput = formatJson(
        response.ok ? (response.result ?? {}) : { error: response.error ?? 'Unknown error' },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._toolTestStatusText = message;
      this._toolTestStatusClass = 'text-xs font-semibold text-error';
      this._toolTestOutput = formatJson({ error: message });
    } finally {
      this._toolTestRunning = false;
    }
  }

  private _resetToolTestArgs(): void {
    const reset = resetToolTestArgsState(this._currentToolTestSelection?.inputSchema);
    if (reset.toolTestArgs !== undefined) this._toolTestArgs = reset.toolTestArgs;
    if (reset.toolTestOutput !== undefined) this._toolTestOutput = reset.toolTestOutput;
    if (reset.toolTestStatusText !== undefined) this._toolTestStatusText = reset.toolTestStatusText;
    if (reset.toolTestStatusClass !== undefined)
      this._toolTestStatusClass = reset.toolTestStatusClass;
  }

  // ─── Navigation / Iframe ───────────────────────────────────────
  private _navigateTo(url: string): void {
    this._currentUrl = normalizeUrl(url);
    this._urlBarVisible = true;
  }

  private _manageIframe(): void {
    const container =
      this._iframeContainer ?? this.shadowRoot?.querySelector<HTMLElement>('#iframeContainer');
    if (!container) {
      spLog('_manageIframe: #iframeContainer not found in shadow DOM');
      return;
    }

    // Clean up previous
    window.removeEventListener('message', this._boundMessageHandler);
    this._currentIframe?.remove();
    this._currentIframe = null;

    // Load extension's built-in loader page — it probes target and shows UI internally
    const loaderUrl = buildLoaderUrl(this._currentUrl);

    this._currentIframe = document.createElement('iframe');
    this._currentIframe.src = loaderUrl;
    this._currentIframe.allow = 'clipboard-read; clipboard-write';
    this._urlBarVisible = false;

    window.addEventListener('message', this._boundMessageHandler);
    container.appendChild(this._currentIframe);
  }

  /** Handler for messages from the loader iframe */
  private _boundMessageHandler = createBoundMessageHandler();

  // ─── Event Handlers ────────────────────────────────────────────
  private _handleTabClick(tab: 'tools' | 'context' | 'feedback' | 'diagnosis'): void {
    console.log(
      '[side-panel] _handleTabClick called with:',
      tab,
      'current _activeTab:',
      this._activeTab,
    );
    this._activeTab = tab;
    console.log('[side-panel] _activeTab set to:', this._activeTab, 'about to requestUpdate');
    this.requestUpdate();
    console.log('[side-panel] requestUpdate done');
    if (tab === 'tools') {
      void this._loadPageTools();
    } else if (tab === 'context') {
      void this._loadContextManifest();
    } else if (tab === 'feedback') {
      void this._loadFeedbackSnapshot();
    }
  }

  private _handleGoClick(): void {
    const input = this.shadowRoot!.querySelector<HTMLInputElement>('#urlInput');
    if (input) {
      this._navigateTo(input.value.trim());
      this.updateComplete.then(() => this._manageIframe());
    }
  }

  private _handleUrlKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      const input = event.target as HTMLInputElement;
      this._navigateTo(input.value.trim());
      this.updateComplete.then(() => this._manageIframe());
    }
  }

  private async _handleReconnect(): Promise<void> {
    if (this._refreshing) return;
    this._refreshing = true;
    this.requestUpdate();
    try {
      await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect);
    } catch (error) {
      spLog(`Reconnect failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setTimeout(() => {
        this._refreshing = false;
        void this._refreshStatus();
        this.requestUpdate();
      }, 800);
    }
  }

  private async _handleInjectAgentation(): Promise<void> {
    if (this._agentationInjecting) return;
    this._agentationInjecting = true;
    this._agentationInjectStatus = 'Injecting...';
    this._agentationInjectStatusClass = 'text-xs opacity-60';
    this.requestUpdate();
    try {
      const tabId = await this._getCurrentTabId();
      if (tabId == null) {
        throw new Error('No active tab');
      }
      await sendRuntimeRequest(BRIDGE_METHODS.extensionAgentationMainEnsure, { tabId });
      this._agentationInjectStatus = 'Injected';
      this._agentationInjectStatusClass = 'text-xs text-success';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._agentationInjectStatus = message;
      this._agentationInjectStatusClass = 'text-xs text-error';
      spLog(`Agentation inject failed: ${message}`, 'error');
    } finally {
      this._agentationInjecting = false;
      this.requestUpdate();
    }
  }

  private _handleOpenTab(): void {
    const input = this.shadowRoot!.querySelector<HTMLInputElement>('#urlInput');
    const url = input?.value.trim();
    if (url) {
      void tabsCreate({ url });
    }
  }

  private _handleToolsFilterInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this._debouncedFilterInput(input.value.trim().toLowerCase());
  }

  private _handleToolsPanelChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;

    const { root, scope, tabId, namespace, instanceId, toolName } = target.dataset;
    if (!scope || !tabId) return;
    // Built-in tree nodes (namespace/instance/tool) follow the builtin root uniformly to avoid mistakenly writing to the page preference tree when reusing page scope.
    const resolvedRoot: 'builtin' | 'page' =
      root === 'builtin' || scope === 'builtin' ? 'builtin' : 'page';

    void this._updateScopeEnabled({
      root: resolvedRoot,
      tabId: resolvedRoot === 'builtin' ? undefined : Number(tabId),
      namespace,
      instanceId,
      toolName,
      enabled: target.checked,
    });
  }

  private _handleToolsPanelClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.dataset.action !== 'test-tool') return;

    this._openToolTestPanel({
      root: (target.dataset.root as 'builtin' | 'page') ?? 'page',
      toolName: target.dataset.toolName ?? '',
      label: target.dataset.label ?? target.dataset.toolName ?? 'Tool',
      tabId: target.dataset.tabId ? Number(target.dataset.tabId) : undefined,
      inputSchema: target.dataset.schema ? safeParseJson(target.dataset.schema) : {},
    });
  }

  /** 响应侧栏 "Inspect Payload" 按钮点击，委托给 _loadContextResource */
  private _handleContextResourceClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.dataset.action !== 'read-resource') return;
    const resourceId = target.dataset.resourceId;
    if (resourceId) {
      void this._loadContextResource(resourceId);
    }
  }

  /** 响应侧栏 "Inspect Skill" 按钮点击，委托给 _loadContextSkillPrompt */
  private _handleContextSkillClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.dataset.action !== 'preview-skill') return;
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
    this._feedbackPriority = input.value as SidepanelFeedbackDraft['priority'];
  }

  // ─── Render Tools Tree Content ─────────────────────────────────
  private _renderToolsTreeContent(): TemplateResult {
    if (!this._toolTreeResponse) {
      return renderToolsEmpty('No tools loaded.');
    }

    const filteredTabs = this._toolTreeResponse.tabs
      .map((tab) => filterTab(tab, this._currentFilter))
      .filter((tab): tab is ToolTreeResponse['tabs'][number] => tab !== null);

    if (filteredTabs.length === 0) {
      const builtinTools = filterBuiltins(this._toolTreeResponse.builtins, this._currentFilter);
      if (builtinTools.totalTools === 0) {
        return renderToolsEmpty(
          this._currentFilter
            ? `No tools match '${this._currentFilter}'.`
            : 'No tools discovered yet.',
        );
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
    try {
      return this._renderContent();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      spLog(`render error: ${message}`, 'error');
      return html`
        <div class="flex flex-col items-center justify-center flex-1 p-4 text-error">
          <p class="text-sm font-semibold">Render Error</p>
          <p class="text-xs mt-1 opacity-70 break-all">${message}</p>
          <button class="btn btn-xs btn-ghost mt-2" @click=${() => this.requestUpdate()}>
            Retry
          </button>
        </div>
      `;
    }
  }

  private _renderContent(): TemplateResult {
    spLog(`render() called, _activeTab = ${this._activeTab}`);
    const buildTimeLabel = formatBuildTimeLabel(
      this.getAttribute('data-build-time')?.trim() || 'dev',
    );
    const buildTimeText = `构建时间：${buildTimeLabel}`;
    const toolsCount = this._toolTreeResponse
      ? `(${this._toolTreeResponse.enabledTools}/${this._toolTreeResponse.totalTools} enabled) · ${buildTimeText}`
      : buildTimeText;

    return html`
      <!-- Header: status-dot (clickable refresh) / title / icon-nav (right) -->
      <div
        class="flex items-center gap-2 px-3 py-1.5 bg-base-100 border-b border-base-300 shrink-0"
      >
        <button
          class="w-4 h-4 rounded-full shrink-0 flex items-center justify-center ${this._refreshing
            ? 'bg-base-300'
            : this._connected
              ? 'bg-success'
              : 'bg-error'} hover:opacity-80 transition-all duration-200 cursor-pointer border-none p-0 overflow-hidden"
          @click=${this._handleReconnect}
          title="${this._refreshing ? 'Refreshing...' : 'Click to refresh'}"
        >
          <svg
            class="w-3 h-3 text-white transition-opacity duration-200 ${this._refreshing
              ? 'animate-spin opacity-100'
              : 'opacity-0'}"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
        <span class="font-semibold text-sm truncate">Page Context Bridge</span>
        <button
          class="btn btn-xs btn-ghost ${this._agentationInjecting ? 'loading' : ''}"
          @click=${() => void this._handleInjectAgentation()}
          ?disabled=${this._agentationInjecting}
          title=${this._agentationInjectStatus || 'Inject Agentation into the active tab'}
        >
          Inject Agentation
        </button>
        ${this._agentationInjectStatus
          ? html`<span
              class=${this._agentationInjectStatusClass}
              title=${this._agentationInjectStatus}
              >${this._agentationInjectStatus}</span
            >`
          : nothing}
        <div role="tablist" class="tabs tabs-boxed ml-auto bg-transparent border-none gap-0.5">
          <button
            role="tab"
            class="tab tab-xs px-2 ${classMap({ 'tab-active': this._activeTab === 'tools' })}"
            @click=${() => this._handleTabClick('tools')}
            title="Tools"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
              />
            </svg>
          </button>
          <button
            role="tab"
            class="tab tab-xs px-2 ${classMap({ 'tab-active': this._activeTab === 'context' })}"
            @click=${() => this._handleTabClick('context')}
            title="Context"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </button>
          <button
            role="tab"
            class="tab tab-xs px-2 ${classMap({ 'tab-active': this._activeTab === 'feedback' })}"
            @click=${() => this._handleTabClick('feedback')}
            title="Feedback"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <button
            role="tab"
            class="tab tab-xs px-2 ${classMap({ 'tab-active': this._activeTab === 'diagnosis' })}"
            @click=${() => this._handleTabClick('diagnosis')}
            title="Diagnosis"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </button>
        </div>
      </div>

      ${renderToolsTab({
        active: this._activeTab === 'tools',
        toolsCount,
        currentFilter: this._currentFilter,
        currentToolTestSelection: this._currentToolTestSelection,
        toolTestTitle: this._toolTestTitle,
        toolTestSubtitle: this._toolTestSubtitle,
        toolTestTabIdValue: this._toolTestTabIdValue,
        toolTestTabIdDisabled: this._toolTestTabIdDisabled,
        toolTestSchemaOutput: this._toolTestSchemaOutput,
        toolTestArgs: this._toolTestArgs,
        toolTestOutput: this._toolTestOutput,
        toolTestStatusText: this._toolTestStatusText,
        toolTestStatusClass: this._toolTestStatusClass,
        toolTestRunning: this._toolTestRunning,
        renderToolsTreeContent: () => this._renderToolsTreeContent(),
        onRefresh: () => void this._loadPageTools(true),
        onFilterInput: this._handleToolsFilterInput,
        onPanelChange: this._handleToolsPanelChange,
        onPanelClick: this._handleToolsPanelClick,
        onCloseToolTestPanel: this._closeToolTestPanel,
        onToolTestTabIdInput: this._handleToolTestTabIdInput,
        onToolTestArgsInput: this._handleToolTestArgsInput,
        onResetToolTestArgs: this._resetToolTestArgs,
        onRunToolDebugCall: () => void this._runToolDebugCall(),
      })}
      ${renderContextTab({
        active: this._activeTab === 'context',
        contextAppValue: this._contextAppValue,
        contextSceneValue: this._contextSceneValue,
        contextTabValue: this._contextTabValue,
        contextRouteValue: this._contextRouteValue,
        contextNamespaceCount: this._contextNamespaceCount,
        contextResourceCount: this._contextResourceCount,
        contextSkillCount: this._contextSkillCount,
        contextNamespacesListHtml: this._contextNamespacesListHtml,
        contextResourcesListHtml: this._contextResourcesListHtml,
        contextSkillsListHtml: this._contextSkillsListHtml,
        manifestStatus: this._manifestStatus,
        manifestStatusClass: this._manifestStatusClass,
        manifestOutput: this._manifestOutput,
        diffStatus: this._diffStatus,
        diffStatusClass: this._diffStatusClass,
        diffOutput: this._diffOutput,
        resourceStatus: this._resourceStatus,
        resourceStatusClass: this._resourceStatusClass,
        resourceOutput: this._resourceOutput,
        skillStatus: this._skillStatus,
        skillStatusClass: this._skillStatusClass,
        skillOutput: this._skillOutput,
        onRefresh: () => void this._loadContextManifest(),
        onResourceClick: this._handleContextResourceClick,
        onSkillClick: this._handleContextSkillClick,
      } as RenderContextTabInput)}

      <!-- Feedback Tab -->
      ${this._activeTab === 'feedback'
        ? renderFeedbackTab({
            snapshot: this._feedbackSnapshot,
            loading: this._feedbackLoading,
            error: this._feedbackError,
            body: this._feedbackBody,
            priority: this._feedbackPriority,
            createStatus: this._feedbackCreateStatus,
            createStatusClass: this._feedbackCreateStatusClass,
            readActionState: (annotationId) => this._readFeedbackActionState(annotationId),
            onRefresh: () => void this._loadFeedbackSnapshot(),
            onBodyInput: this._handleFeedbackBodyInput,
            onPriorityChange: this._handleFeedbackPriorityChange,
            onSubmit: () => void this._submitFeedback(),
            onToggleMode: (annotationId, mode) => this._setFeedbackActionMode(annotationId, mode),
            onActionInput: (annotationId, field, event) =>
              this._handleFeedbackActionInput(annotationId, field, event),
            onClaim: (annotationId) => void this._claimFeedbackAnnotation(annotationId),
            onReply: (annotationId) => void this._replyFeedbackAnnotation(annotationId),
            onResolve: (annotationId) => void this._resolveFeedbackAnnotation(annotationId),
            onDismiss: (annotationId) => void this._dismissFeedbackAnnotation(annotationId),
          })
        : html`<div class="tab-content flex flex-col flex-1 min-h-0"></div>`}

      <!-- Diagnosis Tab -->
      <div
        class="tab-content ${classMap({
          active: this._activeTab === 'diagnosis',
        })} flex flex-col flex-1 min-h-0"
      >
        ${when(
          this._urlBarVisible,
          () => html`
            <div
              class="flex items-center gap-1.5 px-3 py-1.5 bg-base-100 border-b border-base-300 shrink-0"
            >
              <input
                type="text"
                id="urlInput"
                .value=${this._currentUrl}
                @keydown=${this._handleUrlKeydown}
                placeholder="Enter URL to embed..."
                class="input input-sm input-bordered flex-1 font-mono"
              />
              <button class="btn btn-sm btn-primary" @click=${this._handleGoClick}>Go</button>
            </div>
          `,
        )}
        <div class="iframe-container flex-1 relative bg-base-100" id="iframeContainer"></div>
      </div>
    `;
  }
  // end _renderContent
}

declare global {
  interface HTMLElementTagNameMap {
    'side-panel-app': SidePanelApp;
  }
}
