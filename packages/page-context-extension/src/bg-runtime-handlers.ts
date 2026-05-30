/**
 * runtime.onMessage business handler factory.
 * This module handles only protocol dispatch and parameter validation;
 * all state is provided via dependency injection.
 */
import {
  BRIDGE_METHODS,
  CONNECTION_METHODS,
  type FeedbackAnnotationClaimParams,
  type FeedbackAnnotationDismissParams,
  type FeedbackAnnotationReplyParams,
  type FeedbackAnnotationResolveParams,
  type FeedbackRuntimeCreatePayload,
  type FeedbackRuntimeUpdatePayload,
  type FeedbackStateDeltaParams,
  type FeedbackStateSnapshotParams,
  RpcProtocolError,
  RPC_ERROR_CODES,
} from '@page-context/shared-protocol';

import { captureActiveTabFeedbackContext } from './bg-feedback-context';
import {
  ensureAgentationMainOnSenderTab,
  ensureAgentationMainOnTab,
  ensureMainWorldBridgeHostOnSenderTab,
  enrichUiAnchorReactMetaInMainWorld,
  type MainWorldBridgeHostInstaller,
} from '@page-context/agentation';
import {
  ensurePageToolPreferencesLoaded,
  publishPageToolsForTab,
  type PageToolState,
} from './bg-page-tools';
import {
  buildFeedbackAnnotationCreateParams,
  buildFeedbackAnnotationUpdateParams,
} from './background-feedback-adapters';
import {
  mergePageToolEntry,
  normalizePageToolEntries,
  type PageToolSpec,
} from '@page-context/tool-visibility';
import type { ExtensionControlHandlers } from './bg-ws-handlers';
import type { RuntimeExplicitTabBinding, RuntimeExplicitTabBindingInput } from './sidepanel-types';
import { getConnectionRegistry } from './bg-connection-registry';

type JsonRecord = Record<string, unknown>;
const EXTENSION_E2E_REPORT_METHOD = 'extension.e2e.report';

function withSenderTabId(params: unknown, sender: chrome.runtime.MessageSender): unknown {
  const senderTabId = sender.tab?.id;
  if (!senderTabId) {
    return params;
  }
  if (params == null) {
    return { tabId: senderTabId };
  }
  if (typeof params !== 'object') {
    return params;
  }
  const record = params as Record<string, unknown>;
  if (typeof record.tabId === 'number' && Number.isFinite(record.tabId)) {
    return params;
  }
  return { ...record, tabId: senderTabId };
}

