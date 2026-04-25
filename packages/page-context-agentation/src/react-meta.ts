/**
 * React Fiber detection and metadata enrichment for background-side use.
 *
 * Runs inside MAIN world via chrome.scripting.executeScript to read
 * __reactFiber$ / __reactInternalInstance$ properties directly from DOM elements.
 * Only supplements reactPath/reactLeaf on uiAnchor.meta; any failure silently degrades.
 */

import type { FeedbackUiAnchor } from "@page-context/shared-protocol";

interface ReactAnchorMeta {
  reactPath: string[];
  reactLeaf: string;
}

interface ReactMetaQueryInput {
  cssSelector?: string;
  rect?: { x: number; y: number; width: number; height: number };
}

/**
 * Enrich uiAnchor with React component path/leaf metadata collected from MAIN world.
 * Skips injection if both fields already exist to avoid overhead.
 */
export async function enrichUiAnchorReactMetaInMainWorld(
  tabId: number,
  uiAnchor: FeedbackUiAnchor,
): Promise<FeedbackUiAnchor> {
  if (!uiAnchor) {
    return uiAnchor;
  }

  const existingMeta = toPlainRecord(uiAnchor.meta);
  const existingReactPath = toReactPath(existingMeta?.reactPath);
  const existingReactLeaf = toReactLeaf(existingMeta?.reactLeaf);

  // If both fields already have values, skip injection entirely.
  if (existingReactPath && existingReactLeaf) {
    return uiAnchor;
  }

  try {
    const [injectionResult] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: collectReactMetaInMainWorld,
      args: [
        {
          cssSelector: uiAnchor.cssSelector,
          rect: uiAnchor.rect,
        } satisfies ReactMetaQueryInput,
      ],
    });

    const collected = toReactAnchorMeta(injectionResult?.result);
    if (!collected) {
      return uiAnchor;
    }

    const nextReactPath = existingReactPath ?? collected.reactPath;
    const nextReactLeaf = existingReactLeaf ?? collected.reactLeaf;
    if (!nextReactPath || !nextReactLeaf) {
      return uiAnchor;
    }

    return {
      ...uiAnchor,
      meta: {
        ...(existingMeta ?? {}),
        reactPath: nextReactPath,
        reactLeaf: nextReactLeaf,
      },
    };
  } catch {
    // Non-React pages, restricted pages, or injection failures all silently degrade.
    return uiAnchor;
  }
}

function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function toReactAnchorMeta(value: unknown): ReactAnchorMeta | null {
  const record = toPlainRecord(value);
  if (!record) {
    return null;
  }

  const reactPath = toReactPath(record.reactPath);
  const reactLeaf = toReactLeaf(record.reactLeaf);
  if (!reactPath || !reactLeaf) {
    return null;
  }

  return { reactPath, reactLeaf };
}

function toReactPath(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12)
    .filter(Boolean);
}

