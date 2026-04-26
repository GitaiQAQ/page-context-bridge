/**
 * Logging System
 */
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LogLevel, LogEntry } from './types.js';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const HOME = homedir();
const INSTALL_DIR = join(HOME, '.opencode');
const LOG_FILE = join(INSTALL_DIR, 'protocol-handler.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

class Logger {
  private level: LogLevel = 'info';
  private logFile: string = LOG_FILE;

  constructor() {
    mkdirSync(INSTALL_DIR, { recursive: true });
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setLogFile(path: string): void {
    this.logFile = path;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private formatMessage(entry: LogEntry): string {
    const context = entry.context ? ' ' + JSON.stringify(entry.context) : '';
    return `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}${context}\n`;
  }

  private write(entry: LogEntry): void {
    const line = this.formatMessage(entry);

    try {
      this.rotateIfNeeded();
      appendFileSync(this.logFile, line);
    } catch {
      // Ignore log write errors
    }

    process.stderr.write(line);
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.logFile)) return;

    try {
      const stats = statSync(this.logFile);
      if (stats.size > MAX_LOG_SIZE) {
        const backupFile = `${this.logFile}.old`;
        renameSync(this.logFile, backupFile);
      }
    } catch {
      // Ignore rotation errors
    }
  }

  private createEntry(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
    };
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      this.write(this.createEntry('debug', message, context));
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      this.write(this.createEntry('info', message, context));
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      this.write(this.createEntry('warn', message, context));
    }
  }

  error(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      this.write(this.createEntry('error', message, context));
    }
  }
}

export const logger = new Logger();
