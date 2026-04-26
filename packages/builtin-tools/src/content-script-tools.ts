/**
 * Content-script tool implementations.
 *
 * These tools execute in the content script context where they have
 * direct access to the page DOM (window, document).
 */

import type { ContentScriptToolEnv } from '@page-context/shared-protocol';

export { createConsoleCapture } from './console-capture.js';

/**
 * Execute a builtin tool in the content script context.
 * Only handles tools with executionContext === "content-script".
 */
export function executeContentScriptTool(
  tool: string,
  args: Record<string, unknown>,
  env: ContentScriptToolEnv,
): unknown {
  const win = env.win as Window;
  const doc = env.doc as Document;
  const { consoleEntries } = env;

  // Historical (non-namespaced) aliases are intentionally NOT supported.
  switch (tool) {
    case 'builtin.get_page_info':
      return {
        url: win.location.href,
        title: doc.title,
        meta: Array.from(doc.querySelectorAll('meta'))
          .slice(0, 10)
          .map((element) => ({
            name: element.getAttribute('name') || element.getAttribute('property') || '',
            content: element.getAttribute('content') || '',
          })),
      };
    case 'builtin.get_selected_text': {
      const selection = win.getSelection();
      return { text: selection ? selection.toString() : '' };
    }
    case 'builtin.click_element': {
      const selector = String(args.selector ?? '');
      const element = doc.querySelector<HTMLElement>(selector);
      if (!element) {
        throw new Error(`Element not found: ${selector}`);
      }
      element.click();
      return { clicked: true, selector };
    }
    case 'builtin.scroll_into_view': {
      const selector = String(args.selector ?? '');
      const behavior = String(args.behavior ?? 'auto');
      const element = doc.querySelector<HTMLElement>(selector);
      if (!element) {
        throw new Error(`Element not found: ${selector}`);
      }
      element.scrollIntoView({
        behavior: behavior === 'smooth' ? 'smooth' : 'auto',
        block: 'center',
        inline: 'center',
      });
      return { scrolled: true, selector };
    }
    case 'builtin.get_element_text': {
      const selector = String(args.selector ?? '');
      const element = doc.querySelector<HTMLElement>(selector);
      if (!element) {
        throw new Error(`Element not found: ${selector}`);
      }
      return { text: element.textContent, selector };
    }
    case 'builtin.get_element_html': {
      const selector = String(args.selector ?? '');
      const element = doc.querySelector<HTMLElement>(selector);
      if (!element) {
        throw new Error(`Element not found: ${selector}`);
      }
      const html = element.outerHTML;
      if (html.length > 50_000) {
        return {
          html: `${html.slice(0, 50_000)}\n... (truncated)`,
          truncated: true,
          totalLength: html.length,
        };
      }
      return { html, selector };
    }
    case 'builtin.query_elements': {
      const selector = String(args.selector ?? '');
      const limit = Number(args.limit ?? 20);
      const matches = Array.from(doc.querySelectorAll<HTMLElement>(selector));
      return {
        count: matches.length,
        results: matches.slice(0, limit).map((element) => ({
          tag: element.tagName.toLowerCase(),
          id: element.id || undefined,
          className: element.className || undefined,
          text: (element.textContent || '').substring(0, 200).trim(),
          attributes: Array.from(element.attributes)
            .filter((attribute) => !['class', 'id', 'style'].includes(attribute.name))
            .reduce<Record<string, string>>((accumulator, attribute) => {
              accumulator[attribute.name] = attribute.value;
              return accumulator;
            }, {}),
        })),
      };
    }
    case 'builtin.fill_input': {
      const selector = String(args.selector ?? '');
      const value = String(args.value ?? '');
      const element = doc.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
      if (!element) {
        throw new Error(`Element not found: ${selector}`);
      }
      element.focus();
      const setter =
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(element, value);
      } else {
        element.value = value;
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true, selector, value };
    }
    case 'builtin.execute_js': {
      // SECURITY: This eval executes arbitrary JavaScript in the page context.
      // This is intentional — the execute_js MCP tool allows deep page inspection.
      // The MCP bridge server runs locally and relies on local network isolation.
      // See README.md "Security Considerations" for details.
      try {
        const result = eval(String(args.expression ?? ''));
        return {
          ok: true,
          result: typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result),
          type: typeof result,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          type: 'execution_error',
        };
      }
    }
    case 'builtin.get_console_logs': {
      const limit = Number(args.limit ?? 50);
      const level = String(args.level ?? 'all');
      const filtered =
        level === 'all'
          ? consoleEntries
          : consoleEntries.filter((entry: any) => entry.level === level);
      return {
        entries: filtered.slice(-limit),
        total: filtered.length,
      };
    }
    case 'builtin.wait_for_selector': {
      const selector = String(args.selector ?? '');
      const state = String(args.state ?? 'attached');
      const timeoutMs = Math.max(0, Math.floor(Number(args.timeoutMs ?? 10_000)));

      const isVisible = (element: Element): boolean => {
        const el = element as HTMLElement;
        const style = win.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const check = (): { ok: boolean; element?: Element } => {
        const element = doc.querySelector(selector);
        if (!element) {
          return { ok: false };
        }
        if (state === 'visible' && !isVisible(element)) {
          return { ok: false, element };
        }
        return { ok: true, element };
      };

      const initial = check();
      if (initial.ok) {
        return { matched: true, selector, state: state === 'visible' ? 'visible' : 'attached' };
      }

      return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          const now = Date.now();
          const res = check();
          if (res.ok) {
            resolve({
              matched: true,
              selector,
              state: state === 'visible' ? 'visible' : 'attached',
              waitedMs: now - start,
            });
            return;
          }
          if (now - start >= timeoutMs) {
            reject(new Error(`Timeout waiting for selector: ${selector} (state=${state})`));
            return;
          }
          win.requestAnimationFrame(tick);
        };
        tick();
      });
    }
    default:
      throw new Error(`Unknown content-script tool: ${tool}`);
  }
}
