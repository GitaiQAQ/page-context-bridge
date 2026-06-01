import {
  Brain,
  ChevronDown,
  Copy,
  ExternalLink,
  MessageSquare,
  PanelRightOpen,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Wrench,
  X,
  type IconNode,
} from 'lucide';
import { html, svg, type SVGTemplateResult } from 'lit';

export const ICONS = {
  brain: Brain,
  chevronDown: ChevronDown,
  copy: Copy,
  externalLink: ExternalLink,
  messageSquare: MessageSquare,
  panelRightOpen: PanelRightOpen,
  play: Play,
  plug: Plug,
  plus: Plus,
  refreshCw: RefreshCw,
  search: Search,
  settings: Settings,
  trash2: Trash2,
  wrench: Wrench,
  x: X,
} as const satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

export function renderIcon(name: IconName, className = 'h-3.5 w-3.5'): SVGTemplateResult {
  return svg`
    <svg
      class=${className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      ${ICONS[name].map(([tag, attrs]) =>
        tag === 'path'
          ? svg`<path d=${attrs.d ?? ''}></path>`
          : tag === 'circle'
            ? svg`<circle cx=${attrs.cx ?? ''} cy=${attrs.cy ?? ''} r=${attrs.r ?? ''}></circle>`
            : tag === 'line'
              ? svg`<line x1=${attrs.x1 ?? ''} y1=${attrs.y1 ?? ''} x2=${attrs.x2 ?? ''} y2=${attrs.y2 ?? ''}></line>`
              : tag === 'polyline'
                ? svg`<polyline points=${attrs.points ?? ''}></polyline>`
                : tag === 'polygon'
                  ? svg`<polygon points=${attrs.points ?? ''}></polygon>`
                  : svg`${html``}`,
      )}
    </svg>
  `;
}

export function createIconElement(name: IconName, className = 'h-3.5 w-3.5'): SVGSVGElement {
  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEl.setAttribute('class', className);
  svgEl.setAttribute('viewBox', '0 0 24 24');
  svgEl.setAttribute('fill', 'none');
  svgEl.setAttribute('stroke', 'currentColor');
  svgEl.setAttribute('stroke-width', '2');
  svgEl.setAttribute('stroke-linecap', 'round');
  svgEl.setAttribute('stroke-linejoin', 'round');
  svgEl.setAttribute('aria-hidden', 'true');
  svgEl.setAttribute('focusable', 'false');

  for (const [tag, attrs] of ICONS[name]) {
    const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) {
      child.setAttribute(key, String(value));
    }
    svgEl.appendChild(child);
  }
  return svgEl;
}
