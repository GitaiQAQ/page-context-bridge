import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FeedbackPushAgentStatus, PageContextManifest } from "@page-context/shared-protocol";
import {
  FEEDBACK_CONTROL_LEGACY_TOOL_NAMES,
  FEEDBACK_CONTROL_TOOL_SUFFIXES,
} from "@page-context/builtin-tools";

import { McpRegistry } from "./mcp-registry.js";
import type { FeedbackAgentPushAdapter } from "./feedback-agent-push.js";

class FakeMcpServer {
  public readonly tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();

  registerTool(
    name: string,
    _schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): { remove: () => void } {
    this.tools.set(name, handler);
    return {
      remove: () => this.tools.delete(name),
    };
  }

  registerResource(): { remove: () => void } {
    return { remove: () => undefined };
  }

  registerPrompt(): { remove: () => void } {
    return { remove: () => undefined };
  }
}

function createRegistry(feedbackAgentPushAdapter: FeedbackAgentPushAdapter | null | undefined = null, env?: NodeJS.ProcessEnv) {
  return new McpRegistry({
    sendToolCall: async () => ({}),
    getRuntimeStatus: async () => ({ connected: true }),
    reconnectExtension: async () => ({ ok: true }),
    getContextManifest: async () => null,
    getContextManifestDebug: async () => ({ manifest: null, rawManifest: null, debug: null }),
    refreshPageTools: async () => [],
    readContextResource: async () => ({ id: "r", text: "{}" }),
    getContextSkillPrompt: async () => null,
    getPageToolsTree: async () => ({}),
    setPageToolsEnabledBatch: async () => ({}),
  }, "tenant-z", { feedbackAgentPushAdapter, env });
}

