#!/usr/bin/env node
/**
 * opencode-handler: macOS opencode:// protocol handler
 *
 * Architecture:
 *   AppleScript applet (thin wrapper) -> this script -> parse URL -> execute opencode CLI in terminal
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { logger } from './logger.js';
import type { ParsedURL, Config, TerminalType, LogLevel } from './types.js';
import { OpenCodeError, ErrorCode } from './types.js';
import { buildCLICommand } from './cli-builder.js';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const HOME = homedir();
const INSTALL_DIR = join(HOME, '.opencode');
const CONFIG_FILE = join(INSTALL_DIR, 'config.env');
const TRUST_FILE = join(INSTALL_DIR, '.protocol-trusted');

mkdirSync(INSTALL_DIR, { recursive: true });

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

function loadConfig(): Config {
  const configRaw = {
    OPENCODE_BIN: 'opencode' as string,
    OPENCODE_TERMINAL: '' as string,
    LOG_LEVEL: 'info' as 'debug' | 'info' | 'warn' | 'error',
    DEBUG: false as boolean,
  };

  if (!existsSync(CONFIG_FILE)) return configRaw as Config;

  const content = readFileSync(CONFIG_FILE, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();

    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    if (val) {
      if (key === 'OPENCODE_BIN') configRaw.OPENCODE_BIN = val;
      else if (key === 'OPENCODE_TERMINAL') configRaw.OPENCODE_TERMINAL = val;
      else if (key === 'LOG_LEVEL') {
        if (['debug', 'info', 'warn', 'error'].includes(val)) {
          configRaw.LOG_LEVEL = val as LogLevel;
        }
      } else if (key === 'DEBUG') {
        configRaw.DEBUG = val === 'true' || val === '1';
      }
    }
  }

  if (process.env.OPENCODE_BIN) configRaw.OPENCODE_BIN = process.env.OPENCODE_BIN;
  if (process.env.OPENCODE_TERMINAL) configRaw.OPENCODE_TERMINAL = process.env.OPENCODE_TERMINAL;
  if (process.env.LOG_LEVEL) configRaw.LOG_LEVEL = process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error';
  if (process.env.DEBUG) configRaw.DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

  return configRaw;
}

// ─────────────────────────────────────────────
// URL Parsing
// ─────────────────────────────────────────────

function parseOpenCodeURL(urlStr: string): ParsedURL {
  const url = new URL(urlStr);
  if (url.protocol !== 'opencode:') {
    throw new OpenCodeError(ErrorCode.INVALID_URL, `Invalid scheme: ${url.protocol}`);
  }

  const segments: string[] = [];
  if (url.hostname) segments.push(url.hostname);
  segments.push(...url.pathname.split('/').filter(Boolean));

  let version = 'v1';
  if (segments.length && /^v\d+$/.test(segments[0])) {
    version = segments.shift()!;
  }

  const action = segments.shift() || '';
  const resource = segments.join('/');

  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    params[k] = v;
  }

  return { version, action, resource, params };
}

// ─────────────────────────────────────────────
// Shell Helpers
// ─────────────────────────────────────────────

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9\/_.:=@\-]+$/.test(s) && s.length > 0) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function asString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function runOsascript(script: string): void {
  try {
    execSync(`osascript -e ${shellQuote(script)}`, { stdio: 'pipe' });
  } catch (e) {
    logger.warn(`osascript failed: ${String(e)}`);
  }
}

function showNotification(title: string, message: string): void {
  runOsascript(`display notification "${message}" with title "${title}"`);
}

// ─────────────────────────────────────────────
// Terminal Detection
// ─────────────────────────────────────────────

function detectTerminal(preferred: string): TerminalType {
  if (preferred) return preferred as TerminalType;

  const checks: Array<[string, string]> = [
    ['iTerm', '/Applications/iTerm.app'],
    ['Warp', '/Applications/Warp.app'],
    ['Ghostty', '/Applications/Ghostty.app'],
    ['Kitty', '/Applications/kitty.app'],
    ['Alacritty', '/Applications/Alacritty.app'],
  ];

  for (const [name, path] of checks) {
    if (existsSync(path)) return name as TerminalType;
  }
  return 'Terminal';
}

// ─────────────────────────────────────────────
// Terminal Execution
// ─────────────────────────────────────────────

function executeInTerminal(cmd: string, cwd: string, terminal: TerminalType): void {
  logger.info(`Using terminal: ${terminal}, cwd: ${cwd}`);

  const fullCmd =
    `export PATH="$HOME/.opencode/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"; ` +
    `cd ${shellQuote(cwd)} && ${cmd}`;

  switch (terminal) {
    case 'Terminal':
      runOsascript(
        `tell application "Terminal"\nactivate\ndo script ${asString(fullCmd)}\nend tell`
      );
      break;

    case 'iTerm':
    case 'iTerm2':
      runOsascript(
        `tell application "iTerm"\nactivate\nset newWindow to (create window with default profile)\ntell current session of newWindow\nwrite text ${asString(fullCmd)}\nend tell\nend tell`
      );
      break;

    case 'Warp':
      runOsascript(
        `tell application "Warp"\nactivate\nend tell\ndelay 0.8\ntell application "System Events"\ntell process "Warp"\nkeystroke "t" using command down\ndelay 0.5\nkeystroke ${asString(fullCmd)}\nkey code 36\nend tell\nend tell`
      );
      break;

    case 'Kitty':
      spawn('kitty', ['--single-instance', 'bash', '-lc', fullCmd], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      break;

    case 'Alacritty':
      spawn('alacritty', ['-e', 'bash', '-lc', fullCmd], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      break;

    case 'Ghostty':
      spawn('open', ['-a', 'Ghostty'], { detached: true, stdio: 'ignore' }).unref();
      try {
        execSync('pbcopy', { input: fullCmd });
      } catch {
        // Ignore
      }
      showNotification('OpenCode', 'Command copied to clipboard. Press Cmd+V in Ghostty to execute.');
      break;

    default:
      runOsascript(
        `tell application "Terminal"\nactivate\ndo script ${asString(fullCmd)}\nend tell`
      );
  }
}

// ─────────────────────────────────────────────
// Web Action
// ─────────────────────────────────────────────

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(500);
    sock
      .connect(port, '127.0.0.1', () => {
        sock.destroy();
        resolve(true);
      })
      .on('error', () => {
        sock.destroy();
        resolve(false);
      })
      .on('timeout', () => {
        sock.destroy();
        resolve(false);
      });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function handleWebAction(parsed: ParsedURL, cwd: string, bin: string): Promise<void> {
  const port = parsed.params.port ? Number(parsed.params.port) : 4096;

  if (!(await isPortOpen(port))) {
    logger.info(`Starting opencode web on port ${port}...`);
    spawn(bin, ['web', '--port', String(port)], {
      cwd,
      detached: true,
      stdio: 'ignore',
    }).unref();

    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (await isPortOpen(port)) break;
    }
  }

  let browserURL = `http://localhost:${port}`;
  if (parsed.resource) {
    const sessionId = parsed.resource.replace(/^session\//, '');
    browserURL += `/session/${sessionId}`;
  }

  logger.info(`Opening browser: ${browserURL}`);
  spawn('open', [browserURL], { detached: true, stdio: 'ignore' }).unref();
}

// ─────────────────────────────────────────────
// Security Consent
// ─────────────────────────────────────────────

function checkFirstRunConsent(): boolean {
  if (existsSync(TRUST_FILE)) return true;

  try {
    const result = execSync(
      `osascript -e 'display dialog "Allow opencode:// protocol to execute OpenCode commands on this machine?" & return & return & "This will allow browsers to launch the local OpenCode CLI via opencode:// links." with title "OpenCode Protocol Authorization" buttons {"Deny", "Allow"} default button "Allow" with icon caution'`,
      { encoding: 'utf-8' }
    );
    if (result.includes('Allow')) {
      writeFileSync(TRUST_FILE, new Date().toISOString());
      return true;
    }
  } catch {
    // User clicked "Deny" or closed the dialog
  }
  return false;
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

export async function main(): Promise<void> {
  const urlStr = process.argv[2];
  if (!urlStr) {
    console.error('Usage: opencode-handler <opencode://...>');
    process.exit(1);
  }

  logger.info(`Received URL: ${urlStr}`);

  if (!checkFirstRunConsent()) {
    logger.info('User rejected protocol authorization');
    showNotification('OpenCode', 'Protocol authorization denied');
    process.exit(0);
  }

  let parsed: ParsedURL;
  try {
    parsed = parseOpenCodeURL(urlStr);
  } catch (e) {
    const msg = e instanceof OpenCodeError ? e.message : String(e);
    logger.error(`Parse error: ${msg}`);
    showNotification('OpenCode Error', msg);
    process.exit(1);
  }

  logger.info(`Parsed: action=${parsed.action}, resource=${parsed.resource}`, {
    params: parsed.params,
  });

  const config = loadConfig();
  logger.setLevel(config.LOG_LEVEL);

  let cwd = parsed.params.dir || HOME;
  if (!existsSync(cwd)) {
    logger.warn(`dir not found: ${cwd}, falling back to HOME`);
    cwd = HOME;
  }

  if (!['run', 'session', 'attach', 'web'].includes(parsed.action)) {
    const msg = `Unsupported action: ${parsed.action}`;
    logger.warn(msg);
    showNotification('OpenCode', msg);
    process.exit(0);
  }

  try {
    if (parsed.action === 'web') {
      await handleWebAction(parsed, cwd, config.OPENCODE_BIN);
    } else {
      const cliCmd = buildCLICommand(parsed, config.OPENCODE_BIN);
      logger.info(`CLI command: ${cliCmd}`);
      const terminal = detectTerminal(config.OPENCODE_TERMINAL);
      executeInTerminal(cliCmd, cwd, terminal);
    }
  } catch (e) {
    const msg = e instanceof OpenCodeError ? e.message : String(e);
    logger.error(`Execution failed: ${msg}`);
    showNotification('OpenCode Error', `Execution failed: ${msg}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    logger.error('Fatal error', { error: String(e) });
    process.exit(1);
  });
}
