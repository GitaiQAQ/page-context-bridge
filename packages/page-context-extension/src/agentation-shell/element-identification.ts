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
