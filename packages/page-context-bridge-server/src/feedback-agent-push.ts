import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import type { FeedbackAnnotation } from "@page-context/shared-protocol";

import { getRuntimeEnv } from "./runtime-env.js";

export interface FeedbackAgentPushAdapter {
  pushNewAnnotation(annotation: FeedbackAnnotation): void;
}

export interface LocalFeedbackAgentPushAdapterOptions {
  tenantId: string;
  opencodeBin: string;
  workingDirectory: string;
  model?: string;
  agentName?: string;
  spawnEnv?: NodeJS.ProcessEnv;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => Pick<ChildProcess, "on" | "unref">;
  log?: (message: string) => void;
}

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DEFAULT_RUNTIME_DIR_NAME = ".feedback-agent-opencode";

/**
 * 从环境变量构建本地 auto-push 适配器。
 * 默认关闭，避免在普通 bridge 运行时引入额外副作用。
 */
export function createFeedbackAgentPushAdapterFromEnv(
  tenantId: string,
  env: NodeJS.ProcessEnv = getRuntimeEnv(),
  log: (message: string) => void = defaultLog,
): FeedbackAgentPushAdapter | null {
  if (!isEnvEnabled(env.FEEDBACK_PUSH_AGENT_ENABLED)) {
    return null;
  }

  const opencodeBin = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_BIN) ?? "opencode";
  const workingDirectory = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_CWD) ?? process.cwd();
  const model = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_MODEL) ?? undefined;
  const agentName = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_NAME) ?? undefined;
  const spawnEnv = buildFeedbackAgentSpawnEnv(env, workingDirectory);
  return new LocalFeedbackAgentPushAdapter({
    tenantId,
    opencodeBin,
    workingDirectory,
    model,
    agentName,
    spawnEnv,
    log,
  });
}

/**
 * 为 feedback agent 构建隔离的 opencode 运行环境。
 * 目标：默认不读取用户全局 ~/.config/opencode，且允许通过 FEEDBACK_PUSH_AGENT_* 精确覆盖。
 */
export function buildFeedbackAgentSpawnEnv(env: NodeJS.ProcessEnv, workingDirectory: string): NodeJS.ProcessEnv {
  const runtimeRoot = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_RUNTIME_ROOT)
    ?? join(workingDirectory, DEFAULT_RUNTIME_DIR_NAME);
  const home = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_HOME) ?? join(runtimeRoot, "home");
  const xdgConfigHome = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_XDG_CONFIG_HOME) ?? join(runtimeRoot, "config");
  const xdgDataHome = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_XDG_DATA_HOME) ?? join(runtimeRoot, "data");
  const xdgStateHome = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_XDG_STATE_HOME) ?? join(runtimeRoot, "state");
  const xdgCacheHome = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_XDG_CACHE_HOME) ?? join(runtimeRoot, "cache");

  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome,
    XDG_STATE_HOME: xdgStateHome,
    XDG_CACHE_HOME: xdgCacheHome,
  };
}

/**
 * 最小 bridge 侧本地推送：只负责“新注解 -> 一次 opencode run”。
 */
export class LocalFeedbackAgentPushAdapter implements FeedbackAgentPushAdapter {
  private readonly launchedAnnotationIds = new Set<string>();
  private readonly spawnProcess: NonNullable<LocalFeedbackAgentPushAdapterOptions["spawnProcess"]>;
  private readonly log: (message: string) => void;

  constructor(private readonly options: LocalFeedbackAgentPushAdapterOptions) {
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.log = options.log ?? defaultLog;
  }

  pushNewAnnotation(annotation: FeedbackAnnotation): void {
    // 进程内去重：同一 annotation 只尝试启动一次，避免重复推送。
    if (this.launchedAnnotationIds.has(annotation.id)) {
      return;
    }
    this.launchedAnnotationIds.add(annotation.id);

    const args: string[] = ["run"];
    if (this.options.model) {
      args.push("-m", this.options.model);
    }
    if (this.options.agentName) {
      // 与 opencode-protocol 的参数映射保持一致：agent => -agent
      args.push("-agent", this.options.agentName);
    }
    args.push(buildFeedbackAgentPrompt(this.options.tenantId, annotation));

    try {
      const child = this.spawnProcess(this.options.opencodeBin, args, {
        cwd: this.options.workingDirectory,
        env: this.options.spawnEnv,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", (error: unknown) => {
        this.log(`[feedback-agent-push] spawn error annotation=${annotation.id}: ${toErrorMessage(error)}`);
      });
      child.unref();
      this.log(`[feedback-agent-push] launched annotation=${annotation.id} session=${annotation.sessionId}`);
    } catch (error) {
      this.log(`[feedback-agent-push] launch failed annotation=${annotation.id}: ${toErrorMessage(error)}`);
    }
  }
}

export function buildFeedbackAgentPrompt(tenantId: string, annotation: FeedbackAnnotation): string {
  const body = annotation.body.trim() || "(empty)";
  const lines = [
    "你是 bridge 触发的本地 agent，需要处理一条新反馈注解。",
    `tenant_id: ${tenantId}`,
    `annotation_id: ${annotation.id}`,
    `session_id: ${annotation.sessionId}`,
    "",
    "先调用并仅调用现有 feedback_* MCP 工具推进流程：",
    `1) feedback_get_annotation({"annotationId":"${annotation.id}"})`,
    `2) feedback_claim_annotation({"annotationId":"${annotation.id}"})`,
    `3) feedback_reply_annotation({"annotationId":"${annotation.id}","body":"你的行动计划"})`,
    `4) 完成后 feedback_resolve_annotation({"annotationId":"${annotation.id}","resolution":"你的结论"})`,
    "",
    "下面是用户反馈原文：",
    body,
  ];
  return lines.join("\n");
}

function isEnvEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ENABLED_VALUES.has(value.trim().toLowerCase());
}

function pickFirstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (!value) {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function defaultLog(message: string): void {
  process.stderr.write(`[PAGE-CONTEXT-BRIDGE] ${message}\n`);
}
