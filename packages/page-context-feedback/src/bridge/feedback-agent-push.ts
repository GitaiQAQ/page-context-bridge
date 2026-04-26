import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import type { FeedbackAnnotation, FeedbackPushAgentStatus } from '@page-context/shared-protocol';

function getRuntimeEnv(): NodeJS.ProcessEnv {
  const globalWithProcess = globalThis as typeof globalThis & {
    process?: { env?: NodeJS.ProcessEnv };
  };
  return globalWithProcess.process?.env ?? {};
}

export interface FeedbackAgentPushAdapter {
  pushNewAnnotation(annotation: FeedbackAnnotation): void;
}

export interface FeedbackAgentPushStatusReader {
  getPushAgentStatus(): FeedbackPushAgentStatus;
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
  ) => Pick<ChildProcess, 'on' | 'unref'>;
  log?: (message: string) => void;
}

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);
const DEFAULT_RUNTIME_DIR_NAME = '.feedback-agent-opencode';

/**
 * Create local auto-push adapter from environment variables.
 * Disabled by default to avoid introducing extra side effects in normal bridge runtime.
 */
export function createFeedbackAgentPushAdapterFromEnv(
  tenantId: string,
  env: NodeJS.ProcessEnv = getRuntimeEnv(),
  log: (message: string) => void = defaultLog,
): FeedbackAgentPushAdapter | null {
  if (!isEnvEnabled(env.FEEDBACK_PUSH_AGENT_ENABLED)) {
    return null;
  }

  const opencodeBin = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_BIN) ?? 'opencode';
  const workingDirectory = pickFirstNonEmpty(env.FEEDBACK_AGENT_CWD) ?? process.cwd();
  const model = pickFirstNonEmpty(env.FEEDBACK_PUSH_MODEL) ?? undefined;
  const agentName = pickFirstNonEmpty(env.FEEDBACK_PUSH_NAME) ?? undefined;
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
 * Generate "minimal observable" status from environment variables.
 */
export function createFeedbackPushAgentStatusFromEnv(
  env: NodeJS.ProcessEnv = getRuntimeEnv(),
): FeedbackPushAgentStatus {
  const enabled = isEnvEnabled(env.FEEDBACK_PUSH_AGENT_ENABLED);
  return createFeedbackPushAgentStatus({
    enabled,
    mode: enabled ? 'local-opencode' : 'disabled',
  });
}

export function buildFeedbackAgentSpawnEnv(
  env: NodeJS.ProcessEnv,
  workingDirectory: string,
): NodeJS.ProcessEnv {
  const runtimeRoot =
    pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_RUNTIME_ROOT) ??
    join(workingDirectory, DEFAULT_RUNTIME_DIR_NAME);
  const home = pickFirstNonEmpty(env.FEEDBACK_PUSH_HOME) ?? join(runtimeRoot, 'home');
  const xdgConfigHome =
    pickFirstNonEmpty(env.FEEDBACK_PUSH_XDG_CONFIG_HOME) ?? join(runtimeRoot, 'config');
  const xdgDataHome =
    pickFirstNonEmpty(env.FEEDBACK_PUSH_XDG_DATA_HOME) ?? join(runtimeRoot, 'data');
  const xdgStateHome =
    pickFirstNonEmpty(env.FEEDBACK_PUSH_XDG_STATE_HOME) ?? join(runtimeRoot, 'state');
  const xdgCacheHome =
    pickFirstNonEmpty(env.FEEDBACK_PUSH_XDG_CACHE_HOME) ?? join(runtimeRoot, 'cache');

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
 * Minimal bridge-side local push: only responsible for "new annotation -> one opencode run".
 */
