/**
 * 这组函数从 agentation 裁剪而来，只保留 UI 标注主链路需要的能力：
 * 1) 跨 shadow root 向上查找祖先
 * 2) 生成人可读的元素名与路径
 */

function getParentElement(element: Element): Element | null {
  if (element.parentElement) {
    return element.parentElement;
  }
  const root = element.getRootNode();
  if (root instanceof ShadowRoot) {
    return root.host;
  }
  return null;
}

/**
 * 支持穿透 shadow 边界的 closest。
 * 某些组件把真实节点包在 shadow 中，标准 closest 会提前停止。
 */
export function closestCrossingShadow(element: Element, selector: string): Element | null {
  let current: Element | null = element;
  while (current) {
    if (current.matches(selector)) {
      return current;
    }
    current = getParentElement(current);
  }
  return null;
}

export function getElementPath(target: HTMLElement, maxDepth = 4): string {
  const parts: string[] = [];
  let current: HTMLElement | null = target;
  let depth = 0;

  while (current && depth < maxDepth) {
    const tag = current.tagName.toLowerCase();
    if (tag === "html" || tag === "body") {
      break;
    }

    let identifier = tag;
    if (current.id) {
      identifier = `#${current.id}`;
    } else if (typeof current.className === "string" && current.className.trim()) {
      const meaningfulClass = current.className
        .split(/\s+/)
        .find((token) => token.length > 2 && !/^[a-z]{1,2}$/.test(token) && !/[A-Z0-9]{5,}/.test(token));
      if (meaningfulClass) {
        identifier = `.${meaningfulClass.split("_")[0]}`;
      }
    }

    const nextParent = getParentElement(current);
    if (!current.parentElement && nextParent) {
      identifier = `⟨shadow⟩ ${identifier}`;
    }

    parts.unshift(identifier);
    current = nextParent as HTMLElement | null;
    depth += 1;
  }

  return parts.join(" > ");
}

/**
 * 为 popup 生成简短、可读、可落日志的元素描述。
 * 不追求“完全准确”，优先稳定和可理解。
 */
export function identifyElement(target: HTMLElement): { name: string; path: string } {
  const path = getElementPath(target);
  if (target.dataset.element) {
    return { name: target.dataset.element, path };
  }

  const tag = target.tagName.toLowerCase();

  if (["path", "circle", "rect", "line", "g"].includes(tag)) {
    const svg = closestCrossingShadow(target, "svg");
    if (svg) {
      return { name: "graphic element", path };
    }
  }
  if (tag === "svg") {
    const parent = getParentElement(target);
    if (parent?.tagName.toLowerCase() === "button") {
      const btnText = parent.textContent?.trim();
      return { name: btnText ? `icon in "${btnText}" button` : "button icon", path };
    }
    return { name: "icon", path };
  }

  if (tag === "button") {
    const text = target.textContent?.trim();
    const ariaLabel = target.getAttribute("aria-label");
    if (ariaLabel) {
      return { name: `button [${ariaLabel}]`, path };
    }
    return { name: text ? `button "${text.slice(0, 24)}"` : "button", path };
  }
  if (tag === "a") {
    const text = target.textContent?.trim();
    const href = target.getAttribute("href");
    if (text) {
      return { name: `link "${text.slice(0, 24)}"`, path };
    }
    if (href) {
      return { name: `link to ${href.slice(0, 30)}`, path };
    }
    return { name: "link", path };
  }
  if (tag === "input") {
    const type = target.getAttribute("type") || "text";
    const placeholder = target.getAttribute("placeholder");
    if (placeholder) {
      return { name: `input "${placeholder}"`, path };
    }
    return { name: `${type} input`, path };
  }
  if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
    const text = target.textContent?.trim();
    return { name: text ? `${tag} "${text.slice(0, 35)}"` : tag, path };
  }
  if (tag === "img") {
    const alt = target.getAttribute("alt");
    return { name: alt ? `image "${alt.slice(0, 24)}"` : "image", path };
  }

  if (["div", "section", "article", "nav", "header", "footer", "aside", "main"].includes(tag)) {
    const ariaLabel = target.getAttribute("aria-label");
    const role = target.getAttribute("role");
    if (ariaLabel) {
      return { name: `${tag} [${ariaLabel}]`, path };
    }
    if (role) {
      return { name: role, path };
    }
    return { name: tag === "div" ? "container" : tag, path };
  }

  return { name: tag, path };
}

interface ReactFiberNode {
  tag?: number;
  type?: unknown;
  elementType?: unknown;
  return?: ReactFiberNode | null;
}

