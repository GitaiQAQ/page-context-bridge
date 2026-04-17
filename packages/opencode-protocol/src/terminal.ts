/**
 * Terminal Management
 */
import { existsSync } from 'node:fs';
import type { TerminalType } from './types.js';
import { TERMINAL_CONFIG } from './types.js';

const TERMINALS: TerminalType[] = ['iTerm', 'Warp', 'Ghostty', 'Kitty', 'Alacritty', 'Terminal'];

export function detectTerminal(preferred: string): TerminalType {
  if (preferred) return preferred as TerminalType;

  for (const term of TERMINALS) {
    if (existsSync(TERMINAL_CONFIG[term as TerminalType].path)) {
      return term as TerminalType;
    }
  }
  return 'Terminal';
}

export function getTerminalName(terminal: TerminalType): string {
  return TERMINAL_CONFIG[terminal]?.name || 'Terminal';
}
