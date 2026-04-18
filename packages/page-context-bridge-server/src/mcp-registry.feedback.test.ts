import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PageContextManifest } from "@page-context/shared-protocol";

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

function createRegistry(feedbackAgentPushAdapter: FeedbackAgentPushAdapter | null = null) {
  return new McpRegistry({
    sendToolCall: async () => ({}),
    getContextManifest: async () => null,
    readContextResource: async () => ({ id: "r", text: "{}" }),
    getContextSkillPrompt: async () => null,
  }, "tenant-z", { feedbackAgentPushAdapter });
}

function parseTextResponse(payload: unknown) {
  const text = (payload as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

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
    });

    expect(created.context.pageInfo.app).toBe("crm");
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
});