export class LocalFeedbackAgentPushAdapter
  implements FeedbackAgentPushAdapter, FeedbackAgentPushStatusReader
{
  private readonly launchedAnnotationIds = new Set<string>();
  private readonly spawnProcess: NonNullable<LocalFeedbackAgentPushAdapterOptions['spawnProcess']>;
  private readonly log: (message: string) => void;
  private readonly pushAgentStatus: FeedbackPushAgentStatus = createFeedbackPushAgentStatus({
    enabled: true,
    mode: 'local-opencode',
  });

  constructor(private readonly options: LocalFeedbackAgentPushAdapterOptions) {
    this.spawnProcess =
      options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.log = options.log ?? defaultLog;
  }

  getPushAgentStatus(): FeedbackPushAgentStatus {
    return cloneFeedbackPushAgentStatus(this.pushAgentStatus);
  }

  pushNewAnnotation(annotation: FeedbackAnnotation): void {
    if (this.launchedAnnotationIds.has(annotation.id)) return;
    this.launchedAnnotationIds.add(annotation.id);

    const args: string[] = ['run'];
    if (this.options.model) args.push('-m', this.options.model);
    if (this.options.agentName) args.push('-agent', this.options.agentName);
    args.push(buildFeedbackAgentPrompt(this.options.tenantId, annotation));
    const attemptedAt = new Date().toISOString();

    try {
      const child = this.spawnProcess(this.options.opencodeBin, args, {
        cwd: this.options.workingDirectory,
        env: this.options.spawnEnv,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', (error: unknown) => {
        this.recordLaunchResult(annotation, attemptedAt, 'failed', toErrorMessage(error));
        this.log(
          `[feedback-agent-push] spawn error annotation=${annotation.id}: ${toErrorMessage(error)}`,
        );
      });
      child.unref();
      this.recordLaunchResult(annotation, attemptedAt, 'success');
      this.log(
        `[feedback-agent-push] launched annotation=${annotation.id} session=${annotation.sessionId}`,
      );
    } catch (error) {
      const failureReason = toErrorMessage(error);
      this.recordLaunchResult(annotation, attemptedAt, 'failed', failureReason);
      this.log(`[feedback-agent-push] launch failed annotation=${annotation.id}: ${failureReason}`);
    }
  }

  private recordLaunchResult(
    annotation: FeedbackAnnotation,
    attemptedAt: string,
    result: 'success' | 'failed',
    failureReason?: string,
  ): void {
    this.pushAgentStatus.lastLaunch = {
      annotationId: annotation.id,
      sessionId: annotation.sessionId,
      attemptedAt,
      result,
      failureReason: result === 'failed' ? normalizeFailureReason(failureReason) : undefined,
    };
  }
}

export function buildFeedbackAgentPrompt(tenantId: string, annotation: FeedbackAnnotation): string {
  const body = annotation.body.trim() || '(empty)';
  const lines = [
    'You are a local agent triggered by bridge, need to handle a new feedback annotation.',
    `tenant_id: ${tenantId}`,
    `annotation_id: ${annotation.id}`,
    `session_id: ${annotation.sessionId}`,
    '',
    'First call and only call existing feedback.* MCP tools to advance the process:',
    `1) feedback_get_annotation({"annotationId":"${annotation.id}"})`,
    `2) feedback.claim({"annotationId":"${annotation.id}"})`,
    `3) feedback.reply({"annotationId":"${annotation.id}","body":"Your action plan"})`,
    `4) After completion, feedback.resolve({"annotationId":"${annotation.id}","resolution":"Your conclusion"})`,
    '',
    'Below is the original user feedback:',
    body,
  ];
  return lines.join('\n');
}

export function createFeedbackPushAgentStatus(input: {
  enabled: boolean;
  mode: FeedbackPushAgentStatus['mode'];
}): FeedbackPushAgentStatus {
  return {
    enabled: input.enabled,
    readiness: input.enabled ? 'ready' : 'disabled',
    mode: input.mode,
    lastLaunch: null,
  };
}

function isEnvEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ENABLED_VALUES.has(value.trim().toLowerCase());
}

function pickFirstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeFailureReason(reason: string | undefined): string {
  const text = reason?.trim();
  return text && text.length > 0 ? text : 'unknown launch failure';
}

function cloneFeedbackPushAgentStatus(status: FeedbackPushAgentStatus): FeedbackPushAgentStatus {
  return {
    enabled: status.enabled,
    readiness: status.readiness,
    mode: status.mode,
    lastLaunch: status.lastLaunch ? { ...status.lastLaunch } : null,
  };
}

function defaultLog(message: string): void {
  process.stderr.write(`[PAGE-CONTEXT-BRIDGE] ${message}\n`);
}
