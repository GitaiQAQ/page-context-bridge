import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import type { FeedbackAnnotation, FeedbackPushAgentStatus } from '@page-context/shared-protocol';

import { getRuntimeEnv } from './runtime-env.js';

export interface FeedbackAgentPushAdapter {
  pushNewAnnotation(annotation: FeedbackAnnotation): void;
}

/**
 * Optional status reader interface: exposes push-agent runtime state to snapshot/sidepanel.
 * Constraint: reading must be pure functions without side effects.
 */
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
 * Generate "minimal observable" status from environment variables.
 * Note: This only represents configuration state; runtime state (last launch) is continuously updated by adapter in memory.
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

/**
 * Build isolated opencode runtime environment for feedback agent.
 * Goal: By default, do not read user global ~/.config/opencode, and allow precise override via FEEDBACK_PUSH_AGENT_*.
 */
export function buildFeedbackAgentSpawnEnv(
  env: NodeJS.ProcessEnv,
  workingDirectory: string,
): NodeJS.ProcessEnv {
  const runtimeRoot =
    pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_RUNTIME_ROOT) ??
    join(workingDirectory, DEFAULT_RUNTIME_DIR_NAME);
  const home = pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_HOME) ?? join(runtimeRoot, 'home');
  const xdgConfigHome =
    pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_XDG_CONFIG_HOME) ?? join(runtimeRoot, 'config');
  const xdgDataHome =
    pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_XDG_DATA_HOME) ?? join(runtimeRoot, 'data');
  const xdgStateHome =
    pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_XDG_STATE_HOME) ?? join(runtimeRoot, 'state');
  const xdgCacheHome =
    pickFirstNonEmpty(env.FEEDBACK_PUSH_AGENT_XDG_CACHE_HOME) ?? join(runtimeRoot, 'cache');

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
    // In-process deduplication: only attempt to launch once per annotation to avoid duplicate pushes.
    if (this.launchedAnnotationIds.has(annotation.id)) {
      return;
    }
    this.launchedAnnotationIds.add(annotation.id);

    const args: string[] = ['run'];
    if (this.options.model) {
      args.push('-m', this.options.model);
    }
    if (this.options.agentName) {
      // Keep consistent with opencode-protocol parameter mapping: agent => -agent
      args.push('-agent', this.options.agentName);
    }
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
        const failureReason = toErrorMessage(error);
        this.recordLaunchResult(annotation, attemptedAt, 'failed', failureReason);
        this.log(`[feedback-agent-push] spawn error annotation=${annotation.id}: ${failureReason}`);
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
    // Main entry point unified as feedback.*; old feedback_*_annotation are only for compatibility aliases, not recommended for new workflows.
    `2) feedback.claim({"annotationId":"${annotation.id}"})`,
    `3) feedback.reply({"annotationId":"${annotation.id}","body":"Your action plan"})`,
    `4) After completion, feedback.resolve({"annotationId":"${annotation.id}","resolution":"Your conclusion"})`,
    '',
    'Below is the original user feedback:',
    body,
  ];
  return lines.join('\n');
}

/**
 * Unified construction of push-agent status to avoid field drift from manual branching by callers.
 */
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

function normalizeFailureReason(reason: string | undefined): string {
  const text = reason?.trim();
  return text && text.length > 0 ? text : 'unknown launch failure';
}

function cloneFeedbackPushAgentStatus(status: FeedbackPushAgentStatus): FeedbackPushAgentStatus {
  return {
    enabled: status.enabled,
    readiness: status.readiness,
    mode: status.mode,
    lastLaunch: status.lastLaunch
      ? {
          ...status.lastLaunch,
        }
      : null,
  };
}

function defaultLog(message: string): void {
  process.stderr.write(`[PAGE-CONTEXT-BRIDGE] ${message}\n`);
}