interface ReactAnchorMeta {
  reactPath: string[];
  reactLeaf: string;
}

const REACT_FIBER_MAX_DEPTH = 30;
const REACT_PATH_MAX_COMPONENTS = 8;
const REACT_DOM_WALK_MAX_DEPTH = 12;
const REACT_FIBER_KEY_PREFIXES = ["__reactFiber$", "__reactInternalInstance$"] as const;

/**
 * 尝试从目标元素及其祖先里找到 React fiber。
 * 只做轻量探测，不依赖 React 运行时对象。
 */
function getReactFiberFromElementOrAncestors(target: HTMLElement): ReactFiberNode | null {
  let current: Element | null = target;
  let depth = 0;

  while (current && depth < REACT_DOM_WALK_MAX_DEPTH) {
    const fiber = getReactFiberFromElement(current);
    if (fiber) {
      return fiber;
    }
    current = getParentElement(current);
    depth += 1;
  }

  return null;
}

function getReactFiberFromElement(target: Element): ReactFiberNode | null {
  let keys: string[];
  try {
    keys = Object.keys(target);
  } catch {
    // 某些宿主对象可能拦截属性读取，失败时直接降级。
    return null;
  }

  const fiberKey = keys.find((key) => REACT_FIBER_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)));
  if (!fiberKey) {
    return null;
  }

  const value = (target as unknown as Record<string, unknown>)[fiberKey];
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as ReactFiberNode;
}

function getComponentNameFromFiber(fiber: ReactFiberNode): string | null {
  // React HostComponent 的 type 是字符串（如 "div"），这不是组件名。
  if (typeof fiber.type === "string") {
    return null;
  }

  const nameFromElementType = readComponentNameFromType(fiber.elementType, 0);
  if (nameFromElementType) {
    return nameFromElementType;
  }
  return readComponentNameFromType(fiber.type, 0);
}

function readComponentNameFromType(type: unknown, depth: number): string | null {
  if (!type || depth > 3) {
    return null;
  }

  if (typeof type === "function") {
    const fn = type as Function & { displayName?: string };
    const name = fn.displayName ?? fn.name;
    return normalizeComponentName(name);
  }

  if (typeof type !== "object") {
    return null;
  }

  const record = type as Record<string, unknown>;

  const displayName = normalizeComponentName(record.displayName);
  if (displayName) {
    return displayName;
  }

  const directName = normalizeComponentName(record.name);
  if (directName) {
    return directName;
  }

  // 兼容 ForwardRef / Memo / Lazy 等包装类型。
  const nameFromRender = readComponentNameFromType(record.render, depth + 1);
  if (nameFromRender) {
    return nameFromRender;
  }

  const nameFromNestedType = readComponentNameFromType(record.type, depth + 1);
  if (nameFromNestedType) {
    return nameFromNestedType;
  }

  const nameFromLazyResult = readComponentNameFromType(record._result, depth + 1);
  if (nameFromLazyResult) {
    return nameFromLazyResult;
  }

  // ContextProvider 在 _context.displayName 上常能取到可读名字。
  const contextRecord = record._context;
  if (contextRecord && typeof contextRecord === "object") {
    const contextName = normalizeComponentName((contextRecord as Record<string, unknown>).displayName);
    if (contextName) {
      return `${contextName}.Provider`;
    }
  }

  return null;
}

function normalizeComponentName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function isLikelyMinifiedComponentName(name: string): boolean {
  if (name.length <= 2) {
    return true;
  }
  if (name.length <= 3 && name === name.toLowerCase()) {
    return true;
  }
  return false;
}

/**
 * 从 DOM 可见的 fiber 链路提取 React 组件路径。
 * 结果用于写入 uiAnchor.meta，取不到时返回 null。
 */
export function extractReactAnchorMeta(target: HTMLElement): ReactAnchorMeta | null {
  const fiber = getReactFiberFromElementOrAncestors(target);
  if (!fiber) {
    return null;
  }

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
      if (visitedFibers.has(current)) {
        break;
      }
      visitedFibers.add(current);

      const name = getComponentNameFromFiber(current);
      if (name && !isLikelyMinifiedComponentName(name)) {
        const prev = components[components.length - 1];
        // 同名包装层连续出现时折叠，保留路径可读性。
        if (prev !== name) {
          components.push(name);
        }
      }

      current = current.return;
      depth += 1;
    }
  } catch {
    return null;
  }

  if (components.length === 0) {
    return null;
  }

  const reactPath = components.slice().reverse();
  return {
    reactPath,
    reactLeaf: components[0],
  };
}
