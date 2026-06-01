import {
  type FeedbackAnnotation,
  type FeedbackAnnotationStatus,
  type FeedbackPushAgentStatus,
  type FeedbackStateSnapshotResult,
} from '@page-context/shared-protocol';

import { html, nothing, type TemplateResult } from 'lit';

import type { SidepanelFeedbackDraft } from './sidepanel-types';
import { t } from './i18n';
import { renderPanel, renderTabHeader } from './sidepanel-ui';

export type FeedbackActionFormMode = 'reply' | 'resolve' | 'dismiss' | null;
export type FeedbackActionInputField = 'replyBody' | 'resolveNote' | 'dismissReason';

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
    replyBody: '',
    resolveNote: '',
    dismissReason: '',
    submitting: false,
    error: '',
    success: '',
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
    case 'resolved':
      return 'text-success';
    case 'claimed':
      return 'text-info';
    case 'dismissed':
      return 'opacity-50';
    default:
      return 'text-warning';
  }
}

export function feedbackPushAgentBadgeClass(status: FeedbackPushAgentStatus | null): string {
  if (!status || !status.enabled) {
    return 'opacity-50';
  }
  const lastResult = status.lastLaunch?.result;
  if (lastResult === 'failed') {
    return 'text-error';
  }
  if (lastResult === 'success') {
    return 'text-success';
  }
  return 'text-info';
}

export function feedbackPushAgentBadgeText(status: FeedbackPushAgentStatus | null): string {
  if (!status) {
    return 'unknown';
  }
  if (!status.enabled) {
    return 'disabled';
  }
  const lastResult = status.lastLaunch?.result;
  if (lastResult === 'failed') {
    return 'last launch failed';
  }
  if (lastResult === 'success') {
    return 'last launch ok';
  }
  return 'ready';
}

export function canClaimAnnotation(status: FeedbackAnnotationStatus): boolean {
  // Frontend pre-filters obviously illegal transitions so users do not click and then receive an inevitably failed RPC.
  return status === 'open' || status === 'needs_info';
}

export function canReplyAnnotation(status: FeedbackAnnotationStatus): boolean {
  return status !== 'resolved' && status !== 'dismissed';
}

export function canResolveAnnotation(status: FeedbackAnnotationStatus): boolean {
  return status === 'claimed' || status === 'in_progress' || status === 'needs_info';
}

export function canDismissAnnotation(status: FeedbackAnnotationStatus): boolean {
  return status !== 'resolved' && status !== 'dismissed';
}

