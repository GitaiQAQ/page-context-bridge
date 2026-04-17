/**
 * Type Definitions
 */

/** URL parse result */
export interface ParsedURL {
  version: string;
  action: string;
  resource: string;
  params: Record<string, string>;
}

/** Supported action types */
export type ActionType = 'run' | 'session' | 'attach' | 'web';

/** Configuration options */
export interface Config {
  OPENCODE_BIN: string;
  OPENCODE_TERMINAL: string;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  DEBUG: boolean;
}

/** Log levels */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Terminal types */
export type TerminalType =
  | 'Terminal'
  | 'iTerm'
  | 'iTerm2'
  | 'Warp'
  | 'Ghostty'
  | 'Kitty'
  | 'Alacritty';

/** Terminal configuration */
export interface TerminalConfig {
  name: string;
  path: string;
}

/** Terminal config map */
export const TERMINAL_CONFIG: Record<TerminalType, TerminalConfig> = {
  Terminal: { name: 'Terminal', path: '/Applications/Terminal.app' },
  iTerm: { name: 'iTerm', path: '/Applications/iTerm.app' },
  iTerm2: { name: 'iTerm', path: '/Applications/iTerm.app' },
  Warp: { name: 'Warp', path: '/Applications/Warp.app' },
  Ghostty: { name: 'Ghostty', path: '/Applications/Ghostty.app' },
  Kitty: { name: 'kitty', path: '/Applications/kitty.app' },
  Alacritty: { name: 'alacritty', path: '/Applications/Alacritty.app' },
};

/** Log entry */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

/** Error codes */
export enum ErrorCode {
  INVALID_URL = 'INVALID_URL',
  UNSUPPORTED_ACTION = 'UNSUPPORTED_ACTION',
  CONFIG_ERROR = 'CONFIG_ERROR',
  TERMINAL_ERROR = 'TERMINAL_ERROR',
  EXECUTION_ERROR = 'EXECUTION_ERROR',
  USER_REJECTED = 'USER_REJECTED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  UNKNOWN = 'UNKNOWN',
}

/** Custom error class */
export class OpenCodeError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = 'OpenCodeError';
  }
}