/**
 * Runtime binding field normalization:
 * - Prefer the new tabId field.
 * - Fall back to the compatible boundTabId field.
 * - Pass windowId through only when present.
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

async function postFirefoxE2EReport(params: unknown): Promise<{ ok: true }> {
  const payload = params as {
    reportUrl?: unknown;
    payload?: unknown;
  };
  const reportUrl =
    typeof payload.reportUrl === 'string' && payload.reportUrl.trim()
      ? payload.reportUrl.trim()
      : '';
  if (!reportUrl) {
    throw new Error('E2E reportUrl is required');
  }

  // Proxy diagnostics through the extension background to avoid mixed-content blocks from HTTPS pages to local HTTP ports.
  await fetch(reportUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload.payload ?? {}),
  });
  return { ok: true };
}

interface RuntimeRpcMessage {
  method: string;
  params?: unknown;
}

interface CreateRuntimeMessageHandlerDeps {
  pageToolState: PageToolState;
  installPageContextBridgeHostInMainWorld: MainWorldBridgeHostInstaller;
  extensionControlHandlers: ExtensionControlHandlers;
  requestBridgeMethod<TResult>(method: string, params?: unknown): Promise<TResult>;
  queueNotification(method: string, params?: unknown): void;
}

export function createRuntimeMessageHandler(deps: CreateRuntimeMessageHandlerDeps) {
  return async (
    message: RuntimeRpcMessage,
    sender: chrome.runtime.MessageSender,
  ): Promise<unknown> => {
    // Both runtime and WS must read preferences first to keep tool view and filtering behavior consistent.
    await ensurePageToolPreferencesLoaded(deps.pageToolState);

    switch (message.method) {
      case EXTENSION_E2E_REPORT_METHOD:
        return await postFirefoxE2EReport(message.params);
      case BRIDGE_METHODS.extensionStatusGet:
        return deps.extensionControlHandlers.buildExtensionStatusResponse(message.params);
      case CONNECTION_METHODS.list:
        return await getConnectionRegistry().handleList();
      case CONNECTION_METHODS.subscribe:
        return await getConnectionRegistry().handleSubscribe();
      case CONNECTION_METHODS.action:
        return await getConnectionRegistry().handleAction(
          message.params as {
            descriptorId: string;
            action: 'reconnect' | 'disconnect';
          },
        );
      case BRIDGE_METHODS.extensionReconnect:
        return await deps.extensionControlHandlers.handleExtensionReconnect(message.params);
      case BRIDGE_METHODS.extensionPageToolsGet:
        return deps.extensionControlHandlers.handleExtensionPageToolsGet(message.params);
      case BRIDGE_METHODS.extensionPageToolsTreeGet:
        return await deps.extensionControlHandlers.handleExtensionPageToolsTreeGet();
      case BRIDGE_METHODS.extensionPageToolsDiscover:
      case BRIDGE_METHODS.extensionPageToolsRefresh:
        return await deps.extensionControlHandlers.handleExtensionPageToolsRefresh(
          withSenderTabId(message.params, sender),
        );
      case BRIDGE_METHODS.extensionContextManifestGet:
        return await deps.extensionControlHandlers.handleExtensionContextManifestGet(
          message.params,
        );
      case BRIDGE_METHODS.extensionContextResourceRead:
        return await deps.extensionControlHandlers.handleExtensionContextResourceRead(
          message.params,
        );
      case BRIDGE_METHODS.extensionContextSkillGet:
        return await deps.extensionControlHandlers.handleExtensionContextSkillGet(message.params);
      case BRIDGE_METHODS.extensionFeedbackStateSnapshot: {
        const payload = (message.params ?? {}) as FeedbackStateSnapshotParams &
          RuntimeExplicitTabBindingInput;
        // Unified binding semantics: tabId > boundTabId; windowId is only a fallback when sender.tab is missing.
        const runtimeBinding = normalizeRuntimeExplicitTabBinding(payload);
        const params: FeedbackStateSnapshotParams = {
          tabId: runtimeBinding.tabId,
          sessionId: payload.sessionId,
        };
        if (params.tabId == null && !params.sessionId) {
          // Bind sender.tab first; fall back to active tab only when sidepanel has no sender.tab to avoid cross-tab leakage.
          const context = await captureActiveTabFeedbackContext(sender, {
            windowId: runtimeBinding.windowId,
          }).catch(() => null);
          params.tabId = context?.tabId;
        }
        return await deps.requestBridgeMethod(BRIDGE_METHODS.feedbackStateSnapshot, params);
      }
      case BRIDGE_METHODS.extensionFeedbackStateDelta: {
        const payload = (message.params ?? {}) as FeedbackStateDeltaParams;
        const afterSeq = Number(payload.afterSeq ?? 0);
        if (!Number.isFinite(afterSeq) || afterSeq < 0) {
          throw new Error('Feedback delta afterSeq must be a non-negative number');
        }
        const params: FeedbackStateDeltaParams = {
          ...payload,
          afterSeq,
        };
        return await deps.requestBridgeMethod(BRIDGE_METHODS.feedbackStateDelta, params);
      }
      case BRIDGE_METHODS.extensionFeedbackAnnotationCreate: {
        const payload = (message.params ?? {}) as FeedbackRuntimeCreatePayload &
          RuntimeExplicitTabBindingInput;
        if (!payload.body?.trim()) {
          throw new Error('Feedback body is required');
        }
        if (!payload.priority) {
          throw new Error('Feedback priority is required');
        }
        const runtimeBinding = normalizeRuntimeExplicitTabBinding(payload);
        // UI annotations from content-script must bind sender tab; borrowing the current active tab is not allowed.
        const context = await captureActiveTabFeedbackContext(sender, runtimeBinding);
        // Only enrich MAIN world info on the uiAnchor path; keep original value on failure so the main flow is not slowed by extra probing.
        if (payload.uiAnchor) {
          payload.uiAnchor = await enrichUiAnchorReactMetaInMainWorld(
            context.tabId,
            payload.uiAnchor,
          );
        }
        return await deps.requestBridgeMethod(
          BRIDGE_METHODS.feedbackAnnotationCreate,
          buildFeedbackAnnotationCreateParams(payload, context),
        );
      }
      case BRIDGE_METHODS.extensionFeedbackAnnotationUpdate: {
        const payload = (message.params ?? {}) as FeedbackRuntimeUpdatePayload;
        if (!payload.annotationId?.trim()) {
          throw new Error('Feedback annotationId is required');
        }
        if (!payload.body?.trim()) {
          throw new Error('Feedback body is required');
        }
        if (!payload.priority) {
          throw new Error('Feedback priority is required');
        }
        return await deps.requestBridgeMethod(
          BRIDGE_METHODS.feedbackAnnotationUpdate,
          buildFeedbackAnnotationUpdateParams(payload),
        );
      }
      case BRIDGE_METHODS.extensionFeedbackAnnotationClaim: {
        const payload = (message.params ?? {}) as FeedbackAnnotationClaimParams;
        return await deps.requestBridgeMethod(BRIDGE_METHODS.feedbackAnnotationClaim, payload);
      }
      case BRIDGE_METHODS.extensionFeedbackAnnotationReply: {
        const payload = (message.params ?? {}) as FeedbackAnnotationReplyParams;
        return await deps.requestBridgeMethod(BRIDGE_METHODS.feedbackAnnotationReply, payload);
      }
      case BRIDGE_METHODS.extensionFeedbackAnnotationResolve: {
        const payload = (message.params ?? {}) as FeedbackAnnotationResolveParams;
        return await deps.requestBridgeMethod(BRIDGE_METHODS.feedbackAnnotationResolve, payload);
      }
      case BRIDGE_METHODS.extensionFeedbackAnnotationDismiss: {
        const payload = (message.params ?? {}) as FeedbackAnnotationDismissParams;
        // Guard against empty annotationId at the extension boundary to prevent invalid requests from reaching the bridge.
        if (!payload.annotationId?.trim()) {
          throw new Error('Feedback annotationId is required');
        }
        payload.annotationId = payload.annotationId.trim();
        if (payload.dismissReason) {
          payload.dismissReason = payload.dismissReason.trim() || undefined;
        }
        return await deps.requestBridgeMethod(BRIDGE_METHODS.feedbackAnnotationDismiss, payload);
      }
      case BRIDGE_METHODS.extensionPageEvent:
        deps.queueNotification(BRIDGE_METHODS.bridgePageEvent, {
          tabId: sender.tab?.id ?? null,
          payload: (message.params as { payload?: unknown })?.payload,
        });
        return { ok: true };
      case BRIDGE_METHODS.extensionPageToolsRegister: {
        const payload = message.params as {
          namespace?: string;
          instanceId?: string;
          tools?: PageToolSpec[];
        };
        const tabId = sender.tab?.id;
        if (!tabId) {
          throw new Error('No sender tab available');
        }
        const entry = normalizePageToolEntries([
          {
            namespace: payload.namespace ?? 'page',
            instanceId: payload.instanceId ?? 'default',
            tools: payload.tools ?? [],
          },
        ])[0]!;
        const mergedEntries = mergePageToolEntry(
          deps.pageToolState.pageToolsByTab.get(tabId) ?? [],
          entry,
        );
        deps.pageToolState.pageToolsByTab.set(tabId, mergedEntries);
        publishPageToolsForTab(deps.pageToolState, tabId);
        return { ok: true };
      }
      case BRIDGE_METHODS.extensionPageToolsSetEnabled:
        return await deps.extensionControlHandlers.handleExtensionPageToolsSetEnabled(
          message.params,
        );
      case BRIDGE_METHODS.extensionToolDebugCall:
        return await deps.extensionControlHandlers.handleExtensionToolDebugCall(message.params);
      case BRIDGE_METHODS.extensionMainWorldHostEnsure:
        return await ensureMainWorldBridgeHostOnSenderTab(
          sender,
          deps.installPageContextBridgeHostInMainWorld,
        );
      case BRIDGE_METHODS.extensionAgentationMainEnsure: {
        const params = (message.params ?? {}) as { tabId?: number; frameId?: number };
        if (
          typeof params.tabId === 'number' &&
          Number.isInteger(params.tabId) &&
          params.tabId > 0
        ) {
          return await ensureAgentationMainOnTab(params.tabId, params.frameId);
        }
        return await ensureAgentationMainOnSenderTab(sender);
      }
      default:
        throw new RpcProtocolError(
          RPC_ERROR_CODES.methodNotFound,
          `Unhandled runtime method: ${message.method}`,
        );
    }
  };
}
