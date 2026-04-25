import {
  type FeedbackAnnotation,
  type FeedbackAnnotationStatus,
  type FeedbackPushAgentStatus,
  type FeedbackStateSnapshotResult,
} from "@page-context/shared-protocol";

import { html, nothing, type TemplateResult } from "lit";

import type { SidepanelFeedbackDraft } from "./sidepanel-types";

export type FeedbackActionFormMode = "reply" | "resolve" | "dismiss" | null;
export type FeedbackActionInputField = "replyBody" | "resolveNote" | "dismissReason";

// Sidepanel maintains only form interaction state; real business state always follows the snapshot.
export interface FeedbackAnnotationActionState {
  mode: FeedbackActionFormMode;
  replyBody: string;
  resolveNote: string;
  dismissReason: string;
  submitting: boolean;
  error: string;
  success: string;
}

export function createFeedbackActionState(): FeedbackAnnotationActionState {
  return {
    mode: null,
    replyBody: "",
    resolveNote: "",
    dismissReason: "",
    submitting: false,
    error: "",
    success: "",
  };
}

export function reconcileFeedbackActionStates(
  current: Record<string, FeedbackAnnotationActionState>,
  annotations: FeedbackAnnotation[],
): Record<string, FeedbackAnnotationActionState> {
  const next: Record<string, FeedbackAnnotationActionState> = {};
  for (const annotation of annotations) {
    next[annotation.id] = current[annotation.id] ?? createFeedbackActionState();
  }
  return next;
}

export function readFeedbackActionState(
  current: Record<string, FeedbackAnnotationActionState>,
  annotationId: string,
): FeedbackAnnotationActionState {
  return current[annotationId] ?? createFeedbackActionState();
}

export function updateFeedbackActionStates(
  current: Record<string, FeedbackAnnotationActionState>,
  annotationId: string,
  updater: (state: FeedbackAnnotationActionState) => FeedbackAnnotationActionState,
): Record<string, FeedbackAnnotationActionState> {
  return {
    ...current,
    [annotationId]: updater(readFeedbackActionState(current, annotationId)),
  };
}

export function feedbackStatusBadgeClass(status: string): string {
  switch (status) {
    case "resolved":
      return "badge badge-success badge-sm";
    case "claimed":
      return "badge badge-info badge-sm";
    case "dismissed":
      return "badge badge-ghost badge-sm";
    default:
      return "badge badge-warning badge-sm";
  }
}

export function feedbackPushAgentBadgeClass(status: FeedbackPushAgentStatus | null): string {
  if (!status || !status.enabled) {
    return "badge badge-ghost badge-sm";
  }
  const lastResult = status.lastLaunch?.result;
  if (lastResult === "failed") {
    return "badge badge-error badge-sm";
  }
  if (lastResult === "success") {
    return "badge badge-success badge-sm";
  }
  return "badge badge-info badge-sm";
}

export function feedbackPushAgentBadgeText(status: FeedbackPushAgentStatus | null): string {
  if (!status) {
    return "unknown";
  }
  if (!status.enabled) {
    return "disabled";
  }
  const lastResult = status.lastLaunch?.result;
  if (lastResult === "failed") {
    return "last launch failed";
  }
  if (lastResult === "success") {
    return "last launch ok";
  }
  return "ready";
}

export function canClaimAnnotation(status: FeedbackAnnotationStatus): boolean {
  // Frontend pre-filters obviously illegal transitions so users do not click and then receive an inevitably failed RPC.
  return status === "open" || status === "needs_info";
}

export function canReplyAnnotation(status: FeedbackAnnotationStatus): boolean {
  return status !== "resolved" && status !== "dismissed";
}

export function canResolveAnnotation(status: FeedbackAnnotationStatus): boolean {
  return status === "claimed" || status === "in_progress" || status === "needs_info";
}

