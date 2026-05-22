import './browser-polyfill';

import { BRIDGE_METHODS } from '@page-context/shared-protocol';
import {
  createConsoleCapture,
  executeContentScriptTool,
  type ConsoleEntry,
} from '@page-context/builtin-tools';
import { createFeedbackUiAdapter } from './feedback-ui-adapter';
import { storageLocalSet } from './extension-api';
import { createRuntimeListener, sendRuntimeRequest } from './runtime-rpc';
import { requestReadonlyFromMainWorld } from './content-script-readonly-broker';

// 兼容 shared-protocol dist 未刷新时的运行态：method 字符串必须始终可用。
const CONTENT_READONLY_METHODS = {
  manifestGet:
    BRIDGE_METHODS.extensionContentContextManifestGet ?? 'extension.content.context.manifest.get',
  resourceRead:
    BRIDGE_METHODS.extensionContentContextResourceRead ?? 'extension.content.context.resource.read',
  skillGet: BRIDGE_METHODS.extensionContentContextSkillGet ?? 'extension.content.context.skill.get',
  pageToolsDiscover:
    BRIDGE_METHODS.extensionContentPageToolsDiscover ?? 'extension.content.pageTools.discover',
  pageToolExecute:
    BRIDGE_METHODS.extensionContentPageToolExecute ?? 'extension.content.pageTool.execute',
} as const;

const consoleEntries: ConsoleEntry[] = [];
const EXTENSION_E2E_REPORT_METHOD = 'extension.e2e.report';

function log(...args: unknown[]): void {
  if (process.env.NODE_ENV === 'development') {
    console.log('[PAGE-CONTEXT-CS]', ...args);
  }
}

createConsoleCapture(window, consoleEntries);
const feedbackUiAdapter = createFeedbackUiAdapter();

notifyFirefoxE2EContentScriptReady(window);

// ── Listen to MAIN world Agentation callback events ──
// MAIN world Agentation injection is no longer triggered automatically here;
// the side-panel exposes a button that calls extensionAgentationMainEnsure on demand.
// CustomEvent can cross Chrome Extension World boundaries (shared DOM event system)
// Agentation in the MAIN world sends annotation operations via dispatchEvent, which are received and forwarded to the bridge here.

interface AgentationAnnotationEventDetail {
  annotation: {
    id?: string;
    comment: string;
    severity?: 'blocking' | 'important' | 'suggestion';
    element?: string;
    elementPath?: string;
    fullPath?: string;
    reactComponents?: string;
    sourceFile?: string;
    isMultiSelect?: boolean;
    isFixed?: boolean;
    x?: number;
    y?: number;
    boundingBox?: { x: number; y: number; width: number; height: number };
    selectedText?: string;
  };
  timestamp: number;
}

/** Basic validation: discard events with no annotation, no comment, or outdated timestamps */
function isValidAnnotationEvent(detail: unknown): detail is AgentationAnnotationEventDetail {
  if (!detail || typeof detail !== 'object') return false;
  const d = detail as AgentationAnnotationEventDetail;
  if (!d.annotation || typeof d.annotation !== 'object') return false;
  if (typeof d.annotation.comment !== 'string' || !d.annotation.comment.trim()) return false;
  if (typeof d.timestamp !== 'number' || d.timestamp <= 0) return false;
  // Discard events older than 60s to prevent replay attacks
  if (Date.now() - d.timestamp > 60_000) return false;
  return true;
}

window.addEventListener('page-context:agentation:annotation:add', ((event: Event) => {
  const detail = (event as CustomEvent<AgentationAnnotationEventDetail>).detail;
  if (!isValidAnnotationEvent(detail)) return;

  const payload = buildCreatePayload(detail.annotation);
  if (!payload) return;

  void feedbackUiAdapter.createAnnotation?.(payload)?.catch((error) => {
    log('Failed to create annotation from MAIN world Agentation', error);
  });
}) as EventListener);

window.addEventListener('page-context:agentation:annotation:update', ((event: Event) => {
  const detail = (event as CustomEvent<AgentationAnnotationEventDetail>).detail;
  if (!isValidAnnotationEvent(detail)) return;

  const id = normalizeId(detail.annotation.id);
  const body = detail.annotation.comment.trim();
  if (!id || !body) return;

  void feedbackUiAdapter
    .updateAnnotation?.({
      annotationId: id,
      body,
      priority: toFeedbackPriority(detail.annotation.severity),
    })
    .catch((error) => {
      log('Failed to update annotation from MAIN world Agentation', error);
    });
}) as EventListener);

