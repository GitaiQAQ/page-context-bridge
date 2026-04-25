/**
 * Service-worker tool implementations.
 *
 * These tools execute in the page-context extension service worker (background)
 * where they have access to extension APIs (tabs, etc.) but not the DOM.
 */

import type { ServiceWorkerToolContext } from "@page-context/shared-protocol";

function toTargetTabId(args: Record<string, unknown>, ctx: ServiceWorkerToolContext): Promise<number> {
  const explicit = Number(args.tabId ?? 0);
  if (explicit) {
    return Promise.resolve(explicit);
  }
  return ctx.getActiveTabId().then((id: number | undefined) => {
    if (!id) {
      throw new Error("No active tab available");
    }
    return id;
  });
}

function normalizeWaitUntil(value: unknown): "load" | "none" {
  const v = String(value ?? "load");
  return v === "none" ? "none" : "load";
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, n));
}

function modifierMask(modifiers: unknown): number {
  const list = Array.isArray(modifiers) ? modifiers.map(String) : [];
  let mask = 0;
  for (const m of list) {
    switch (m) {
      case "Alt": mask |= 1; break;
      case "Control": mask |= 2; break;
      case "Meta": mask |= 4; break;
      case "Shift": mask |= 8; break;
      default: break;
    }
  }
  return mask;
}

function keyToCdp(key: string): { key: string; code?: string; windowsVirtualKeyCode?: number; nativeVirtualKeyCode?: number; text?: string } {
  const k = key;
  const special: Record<string, { code: string; vk: number }> = {
    Enter: { code: "Enter", vk: 13 },
    Tab: { code: "Tab", vk: 9 },
    Escape: { code: "Escape", vk: 27 },
    Backspace: { code: "Backspace", vk: 8 },
    Delete: { code: "Delete", vk: 46 },
    ArrowUp: { code: "ArrowUp", vk: 38 },
    ArrowDown: { code: "ArrowDown", vk: 40 },
    ArrowLeft: { code: "ArrowLeft", vk: 37 },
    ArrowRight: { code: "ArrowRight", vk: 39 },
    Home: { code: "Home", vk: 36 },
    End: { code: "End", vk: 35 },
    PageUp: { code: "PageUp", vk: 33 },
    PageDown: { code: "PageDown", vk: 34 },
    Space: { code: "Space", vk: 32 },
  };

  const hit = special[k];
  if (hit) {
    return { key: k === "Space" ? " " : k, code: hit.code, windowsVirtualKeyCode: hit.vk, nativeVirtualKeyCode: hit.vk, text: k === "Space" ? " " : undefined };
  }

  if (k.length === 1) {
    const ch = k;
    const upper = ch.toUpperCase();
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(ch) ? `Digit${ch}` : undefined;
    const vk = upper.charCodeAt(0);
    return { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: ch };
  }

  return { key: k };
}

/**
 * Execute a builtin tool in the service worker context.
 * Only handles tools with executionContext === "service-worker".
 */
