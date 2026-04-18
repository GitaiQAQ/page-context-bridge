import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { FeedbackAnnotation } from "@page-context/shared-protocol";

export interface FeedbackAgentPushAdapter {
  pushNewAnnotation(annotation: FeedbackAnnotation): void;
}

export interface LocalFeedbackAgentPushAdapterOptions {
  tenantId: string;
  opencodeBin: string;
  workingDirectory: string;
  model?: string;
  agentName?: string;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => Pick<ChildProcess, "on" | "unref">;
  log?: (message: string) => void;
}

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * 从环境变量构建本地 auto-push 适配器。
 * 默认关闭，避免在普通 bridge 运行时引入额外副作用。
 */
export function createFeedbackAgentPushAdapterFromEnv(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = defaultLog,
): FeedbackAgentPushAdapter | null {
  if (!isEnvEnabled(env.FEEDBACK_PUSH_AGENT_ENABLED)) {
    return null;
  }

  const opencodeBin = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_BIN) ?? "opencode";
  const workingDirectory = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_CWD) ?? process.cwd();
  const model = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_MODEL) ?? undefined;
  const agentName = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_NAME) ?? undefined;
  return new LocalFeedbackAgentPushAdapter({
    tenantId,
    opencodeBin,
    workingDirectory,
    model,
    agentName,
    log,
  });
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