export function canDismissAnnotation(status: FeedbackAnnotationStatus): boolean {
  return status !== "resolved" && status !== "dismissed";
}

export function formatFeedbackTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString("en-US", { hour12: false });
}

interface FeedbackRenderCallbacks {
  onToggleMode(annotationId: string, mode: FeedbackActionFormMode): void;
  onInput(annotationId: string, field: FeedbackActionInputField, event: Event): void;
  onClaim(annotationId: string): void;
  onReply(annotationId: string): void;
  onResolve(annotationId: string): void;
  onDismiss(annotationId: string): void;
}

export function renderFeedbackThread(annotation: FeedbackAnnotation): TemplateResult {
  if (annotation.thread.length === 0) {
    return html`<div class="text-xs opacity-50">No thread messages</div>`;
  }

  return html`
    <div class="flex flex-col gap-1">
      ${annotation.thread.map((message) => html`
        <div class="border border-base-300 rounded-md p-2 bg-base-200/60 flex flex-col gap-1">
          <div class="flex items-center gap-1 text-[11px] opacity-70">
            <span class="font-semibold">${message.author.displayName}</span>
            <span class="badge badge-ghost badge-xs">${message.author.source}</span>
            <span class="badge badge-outline badge-xs">${message.kind}</span>
            <span class="ml-auto">${formatFeedbackTime(message.createdAt)}</span>
          </div>
          <div class="text-xs whitespace-pre-wrap break-words">${message.body}</div>
        </div>
      `)}
    </div>
  `;
}

export function renderFeedbackActionForm(
  annotation: FeedbackAnnotation,
  state: FeedbackAnnotationActionState,
  callbacks: FeedbackRenderCallbacks,
): TemplateResult {
  // Form only collects input; real state transitions depend on post-success snapshot refresh to avoid locally "guessing" business state.
  if (state.mode === "reply") {
    return html`
      <div class="border border-base-300 rounded-md p-2 bg-base-200/50 flex flex-col gap-2">
        <textarea
          class="textarea textarea-sm textarea-bordered min-h-[4.5rem]"
          placeholder="Add processing progress or follow-up questions"
          .value=${state.replyBody}
          @input=${(event: Event) => callbacks.onInput(annotation.id, "replyBody", event)}
        ></textarea>
        <div class="flex items-center gap-2">
          <button class="btn btn-xs btn-ghost" .disabled=${state.submitting} @click=${() => callbacks.onToggleMode(annotation.id, null)}>Cancel</button>
          <button class="btn btn-xs btn-primary ml-auto" .disabled=${state.submitting} @click=${() => callbacks.onReply(annotation.id)}>
            ${state.submitting ? "Submitting..." : "Submit Reply"}
          </button>
        </div>
      </div>
    `;
  }

  if (state.mode === "resolve") {
    return html`
      <div class="border border-base-300 rounded-md p-2 bg-base-200/50 flex flex-col gap-2">
        <textarea
          class="textarea textarea-sm textarea-bordered min-h-[4.5rem]"
          placeholder="Optional: fill in resolution notes"
          .value=${state.resolveNote}
          @input=${(event: Event) => callbacks.onInput(annotation.id, "resolveNote", event)}
        ></textarea>
        <div class="flex items-center gap-2">
          <button class="btn btn-xs btn-ghost" .disabled=${state.submitting} @click=${() => callbacks.onToggleMode(annotation.id, null)}>Cancel</button>
          <button class="btn btn-xs btn-success ml-auto" .disabled=${state.submitting} @click=${() => callbacks.onResolve(annotation.id)}>
            ${state.submitting ? "Submitting..." : "Confirm Resolve"}
          </button>
        </div>
      </div>
    `;
  }

  if (state.mode === "dismiss") {
    return html`
      <div class="border border-base-300 rounded-md p-2 bg-base-200/50 flex flex-col gap-2">
        <input
          class="input input-sm input-bordered"
          placeholder="Optional: fill in dismiss reason"
          .value=${state.dismissReason}
          @input=${(event: Event) => callbacks.onInput(annotation.id, "dismissReason", event)}
        />
        <div class="flex items-center gap-2">
          <button class="btn btn-xs btn-ghost" .disabled=${state.submitting} @click=${() => callbacks.onToggleMode(annotation.id, null)}>Cancel</button>
          <button class="btn btn-xs btn-warning ml-auto" .disabled=${state.submitting} @click=${() => callbacks.onDismiss(annotation.id)}>
            ${state.submitting ? "Submitting..." : "Confirm Dismiss"}
          </button>
        </div>
      </div>
    `;
  }

  return html``;
}

