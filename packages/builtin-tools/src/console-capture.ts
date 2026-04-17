/**
 * Console capture utility for content scripts.
 *
 * Intercepts console.log/warn/error/info calls and window error events,
 * storing entries in a capped buffer for retrieval via get_console_logs.
 */

export interface ConsoleEntry {
  level: "log" | "warn" | "error" | "info";
  timestamp: number;
  args: string;
}

const MAX_CONSOLE_ENTRIES = 200;

export function createConsoleCapture(win: Window, consoleEntries: ConsoleEntry[]): void {
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
  };

  const capture = (level: ConsoleEntry["level"], args: unknown[]) => {
    const entry: ConsoleEntry = {
      level,
      timestamp: Date.now(),
      args: args
        .map((value) => {
          try {
            return typeof value === "object" ? JSON.stringify(value) : String(value);
          } catch {
            return String(value);
          }
        })
        .join(" "),
    };
    consoleEntries.push(entry);
    if (consoleEntries.length > MAX_CONSOLE_ENTRIES) {
      consoleEntries.shift();
    }
  };

  console.log = (...args: unknown[]) => {
    capture("log", args);
    originalConsole.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    capture("warn", args);
    originalConsole.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    capture("error", args);
    originalConsole.error(...args);
  };
  console.info = (...args: unknown[]) => {
    capture("info", args);
    originalConsole.info(...args);
  };

  win.addEventListener("error", (event) => {
    capture("error", [`${event.message} at ${event.filename}:${event.lineno}`]);
  });
}
