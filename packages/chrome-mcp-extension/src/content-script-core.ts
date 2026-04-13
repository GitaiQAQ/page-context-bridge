export interface ConsoleEntry {
  level: "log" | "warn" | "error" | "info";
  timestamp: number;
  args: string;
}

export interface ToolEnvironment {
  win: Window;
  doc: Document;
  consoleEntries: ConsoleEntry[];
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

export function executeBuiltInTool(tool: string, args: Record<string, unknown>, environment: ToolEnvironment) {
  const { win, doc, consoleEntries } = environment;

  switch (tool) {
    case "get_page_info":
      return {
        url: win.location.href,
        title: doc.title,
        meta: Array.from(doc.querySelectorAll("meta"))
          .slice(0, 10)
          .map((element) => ({
            name: element.getAttribute("name") || element.getAttribute("property") || "",
            content: element.getAttribute("content") || "",
          })),
      };
    case "get_selected_text": {
      const selection = win.getSelection();
      return { text: selection ? selection.toString() : "" };
    }
    case "click_element": {
      const selector = String(args.selector ?? "");
      const element = doc.querySelector<HTMLElement>(selector);
      if (!element) {
        throw new Error(`Element not found: ${selector}`);
      }
      element.click();
      return { clicked: true, selector };
    }
    case "get_element_text": {
      const selector = String(args.selector ?? "");
      const element = doc.querySelector<HTMLElement>(selector);
      if (!element) {
        throw new Error(`Element not found: ${selector}`);
      }
      return { text: element.textContent, selector };
    }
    case "get_element_html": {
      const selector = String(args.selector ?? "");
      const element = doc.querySelector<HTMLElement>(selector);
      if (!element) {
        throw new Error(`Element not found: ${selector}`);
      }
      const html = element.outerHTML;
      if (html.length > 50_000) {
        return { html: `${html.slice(0, 50_000)}\n... (truncated)`, truncated: true, totalLength: html.length };
      }
      return { html, selector };
    }
    case "query_elements": {
      const selector = String(args.selector ?? "");
      const limit = Number(args.limit ?? 20);
      const matches = Array.from(doc.querySelectorAll<HTMLElement>(selector));
      return {
        count: matches.length,
        results: matches.slice(0, limit).map((element) => ({
          tag: element.tagName.toLowerCase(),
          id: element.id || undefined,
          className: element.className || undefined,
          text: (element.textContent || "").substring(0, 200).trim(),
          attributes: Array.from(element.attributes)
            .filter((attribute) => !["class", "id", "style"].includes(attribute.name))
            .reduce<Record<string, string>>((accumulator, attribute) => {
              accumulator[attribute.name] = attribute.value;
              return accumulator;
            }, {}),
        })),
      };
    }
    case "fill_input": {
      const selector = String(args.selector ?? "");
      const value = String(args.value ?? "");
      const element = doc.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
      if (!element) {
        throw new Error(`Element not found: ${selector}`);
      }
      element.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
        || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) {
        setter.call(element, value);
      } else {
        element.value = value;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: true, selector, value };
    }
    case "execute_js": {
      // SECURITY: This eval executes arbitrary JavaScript in the page context.
      // This is intentional — the execute_js MCP tool allows deep page inspection.
      // The MCP bridge server runs locally and relies on local network isolation.
      // See README.md "Security Considerations" for details.
      try {
        const result = eval(String(args.expression ?? ""));
        return {
          ok: true,
          result: typeof result === "object" ? JSON.stringify(result, null, 2) : String(result),
          type: typeof result,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          type: "execution_error",
        };
      }
    }
    case "get_console_logs": {
      const limit = Number(args.limit ?? 50);
      const level = String(args.level ?? "all");
      const filtered = level === "all" ? consoleEntries : consoleEntries.filter((entry) => entry.level === level);
      return {
        entries: filtered.slice(-limit),
        total: filtered.length,
      };
    }
    case "navigate":
    case "screenshot_tab":
      throw new Error(`Tool '${tool}' is handled by the service worker`);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