function parseTextResponse(payload: unknown) {
  const text = (payload as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

const FEEDBACK_CONTROL_TOOL_NAMES = {
  getSnapshot: `feedback.${FEEDBACK_CONTROL_TOOL_SUFFIXES.getSnapshot}`,
  createAnnotation: `feedback.${FEEDBACK_CONTROL_TOOL_SUFFIXES.createAnnotation}`,
  updateAnnotation: `feedback.${FEEDBACK_CONTROL_TOOL_SUFFIXES.updateAnnotation}`,
} as const;

describe("mcp-registry feedback tools", () => {
  it("derives links from manifest and page tools while creating annotation", () => {
    const registry = createRegistry();
    const manifest: PageContextManifest = {
      version: "1",
      app: "crm",
      route: "/lead/1",
      scene: "lead_detail",
      namespaces: [{ namespace: "lead", title: "Lead" }],
      resources: [{ id: "lead.profile", namespace: "lead", title: "Lead Profile" }],
      skills: [{ id: "lead.fix", namespace: "lead", title: "Lead Fix", description: "Fix lead issues" }],
      generatedAt: "2026-04-18T00:00:00.000Z",
    };

    registry.setPageTools(5, [{ name: "lead.inspect", description: "Inspect lead" }]);
    registry.syncContextManifestOnAllServers(5, manifest);

    const created = registry.createFeedbackAnnotation({
      body: "手机号格式异常",
      priority: "high",
      tabId: 5,
      url: "https://example.com/lead/1",
      uiAnchor: {
        cssSelector: ".lead-phone",
        framePath: [0],
        rect: { x: 1, y: 2, width: 3, height: 4 },
      },
    });

    expect(created.context.pageInfo.app).toBe("crm");
    expect(created.target.uiAnchor?.cssSelector).toBe(".lead-phone");
    expect(created.context.uiAnchor?.rect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(created.linkedCapabilities.namespaceHints).toContain("lead");
    expect(created.linkedCapabilities.relatedToolNames).toContain("lead.inspect");
    expect(created.linkedCapabilities.relatedResourceIds).toContain("lead.profile");
    expect(created.linkedCapabilities.relatedSkillIds).toContain("lead.fix");
  });

  it("triggers local feedback agent push after annotation is created", () => {
    const pushedIds: string[] = [];
    const registry = createRegistry({
      pushNewAnnotation: (annotation) => {
        pushedIds.push(annotation.id);
      },
    });

    const created = registry.createFeedbackAnnotation({
      body: "提交按钮无响应",
      tabId: 7,
      url: "https://example.com/form",
    });

    expect(pushedIds).toEqual([created.id]);
  });

  it("keeps annotation creation successful when agent push throws", () => {
    const registry = createRegistry({
      pushNewAnnotation: () => {
        throw new Error("spawn failed");
      },
    });

    // agent 触发失败不应回滚 annotation 创建，仓库状态要先落地成功。
    const created = registry.createFeedbackAnnotation({
      body: "异常兜底验证",
      tabId: 13,
      url: "https://example.com/fallback",
    });

    expect(created.body).toBe("异常兜底验证");
    const annotations = registry.listFeedbackAnnotations({ tabId: 13 });
    expect(annotations.some((item) => item.id === created.id)).toBe(true);
  });

  it("exposes push-agent status in snapshot and keeps failure reason", () => {
    let status: FeedbackPushAgentStatus = {
      enabled: true,
      readiness: "ready",
      mode: "custom",
      lastLaunch: null,
    };

    const registry = createRegistry({
      pushNewAnnotation: (annotation) => {
        status = {
          ...status,
          lastLaunch: {
            annotationId: annotation.id,
            sessionId: annotation.sessionId,
            attemptedAt: "2026-04-23T00:00:00.000Z",
            result: "failed",
            failureReason: "spawn timeout",
          },
        };
      },
      getPushAgentStatus: () => ({ ...status, lastLaunch: status.lastLaunch ? { ...status.lastLaunch } : null }),
    });

    const created = registry.createFeedbackAnnotation({
      body: "auto push 失败可观测性",
      tabId: 21,
      url: "https://example.com/failure",
    });
    const snapshot = registry.getFeedbackSnapshot({ tabId: 21 });

    expect(snapshot.pushAgent?.enabled).toBe(true);
    expect(snapshot.pushAgent?.readiness).toBe("ready");
    expect(snapshot.pushAgent?.mode).toBe("custom");
    expect(snapshot.pushAgent?.lastLaunch?.annotationId).toBe(created.id);
    expect(snapshot.pushAgent?.lastLaunch?.result).toBe("failed");
    expect(snapshot.pushAgent?.lastLaunch?.failureReason).toBe("spawn timeout");
  });

  it("returns disabled push-agent status when auto-push env is off", () => {
    const registry = createRegistry(undefined, {
      FEEDBACK_PUSH_AGENT_ENABLED: "0",
    });

    const snapshot = registry.getFeedbackSnapshot();
    expect(snapshot.pushAgent).toEqual({
      enabled: false,
      readiness: "disabled",
      mode: "disabled",
      lastLaunch: null,
    });
  });

  it("registers MCP feedback tools and returns cursor-based events", async () => {
    const registry = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    expect(fakeServer.tools.has("feedback_watch_events")).toBe(true);
    expect(fakeServer.tools.has("feedback_claim_annotation")).toBe(true);

    const created = registry.createFeedbackAnnotation({
      body: "列表加载慢",
      tabId: 3,
      url: "https://example.com/list",
    });

    const claim = fakeServer.tools.get("feedback_claim_annotation");
    await claim?.({ annotationId: created.id, actorId: "agent-1", actorName: "Agent One" });

    const watch = fakeServer.tools.get("feedback_watch_events");
    const watched = await watch?.({ afterSeq: 0 });
    const parsed = parseTextResponse(watched);
    const events = parsed.events as Array<{ eventType: string }>;
    expect(events.map((item) => item.eventType)).toEqual([
      "session.started",
      "annotation.created",
      "annotation.claimed",
    ]);
    expect(typeof parsed.lastSeq).toBe("number");
  });

  it("registers namespaced feedback control tools and keeps legacy aliases", () => {
    const registry = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    expect(fakeServer.tools.has(FEEDBACK_CONTROL_TOOL_NAMES.getSnapshot)).toBe(true);
    expect(fakeServer.tools.has(FEEDBACK_CONTROL_TOOL_NAMES.createAnnotation)).toBe(true);
    expect(fakeServer.tools.has(FEEDBACK_CONTROL_TOOL_NAMES.updateAnnotation)).toBe(true);
    expect(fakeServer.tools.has(FEEDBACK_CONTROL_LEGACY_TOOL_NAMES.getSnapshot)).toBe(true);
    expect(fakeServer.tools.has(FEEDBACK_CONTROL_LEGACY_TOOL_NAMES.createAnnotation)).toBe(true);
    expect(fakeServer.tools.has(FEEDBACK_CONTROL_LEGACY_TOOL_NAMES.updateAnnotation)).toBe(true);
  });

  it("supports snapshot/create/update through namespaced feedback control tools", async () => {
    const registry = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const create = fakeServer.tools.get(FEEDBACK_CONTROL_TOOL_NAMES.createAnnotation);
    const createdPayload = await create?.({
      body: "首版问题描述",
      priority: "normal",
      tabId: 33,
      url: "https://example.com/feedback",
      actorId: "agent-9",
      actorName: "Agent Nine",
    });
    const created = parseTextResponse(createdPayload).annotation as { id: string; body: string; priority: string };

    const update = fakeServer.tools.get(FEEDBACK_CONTROL_TOOL_NAMES.updateAnnotation);
    const updatedPayload = await update?.({
      annotationId: created.id,
      body: "修订后的问题描述",
      priority: "high",
    });
    const updated = parseTextResponse(updatedPayload).annotation as { body: string; priority: string };

    const getSnapshot = fakeServer.tools.get(FEEDBACK_CONTROL_TOOL_NAMES.getSnapshot);
    const snapshotPayload = await getSnapshot?.({ tabId: 33 });
    const snapshot = parseTextResponse(snapshotPayload);
    const annotations = snapshot.annotations as Array<{ id: string; body: string; priority: string }>;

    // 这里验证“同一条 annotation 经由 MCP create+update 后，快照可直接拉到最终态”。
    expect(updated.body).toBe("修订后的问题描述");
    expect(updated.priority).toBe("high");
    expect(annotations.some((item) =>
      item.id === created.id
      && item.body === "修订后的问题描述"
      && item.priority === "high")).toBe(true);
  });

  it("updates and dismisses annotation through registry methods", () => {
    const registry = createRegistry();
    const created = registry.createFeedbackAnnotation({
      body: "初始内容",
      priority: "normal",
      tabId: 11,
      url: "https://example.com/form",
    });

    const updated = registry.updateFeedbackAnnotation({
      annotationId: created.id,
      body: "编辑后的内容",
      priority: "critical",
    });
    expect(updated.body).toBe("编辑后的内容");
    expect(updated.priority).toBe("critical");

    const dismissed = registry.dismissFeedbackAnnotation({
      annotationId: created.id,
      dismissReason: "marker deleted from agentation shell",
    });
    expect(dismissed.status).toBe("dismissed");
    expect(dismissed.dismissReason).toContain("marker deleted");
  });
});