window.addEventListener('page-context:agentation:annotation:delete', ((event: Event) => {
  const detail = (event as CustomEvent<AgentationAnnotationEventDetail>).detail;
  if (!isValidAnnotationEvent(detail)) return;

  const id = normalizeId(detail.annotation.id);
  if (!id) return;

  void feedbackUiAdapter
    .dismissAnnotation?.({
      annotationId: id,
      dismissReason: 'deleted from agentation main world',
    })
    .catch((error) => {
      log('Failed to dismiss annotation from MAIN world Agentation', error);
    });
}) as EventListener);

// ── Tool execution listener (remains unchanged) ──

chrome.runtime.onMessage.addListener(
  createRuntimeListener(async (message) => {
    switch (message.method) {
      case CONTENT_READONLY_METHODS.manifestGet:
        return await requestReadonlyFromMainWorld(window, 'context.manifest.get');
      case CONTENT_READONLY_METHODS.resourceRead:
        return await requestReadonlyFromMainWorld(window, 'context.resource.read', message.params);
      case CONTENT_READONLY_METHODS.skillGet:
        return await requestReadonlyFromMainWorld(window, 'context.skill.get', message.params);
      case CONTENT_READONLY_METHODS.pageToolsDiscover:
        return await requestReadonlyFromMainWorld(window, 'page.tools.discover');
      case CONTENT_READONLY_METHODS.pageToolExecute:
        return await requestReadonlyFromMainWorld(window, 'page.tool.execute', message.params);
      case BRIDGE_METHODS.extensionToolExecute: {
        const payload = (message.params ?? {}) as { tool: string; args?: Record<string, unknown> };
        return executeContentScriptTool(payload.tool, payload.args ?? {}, {
          win: window,
          doc: document,
          consoleEntries,
        });
      }
      default:
        throw new Error(`Unknown content-script method: ${message.method}`);
    }
  }),
);

// ── Page event forwarding (remains unchanged) ──

window.addEventListener('message', (event) => {
  if (event.source !== window) {
    return;
  }
  const data = event.data;
  if (!data || typeof data !== 'object') {
    return;
  }

  if ((data as { type?: string }).type === 'PAGE_CONTEXT_REQUEST') {
    log('Forwarding page context request from page to background');
    void sendRuntimeRequest(BRIDGE_METHODS.extensionPageEvent, {
      payload: (data as { payload?: unknown }).payload,
    }).catch((error) => {
      log('Failed to forward page event', error);
    });
  }
});

// ── Helper function: convert Agentation raw annotation to bridge payload ──

function buildCreatePayload(ann: AgentationAnnotationEventDetail['annotation']) {
  const body = ann.comment?.trim();
  if (!body) return null;

  const targetRect = resolveTargetRect(ann);
  const selectedText = normalizeText(ann.selectedText);

  return {
    body,
    priority: toFeedbackPriority(ann.severity),
    selectedText,
    uiAnchor: buildUiAnchor(ann, targetRect, selectedText),
    target: {
      elementName: normalizeText(ann.element) ?? 'element',
      elementPath: normalizeText(ann.elementPath) ?? '',
      rect: targetRect,
    },
  };
}

function resolveTargetRect(ann: AgentationAnnotationEventDetail['annotation']): DOMRectReadOnly {
  const box = ann.boundingBox;
  if (box) {
    const viewportY = ann.isFixed ? box.y : box.y - window.scrollY;
    return new DOMRectReadOnly(box.x, viewportY, Math.max(1, box.width), Math.max(1, box.height));
  }

  const vx = Number.isFinite(ann.x) ? (ann.x! / 100) * window.innerWidth : window.innerWidth / 2;
  const ry = Number.isFinite(ann.y) ? ann.y! : window.innerHeight / 2;
  const vy = ann.isFixed ? ry : ry - window.scrollY;
  return new DOMRectReadOnly(vx, vy, 1, 1);
}