export function formatFeedbackTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString('en-US', { hour12: false });
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
      ${annotation.thread.map(
        (message) => html`
          <div class="border-t border-base-200 py-1.5 flex flex-col gap-1">
            <div class="flex items-center gap-1 text-[11px] opacity-70">
              <span class="font-semibold">${message.author.displayName}</span>
              <span>${message.author.source} · ${message.kind}</span>
              <span class="ml-auto">${formatFeedbackTime(message.createdAt)}</span>
            </div>
            <div class="text-xs whitespace-pre-wrap break-words">${message.body}</div>
          </div>
        `,
      )}
    </div>
  `;
}

export function renderFeedbackActionForm(
  annotation: FeedbackAnnotation,
  state: FeedbackAnnotationActionState,
  callbacks: FeedbackRenderCallbacks,
): TemplateResult {
  // Form only collects input; real state transitions depend on post-success snapshot refresh to avoid locally "guessing" business state.
  if (state.mode === 'reply') {
    return html`
      <div class="border border-base-300 rounded-md p-2 bg-base-200/50 flex flex-col gap-2">
        <textarea
          class="textarea textarea-sm textarea-bordered min-h-[4.5rem]"
          placeholder=${t('replyPlaceholder')}
          .value=${state.replyBody}
          @input=${(event: Event) => callbacks.onInput(annotation.id, 'replyBody', event)}
        ></textarea>
        <div class="flex items-center gap-2">
          <button
            class="btn btn-xs btn-ghost"
            .disabled=${state.submitting}
            @click=${() => callbacks.onToggleMode(annotation.id, null)}
          >
            ${t('cancel')}
          </button>
          <button
            class="btn btn-xs btn-primary ml-auto"
            .disabled=${state.submitting}
            @click=${() => callbacks.onReply(annotation.id)}
          >
            ${state.submitting ? t('submitting') : t('submitReply')}
          </button>
        </div>
      </div>
    `;
  }

  if (state.mode === 'resolve') {
    return html`
      <div class="border border-base-300 rounded-md p-2 bg-base-200/50 flex flex-col gap-2">
        <textarea
          class="textarea textarea-sm textarea-bordered min-h-[4.5rem]"
          placeholder=${t('resolveNotePlaceholder')}
          .value=${state.resolveNote}
          @input=${(event: Event) => callbacks.onInput(annotation.id, 'resolveNote', event)}
        ></textarea>
        <div class="flex items-center gap-2">
          <button
            class="btn btn-xs btn-ghost"
            .disabled=${state.submitting}
            @click=${() => callbacks.onToggleMode(annotation.id, null)}
          >
            ${t('cancel')}
          </button>
          <button
            class="btn btn-xs btn-success ml-auto"
            .disabled=${state.submitting}
            @click=${() => callbacks.onResolve(annotation.id)}
          >
            ${state.submitting ? t('submitting') : t('confirmResolve')}
          </button>
        </div>
      </div>
    `;
  }

  if (state.mode === 'dismiss') {
    return html`
      <div class="border border-base-300 rounded-md p-2 bg-base-200/50 flex flex-col gap-2">
        <input
          class="input input-sm input-bordered"
          placeholder=${t('dismissReasonPlaceholder')}
          .value=${state.dismissReason}
          @input=${(event: Event) => callbacks.onInput(annotation.id, 'dismissReason', event)}
        />
        <div class="flex items-center gap-2">
          <button
            class="btn btn-xs btn-ghost"
            .disabled=${state.submitting}
            @click=${() => callbacks.onToggleMode(annotation.id, null)}
          >
            ${t('cancel')}
          </button>
          <button
            class="btn btn-xs btn-warning ml-auto"
            .disabled=${state.submitting}
            @click=${() => callbacks.onDismiss(annotation.id)}
          >
            ${state.submitting ? t('submitting') : t('confirmDismiss')}
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
        ? html`<button
            class="btn btn-xs btn-ghost border border-base-300 h-6 min-h-0 px-2"
            .disabled=${state.submitting}
            @click=${() => callbacks.onClaim(annotation.id)}
          >
            ${state.submitting ? t('submitting') : t('claim')}
          </button>`
        : nothing}
      ${canReply
        ? html`<button
            class="btn btn-xs btn-ghost h-6 min-h-0 px-2"
            .disabled=${state.submitting}
            @click=${() => callbacks.onToggleMode(annotation.id, 'reply')}
          >
            ${t('reply')}
          </button>`
        : nothing}
      ${canResolve || canDismiss
        ? html`<details class="dropdown dropdown-end">
            <summary class="btn btn-xs btn-ghost h-6 min-h-0 px-2">${t('more')}</summary>
            <div
              class="menu dropdown-content z-10 mt-1 rounded-sm border border-base-300 bg-base-100 p-1 shadow-sm"
            >
              ${canResolve
                ? html`<button
                    class="btn btn-xs btn-ghost justify-start"
                    .disabled=${state.submitting}
                    @click=${() => callbacks.onToggleMode(annotation.id, 'resolve')}
                  >
                    ${t('resolve')}
                  </button>`
                : nothing}
              ${canDismiss
                ? html`<button
                    class="btn btn-xs btn-ghost justify-start"
                    .disabled=${state.submitting}
                    @click=${() => callbacks.onToggleMode(annotation.id, 'dismiss')}
                  >
                    ${t('dismiss')}
                  </button>`
                : nothing}
            </div>
          </details>`
        : nothing}
      ${!canClaim && !canReply && !canResolve && !canDismiss
        ? html`<span class="text-xs opacity-50">${t('noActionsAvailable')}</span>`
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
  priority: SidepanelFeedbackDraft['priority'];
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

  return html`
    <div class="tab-content active flex flex-col flex-1 min-h-0">
      ${renderTabHeader({
        title: t('feedback'),
        action: html`<button class="btn btn-xs btn-ghost" @click=${input.onRefresh}>
          ${t('refresh')}
        </button>`,
      })}
      <div class="flex-1 overflow-y-auto p-3 bg-base-200 flex flex-col gap-2">
        ${renderPanel({
          title: t('createFeedback'),
          body: html`
            <div class="flex flex-col gap-2">
              <textarea
                class="textarea textarea-sm textarea-bordered min-h-[6rem]"
                placeholder=${t('feedbackPlaceholder')}
                .value=${input.body}
                @input=${input.onBodyInput}
              ></textarea>
              <div class="flex gap-2 items-center">
                <label class="text-xs opacity-70" for="feedbackPriority">${t('priority')}</label>
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
                <button class="btn btn-sm btn-primary ml-auto" @click=${input.onSubmit}>
                  ${t('submit')}
                </button>
              </div>
              <div class="text-xs opacity-70">
                ${currentFeedbackSession
                  ? html`${t('activeTab')}: #${currentFeedbackSession.tabId} ·
                    ${currentFeedbackSession.title || currentFeedbackSession.url}`
                  : html`${t('activeTab')}: ${t('sessionNotCreated')}`}
              </div>
              ${feedbackAnnotations[0]?.target.textQuote
                ? html`<div class="text-xs opacity-70">
                    ${t('selectedText')}: ${feedbackAnnotations[0].target.textQuote}
                  </div>`
                : nothing}
              <div class="${input.createStatusClass}">${input.createStatus}</div>
            </div>
          `,
        })}
        ${renderPanel({
          title: t('currentSession'),
          meta: input.loading
            ? t('loading')
            : t('annotations', { count: feedbackAnnotations.length }),
          body: html`
            <div class="flex flex-col gap-2">
              ${input.error ? html`<div class="text-xs text-error">${input.error}</div>` : nothing}
              ${!currentFeedbackSession
                ? html`<div class="text-xs opacity-60">${t('noFeedbackRecordsYet')}</div>`
                : html`
                    <div class="text-xs opacity-70">
                      Session ${currentFeedbackSession.id} · seq
                      ${currentFeedbackSession.lastEventSeq}
                    </div>
                    <div class="flex flex-col gap-2">
                      ${feedbackAnnotations.length === 0
                        ? html`<div class="text-xs opacity-60">${t('noAnnotationsYet')}</div>`
                        : html`${feedbackAnnotations.map((annotation) => {
                            const state = input.readActionState(annotation.id);
                            return html`
                              <div class="border-t border-base-200 py-2 flex flex-col gap-1.5">
                                <div class="flex items-center gap-2">
                                  <span class="text-xs font-semibold">${annotation.status}</span>
                                  <span class="text-xs opacity-55">${annotation.priority}</span>
                                  <span class="text-[11px] opacity-50 ml-auto"
                                    >${formatFeedbackTime(annotation.updatedAt)}</span
                                  >
                                </div>
                                <div class="text-sm whitespace-pre-wrap break-words">
                                  ${annotation.body}
                                </div>
                                <div class="text-xs opacity-70">
                                  #${annotation.id} · ${t('by')} ${annotation.author.displayName} ·
                                  ${t('created')} ${formatFeedbackTime(annotation.createdAt)}
                                </div>
                                ${annotation.target.textQuote
                                  ? html`<div class="text-xs opacity-80">
                                      ${t('quoted')}: ${annotation.target.textQuote}
                                    </div>`
                                  : nothing}
                                ${annotation.claimedBy ||
                                annotation.resolvedBy ||
                                annotation.resolution ||
                                annotation.dismissReason
                                  ? html`
                                      <div class="text-xs opacity-70 flex flex-wrap gap-2">
                                        ${annotation.claimedBy
                                          ? html`<span
                                              >${t('claimedBy')}:
                                              ${annotation.claimedBy.displayName}</span
                                            >`
                                          : nothing}
                                        ${annotation.resolvedBy
                                          ? html`<span
                                              >${t('resolvedBy')}:
                                              ${annotation.resolvedBy.displayName}</span
                                            >`
                                          : nothing}
                                        ${annotation.resolution
                                          ? html`<span
                                              >${t('resolution')}: ${annotation.resolution}</span
                                            >`
                                          : nothing}
                                        ${annotation.dismissReason
                                          ? html`<span
                                              >${t('dismissReason')}:
                                              ${annotation.dismissReason}</span
                                            >`
                                          : nothing}
                                      </div>
                                    `
                                  : nothing}
                                ${annotation.linkedCapabilities.relatedToolNames.length +
                                  annotation.linkedCapabilities.relatedResourceIds.length +
                                  annotation.linkedCapabilities.relatedSkillIds.length >
                                0
                                  ? html`
                                      <div class="text-[11px] opacity-55 truncate">
                                        ${t('related')}:
                                        ${[
                                          ...annotation.linkedCapabilities.relatedToolNames,
                                          ...annotation.linkedCapabilities.relatedResourceIds,
                                          ...annotation.linkedCapabilities.relatedSkillIds,
                                        ].join(', ')}
                                      </div>
                                    `
                                  : nothing}
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
                          })}`}
                    </div>
                  `}
            </div>
          `,
        })}
      </div>
    </div>
  `;
}
