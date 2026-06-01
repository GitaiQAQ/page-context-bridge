import { html, type TemplateResult } from 'lit';

import type { ToolTestSelection } from './sidepanel-types';
import { t } from './i18n';
import { renderIcon } from './icons';
import { renderTabHeader } from './sidepanel-ui';

export interface RenderToolsTabInput {
  active: boolean;
  toolsCount: string;
  currentFilter: string;
  currentToolTestSelection: ToolTestSelection | null;
  toolTestTitle: string;
  toolTestSubtitle: string;
  toolTestTabIdValue: string;
  toolTestTabIdDisabled: boolean;
  toolTestSchemaOutput: string;
  toolTestArgs: string;
  toolTestOutput: string;
  toolTestStatusText: string;
  toolTestStatusClass: string;
  toolTestRunning: boolean;
  renderToolsTreeContent(): TemplateResult;
  onRefresh(): void;
  onFilterInput(event: Event): void;
  onPanelChange(event: Event): void;
  onPanelClick(event: Event): void;
  onCloseToolTestPanel(): void;
  onToolTestTabIdInput(event: Event): void;
  onToolTestArgsInput(event: Event): void;
  onResetToolTestArgs(): void;
  onRunToolDebugCall(): void;
}

export function renderToolsTab(input: RenderToolsTabInput): TemplateResult {
  return html`
    <div
      class="pcb-tab-panel ${input.active ? 'active' : ''} flex flex-col flex-1 min-h-0 bg-base-200"
    >
      ${renderTabHeader({
        title: t('contextTools'),
        meta: html`<span data-testid="build-time-label" title=${input.toolsCount}
          >${input.toolsCount}</span
        >`,
        action: html`<button
          class="btn btn-xs btn-ghost border border-base-300 gap-1"
          @click=${input.onRefresh}
        >
          ${renderIcon('refreshCw', 'h-3 w-3')} ${t('refresh')}
        </button>`,
      })}
      <div class="px-3 py-2 border-b border-base-300 bg-base-100 shrink-0">
        <input
          type="search"
          .value=${input.currentFilter}
          @input=${input.onFilterInput}
          placeholder=${t('filterToolsPlaceholder')}
          class="input input-sm input-bordered w-full bg-base-200/60"
        />
      </div>
      <div
        class="flex-1 overflow-y-auto"
        id="toolsPanel"
        @change=${input.onPanelChange}
        @click=${input.onPanelClick}
      >
        ${input.renderToolsTreeContent()}
      </div>

      ${input.currentToolTestSelection
        ? html`
            <div
              class="test-panel open border-t border-base-300 bg-base-100 p-3 flex-col gap-2 shrink-0 max-h-[48%] overflow-auto shadow-sm"
            >
              <div class="flex items-center justify-between gap-2">
                <div>
                  <div class="text-sm font-bold">${input.toolTestTitle}</div>
                  <div class="text-xs opacity-60 break-all">${input.toolTestSubtitle}</div>
                </div>
                <button
                  class="btn btn-xs btn-ghost border border-base-300 gap-1"
                  @click=${input.onCloseToolTestPanel}
                >
                  ${renderIcon('x', 'h-3 w-3')} ${t('close')}
                </button>
              </div>
              <div class="flex flex-col gap-1">
                <label class="label text-xs font-semibold" for="toolTestTabIdInput"
                  >${t('tabId')}</label
                >
                <input
                  id="toolTestTabIdInput"
                  type="number"
                  .value=${input.toolTestTabIdValue}
                  .disabled=${input.toolTestTabIdDisabled}
                  @input=${input.onToolTestTabIdInput}
                  placeholder=${t('tabIdOptionalHint')}
                  class="input input-sm input-bordered"
                />
              </div>
              <div class="flex flex-col gap-1">
                <label class="label text-xs font-semibold" for="toolTestSchemaOutput"
                  >${t('inputSchema')}</label
                >
                <pre
                  class="bg-base-200 rounded-lg border border-base-300 p-2 text-xs font-mono whitespace-pre-wrap break-words min-h-[3rem]"
                >
${input.toolTestSchemaOutput}</pre
                >
              </div>
              <div class="flex flex-col gap-1">
                <label class="label text-xs font-semibold" for="toolTestArgsInput"
                  >${t('rpcArgsJson')}</label
                >
                <textarea
                  id="toolTestArgsInput"
                  class="textarea textarea-sm textarea-bordered font-mono min-h-[5.5rem]"
                  .value=${input.toolTestArgs}
                  @input=${input.onToolTestArgsInput}
                ></textarea>
              </div>
              <div class="flex gap-2 justify-end">
                <button
                  class="btn btn-xs btn-ghost border border-base-300 gap-1"
                  @click=${input.onResetToolTestArgs}
                >
                  ${renderIcon('refreshCw', 'h-3 w-3')} ${t('resetArgs')}
                </button>
                <button
                  class="btn btn-xs btn-primary gap-1"
                  .disabled=${input.toolTestRunning}
                  @click=${input.onRunToolDebugCall}
                >
                  ${renderIcon('play', 'h-3 w-3')} ${t('runRpcCall')}
                </button>
              </div>
              <div class="text-xs font-semibold ${input.toolTestStatusClass}">
                ${input.toolTestStatusText}
              </div>
              <div class="flex flex-col gap-1">
                <label class="label text-xs font-semibold" for="toolTestOutput"
                  >${t('output')}</label
                >
                <pre
                  class="bg-base-200 rounded-lg border border-base-300 p-2 text-xs font-mono whitespace-pre-wrap break-words min-h-[3rem]"
                >
${input.toolTestOutput}</pre
                >
              </div>
            </div>
          `
        : html``}
    </div>
  `;
}