function buildUiAnchor(
  ann: AgentationAnnotationEventDetail['annotation'],
  rect: DOMRectReadOnly,
  selectedText?: string,
) {
  const meta: Record<string, unknown> = {
    source: 'agentation-main-world',
    element: normalizeText(ann.element),
    elementPath: normalizeText(ann.elementPath),
    fullPath: normalizeText(ann.fullPath),
    reactComponents: normalizeText(ann.reactComponents),
    sourceFile: normalizeText(ann.sourceFile),
  };
  if (ann.isMultiSelect) meta.isMultiSelect = true;
  if (ann.isFixed) meta.isFixed = true;

  return {
    cssSelector: toCssSelectorCandidate(ann.elementPath),
    textQuote: selectedText,
    framePath: [0],
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    meta,
  };
}

function toFeedbackPriority(severity?: string): 'critical' | 'high' | 'normal' {
  switch (severity) {
    case 'blocking':
      return 'critical';
    case 'important':
      return 'high';
    default:
      return 'normal';
  }
}

function toCssSelectorCandidate(elementPath?: string): string | undefined {
  const path = elementPath?.trim();
  if (!path || path.includes('⟨shadow⟩')) return undefined;
  const segments = path
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return undefined;
  const leaf = segments.at(-1);
  if (!leaf) return undefined;
  if (/^#[A-Za-z0-9_-]+$/.test(leaf)) return leaf;
  if (/^\.[A-Za-z0-9_-]+$/.test(leaf)) return leaf;
  if (/^[A-Za-z][A-Za-z0-9-]*$/.test(leaf)) return leaf.toLowerCase();
  return undefined;
}

function normalizeText(value?: string): string | undefined {
  return value?.trim() || undefined;
}

function normalizeId(value?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}

window.__PAGE_CONTEXT_BRIDGE_DEMO__ = () => {
  const selection = window.getSelection();
  const text = selection ? selection.toString() : '';

  window.postMessage(
    {
      type: 'PAGE_CONTEXT_REQUEST',
      payload: {
        type: 'demo.selection',
        text,
      },
    },
    '*',
  );
};

type FirefoxReadonlyRegistrationResult = {
  ok: boolean;
  registeredEntryCount: number;
  lastError?: string;
};

const firefoxReadonlyRegistrationPromise = registerFirefoxPageToolsFromReadonlyBridge();
void runFirefoxE2EProbeIfRequested();

async function registerFirefoxPageToolsFromReadonlyBridge(): Promise<FirefoxReadonlyRegistrationResult> {
  const runtimeManifest = chrome.runtime?.getManifest?.();
  const isFirefoxRuntime =
    Boolean(runtimeManifest?.browser_specific_settings?.gecko) ||
    /Firefox\//i.test(navigator.userAgent);
  if (!isFirefoxRuntime) {
    return { ok: false, registeredEntryCount: 0, lastError: 'Not running in Firefox runtime' };
  }

  const delays = [0, 500, 1500, 3000];
  let lastError: string | undefined;
  for (const delay of delays) {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      const entries = await requestReadonlyFromMainWorld<
        Array<{ namespace?: string; instanceId?: string; tools?: unknown[] }>
      >(window, 'page.tools.discover');
      if (!Array.isArray(entries) || entries.length === 0) {
        continue;
      }
      const validEntries = entries.filter(
        (entry) =>
          entry &&
          typeof entry.namespace === 'string' &&
          typeof entry.instanceId === 'string' &&
          Array.isArray(entry.tools) &&
          entry.tools.length > 0,
      );
      if (validEntries.length === 0) {
        continue;
      }
      await replayFirefoxPageToolRegistration(validEntries);
      log('Registered Firefox page tools from readonly bridge', validEntries.length);
      return { ok: true, registeredEntryCount: validEntries.length };
    } catch (error) {
      log('Firefox readonly tool registration attempt failed', error);
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ok: false,
    registeredEntryCount: 0,
    lastError,
  };
}

async function replayFirefoxPageToolRegistration(
  entries: Array<{ namespace: string; instanceId: string; tools: unknown[] }>,
): Promise<void> {
  await Promise.all(
    entries.map((entry) =>
      sendRuntimeRequest(BRIDGE_METHODS.extensionPageToolsRegister, {
        namespace: entry.namespace,
        instanceId: entry.instanceId,
        tools: entry.tools,
      }),
    ),
  );

  const replayDelays = [0, 300, 1_000, 3_000];
  void (async () => {
    for (const delay of replayDelays) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      await Promise.allSettled(
        entries.map((entry) =>
          sendRuntimeRequest(BRIDGE_METHODS.extensionPageToolsRegister, {
            namespace: entry.namespace,
            instanceId: entry.instanceId,
            tools: entry.tools,
          }),
        ),
      );
    }
  })();
}

