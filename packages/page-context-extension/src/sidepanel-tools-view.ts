import { html, type TemplateResult } from 'lit';

import type { ToolTestSelection } from './sidepanel-types';

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
    <div class="tab-content ${input.active ? 'active' : ''} flex flex-col flex-1 min-h-0">
      <div
        class="flex items-center gap-2 px-3 py-2 bg-base-100 border-b border-base-300 sticky top-0 z-10"
      >
        <span class="text-xs font-bold uppercase tracking-wide opacity-60">Context Tools</span>
        <span class="text-xs opacity-50">${input.toolsCount}</span>
        <button class="btn btn-xs btn-ghost ml-auto" @click=${input.onRefresh}>Refresh</button>
      </div>
      <div class="px-3 py-1.5 border-b border-base-300 bg-base-200 sticky top-[2.75rem] z-20">
        <input
          type="search"
          .value=${input.currentFilter}
          @input=${input.onFilterInput}
          placeholder="Filter by tab / namespace / instance / tool"
          class="input input-sm input-bordered w-full"
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
              class="test-panel open border-t border-base-300 bg-base-100 p-3 flex-col gap-2 shrink-0 max-h-[48%] overflow-auto"
            >
              <div class="flex items-center justify-between gap-2">
                <div>
                  <div class="text-sm font-bold">${input.toolTestTitle}</div>
                  <div class="text-xs opacity-60 break-all">${input.toolTestSubtitle}</div>
                </div>
                <button class="btn btn-xs btn-ghost" @click=${input.onCloseToolTestPanel}>
                  Close
                </button>
              </div>
              <div class="flex flex-col gap-1">
                <label class="label text-xs font-semibold" for="toolTestTabIdInput">Tab ID</label>
                <input
                  id="toolTestTabIdInput"
                  type="number"
                  .value=${input.toolTestTabIdValue}
                  .disabled=${input.toolTestTabIdDisabled}
                  @input=${input.onToolTestTabIdInput}
                  placeholder="Optional for built-in tools"
                  class="input input-sm input-bordered"
                />
              </div>
              <div class="flex flex-col gap-1">
                <label class="label text-xs font-semibold" for="toolTestSchemaOutput"
                  >Input Schema</label
                >
                <pre
                  class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words min-h-[3rem]"
                >
${input.toolTestSchemaOutput}</pre
                >
              </div>
              <div class="flex flex-col gap-1">
                <label class="label text-xs font-semibold" for="toolTestArgsInput"
                  >RPC Args (JSON)</label
                >
                <textarea
                  id="toolTestArgsInput"
                  class="textarea textarea-sm textarea-bordered font-mono min-h-[5.5rem]"
                  .value=${input.toolTestArgs}
                  @input=${input.onToolTestArgsInput}
                ></textarea>
              </div>
              <div class="flex gap-2 justify-end">
                <button class="btn btn-xs btn-ghost" @click=${input.onResetToolTestArgs}>
                  Reset Args
                </button>
                <button
                  class="btn btn-xs btn-primary"
                  .disabled=${input.toolTestRunning}
                  @click=${input.onRunToolDebugCall}
                >
                  Run RPC Call
                </button>
              </div>
              <div class="text-xs font-semibold ${input.toolTestStatusClass}">
                ${input.toolTestStatusText}
              </div>
              <div class="flex flex-col gap-1">
                <label class="label text-xs font-semibold" for="toolTestOutput">Output</label>
                <pre
                  class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words min-h-[3rem]"
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
