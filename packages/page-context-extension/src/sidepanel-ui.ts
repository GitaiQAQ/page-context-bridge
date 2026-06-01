import { html, nothing, type TemplateResult } from 'lit';

export function renderTabHeader(input: {
  title: string;
  meta?: string | TemplateResult;
  action?: TemplateResult;
}): TemplateResult {
  return html`
    <div class="flex items-center gap-2 border-b border-base-300 bg-base-100 px-3 py-2 shrink-0">
      <span class="text-xs font-bold uppercase tracking-wide opacity-60">${input.title}</span>
      ${input.meta
        ? html`<span class="text-[11px] opacity-45 truncate">${input.meta}</span>`
        : nothing}
      ${input.action ? html`<div class="ml-auto">${input.action}</div>` : nothing}
    </div>
  `;
}

export function renderPanel(input: {
  title?: string;
  meta?: string | TemplateResult;
  body: TemplateResult;
  action?: TemplateResult;
  className?: string;
}): TemplateResult {
  return html`
    <section class="border border-base-300 bg-base-100 ${input.className ?? ''}">
      ${input.title || input.meta || input.action
        ? html`
            <div class="flex items-center gap-2 border-b border-base-200 px-3 py-2">
              ${input.title
                ? html`<h3 class="text-sm font-bold leading-tight">${input.title}</h3>`
                : nothing}
              ${input.meta ? html`<span class="text-xs opacity-55">${input.meta}</span>` : nothing}
              ${input.action ? html`<div class="ml-auto">${input.action}</div>` : nothing}
            </div>
          `
        : nothing}
      <div class="p-3">${input.body}</div>
    </section>
  `;
}

export function renderInlineMeta(parts: Array<string | number | null | undefined>): TemplateResult {
  return html`<span class="text-[11px] opacity-55">${parts.filter(Boolean).join(' · ')}</span>`;
}