async function runFirefoxE2EProbeIfRequested(): Promise<void> {
  const searchParams = new URLSearchParams(window.location.search);
  if (searchParams.get('__pcE2E') !== '1') {
    return;
  }
  const bootstrapOnly = searchParams.get('pcBootstrapOnly') === '1';

  const reportUrl = searchParams.get('__pcE2EReport');
  if (!reportUrl && !bootstrapOnly) {
    return;
  }

  const report: Record<string, unknown> = {
    href: window.location.href,
    contentScriptLoaded: true,
  };
  const expectedPageToolName = searchParams.get('pcExpectedToolName')?.trim() ?? '';
  const expectedPageToolNamespace = searchParams.get('pcExpectedToolNamespace')?.trim() ?? '';
  const expectedPageToolInstanceId = searchParams.get('pcExpectedToolInstanceId')?.trim() ?? '';
  const expectedPageToolArgsRaw = searchParams.get('pcExpectedToolArgs')?.trim() ?? '';
  const skipReadonlyExecute = searchParams.get('pcSkipReadonlyExecute') === '1';

  let expectedPageToolArgs: Record<string, unknown> = {};
  if (expectedPageToolArgsRaw) {
    try {
      const parsed = JSON.parse(expectedPageToolArgsRaw);
      if (parsed && typeof parsed === 'object') {
        expectedPageToolArgs = parsed as Record<string, unknown>;
      }
    } catch (error) {
      report.readonlyExecuteConfigError = error instanceof Error ? error.message : String(error);
    }
  }

  // bootstrapOnly 只负责把扩展后台和 WS 链路先唤起来，
  // 不在这个中转页上做真正的页面桥接断言，避免外部真实页还没跳转过去时
  // 就被 demo 页的探针结果抢先覆盖。
  if (bootstrapOnly) {
    const wsUrl = searchParams.get('__pcE2EWs');
    if (!wsUrl) {
      return;
    }
    try {
      await storageLocalSet({ mcpWsUrl: wsUrl });
      await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect);
    } catch (error) {
      log('Failed to bootstrap Firefox E2E WebSocket connection', error);
    }
    return;
  }

  try {
    const registration = await firefoxReadonlyRegistrationPromise;
    report.readonlyRegistrationOk = registration.ok;
    report.readonlyRegisteredEntryCount = registration.registeredEntryCount;
    if (registration.lastError) {
      report.readonlyRegistrationError = registration.lastError;
    }

    try {
      const readonlyEntries = await requestReadonlyFromMainWorld<Array<{ tools?: unknown[] }>>(
        window,
        'page.tools.discover',
      );
      const readonlyToolCount = Array.isArray(readonlyEntries)
        ? readonlyEntries.reduce(
            (count, entry) => count + (Array.isArray(entry?.tools) ? entry.tools.length : 0),
            0,
          )
        : 0;
      report.readonlyToolCount = readonlyToolCount;
    } catch (error) {
      report.readonlyToolCountError = error instanceof Error ? error.message : String(error);
      throw error;
    }

    // 这里必须做一次真实调用，避免“只能发现不能执行”的假阳性。
    // 但真实页面的工具名不固定，所以只在显式给出目标工具，或本地 demo 默认工具可用时执行。
    if (!skipReadonlyExecute) {
      try {
        const readonlyExecute = await requestReadonlyFromMainWorld<{
          ok?: boolean;
          result?: unknown;
          error?: string;
        }>(window, 'page.tool.execute', {
          pageToolName: expectedPageToolName || 'e2e-tool-1',
          namespace: expectedPageToolNamespace || 'e2e',
          instanceId: expectedPageToolInstanceId || 'test',
          args: expectedPageToolName ? expectedPageToolArgs : { probe: 'firefox-e2e' },
        });
        report.readonlyExecuteTarget = {
          pageToolName: expectedPageToolName || 'e2e-tool-1',
          namespace: expectedPageToolNamespace || 'e2e',
          instanceId: expectedPageToolInstanceId || 'test',
        };
        report.readonlyExecuteOk = Boolean(readonlyExecute?.ok);
        if (readonlyExecute?.result !== undefined) {
          report.readonlyExecuteResult = readonlyExecute.result;
        }
        if (readonlyExecute?.error) {
          report.readonlyExecuteError = readonlyExecute.error;
        }
      } catch (error) {
        report.readonlyExecuteThrownError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    } else {
      report.readonlyExecuteSkipped = true;
    }

    try {
      const runtimeDiscover = (await sendRuntimeRequest(BRIDGE_METHODS.extensionPageToolsDiscover, {
        source: 'firefox-e2e',
      })) as { tools?: unknown[] };
      report.runtimeDiscoveredToolCount = Array.isArray(runtimeDiscover?.tools)
        ? runtimeDiscover.tools.length
        : 0;
    } catch (error) {
      report.runtimeDiscoverError = error instanceof Error ? error.message : String(error);
      throw error;
    }

    try {
      const toolTree = (await sendRuntimeRequest(BRIDGE_METHODS.extensionPageToolsTreeGet)) as {
        totalTools?: number;
        enabledTools?: number;
        tabs?: Array<{ url?: string; totalTools?: number; enabledTools?: number }>;
      };
      report.toolTreeTotalTools = Number(toolTree?.totalTools ?? 0);
      report.toolTreeEnabledTools = Number(toolTree?.enabledTools ?? 0);
      const currentTabNode = Array.isArray(toolTree?.tabs)
        ? toolTree.tabs.find(
            (tab) => typeof tab?.url === 'string' && tab.url === window.location.href,
          )
        : undefined;
      report.currentTabToolCount = Number(currentTabNode?.totalTools ?? 0);
    } catch (error) {
      report.toolTreeError = error instanceof Error ? error.message : String(error);
      throw error;
    }

    const wsUrl = searchParams.get('__pcE2EWs');
    if (wsUrl) {
      try {
        await storageLocalSet({ mcpWsUrl: wsUrl });
        await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect);
        const deadline = Date.now() + 15_000;
        let connected = false;
        let sessionId: string | null = null;
        while (Date.now() < deadline) {
          const status = (await sendRuntimeRequest(BRIDGE_METHODS.extensionStatusGet)) as {
            connected?: boolean;
            sessionId?: string | null;
            pendingToolCalls?: number;
          };
          connected = Boolean(status?.connected);
          sessionId = typeof status?.sessionId === 'string' ? status.sessionId : null;
          if (connected) {
            report.wsPendingToolCalls = Number(status?.pendingToolCalls ?? 0);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        report.wsConnected = connected;
        report.wsSessionId = sessionId;
      } catch (error) {
        report.wsError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }

    report.ok =
      (Boolean(report.readonlyRegistrationOk) || Number(report.readonlyToolCount ?? 0) > 0) &&
      (Boolean(report.readonlyExecuteOk) || Boolean(report.readonlyExecuteSkipped)) &&
      Number(report.runtimeDiscoveredToolCount ?? 0) > 0 &&
      Number(report.currentTabToolCount ?? 0) > 0;
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
  }

  // 真实 HTTPS 页面上，直接 fetch(http://127.0.0.1:...) 可能被浏览器按 mixed content 拦掉。
  // 这里优先让扩展后台代发报告；后台同属扩展环境，更适合作为统一诊断出口。
  try {
    await sendRuntimeRequest(EXTENSION_E2E_REPORT_METHOD, {
      reportUrl,
      payload: report,
    });
  } catch (runtimeError) {
    try {
      await fetch(reportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });
    } catch (fetchError) {
      log('Failed to send Firefox E2E probe report', runtimeError, fetchError);
    }
  }
}

function notifyFirefoxE2EContentScriptReady(win: Window): void {
  const searchParams = new URLSearchParams(win.location.search);
  if (searchParams.get('__pcE2E') !== '1') {
    return;
  }

  // Firefox 的临时扩展安装与首个 start-url 导航存在时序竞争。
  // E2E fixture 页收到这个事件前会兜底自刷新几次，直到内容脚本真的注入成功。
  win.dispatchEvent(new CustomEvent('page-context:e2e:content-script-ready'));
}

declare global {
  interface Window {
    __PAGE_CONTEXT_BRIDGE_DEMO__?: () => void;
  }
}
