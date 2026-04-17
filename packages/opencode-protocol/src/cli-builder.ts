/**
 * CLI Command Builder
 */
import type { ParsedURL } from './types.js';
import { ACTIONS } from './config.js';

export function buildCLICommand(parsed: ParsedURL, bin: string): string {
  const { action, resource, params } = parsed;
  const config = ACTIONS[action];

  if (!config) {
    throw new Error(`Unsupported action: ${action}`);
  }

  const parts = [bin, config.command];

  for (const [urlParam, cliFlag] of Object.entries(config.paramMap)) {
    const value = params[urlParam];
    if (value === undefined) continue;

    if (cliFlag === null) {
      if (urlParam === 'session' && resource === 'continue') {
        parts.push('-c');
      } else if (resource || urlParam === 'url') {
        parts.push(value);
      }
      continue;
    }

    if (config.boolParams?.includes(urlParam)) {
      if (isTruthy(value)) {
        parts.push(`-${cliFlag}`);
      }
      continue;
    }

    if (config.arrayParams?.includes(urlParam)) {
      const values = value.split(',').map((v) => v.trim()).filter(Boolean);
      for (const v of values) {
        parts.push(`-${cliFlag}`, v);
      }
      continue;
    }

    parts.push(`-${cliFlag}`, value);
  }

  if (action === 'run' && params.msg) {
    for (const m of params.msg.split(',')) {
      parts.push(m.trim());
    }
  }

  return parts.map(shellQuote).join(' ');
}

function isTruthy(val: string): boolean {
  return val === '1' || val === 'true' || val === 'True';
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9\/_.:=@\-]+$/.test(s) && s.length > 0) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