export async function executeServiceWorkerTool(
  tool: string,
  args: Record<string, unknown>,
  ctx: ServiceWorkerToolContext,
): Promise<unknown> {
  // Historical (non-namespaced) aliases are intentionally NOT supported.
  switch (tool) {
    case "builtin.list_tabs": {
      const tabs = await ctx.listTabs();
      return { tabs };
    }
    case "builtin.screenshot_tab": {
      // Default: jpeg with moderate quality to reduce payload size and latency.
      const format = (args.format as "png" | "jpeg" | undefined) ?? "jpeg";
      const quality = clampNumber(args.quality, 70, 0, 100);
      const dataUrl = await ctx.captureVisibleTab(format, format === "jpeg" ? Math.round(quality) : undefined);
      return {
        format,
        dataUrl,
        sizeHint: dataUrl.length,
      };
    }
    case "builtin.screenshot_page": {
      const tabId = await toTargetTabId(args, ctx);
      // Default: jpeg + quality + maxPixels to keep capture & transport fast.
      const format = (args.format as "png" | "jpeg" | undefined) ?? "jpeg";
      const quality = clampNumber(args.quality, 70, 0, 100);
      const fullPage = Boolean(args.fullPage ?? false);

      // Default cap: 4MP. Allow callers to override.
      const maxPixels = clampNumber(args.maxPixels, 4_000_000, 100_000, 200_000_000);

      // CDP returns base64 without data URL prefix.
      // Determine capture area and optional scaling.
      let clip: { x: number; y: number; width: number; height: number; scale: number } | null = null;
      try {
        const metrics = (await ctx.cdpSendCommand(tabId, "Page.getLayoutMetrics")) as any;
        const contentSize = metrics?.contentSize;
        const visualViewport = metrics?.visualViewport;
        const width = Number(fullPage ? contentSize?.width : visualViewport?.clientWidth);
        const height = Number(fullPage ? contentSize?.height : visualViewport?.clientHeight);
        if (width > 0 && height > 0) {
          const pixels = width * height;
          const scale = pixels > maxPixels ? Math.max(0.1, Math.min(1, Math.sqrt(maxPixels / pixels))) : 1;
          if (scale < 1 || fullPage) {
            clip = { x: 0, y: 0, width, height, scale };
          }
        }
      } catch {
        // Ignore metrics failures; fall back to default capture.
      }

      const params: Record<string, unknown> = {
        format,
        fromSurface: true,
        ...(clip ? { clip } : null),
      };
      if (format === "jpeg") {
        params.quality = quality;
      }
      if (fullPage) {
        params.captureBeyondViewport = true;
      }

      try {
        const result = (await ctx.cdpSendCommand(tabId, "Page.captureScreenshot", params)) as { data?: string };
        if (!result?.data) {
          throw new Error("CDP Page.captureScreenshot returned no data");
        }
        return {
          tabId,
          format,
          dataBase64: result.data,
          ...(clip ? { scale: clip.scale, maxPixels } : null),
        };
      } catch (error) {
        // Fallback: try layout metrics + clip (older Chrome versions).
        if (!fullPage) {
          throw error;
        }
        const metrics = (await ctx.cdpSendCommand(tabId, "Page.getLayoutMetrics")) as any;
        const size = metrics?.contentSize;
        const width = Number(size?.width ?? 0);
        const height = Number(size?.height ?? 0);
        if (!width || !height) {
          throw error;
        }
        const clipped = (await ctx.cdpSendCommand(tabId, "Page.captureScreenshot", {
          ...params,
          clip: { x: 0, y: 0, width, height, scale: 1 },
        })) as { data?: string };
        if (!clipped?.data) {
          throw error;
        }
        return { tabId, format, dataBase64: clipped.data, clipped: true, width, height };
      }
    }
    case "builtin.navigate": {
      const targetTabId = await toTargetTabId(args, ctx);
      const url = String(args.url ?? "");
      await ctx.navigateTab(targetTabId, url);
      const waitUntil = normalizeWaitUntil(args.waitUntil);
      const timeoutMs = Math.max(0, Math.floor(Number(args.timeoutMs ?? 15_000)));
      if (waitUntil !== "none") {
        await ctx.waitForTabStatus(targetTabId, "complete", timeoutMs);
      }
      return { navigating: true, tabId: targetTabId, url, waitUntil };
    }
    case "builtin.wait_for_navigation": {
      const targetTabId = await toTargetTabId(args, ctx);
      const timeoutMs = Math.max(0, Math.floor(Number(args.timeoutMs ?? 15_000)));
      await ctx.waitForTabStatus(targetTabId, "complete", timeoutMs);
      return { ok: true, tabId: targetTabId, status: "complete" };
    }
    case "builtin.reload": {
      const targetTabId = await toTargetTabId(args, ctx);
      const bypassCache = Boolean(args.bypassCache ?? false);
      await ctx.reloadTab(targetTabId, bypassCache);
      const waitUntil = normalizeWaitUntil(args.waitUntil);
      const timeoutMs = Math.max(0, Math.floor(Number(args.timeoutMs ?? 15_000)));
      if (waitUntil !== "none") {
        await ctx.waitForTabStatus(targetTabId, "complete", timeoutMs);
      }
      return { reloaded: true, tabId: targetTabId, bypassCache, waitUntil };
    }
    case "builtin.go_back": {
      const targetTabId = await toTargetTabId(args, ctx);
      await ctx.goBack(targetTabId);
      const waitUntil = normalizeWaitUntil(args.waitUntil);
      const timeoutMs = Math.max(0, Math.floor(Number(args.timeoutMs ?? 15_000)));
      if (waitUntil !== "none") {
        await ctx.waitForTabStatus(targetTabId, "complete", timeoutMs);
      }
      return { ok: true, tabId: targetTabId, action: "back", waitUntil };
    }
    case "builtin.go_forward": {
      const targetTabId = await toTargetTabId(args, ctx);
      await ctx.goForward(targetTabId);
      const waitUntil = normalizeWaitUntil(args.waitUntil);
      const timeoutMs = Math.max(0, Math.floor(Number(args.timeoutMs ?? 15_000)));
      if (waitUntil !== "none") {
        await ctx.waitForTabStatus(targetTabId, "complete", timeoutMs);
      }
      return { ok: true, tabId: targetTabId, action: "forward", waitUntil };
    }
    case "builtin.open_tab": {
      const url = String(args.url ?? "");
      if (!url) {
        throw new Error("Missing url");
      }
      const active = args.active == null ? true : Boolean(args.active);
      const created = await ctx.createTab(url, active);
      return { opened: true, url, active, tabId: created.tabId };
    }
    case "builtin.close_tab": {
      const targetTabId = await toTargetTabId(args, ctx);
      await ctx.closeTab(targetTabId);
      return { closed: true, tabId: targetTabId };
    }
    case "builtin.press_key": {
      const targetTabId = await toTargetTabId(args, ctx);
      const key = String(args.key ?? "");
      if (!key) {
        throw new Error("Missing key");
      }
      const modifiers = modifierMask(args.modifiers);
      const def = keyToCdp(key);
      await ctx.cdpSendCommand(targetTabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers, ...def });
      await ctx.cdpSendCommand(targetTabId, "Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...def });
      return { ok: true, tabId: targetTabId, key };
    }
    case "builtin.type_text": {
      const targetTabId = await toTargetTabId(args, ctx);
      const text = String(args.text ?? "");
      await ctx.cdpSendCommand(targetTabId, "Input.insertText", { text });
      return { ok: true, tabId: targetTabId, length: text.length };
    }
    default:
      throw new Error(`Unknown service-worker tool: ${tool}`);
  }
}
