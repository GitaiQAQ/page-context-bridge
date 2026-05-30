import './browser-polyfill';

import {
  BRIDGE_METHODS,
  type ConnectionDescriptor,
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
    return 'Dev environment / build time not injected';
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
 * Read sidepanel URL query bindings.
 * Only parses launcher/fallback contract fields to avoid mixing runtime payload semantics.
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
 * Normalize runtime explicit bindings.
 * Rule: tabId > boundTabId; windowId is passed through only if present.
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

import { repeat } from 'lit/directives/repeat.js';

import type { ContextManifestFilterDebug } from './context-manifest-filter-debug';
import {
  storageLocalGet,
  storageLocalRemove,
  storageLocalSet,
  tabsCreate,
  tabsQuery,
} from './extension-api';
import { sendRuntimeRequest } from './runtime-rpc';
import {
  type SidepanelSurface,
  consumeLaunchUrlForSurface,
  readSidepanelSurface,
} from './sidepanel-launch-state';
import {
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
import './connections-panel';
import {
  buildExtWsUrl as buildOpenCodeExtWsUrl,
  buildExtWsUrlFromDefaultBridgeWs,
  buildIframeUrl as buildOpenCodeWebUrl,
  createSession as createOpenCodeSession,
  deleteSession as deleteOpenCodeSession,
  ensureMcpRegistered,
  listSessions as listOpenCodeSessions,
  type OpenCodeConfig,
  type OpenCodeSession,
} from './sidepanel-opencode';
import {
  type ContextManifestResponse,
  type ContextSkillResponse,
  type RuntimeExplicitTabBinding,
  type RuntimeExplicitTabBindingInput,
  type SidepanelFeedbackDraft,
  type SidepanelUrlTabBinding,
  type ToolDebugResponse,
  type ToolTestSelection,
  type ToolTreeResponse,
} from './sidepanel-types';
import {
  LEGACY_OPENCODE_CONFIG_STORAGE_KEY,
  migrateLegacyConnectionEndpoints,
  type ConnectionEndpointsConfig,
} from './connections-endpoints';
import { ConnectionsController, getConnectionsStore } from './connections-controller';
import { getScopedBridgeDescriptorId } from './bg-scoped-ws-connection';

// Vite resolves this to the built CSS asset URL at runtime
import sidepanelCssUrl from './sidepanel.css?url';

const OPENCODE_CONFIG_STORAGE_KEY = LEGACY_OPENCODE_CONFIG_STORAGE_KEY;
const BRIDGE_INSTALL_ID_STORAGE_KEY = 'page-context.bridge-install-id.v1';

interface StoredOpenCodeConfig {
  lastSessionId?: string;
  sessionId?: string;
  sessions?: Array<{
    sessionId: string;
    directory?: string;
    opencodeBaseUrl?: string;
  }>;
}

interface OpenCodeSessionView {
  sessionId: string;
  bridgeChannelId: string;
  sessionDirectory: string;
  opencodeBaseUrl: string;
  webUrl: string;
  wsUrl: string;
  connected: boolean;
  bridgeSessionId: string | null;
}

type SidePanelTab = 'tools' | 'context' | 'feedback' | 'opencode' | 'connections';

function shortenSessionId(sessionId: string): string {
  if (sessionId.length <= 18) {
    return sessionId;
  }
  return `${sessionId.slice(0, 10)}…${sessionId.slice(-6)}`;
}

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
        overflow: auto;
      }
    `,
  ];

  // ─── State ──────────────────────────────────────────────────────
  @state() private _refreshing = false;
  @state() private _currentTabId: number | null = null;
  @state() private _toolTreeResponse: ToolTreeResponse | null = null;
  @state() private _currentFilter = '';
  @state() private _currentToolTestSelection: ToolTestSelection | null = null;
  @state() private _currentRawContextManifest: PageContextManifest | null = null;
  @state() private _currentEffectiveContextManifest: PageContextManifest | null = null;
  @state() private _currentContextDebug: ContextManifestFilterDebug | null = null;
  @state()
  private _activeTab: SidePanelTab = 'tools';
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
  @state() private _opencodeBaseUrl = 'http://localhost:4096';
  @state() private _bridgeBaseUrl = 'http://localhost:22334';
  @state() private _opencodeDraftSessionId = '';
  @state() private _opencodeActiveSessionId = '';
  @state() private _opencodeSessions: OpenCodeSessionView[] = [];
  @state() private _opencodeConnecting = false;
  @state() private _opencodeMessage = '';
  @state() private _opencodeIframeOpen = false;

  // ─── Query references (shadowRoot is guaranteed when using default createRenderRoot) ──
  // ─── Private state (non-reactive) ─────────────────────────────
  private readonly _connections = new ConnectionsController(this);
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
   * URL query bindings and runtime explicit bindings are stored separately to avoid field name conflicts (boundTabId/tabId).
   */
  private readonly _urlTabBinding: SidepanelUrlTabBinding = readSidepanelUrlTabBinding();
  private readonly _runtimeTabBinding: RuntimeExplicitTabBinding =
    normalizeRuntimeExplicitTabBinding(this._urlTabBinding);
  private readonly _surface: SidepanelSurface = readCurrentSidepanelSurface();
  private readonly _boundTabId = this._runtimeTabBinding.tabId;
  private readonly _boundWindowId = this._runtimeTabBinding.windowId;
  private _bridgeInstallId = '';

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
    void this._init();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
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
  }

  // ─── Initialization ────────────────────────────────────────────
  private async _init(): Promise<void> {
    await getConnectionsStore().ensureSubscribed();
    await getConnectionsStore().refresh();
    this._feedbackPollIntervalId = setInterval(() => {
      if (this._activeTab === 'feedback') {
        void this._loadFeedbackSnapshot();
      }
    }, 10_000);
    await this._loadPageTools();

    await consumeLaunchUrlForSurface(this._surface);
    await this._restoreOpenCodeConfig();
    this._currentTabId = await this._getCurrentTabId();

    // Register extension API listeners
    this._tabActivatedListener = (activeInfo: { tabId: number; windowId: number }) => {
      if (this._boundTabId != null && activeInfo.tabId !== this._boundTabId) {
        return;
      }
      const previousTabId = this._currentTabId;
      this._currentTabId = activeInfo.tabId;
      if (activeInfo.tabId !== previousTabId && this._activeTab === 'tools') {
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

  private _getOpenCodeConfig(): OpenCodeConfig {
    return {
      opencodeBaseUrl: this._opencodeBaseUrl,
      bridgeBaseUrl: this._bridgeBaseUrl,
    };
  }

  private _buildOpenCodeSessionView(
    session: OpenCodeSession,
    descriptor?: ConnectionDescriptor | null,
    bridgeChannelId = '',
  ): OpenCodeSessionView {
    const cfg = {
      ...this._getOpenCodeConfig(),
      opencodeBaseUrl: session.opencodeBaseUrl?.trim() || this._opencodeBaseUrl,
    };
    const channelId =
      bridgeChannelId.trim() ||
      (typeof descriptor?.meta?.tenantId === 'string' ? descriptor.meta.tenantId : '') ||
      this._bridgeInstallId;
    return {
      sessionId: session.id,
      bridgeChannelId: channelId,
      sessionDirectory: session.directory?.trim() ?? '',
      opencodeBaseUrl: cfg.opencodeBaseUrl,
      webUrl: buildOpenCodeWebUrl(cfg, session),
      wsUrl: descriptor?.endpoint ?? (channelId ? this._getOpenCodeExtWsUrl(channelId) : ''),
      connected: descriptor?.status === 'connected',
      bridgeSessionId:
        typeof descriptor?.meta?.bridgeSessionId === 'string'
          ? descriptor.meta.bridgeSessionId
          : null,
    };
  }

  private _getOpenCodeSession(sessionId: string): OpenCodeSessionView | undefined {
    return this._opencodeSessions.find((session) => session.sessionId === sessionId);
  }

  /**
   * The session list is the sidepanel's single source of truth for OpenCode session/runtime state.
   * Update by id in place so switching sessions does not lose existing scoped ws state.
   */
  private _upsertOpenCodeSession(session: OpenCodeSessionView): void {
    const index = this._opencodeSessions.findIndex(
      (entry) => entry.sessionId === session.sessionId,
    );
    if (index < 0) {
      this._opencodeSessions = [...this._opencodeSessions, session];
      return;
    }

    this._opencodeSessions = this._opencodeSessions.map((entry, entryIndex) =>
      entryIndex === index ? session : entry,
    );
  }

  private _removeOpenCodeSession(sessionId: string): void {
    this._opencodeSessions = this._opencodeSessions.filter(
      (session) => session.sessionId !== sessionId,
    );
  }

  private async _selectOpenCodeSession(sessionId: string): Promise<void> {
    this._opencodeActiveSessionId = sessionId;
    this._opencodeDraftSessionId = sessionId;
    this._opencodeIframeOpen = true;
    await this._persistOpenCodeConfig();
  }

  private _getActiveOpenCodeSession(): OpenCodeSessionView | null {
    if (!this._opencodeActiveSessionId) {
      return null;
    }
    return this._getOpenCodeSession(this._opencodeActiveSessionId) ?? null;
  }

  private _getOpenCodeScopedDescriptor(sessionId: string): ConnectionDescriptor | null {
    const session = this._getOpenCodeSession(sessionId);
    const channelId = session?.bridgeChannelId || this._bridgeInstallId;
    if (!channelId) {
      return null;
    }
    return this._connections.getDescriptor(getScopedBridgeDescriptorId(channelId));
  }

  private _getOpenCodeExtWsUrl(channelId: string): string {
    const defaultBridge = this._connections.descriptors.find(
      (descriptor) => descriptor.kind === 'bridge-default-ws' && descriptor.endpoint,
    );
    if (defaultBridge?.endpoint) {
      try {
        return buildExtWsUrlFromDefaultBridgeWs(defaultBridge.endpoint, channelId);
      } catch (error) {
        spLog(
          `Failed to derive scoped OpenCode WS from default bridge endpoint ${defaultBridge.endpoint}: ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        );
      }
    }

    return buildOpenCodeExtWsUrl(this._getOpenCodeConfig(), channelId);
  }

  private async _getBridgeInstallId(): Promise<string> {
    if (this._bridgeInstallId) {
      return this._bridgeInstallId;
    }

    const result = await storageLocalGet<{ [BRIDGE_INSTALL_ID_STORAGE_KEY]?: string }>(
      BRIDGE_INSTALL_ID_STORAGE_KEY,
    );
    const saved = result[BRIDGE_INSTALL_ID_STORAGE_KEY]?.trim();
    if (saved) {
      this._bridgeInstallId = saved;
      return saved;
    }

    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `install-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this._bridgeInstallId = generated;
    await storageLocalSet({ [BRIDGE_INSTALL_ID_STORAGE_KEY]: generated });
    return generated;
  }

  private async _getBridgeChannelId(): Promise<string> {
    return this._getBridgeInstallId();
  }

  private _getOpenCodeReadiness(): {
    title: string;
    detail: string;
    tone: 'success' | 'warning' | 'neutral';
  } {
    const descriptors = this._connections.descriptors;
    const bridge = descriptors.find((descriptor) => descriptor.kind === 'bridge-default-ws');
    const opencodeHttp = descriptors.find((descriptor) => descriptor.kind === 'opencode-http');
    const active = this._getActiveOpenCodeSession();
    const scoped = active ? this._getOpenCodeScopedDescriptor(active.sessionId) : null;

    if (active && scoped?.status === 'connected') {
      return {
        title: 'Ready for page-aware coding',
        detail: 'OpenCode is connected to this extension; LLMs can call page tools via MCP.',
        tone: 'success',
      };
    }

    if (opencodeHttp?.status === 'unreachable' || opencodeHttp?.status === 'error') {
      return {
        title: 'OpenCode endpoint needs attention',
        detail: opencodeHttp.statusReason ?? 'Check the OpenCode Base URL in Connections panel.',
        tone: 'warning',
      };
    }

    if (
      bridge?.status === 'closed' ||
      bridge?.status === 'error' ||
      bridge?.status === 'unreachable'
    ) {
      return {
        title: 'Bridge control plane is offline',
        detail: bridge.statusReason ?? 'Reconnect the bridge in the Connections panel first.',
        tone: 'warning',
      };
    }

    return {
      title: 'Create or restore an OpenCode session',
      detail:
        'Provide sessionId to reuse an existing session, or leave it blank to create a new OpenCode session.',
      tone: 'neutral',
    };
  }

  private async _disconnectOpenCodeBridgeSession(sessionId: string): Promise<void> {
    const channelId =
      this._getOpenCodeSession(sessionId)?.bridgeChannelId || (await this._getBridgeChannelId());
    await this._disconnectOpenCodeBridgeChannel(channelId);
  }

  private async _disconnectOpenCodeBridgeChannel(channelId: string): Promise<void> {
    await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect, {
      sessionId: channelId,
      disconnect: true,
    });
  }

  /**
   * Wait until the scoped ws descriptor reaches a stable state.
   *
   * Stop reading legacy `extensionStatusGet`; wait for the registry descriptor instead.
   */
  private async _waitForScopedConnection(channelId: string): Promise<ConnectionDescriptor> {
    const descriptorId = getScopedBridgeDescriptorId(channelId);
    const descriptor = await getConnectionsStore().waitForDescriptor(
      descriptorId,
      (current) =>
        current?.status === 'connected' ||
        current?.status === 'error' ||
        current?.status === 'closed',
      5_000,
    );

    if (!descriptor || descriptor.status !== 'connected') {
      throw new Error(
        descriptor?.statusReason || `Bridge WebSocket for channel "${channelId}" is not connected`,
      );
    }
    return descriptor;
  }

  private async _createOrReuseOpenCodeSession(forceNewSession = false): Promise<OpenCodeSession> {
    const desiredSessionId = forceNewSession ? '' : this._opencodeDraftSessionId.trim();
    if (!desiredSessionId) {
      return this._createOpenCodeSession();
    }

    const sessions = await listOpenCodeSessions(this._getOpenCodeConfig());
    const matched = sessions.find((session) => session.id === desiredSessionId);
    if (matched) {
      return matched;
    }

    return this._createOpenCodeSession();
  }

  private async _createOpenCodeSession(): Promise<OpenCodeSession> {
    const cfg = this._getOpenCodeConfig();
    this._opencodeMessage = 'Creating OpenCode session...';
    this.requestUpdate();
    const session = await createOpenCodeSession(cfg);
    return {
      ...session,
      directory: session.directory?.trim(),
      opencodeBaseUrl: session.opencodeBaseUrl?.trim() || cfg.opencodeBaseUrl,
    };
  }

  private async _connectOpenCodeSession(session: OpenCodeSession): Promise<OpenCodeSessionView> {
    const cfg = {
      ...this._getOpenCodeConfig(),
      opencodeBaseUrl: session.opencodeBaseUrl?.trim() || this._opencodeBaseUrl,
    };
    const sessionId = session.id;
    const channelId = await this._getBridgeChannelId();

    this._opencodeMessage = `Connecting bridge channel ${channelId}...`;
    this.requestUpdate();
    await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect, {
      sessionId: channelId,
      wsUrl: this._getOpenCodeExtWsUrl(channelId),
    });

    const descriptor = await this._waitForScopedConnection(channelId);

    this._opencodeMessage = `Registering MCP for ${sessionId}...`;
    this.requestUpdate();
    await ensureMcpRegistered(cfg, sessionId);

    const sessionView = this._buildOpenCodeSessionView(session, descriptor, channelId);
    this._upsertOpenCodeSession(sessionView);
    await this._selectOpenCodeSession(sessionId);
    this._opencodeMessage = `Connected ${sessionId}`;
    return sessionView;
  }

  /**
   * Restore only the last configuration that connected successfully.
   * This reduces noise from temporary trial endpoints being restored.
   */
  private async _restoreOpenCodeConfig(): Promise<void> {
    try {
      const endpoints = await migrateLegacyConnectionEndpoints();
      this._opencodeBaseUrl = endpoints.opencodeBaseUrl;
      this._bridgeBaseUrl = endpoints.bridgeBaseUrl;

      const result = await storageLocalGet<{
        [OPENCODE_CONFIG_STORAGE_KEY]?: StoredOpenCodeConfig;
      }>(OPENCODE_CONFIG_STORAGE_KEY);
      const saved = result[OPENCODE_CONFIG_STORAGE_KEY];
      if (!saved) {
        return;
      }
      const lastSessionId =
        typeof saved.lastSessionId === 'string'
          ? saved.lastSessionId.trim()
          : typeof saved.sessionId === 'string'
            ? saved.sessionId.trim()
            : '';
      this._opencodeDraftSessionId = lastSessionId;
      if (!lastSessionId) {
        return;
      }

      const savedSessions = Array.isArray(saved.sessions)
        ? saved.sessions.filter(
            (
              session,
            ): session is { sessionId: string; directory?: string; opencodeBaseUrl?: string } =>
              typeof session.sessionId === 'string' && Boolean(session.sessionId.trim()),
          )
        : [];
      const savedSessionById = new Map(
        savedSessions.map((session) => [session.sessionId.trim(), session] as const),
      );
      const lastSavedSession = savedSessionById.get(lastSessionId);
      const baseCfg = this._getOpenCodeConfig();
      const sessionListConfigs = Array.from(
        new Map(
          [
            baseCfg,
            ...savedSessions.map((session) => ({
              ...baseCfg,
              opencodeBaseUrl: session.opencodeBaseUrl?.trim() || baseCfg.opencodeBaseUrl,
            })),
          ].map((cfg) => [cfg.opencodeBaseUrl, cfg] as const),
        ).values(),
      );
      const settledSessionLists = await Promise.allSettled(
        sessionListConfigs.map((cfg) => listOpenCodeSessions(cfg)),
      );
      const sessions = settledSessionLists.flatMap((result) =>
        result.status === 'fulfilled' ? result.value : [],
      );
      const channelId = await this._getBridgeChannelId();
      await getConnectionsStore().refresh();
      const descriptors = this._connections.descriptors;
      const aliveSessionIds = new Set(sessions.map((session) => session.id));
      const staleScopedDescriptors = descriptors.filter(
        (descriptor) =>
          descriptor.kind === 'opencode-bridge-ws' &&
          typeof descriptor.meta?.tenantId === 'string' &&
          descriptor.meta.tenantId !== channelId,
      );

      // External session deletion is a real user action, not an error state.
      // During sidepanel restore, close ws links that still exist in the browser but no longer exist in opencode,
      // realigning runtime state with opencode truth.
      await Promise.all(
        staleScopedDescriptors.map(async (descriptor) => {
          const staleChannelId = String(descriptor.meta?.tenantId ?? '');
          try {
            await this._disconnectOpenCodeBridgeChannel(staleChannelId);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            spLog(
              `Failed to drop stale OpenCode bridge channel ${staleChannelId}: ${message}`,
              'warn',
            );
          }
        }),
      );
      await getConnectionsStore().refresh();

      if (!aliveSessionIds.has(lastSessionId)) {
        await this._disconnectOpenCodeBridgeChannel(channelId).catch(() => undefined);
        this._opencodeSessions = [];
        this._opencodeActiveSessionId = '';
        this._opencodeDraftSessionId = '';
        this._opencodeIframeOpen = false;
        this._opencodeMessage = 'Last session no longer exists. Cleared saved state.';
        await storageLocalRemove(OPENCODE_CONFIG_STORAGE_KEY);
        return;
      }

      const aliveScopedDescriptors = this._connections.descriptors.filter(
        (descriptor) =>
          descriptor.kind === 'opencode-bridge-ws' &&
          descriptor.status === 'connected' &&
          typeof descriptor.meta?.tenantId === 'string' &&
          descriptor.meta.tenantId === channelId,
      );
      const sessionById = new Map(sessions.map((session) => [session.id, session] as const));
      const restoredDescriptor = aliveScopedDescriptors[0] ?? null;
      this._opencodeSessions = savedSessions
        .filter((session) => aliveSessionIds.has(session.sessionId.trim()))
        .map((savedSession) =>
          this._buildOpenCodeSessionView(
            sessionById.get(savedSession.sessionId.trim()) ?? {
              id: savedSession.sessionId.trim(),
              directory: savedSession.directory,
              opencodeBaseUrl: savedSession.opencodeBaseUrl,
            },
            restoredDescriptor,
            channelId,
          ),
        );

      let activeDescriptor = restoredDescriptor;
      if (!activeDescriptor) {
        await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect, {
          sessionId: channelId,
          wsUrl: this._getOpenCodeExtWsUrl(channelId),
        });
        activeDescriptor = await this._waitForScopedConnection(channelId);
      }

      this._upsertOpenCodeSession(
        this._buildOpenCodeSessionView(
          sessionById.get(lastSessionId) ?? {
            id: lastSessionId,
            directory: lastSavedSession?.directory,
            opencodeBaseUrl: lastSavedSession?.opencodeBaseUrl,
          },
          activeDescriptor,
          channelId,
        ),
      );
      this._opencodeActiveSessionId = lastSessionId;
      this._opencodeMessage = `Restored session ${lastSessionId}`;
      await this._persistOpenCodeConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._opencodeMessage = `Restore skipped: ${message}`;
      spLog(`Failed to restore OpenCode config: ${message}`, 'warn');
    }
  }

  private async _persistOpenCodeConfig(): Promise<void> {
    const lastSessionId = this._opencodeActiveSessionId.trim();
    const sessions = this._opencodeSessions.map((session) => ({
      sessionId: session.sessionId,
      directory: session.sessionDirectory,
      opencodeBaseUrl: session.opencodeBaseUrl,
    }));
    await storageLocalSet({
      [OPENCODE_CONFIG_STORAGE_KEY]: {
        lastSessionId,
        // Support legacy fields so saved config is not lost after upgrades.
        sessionId: lastSessionId,
        sessions,
      } satisfies StoredOpenCodeConfig,
    });
  }

  // ─── Status & Tab Management ───────────────────────────────────
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
   * Build explicit bindings for feedback/runtime requests.
   * Rules:
   * - Prefer tabId when it is known.
   * - Use only windowId when tabId is missing but windowId exists.
   * - Omit binding fields when neither exists.
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

  // Context Manifest (page capabilities)

  /** Load the current tab context manifest and fill the left summary plus right details panel. */
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
   * Clear all context panel state and show a placeholder message.
   * Called when there is no active tab or manifest loading fails.
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
   * Build diff cards between raw and filtered manifests (hidden items plus trimmed tools).
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
   * Render one diff category card (Namespaces / Resources / Skills).
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

  /** Render the skill tool trimming card (recommended tools filtered out). */
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

  /** Read a resource payload through RPC and fill the right Data Payload card. */
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

  /** Fetch a skill prompt contract through RPC and fill the right Skill Prompt card. */
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

  // ─── Event Handlers ────────────────────────────────────────────
  private _handleTabClick(tab: SidePanelTab): void {
    this._activeTab = tab;
    this.requestUpdate();
    if (tab === 'tools') {
      void this._loadPageTools();
    } else if (tab === 'context') {
      void this._loadContextManifest();
    } else if (tab === 'feedback') {
      void this._loadFeedbackSnapshot();
    } else if (tab === 'connections') {
      void getConnectionsStore().refresh();
    }
  }

  private async _handleReconnect(): Promise<void> {
    if (this._refreshing) return;
    this._refreshing = true;
    this.requestUpdate();
    try {
      await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect);
      await getConnectionsStore().refresh();
    } catch (error) {
      spLog(`Reconnect failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setTimeout(() => {
        this._refreshing = false;
        this.requestUpdate();
      }, 800);
    }
  }

  private async _handleInjectAgentation(): Promise<void> {
    if (this._agentationInjecting) return;
    this._agentationInjecting = true;
    this.requestUpdate();
    try {
      const tabId = await this._getCurrentTabId();
      if (tabId == null) {
        throw new Error('No active tab');
      }
      await sendRuntimeRequest(BRIDGE_METHODS.extensionAgentationMainEnsure, { tabId });
      await getConnectionsStore().refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      spLog(`Agentation inject failed: ${message}`, 'error');
      await getConnectionsStore().refresh();
    } finally {
      this._agentationInjecting = false;
      this.requestUpdate();
    }
  }

  private async _handleOpencodeConnect(forceNewSession = false): Promise<void> {
    if (this._opencodeConnecting) {
      return;
    }

    this._opencodeConnecting = true;
    this._opencodeMessage = 'Resolving session...';
    this.requestUpdate();

    try {
      const session = await this._createOrReuseOpenCodeSession(forceNewSession);
      this._opencodeDraftSessionId = session.id;
      await this._connectOpenCodeSession(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._opencodeMessage = message;
      spLog(`OpenCode connect failed: ${message}`, 'error');
    } finally {
      this._opencodeConnecting = false;
      this.requestUpdate();
    }
  }

  private async _handleOpencodeDisconnect(
    sessionId = this._opencodeActiveSessionId,
  ): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return;
    }

    this._opencodeConnecting = true;
    this._opencodeMessage = 'Disconnecting...';
    this.requestUpdate();

    try {
      await this._disconnectOpenCodeBridgeSession(normalizedSessionId);
      await getConnectionsStore().refresh();

      this._removeOpenCodeSession(normalizedSessionId);
      if (this._opencodeActiveSessionId === normalizedSessionId) {
        const nextActiveSession = this._opencodeSessions[0];
        this._opencodeActiveSessionId = nextActiveSession?.sessionId ?? '';
        this._opencodeIframeOpen = false;
      }
      this._opencodeDraftSessionId = normalizedSessionId;
      await this._persistOpenCodeConfig();

      this._opencodeMessage = `Disconnected ${normalizedSessionId}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._opencodeMessage = message;
      spLog(`OpenCode disconnect failed: ${message}`, 'error');
    } finally {
      this._opencodeConnecting = false;
      this.requestUpdate();
    }
  }

  private async _handleCopyOpenCodeSessionId(sessionId: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(sessionId);
      this._opencodeMessage = `Copied ${shortenSessionId(sessionId)}`;
    } catch (error) {
      this._opencodeMessage = error instanceof Error ? error.message : String(error);
    }
    this.requestUpdate();
  }

  private _handleOpenOpenCodeIframe(sessionId = this._opencodeActiveSessionId): void {
    if (!sessionId) {
      return;
    }
    this._opencodeActiveSessionId = sessionId;
    this._opencodeDraftSessionId = sessionId;
    this._opencodeIframeOpen = true;
  }

  private _handleCloseOpenCodeIframe(): void {
    this._opencodeIframeOpen = false;
  }

  private _handleOpenOpenCodeSession(session: OpenCodeSessionView): void {
    if (session.webUrl) {
      void tabsCreate({ url: session.webUrl });
    }
  }

  private async _handleDeleteOpenCodeSession(sessionId: string): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || this._opencodeConnecting) {
      return;
    }

    this._opencodeConnecting = true;
    this._opencodeMessage = `Deleting ${shortenSessionId(normalizedSessionId)}...`;
    this.requestUpdate();

    try {
      await this._disconnectOpenCodeBridgeSession(normalizedSessionId).catch(() => undefined);
      await deleteOpenCodeSession(this._getOpenCodeConfig(), normalizedSessionId);
      await getConnectionsStore().refresh();
      this._removeOpenCodeSession(normalizedSessionId);
      if (this._opencodeActiveSessionId === normalizedSessionId) {
        const nextActiveSession = this._opencodeSessions[0];
        this._opencodeActiveSessionId = nextActiveSession?.sessionId ?? '';
        this._opencodeIframeOpen = false;
      }
      this._opencodeDraftSessionId = '';
      await this._persistOpenCodeConfig();
      this._opencodeMessage = `Deleted ${shortenSessionId(normalizedSessionId)}`;
    } catch (error) {
      this._opencodeMessage = error instanceof Error ? error.message : String(error);
    } finally {
      this._opencodeConnecting = false;
      this.requestUpdate();
    }
  }

  private _handleConnectionsEndpointsChanged(event: CustomEvent<ConnectionEndpointsConfig>): void {
    this._opencodeBaseUrl = event.detail.opencodeBaseUrl;
    this._bridgeBaseUrl = event.detail.bridgeBaseUrl;
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

  /** Handle sidepanel "Inspect Payload" clicks by delegating to _loadContextResource. */
  private _handleContextResourceClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.dataset.action !== 'read-resource') return;
    const resourceId = target.dataset.resourceId;
    if (resourceId) {
      void this._loadContextResource(resourceId);
    }
  }

  /** Handle sidepanel "Inspect Skill" clicks by delegating to _loadContextSkillPrompt. */
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

  private _getConnectionAttentionCount(): number {
    return this._connections.descriptors.filter(
      (descriptor) => descriptor.status === 'error' || descriptor.status === 'unreachable',
    ).length;
  }

  private _renderJourneyCard(input: {
    eyebrow: string;
    title: string;
    body: string;
    cta: string;
    tab: SidePanelTab;
    active?: boolean;
    tone?: 'primary' | 'warning' | 'neutral';
    meta?: string;
  }): TemplateResult {
    const toneClass =
      input.tone === 'primary'
        ? 'border-primary/40 bg-primary/10'
        : input.tone === 'warning'
          ? 'border-warning/50 bg-warning/10'
          : 'border-base-300 bg-base-100/80';
    return html`
      <button
        type="button"
        class="min-w-[13.5rem] flex-1 rounded-2xl border px-3 py-2.5 text-left shadow-sm transition-colors active:scale-[0.98] ${toneClass} ${input.active
          ? 'ring-1 ring-primary/50'
          : 'hover:border-primary/50'}"
        @click=${() => this._handleTabClick(input.tab)}
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-[10px] font-bold uppercase tracking-[0.16em] opacity-50">
            ${input.eyebrow}
          </span>
          ${input.meta
            ? html`<span class="badge badge-ghost badge-xs font-mono">${input.meta}</span>`
            : nothing}
        </div>
        <div class="mt-1 text-sm font-bold leading-snug">${input.title}</div>
        <p class="mt-1 text-[11px] leading-relaxed opacity-60">${input.body}</p>
        <div class="mt-2 text-[11px] font-semibold text-primary">${input.cta} →</div>
      </button>
    `;
  }

  private _renderProductJourney(): TemplateResult {
    const readiness = this._getOpenCodeReadiness();
    const attentionCount = this._getConnectionAttentionCount();
    const enabledTools = this._toolTreeResponse?.enabledTools ?? 0;
    const totalTools = this._toolTreeResponse?.totalTools ?? 0;
    const openFeedbackCount = this._feedbackSnapshot?.annotations?.length ?? 0;
    const settingsTone = attentionCount > 0 ? 'warning' : 'neutral';

    return html`
      <section
        class="border-b border-base-300 bg-base-200/50 px-3 py-2 shrink-0"
        aria-label="Real user story shortcuts"
      >
        <div class="mb-2 flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-[10px] font-bold uppercase tracking-[0.18em] opacity-50">
              Product paths
            </div>
            <div class="text-xs opacity-60 truncate">
              Use the real connection chain: configure endpoints first, connect OpenCode, verify
              page capabilities, then collect feedback.
            </div>
          </div>
          <button
            class="btn btn-xs btn-ghost shrink-0"
            @click=${() => this._handleTabClick('connections')}
            title="Open endpoint config"
          >
            Endpoint config
          </button>
        </div>
        <div class="flex gap-2 overflow-x-auto pb-1">
          ${this._renderJourneyCard({
            eyebrow: '01 · Setup',
            title: attentionCount > 0 ? 'Fix external connections' : 'Check endpoint config',
            body: 'Maintain OpenCode Base URL, Bridge Base URL, health checks, and diagnostics in one place.',
            cta: 'Open config',
            tab: 'connections',
            active: this._activeTab === 'connections',
            tone: settingsTone,
            meta: attentionCount > 0 ? `${attentionCount} issue` : 'ready',
          })}
          ${this._renderJourneyCard({
            eyebrow: '02 · AI workspace',
            title: readiness.title,
            body: 'Create or restore multi-session OpenCode and register scoped bridge MCP.',
            cta: 'Manage OpenCode',
            tab: 'opencode',
            active: this._activeTab === 'opencode',
            tone:
              readiness.tone === 'warning'
                ? 'warning'
                : readiness.tone === 'success'
                  ? 'primary'
                  : 'neutral',
            meta: `${this._opencodeSessions.length} session`,
          })}
          ${this._renderJourneyCard({
            eyebrow: '03 · Page capability',
            title: 'Validate current page tools',
            body: 'Debug callable tools in Tools tab; view resources, skills, and manifest diffs in Context tab.',
            cta: 'Inspect tools',
            tab: 'tools',
            active: this._activeTab === 'tools' || this._activeTab === 'context',
            meta: totalTools > 0 ? `${enabledTools}/${totalTools}` : 'loading',
          })}
          ${this._renderJourneyCard({
            eyebrow: '04 · Feedback loop',
            title: 'Turn issues into actionable feedback',
            body: 'Collect annotations, claim/reply/resolve, and push browser issues back into the collaboration pipeline.',
            cta: 'Review feedback',
            tab: 'feedback',
            active: this._activeTab === 'feedback',
            meta: `${openFeedbackCount}`,
          })}
        </div>
      </section>
    `;
  }

  private _renderOpenCodeIframeFullscreen(
    activeSession: OpenCodeSessionView,
    activeScopedDescriptor: ConnectionDescriptor | null,
  ): TemplateResult {
    return html`
      <section
        class="relative flex h-full min-h-0 flex-1 overflow-hidden bg-neutral text-neutral-content"
      >
        <iframe
          class="block h-full min-h-0 w-full flex-1 border-0 bg-base-100"
          data-session-id=${activeSession.sessionId}
          title=${`OpenCode session ${activeSession.sessionId}`}
          src=${activeSession.webUrl}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-pointer-lock allow-presentation"
          referrerpolicy="no-referrer"
        ></iframe>

        <div
          class="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-3"
        >
          <div
            class="pointer-events-auto min-w-0 max-w-[calc(100%-4rem)] rounded-2xl bg-neutral/80 px-3 py-2 text-neutral-content shadow-2xl backdrop-blur-md"
          >
            <p class="text-[10px] font-bold uppercase tracking-[0.2em] opacity-60">
              OpenCode sidebar iframe
            </p>
            <div class="mt-0.5 flex items-center gap-2 min-w-0">
              <span
                class="font-mono text-xs font-semibold truncate"
                title=${activeSession.sessionId}
              >
                ${shortenSessionId(activeSession.sessionId)}
              </span>
              ${activeScopedDescriptor
                ? html`<connection-status-badge
                    connection-id=${activeScopedDescriptor.id}
                  ></connection-status-badge>`
                : html`<span class="badge badge-outline badge-xs">pending</span>`}
            </div>
          </div>

          <button
            class="btn btn-sm btn-circle pointer-events-auto border-base-100/20 bg-neutral/80 text-neutral-content shadow-2xl backdrop-blur-md transition-transform duration-150 active:scale-[0.96] hover:bg-neutral"
            aria-label="Close OpenCode iframe"
            title="Close OpenCode iframe"
            @click=${() => this._handleCloseOpenCodeIframe()}
          >
            <svg
              class="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </section>
    `;
  }

  private _renderOpencodeTab(): TemplateResult {
    const activeSession = this._getActiveOpenCodeSession();
    const readiness = this._getOpenCodeReadiness();
    const activeScopedDescriptor = activeSession
      ? this._getOpenCodeScopedDescriptor(activeSession.sessionId)
      : null;

    return html`
      <div
        class="tab-content ${this._activeTab === 'opencode'
          ? 'active'
          : ''} flex flex-col flex-1 min-h-0"
      >
        <div class="flex flex-col gap-3 p-3 bg-base-200/40 flex-1 min-h-0 overflow-y-auto">
          <section
            class="rounded-2xl border p-4 shadow-sm bg-base-100 ${readiness.tone === 'success'
              ? 'border-success/40'
              : readiness.tone === 'warning'
                ? 'border-warning/50'
                : 'border-base-300'}"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-xs font-bold uppercase tracking-[0.18em] opacity-50">
                  OpenCode workspace
                </p>
                <h2 class="text-lg font-bold leading-tight">${readiness.title}</h2>
                <p class="text-xs opacity-60 mt-1 leading-relaxed">${readiness.detail}</p>
              </div>
              ${activeScopedDescriptor
                ? html`<connection-status-badge
                    connection-id=${activeScopedDescriptor.id}
                  ></connection-status-badge>`
                : html`<span class="badge badge-outline badge-sm">No session</span>`}
            </div>
            <div class="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div class="rounded-xl bg-base-200/70 px-3 py-2 min-w-0">
                <div class="opacity-50">Sessions</div>
                <div class="font-bold text-base">${this._opencodeSessions.length}</div>
              </div>
              <div class="rounded-xl bg-base-200/70 px-3 py-2 min-w-0">
                <div class="opacity-50">Active</div>
                <div
                  class="font-mono font-semibold truncate"
                  title=${activeSession?.sessionId ?? ''}
                >
                  ${activeSession ? shortenSessionId(activeSession.sessionId) : '—'}
                </div>
              </div>
              <div class="rounded-xl bg-base-200/70 px-3 py-2 min-w-0">
                <div class="opacity-50">Bridge</div>
                <div class="truncate">
                  ${activeScopedDescriptor
                    ? html`<connection-status-badge
                        connection-id=${activeScopedDescriptor.id}
                      ></connection-status-badge>`
                    : html`<span class="opacity-60">waiting</span>`}
                </div>
              </div>
            </div>
          </section>

          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs opacity-60 leading-relaxed">
              Endpoint config, health check, and all connection status are managed centrally in
              Endpoint config; OpenCode panel no longer provides configuration editing.
            </span>
            <button
              class="btn btn-xs btn-ghost"
              @click=${() => this._handleTabClick('connections')}
              title="Open endpoint config panel"
            >
              Open endpoint config
            </button>
          </div>

          <div
            class="rounded-2xl border border-base-300 bg-base-100 p-3 shadow-sm flex flex-col gap-2"
          >
            <div class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-2 items-end">
              <label class="form-control flex flex-col gap-1">
                <span class="text-xs font-semibold opacity-70">Session ID (optional)</span>
                <input
                  type="text"
                  class="input input-sm input-bordered font-mono"
                  .value=${this._opencodeDraftSessionId}
                  @input=${(event: Event) => {
                    this._opencodeDraftSessionId = (event.target as HTMLInputElement).value;
                  }}
                  placeholder="leave empty to create a new session"
                />
              </label>
              <div class="flex items-center gap-2">
                <button
                  class="btn btn-sm btn-primary ${this._opencodeConnecting ? 'loading' : ''}"
                  @click=${() => void this._handleOpencodeConnect()}
                  ?disabled=${this._opencodeConnecting}
                >
                  Connect
                </button>
                <button
                  class="btn btn-sm btn-secondary"
                  @click=${() => void this._handleOpencodeConnect(true)}
                  ?disabled=${this._opencodeConnecting}
                >
                  New Session
                </button>
                <button
                  class="btn btn-sm btn-outline"
                  @click=${() => void this._handleOpencodeDisconnect()}
                  ?disabled=${this._opencodeConnecting || !activeSession}
                >
                  Disconnect
                </button>
              </div>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-xs opacity-60 leading-relaxed">
                New Session creates an OpenCode session; Disconnect only tears down the scoped
                bridge, deleting a session requires the Delete action on the session card.
              </span>
              ${this._opencodeMessage
                ? html`<span class="text-xs opacity-60" role="status"
                    >${this._opencodeMessage}</span
                  >`
                : nothing}
            </div>
          </div>

          ${this._opencodeSessions.length > 0
            ? html`
                <div class="grid grid-cols-1 gap-2 xl:grid-cols-2">
                  ${repeat(
                    this._opencodeSessions,
                    (session) => session.sessionId,
                    (session) => {
                      const descriptor = this._getOpenCodeScopedDescriptor(session.sessionId);
                      const active = session.sessionId === this._opencodeActiveSessionId;
                      return html`
                        <div
                          class="rounded-2xl border bg-base-100 p-3 shadow-sm transition-colors ${active
                            ? 'border-primary ring-1 ring-primary/40 xl:col-span-2'
                            : 'border-base-300 hover:border-primary/50'}"
                        >
                          <div class="flex items-center justify-between gap-2">
                            <button
                              class="font-mono text-xs font-semibold truncate text-left hover:underline"
                              title=${session.wsUrl}
                              @click=${() => void this._selectOpenCodeSession(session.sessionId)}
                            >
                              ${shortenSessionId(session.sessionId)}
                            </button>
                            <div class="flex items-center gap-2">
                              ${active
                                ? html`<span class="badge badge-primary badge-xs">Active</span>`
                                : nothing}
                              ${descriptor
                                ? html`<connection-status-badge
                                    connection-id=${descriptor.id}
                                  ></connection-status-badge>`
                                : html`<span class="badge badge-outline badge-xs">pending</span>`}
                            </div>
                          </div>
                          <div class="text-[11px] opacity-50 truncate mt-1">
                            ${session.sessionDirectory || 'legacy route'}
                          </div>
                          ${active
                            ? html`
                                <div
                                  class="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-xl bg-base-200/70 px-3 py-2 text-[11px]"
                                >
                                  <span class="opacity-50">OpenCode URL</span>
                                  <span class="font-mono truncate" title=${session.webUrl}
                                    >${session.webUrl}</span
                                  >
                                  <span class="opacity-50">Bridge WS</span>
                                  <span class="font-mono truncate" title=${session.wsUrl}
                                    >${session.wsUrl}</span
                                  >
                                  <span class="opacity-50">Worktree</span>
                                  <span class="font-mono truncate" title=${session.sessionDirectory}
                                    >${session.sessionDirectory || 'legacy route'}</span
                                  >
                                  <span class="opacity-50">MCP</span>
                                  <span class="font-mono truncate"
                                    >page-context-${session.sessionId}</span
                                  >
                                </div>
                                <p class="mt-2 text-[11px] leading-relaxed opacity-60">
                                  Active is only the currently selected session. Clicking Sidebar
                                  opens the iframe fullscreen, and connections remain after closing
                                  it.
                                </p>
                              `
                            : nothing}
                          <div class="mt-2 flex flex-wrap items-center gap-1">
                            <button
                              class="btn btn-[10px] btn-ghost min-h-0 h-6 px-2"
                              title="Copy session id"
                              @click=${() =>
                                void this._handleCopyOpenCodeSessionId(session.sessionId)}
                            >
                              Copy
                            </button>
                            <button
                              class="btn btn-[10px] btn-ghost min-h-0 h-6 px-2"
                              title="Open this OpenCode session fullscreen in the sidebar"
                              @click=${() => this._handleOpenOpenCodeIframe(session.sessionId)}
                            >
                              Open in sidebar
                            </button>
                            <button
                              class="btn btn-[10px] btn-ghost min-h-0 h-6 px-2"
                              title="Open this OpenCode session in a browser tab"
                              @click=${() => this._handleOpenOpenCodeSession(session)}
                            >
                              Open
                            </button>
                            <button
                              class="btn btn-[10px] btn-ghost min-h-0 h-6 px-2"
                              title="Disconnect this session bridge link"
                              ?disabled=${this._opencodeConnecting}
                              @click=${() => void this._handleOpencodeDisconnect(session.sessionId)}
                            >
                              Disconnect
                            </button>
                            <button
                              class="btn btn-[10px] btn-error btn-outline min-h-0 h-6 px-2"
                              title="Delete this OpenCode session"
                              ?disabled=${this._opencodeConnecting}
                              @click=${() =>
                                void this._handleDeleteOpenCodeSession(session.sessionId)}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      `;
                    },
                  )}
                </div>
              `
            : html`
                <div class="flex flex-1 items-center justify-center px-6 py-8 text-center">
                  <div
                    class="max-w-sm rounded-3xl border border-dashed border-base-300 bg-base-100/80 p-6 shadow-sm"
                  >
                    <div class="text-3xl mb-2">⌘</div>
                    <div class="text-sm font-semibold">No OpenCode sessions yet</div>
                    <p class="text-xs opacity-60 mt-2 leading-relaxed">
                      Clicking New Session creates an OpenCode session, connects scoped bridge WS,
                      registers MCP, then embeds OpenCode directly in the current sidebar.
                    </p>
                    <button
                      class="btn btn-sm btn-primary mt-4 ${this._opencodeConnecting
                        ? 'loading'
                        : ''}"
                      @click=${() => void this._handleOpencodeConnect(true)}
                      ?disabled=${this._opencodeConnecting}
                    >
                      Start a session
                    </button>
                  </div>
                </div>
              `}
        </div>
      </div>
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
    const buildTimeLabel = formatBuildTimeLabel(
      this.getAttribute('data-build-time')?.trim() || 'dev',
    );
    const buildTimeText = `Build time: ${buildTimeLabel}`;
    const toolsCount = this._toolTreeResponse
      ? `(${this._toolTreeResponse.enabledTools}/${this._toolTreeResponse.totalTools} enabled) · ${buildTimeText}`
      : buildTimeText;
    const activeOpenCodeSession = this._getActiveOpenCodeSession();
    if (this._opencodeIframeOpen && activeOpenCodeSession) {
      return this._renderOpenCodeIframeFullscreen(
        activeOpenCodeSession,
        this._getOpenCodeScopedDescriptor(activeOpenCodeSession.sessionId),
      );
    }

    return html`
      <!-- Header: status-dot (clickable refresh) / title / icon-nav (right) -->
      <div
        class="flex items-center gap-2 px-3 py-1.5 bg-base-100 border-b border-base-300 shrink-0"
      >
        <button
          class="btn btn-xs btn-ghost btn-square shrink-0"
          @click=${this._handleReconnect}
          title="${this._refreshing ? 'Refreshing...' : 'Refresh sidepanel data'}"
        >
          <svg
            class="w-3.5 h-3.5 transition-opacity duration-200 ${this._refreshing
              ? 'animate-spin opacity-100'
              : 'opacity-70'}"
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
          title="Inject Agentation into the active tab"
        >
          Inject Agentation
        </button>
        <div role="tablist" class="tabs tabs-boxed ml-auto bg-transparent border-none gap-0.5">
          <button
            role="tab"
            class="tab tab-xs gap-1 px-2 ${this._activeTab === 'tools' ? 'tab-active' : ''}"
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
            <span class="hidden xl:inline">Tools</span>
          </button>
          <button
            role="tab"
            class="tab tab-xs gap-1 px-2 ${this._activeTab === 'context' ? 'tab-active' : ''}"
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
            <span class="hidden xl:inline">Context</span>
          </button>
          <button
            role="tab"
            class="tab tab-xs gap-1 px-2 ${this._activeTab === 'feedback' ? 'tab-active' : ''}"
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
            <span class="hidden xl:inline">Feedback</span>
          </button>
          <button
            role="tab"
            class="tab tab-xs gap-1 px-2 ${this._activeTab === 'connections' ? 'tab-active' : ''}"
            @click=${() => this._handleTabClick('connections')}
            title="Endpoint config"
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
              <path d="M9 12H5a3 3 0 0 1 0-6h4" />
              <path d="M15 6h4a3 3 0 1 1 0 6h-4" />
              <line x1="8" y1="12" x2="16" y2="12" />
              <line x1="12" y1="9" x2="12" y2="15" />
            </svg>
            <span class="hidden xl:inline">Config</span>
          </button>
          <button
            role="tab"
            class="tab tab-xs gap-1 px-2 ${this._activeTab === 'opencode' ? 'tab-active' : ''}"
            @click=${() => this._handleTabClick('opencode')}
            title="OpenCode"
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
              <path d="M16 18l6-6-6-6" />
              <path d="M8 6l-6 6 6 6" />
            </svg>
            <span class="hidden xl:inline">OpenCode</span>
          </button>
        </div>
      </div>

      ${this._renderProductJourney()}
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

      <connections-panel
        ?hidden=${this._activeTab !== 'connections'}
        @connections-endpoints-changed=${this._handleConnectionsEndpointsChanged}
      ></connections-panel>

      ${this._renderOpencodeTab()}
    `;
  }
  // end _renderContent
}

declare global {
  interface HTMLElementTagNameMap {
    'side-panel-app': SidePanelApp;
  }
}
