import type { SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { FeedbackAnnotation } from "@page-context/shared-protocol";

import {
  buildFeedbackAgentSpawnEnv,
  buildFeedbackAgentPrompt,
  createFeedbackAgentPushAdapterFromEnv,
  createFeedbackPushAgentStatusFromEnv,
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

  it("builds isolated HOME/XDG_* env for opencode by default", () => {
    const spawnEnv = buildFeedbackAgentSpawnEnv({ PATH: "/usr/bin" }, "/tmp/project");
    expect(spawnEnv.PATH).toBe("/usr/bin");
    expect(spawnEnv.HOME).toBe("/tmp/project/.feedback-agent-opencode/home");
    expect(spawnEnv.XDG_CONFIG_HOME).toBe("/tmp/project/.feedback-agent-opencode/config");
    expect(spawnEnv.XDG_DATA_HOME).toBe("/tmp/project/.feedback-agent-opencode/data");
    expect(spawnEnv.XDG_STATE_HOME).toBe("/tmp/project/.feedback-agent-opencode/state");
    expect(spawnEnv.XDG_CACHE_HOME).toBe("/tmp/project/.feedback-agent-opencode/cache");
  });

  it("respects FEEDBACK_PUSH_AGENT_* env overrides for isolation paths", () => {
    const spawnEnv = buildFeedbackAgentSpawnEnv({
      FEEDBACK_PUSH_AGENT_RUNTIME_ROOT: "/tmp/custom-root",
      FEEDBACK_PUSH_AGENT_HOME: "/tmp/custom-home",
      FEEDBACK_PUSH_AGENT_XDG_CONFIG_HOME: "/tmp/custom-config",
      FEEDBACK_PUSH_AGENT_XDG_DATA_HOME: "/tmp/custom-data",
      FEEDBACK_PUSH_AGENT_XDG_STATE_HOME: "/tmp/custom-state",
      FEEDBACK_PUSH_AGENT_XDG_CACHE_HOME: "/tmp/custom-cache",
    }, "/tmp/project");
    expect(spawnEnv.HOME).toBe("/tmp/custom-home");
    expect(spawnEnv.XDG_CONFIG_HOME).toBe("/tmp/custom-config");
    expect(spawnEnv.XDG_DATA_HOME).toBe("/tmp/custom-data");
    expect(spawnEnv.XDG_STATE_HOME).toBe("/tmp/custom-state");
    expect(spawnEnv.XDG_CACHE_HOME).toBe("/tmp/custom-cache");
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
      spawnEnv: {
        PATH: "/usr/bin",
        HOME: "/tmp/agent-home",
        XDG_CONFIG_HOME: "/tmp/agent-config",
        XDG_DATA_HOME: "/tmp/agent-data",
        XDG_STATE_HOME: "/tmp/agent-state",
        XDG_CACHE_HOME: "/tmp/agent-cache",
      },
      spawnProcess,
    });

    const annotation = createAnnotation();
    adapter.pushNewAnnotation(annotation);
    adapter.pushNewAnnotation(annotation);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.cmd).toBe("opencode");
    expect(spawnCalls[0]?.options.cwd).toBe("/tmp/browser-debug-extension-feedback-agent-push");
    expect(spawnCalls[0]?.options.env?.HOME).toBe("/tmp/agent-home");
    expect(spawnCalls[0]?.options.env?.XDG_CONFIG_HOME).toBe("/tmp/agent-config");
    expect(spawnCalls[0]?.args[0]).toBe("run");
    expect(spawnCalls[0]?.args).toContain("-m");
    expect(spawnCalls[0]?.args).toContain("gpt-5");
    expect(spawnCalls[0]?.args).toContain("-agent");
    expect(spawnCalls[0]?.args).toContain("feedback-bot");
    const status = adapter.getPushAgentStatus();
    expect(status.enabled).toBe(true);
    expect(status.readiness).toBe("ready");
    expect(status.mode).toBe("local-opencode");
    expect(status.lastLaunch?.annotationId).toBe("annotation_1");
    expect(status.lastLaunch?.result).toBe("success");
    expect(status.lastLaunch?.failureReason).toBeUndefined();
  });

  it("captures launch failure reason when spawn throws", () => {
    const adapter = new LocalFeedbackAgentPushAdapter({
      tenantId: "tenant-z",
      opencodeBin: "opencode",
      workingDirectory: "/tmp/browser-debug-extension-feedback-agent-push",
      spawnProcess: () => {
        throw new Error("ENOENT: opencode not found");
      },
    });

    adapter.pushNewAnnotation(createAnnotation({ id: "annotation_fail" }));
    const status = adapter.getPushAgentStatus();
    expect(status.lastLaunch?.annotationId).toBe("annotation_fail");
    expect(status.lastLaunch?.result).toBe("failed");
    expect(status.lastLaunch?.failureReason).toContain("ENOENT");
  });

  it("derives disabled status from env when auto-push is off", () => {
    const status = createFeedbackPushAgentStatusFromEnv({});
    expect(status.enabled).toBe(false);
    expect(status.readiness).toBe("disabled");
    expect(status.mode).toBe("disabled");
    expect(status.lastLaunch).toBeNull();
  });

  it("builds prompt with tenant + annotation identity and tool instructions", () => {
    const prompt = buildFeedbackAgentPrompt("tenant-z", createAnnotation({ id: "annotation_77" }));
    expect(prompt).toContain("tenant_id: tenant-z");
    expect(prompt).toContain("annotation_id: annotation_77");
    expect(prompt).toContain("feedback_get_annotation");
    expect(prompt).toContain("feedback.claim");
    expect(prompt).toContain("feedback.reply");
    expect(prompt).toContain("feedback.resolve");
  });
});