export function renderFeedbackActions(
  annotation: FeedbackAnnotation,
  state: FeedbackAnnotationActionState,
  callbacks: FeedbackRenderCallbacks,
): TemplateResult {
  const canClaim = canClaimAnnotation(annotation.status);
  const canReply = canReplyAnnotation(annotation.status);
  const canResolve = canResolveAnnotation(annotation.status);
  const canDismiss = canDismissAnnotation(annotation.status);

  return html`
    <div class="flex flex-wrap items-center gap-1.5">
      ${canClaim
        ? html`<button class="btn btn-xs btn-info" .disabled=${state.submitting} @click=${() => callbacks.onClaim(annotation.id)}>${state.submitting ? "Submitting..." : "Claim"}</button>`
        : nothing}
      ${canReply
        ? html`<button class="btn btn-xs btn-ghost" .disabled=${state.submitting} @click=${() => callbacks.onToggleMode(annotation.id, "reply")}>Reply</button>`
        : nothing}
      ${canResolve
        ? html`<button class="btn btn-xs btn-success btn-outline" .disabled=${state.submitting} @click=${() => callbacks.onToggleMode(annotation.id, "resolve")}>Resolve</button>`
        : nothing}
      ${canDismiss
        ? html`<button class="btn btn-xs btn-warning btn-outline" .disabled=${state.submitting} @click=${() => callbacks.onToggleMode(annotation.id, "dismiss")}>Dismiss</button>`
        : nothing}
      ${(!canClaim && !canReply && !canResolve && !canDismiss)
        ? html`<span class="text-xs opacity-50">No actions available in current state</span>`
        : nothing}
    </div>
    ${state.error ? html`<div class="text-xs text-error">${state.error}</div>` : nothing}
    ${state.success ? html`<div class="text-xs text-success">${state.success}</div>` : nothing}
    ${renderFeedbackActionForm(annotation, state, callbacks)}
  `;
}

export interface RenderFeedbackTabInput {
  snapshot: FeedbackStateSnapshotResult | null;
  loading: boolean;
  error: string;
  body: string;
  priority: SidepanelFeedbackDraft["priority"];
  createStatus: string;
  createStatusClass: string;
  readActionState(annotationId: string): FeedbackAnnotationActionState;
  onRefresh(): void;
  onBodyInput(event: Event): void;
  onPriorityChange(event: Event): void;
  onSubmit(): void;
  onToggleMode(annotationId: string, mode: FeedbackActionFormMode): void;
  onActionInput(annotationId: string, field: FeedbackActionInputField, event: Event): void;
  onClaim(annotationId: string): void;
  onReply(annotationId: string): void;
  onResolve(annotationId: string): void;
  onDismiss(annotationId: string): void;
}