function toReactLeaf(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function collectReactMetaInMainWorld(input: ReactMetaQueryInput): ReactAnchorMeta | null {
  type ReactFiberNode = {
    type?: unknown;
    elementType?: unknown;
    return?: ReactFiberNode | null;
  };

  const REACT_FIBER_KEY_PREFIXES = ["__reactFiber$", "__reactInternalInstance$", "__reactContainer$"] as const;
  const REACT_DOM_WALK_MAX_DEPTH = 12;
  const REACT_FIBER_MAX_DEPTH = 30;
  const REACT_PATH_MAX_COMPONENTS = 8;

  const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

  const getParentElement = (element: Element): Element | null => {
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    if (root instanceof ShadowRoot) return root.host;
    return null;
  };

  const resolveTargetElement = (): Element | null => {
    const selector = typeof input.cssSelector === "string" ? input.cssSelector.trim() : "";
    if (selector) {
      try {
        const bySelector = document.querySelector(selector);
        if (bySelector) return bySelector;
      } catch {
        // Invalid selector; continue with coordinate fallback.
      }
    }

    const rect = input.rect;
    if (!rect) return null;
    if (!isFiniteNumber(rect.x) || !isFiniteNumber(rect.y) || !isFiniteNumber(rect.width) || !isFiniteNumber(rect.height)) {
      return null;
    }
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    return document.elementFromPoint(centerX, centerY);
  };

  const getReactFiberFromElement = (element: Element): ReactFiberNode | null => {
    let keys: string[];
    try {
      keys = Object.keys(element as unknown as Record<string, unknown>);
    } catch {
      return null;
    }
    const fiberKey = keys.find((key) => REACT_FIBER_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)));
    if (!fiberKey) return null;
    const fiber = (element as unknown as Record<string, unknown>)[fiberKey];
    if (!fiber || typeof fiber !== "object") return null;
    return fiber as ReactFiberNode;
  };

  const getReactFiberFromElementOrAncestors = (target: Element): ReactFiberNode | null => {
    let current: Element | null = target;
    let depth = 0;
    while (current && depth < REACT_DOM_WALK_MAX_DEPTH) {
      const fiber = getReactFiberFromElement(current);
      if (fiber) return fiber;
      current = getParentElement(current);
      depth += 1;
    }
    return null;
  };

  const normalizeName = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized || null;
  };

  const isLikelyMinifiedName = (name: string): boolean => {
    if (name.length <= 2) return true;
    if (name.length <= 3 && name === name.toLowerCase()) return true;
    return false;
  };

  const readComponentNameFromType = (type: unknown, depth: number): string | null => {
    if (!type || depth > 3) return null;
    if (typeof type === "function") {
      const fn = type as Function & { displayName?: string };
      return normalizeName(fn.displayName ?? fn.name);
    }
    if (typeof type !== "object") return null;
    const record = type as Record<string, unknown>;
    const displayName = normalizeName(record.displayName);
    if (displayName) return displayName;
    const directName = normalizeName(record.name);
    if (directName) return directName;
    const nameFromRender = readComponentNameFromType(record.render, depth + 1);
    if (nameFromRender) return nameFromRender;
    const nameFromNestedType = readComponentNameFromType(record.type, depth + 1);
    if (nameFromNestedType) return nameFromNestedType;
    const nameFromLazyResult = readComponentNameFromType(record._result, depth + 1);
    if (nameFromLazyResult) return nameFromLazyResult;
    const contextRecord = record._context;
    if (contextRecord && typeof contextRecord === "object") {
      const contextName = normalizeName((contextRecord as Record<string, unknown>).displayName);
      if (contextName) return `${contextName}.Provider`;
    }
    return null;
  };

  const getComponentNameFromFiber = (fiber: ReactFiberNode): string | null => {
    if (typeof fiber.type === "string") return null;
    return readComponentNameFromType(fiber.elementType, 0) ?? readComponentNameFromType(fiber.type, 0);
  };

  const targetElement = resolveTargetElement();
  if (!targetElement) return null;

  const fiber = getReactFiberFromElementOrAncestors(targetElement);
  if (!fiber) return null;

  const components: string[] = [];
  const visitedFibers = new Set<ReactFiberNode>();
  let current: ReactFiberNode | null | undefined = fiber;
  let depth = 0;

  try {
    while (
      current &&
      depth < REACT_FIBER_MAX_DEPTH &&
      components.length < REACT_PATH_MAX_COMPONENTS
    ) {
      if (visitedFibers.has(current)) break;
      visitedFibers.add(current);

      const name = getComponentNameFromFiber(current);
      if (name && !isLikelyMinifiedName(name)) {
        const prev = components[components.length - 1];
        if (prev !== name) components.push(name);
      }

      current = current.return;
      depth += 1;
    }
  } catch {
    return null;
  }

  if (components.length === 0) return null;

  return {
    reactPath: components.slice().reverse(),
    reactLeaf: components[0]!,
  };
}
