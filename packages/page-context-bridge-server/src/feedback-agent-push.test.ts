import type { SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { FeedbackAnnotation } from "@page-context/shared-protocol";

import {
  buildFeedbackAgentPrompt,
  createFeedbackAgentPushAdapterFromEnv,
  LocalFeedbackAgentPushAdapter,
} from "./feedback-agent-push.js";

function createAnnotation(overrides: Partial<FeedbackAnnotation> = {}): FeedbackAnnotation {
  return {
    id: "annotation_1",
    sessionId: "session_1",
    author: { source: "extension", id: "u1", displayName: "U1" },
    body: "列表加载慢",
    status: "open",
    priority: "high",
    target: {
      tabId: 9,
      url: "https://example.com/list",
    },
    context: {
      pageInfo: {
        tabId: 9,
        url: "https://example.com/list",
      },
    },
    linkedCapabilities: {
      namespaceHints: [],
      relatedToolNames: [],
      relatedResourceIds: [],
      relatedSkillIds: [],
      linkReasons: [],
    },
    thread: [],
    createdAt: "2026-04-18T00:00:00.000Z",
    updatedAt: "2026-04-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("feedback-agent-push adapter", () => {
  it("stays disabled when FEEDBACK_PUSH_AGENT_ENABLED is missing", () => {
    const adapter = createFeedbackAgentPushAdapterFromEnv("tenant-a", {});
    expect(adapter).toBeNull();
  });

  it("reads FEEDBACK_PUSH_AGENT_* envs when enabled", () => {
    const adapter = createFeedbackAgentPushAdapterFromEnv("tenant-a", {
      FEEDBACK_PUSH_AGENT_ENABLED: "true",
      FEEDBACK_PUSH_AGENT_BIN: "/usr/local/bin/opencode",
      FEEDBACK_PUSH_AGENT_CWD: "/tmp/project",
      FEEDBACK_PUSH_AGENT_MODEL: "gpt-5",
      FEEDBACK_PUSH_AGENT_NAME: "feedback-bot",
    });
    expect(adapter).toBeInstanceOf(LocalFeedbackAgentPushAdapter);
  });

  it("spawns opencode run once per annotation id", () => {
    const spawnCalls: Array<{ cmd: string; args: readonly string[]; options: SpawnOptions }> = [];
    const spawnProcess = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => {
      spawnCalls.push({ cmd: command, args, options });
      return {
        on: vi.fn(),
        unref: vi.fn(),
      };
    });

    const adapter = new LocalFeedbackAgentPushAdapter({
      tenantId: "tenant-z",
      opencodeBin: "opencode",
      workingDirectory: "/tmp/browser-debug-extension-feedback-agent-push",
      model: "gpt-5",
      agentName: "feedback-bot",
      spawnProcess,
    });

    const annotation = createAnnotation();
    adapter.pushNewAnnotation(annotation);
    adapter.pushNewAnnotation(annotation);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.cmd).toBe("opencode");
    expect(spawnCalls[0]?.options.cwd).toBe("/tmp/browser-debug-extension-feedback-agent-push");
    expect(spawnCalls[0]?.args[0]).toBe("run");
    expect(spawnCalls[0]?.args).toContain("-m");
    expect(spawnCalls[0]?.args).toContain("gpt-5");
    expect(spawnCalls[0]?.args).toContain("-agent");
    expect(spawnCalls[0]?.args).toContain("feedback-bot");
  });

  it("builds prompt with tenant + annotation identity and tool instructions", () => {
    const prompt = buildFeedbackAgentPrompt("tenant-z", createAnnotation({ id: "annotation_77" }));
    expect(prompt).toContain("tenant_id: tenant-z");
    expect(prompt).toContain("annotation_id: annotation_77");
    expect(prompt).toContain("feedback_get_annotation");
    expect(prompt).toContain("feedback_claim_annotation");
    expect(prompt).toContain("feedback_reply_annotation");
    expect(prompt).toContain("feedback_resolve_annotation");
  });
});