export function renderFeedbackTab(input: RenderFeedbackTabInput): TemplateResult {
  const currentFeedbackSession = input.snapshot?.sessions[0] ?? null;
  const feedbackAnnotations = input.snapshot?.annotations ?? [];
  const feedbackPushAgentStatus = input.snapshot?.pushAgent ?? null;

  return html`
    <div class="tab-content active flex flex-col flex-1 min-h-0">
      <div class="flex items-center gap-2 px-3 py-2 bg-base-100 border-b border-base-300 shrink-0">
        <span class="text-xs font-bold uppercase tracking-wide opacity-60">Feedback</span>
        <button class="btn btn-xs btn-ghost ml-auto" @click=${input.onRefresh}>Refresh</button>
      </div>
      <div class="flex-1 overflow-y-auto p-3 bg-base-200 flex flex-col gap-3">
        <div class="card bg-base-100 border border-base-300 shadow-sm">
          <div class="card-body p-3 gap-2">
            <div class="flex items-center gap-2">
              <div class="font-bold text-sm">Auto Push Agent</div>
              <span class="${feedbackPushAgentBadgeClass(feedbackPushAgentStatus)} ml-auto">${feedbackPushAgentBadgeText(feedbackPushAgentStatus)}</span>
            </div>
            ${!feedbackPushAgentStatus
              ? html`<div class="text-xs opacity-60">Current snapshot does not contain push-agent status.</div>`
              : html`
                <div class="text-xs opacity-70">
                  enabled: <span class="font-mono">${String(feedbackPushAgentStatus.enabled)}</span>
                  · readiness: <span class="font-mono">${feedbackPushAgentStatus.readiness}</span>
                  · mode: <span class="font-mono">${feedbackPushAgentStatus.mode}</span>
                </div>
                ${feedbackPushAgentStatus.lastLaunch
                  ? html`
                    <div class="text-xs opacity-70">
                      last launch: <span class="font-mono">${feedbackPushAgentStatus.lastLaunch.result}</span>
                      · at ${formatFeedbackTime(feedbackPushAgentStatus.lastLaunch.attemptedAt)}
                      · annotation ${feedbackPushAgentStatus.lastLaunch.annotationId}
                    </div>
                    ${feedbackPushAgentStatus.lastLaunch.failureReason
                      ? html`<div class="text-xs text-error">failure: ${feedbackPushAgentStatus.lastLaunch.failureReason}</div>`
                      : nothing}
                  `
                  : html`<div class="text-xs opacity-60">last launch: (no records yet)</div>`}
              `}
          </div>
        </div>

        <div class="card bg-base-100 border border-base-300 shadow-sm">
          <div class="card-body p-3 gap-2">
            <div class="font-bold text-sm">Create Feedback</div>
            <textarea
              class="textarea textarea-sm textarea-bordered min-h-[6rem]"
              placeholder="Describe the problem, expected behavior, reproduction steps"
              .value=${input.body}
              @input=${input.onBodyInput}
            ></textarea>
            <div class="flex gap-2 items-center">
              <label class="text-xs opacity-70" for="feedbackPriority">Priority</label>
              <select
                id="feedbackPriority"
                class="select select-sm select-bordered w-36"
                .value=${input.priority}
                @change=${input.onPriorityChange}
              >
                <option value="low">low</option>
                <option value="normal">normal</option>
                <option value="high">high</option>
                <option value="critical">critical</option>
              </select>
              <button class="btn btn-sm btn-primary ml-auto" @click=${input.onSubmit}>Submit</button>
            </div>
            <div class="text-xs opacity-70">
              ${currentFeedbackSession
                ? html`Active Tab: #${currentFeedbackSession.tabId} · ${currentFeedbackSession.title || currentFeedbackSession.url}`
                : html`Active Tab: (session not created)`}
            </div>
            ${feedbackAnnotations[0]?.target.textQuote
              ? html`<div class="text-xs opacity-70">Selected Text: ${feedbackAnnotations[0].target.textQuote}</div>`
              : nothing}
            <div class="${input.createStatusClass}">${input.createStatus}</div>
          </div>
        </div>

        <div class="card bg-base-100 border border-base-300 shadow-sm">
          <div class="card-body p-3 gap-2">
            <div class="flex items-center justify-between">
              <div class="font-bold text-sm">Current Session</div>
              <div class="text-xs opacity-60">
                ${input.loading ? "Loading..." : `${feedbackAnnotations.length} annotations`}
              </div>
            </div>
            ${input.error
              ? html`<div class="text-xs text-error">${input.error}</div>`
              : nothing}
            ${!currentFeedbackSession
              ? html`<div class="text-xs opacity-60">No feedback records for current page yet.</div>`
              : html`
                <div class="text-xs opacity-70">
                  Session ${currentFeedbackSession.id} · seq ${currentFeedbackSession.lastEventSeq}
                </div>
                <div class="flex flex-col gap-2">
                  ${feedbackAnnotations.length === 0
                    ? html`<div class="text-xs opacity-60">No annotations yet.</div>`
                    : html`${feedbackAnnotations.map((annotation) => {
                        const state = input.readActionState(annotation.id);
                        return html`
                          <div class="border border-base-300 rounded-lg p-2 bg-base-100 flex flex-col gap-1.5">
                            <div class="flex items-center gap-2">
                              <span class="${feedbackStatusBadgeClass(annotation.status)}">${annotation.status}</span>
                              <span class="badge badge-outline badge-sm">${annotation.priority}</span>
                              <span class="text-[11px] opacity-50 ml-auto">${formatFeedbackTime(annotation.updatedAt)}</span>
                            </div>
                            <div class="text-sm whitespace-pre-wrap break-words">${annotation.body}</div>
                            <div class="text-xs opacity-70">
                              #${annotation.id} · by ${annotation.author.displayName} ·
                              created ${formatFeedbackTime(annotation.createdAt)}
                            </div>
                            ${annotation.target.textQuote
                              ? html`<div class="text-xs opacity-80">Quote: ${annotation.target.textQuote}</div>`
                              : nothing}
                            ${annotation.claimedBy || annotation.resolvedBy || annotation.resolution || annotation.dismissReason
                              ? html`
                                <div class="text-xs opacity-70 flex flex-wrap gap-2">
                                  ${annotation.claimedBy ? html`<span>Claimed by: ${annotation.claimedBy.displayName}</span>` : nothing}
                                  ${annotation.resolvedBy ? html`<span>Resolved by: ${annotation.resolvedBy.displayName}</span>` : nothing}
                                  ${annotation.resolution ? html`<span>Resolution: ${annotation.resolution}</span>` : nothing}
                                  ${annotation.dismissReason ? html`<span>Dismiss reason: ${annotation.dismissReason}</span>` : nothing}
                                </div>
                              `
                              : nothing}
                            ${(annotation.linkedCapabilities.relatedToolNames.length
                              + annotation.linkedCapabilities.relatedResourceIds.length
                              + annotation.linkedCapabilities.relatedSkillIds.length) > 0
                              ? html`
                                <div class="flex flex-wrap gap-1">
                                  ${annotation.linkedCapabilities.relatedToolNames.map((tool) => html`<span class="badge badge-ghost badge-xs">tool:${tool}</span>`)}
                                  ${annotation.linkedCapabilities.relatedResourceIds.map((resource) => html`<span class="badge badge-ghost badge-xs">resource:${resource}</span>`)}
                                  ${annotation.linkedCapabilities.relatedSkillIds.map((skill) => html`<span class="badge badge-ghost badge-xs">skill:${skill}</span>`)}
                                </div>
                              `
                              : html`<div class="text-xs opacity-50">No related capabilities</div>`}
                            ${renderFeedbackActions(annotation, state, {
                              onToggleMode: input.onToggleMode,
                              onInput: input.onActionInput,
                              onClaim: input.onClaim,
                              onReply: input.onReply,
                              onResolve: input.onResolve,
                              onDismiss: input.onDismiss,
                            })}
                            ${renderFeedbackThread(annotation)}
                          </div>
                        `;
                      })}`
                  }
                </div>
              `}
          </div>
        </div>
      </div>
    </div>
  `;
}
