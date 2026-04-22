import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENTATION_REACT_HOST_ID, mountAgentationReactRoot } from "./agentation-react-root";

describe("mountAgentationReactRoot", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("mounts default marker into a shadow host", () => {
    const mounted = mountAgentationReactRoot();

    const host = document.getElementById(AGENTATION_REACT_HOST_ID);
    expect(host).toBe(mounted.host);
    expect(host?.shadowRoot).toBe(mounted.shadowRoot);
    const readyNode = mounted.shadowRoot.querySelector('[data-agentation-react-ready="true"]');
    expect(readyNode).not.toBeNull();
    expect(readyNode?.textContent).toContain("default");

    mounted.unmount();
    expect(document.getElementById(AGENTATION_REACT_HOST_ID)).toBeNull();
  });

  it("supports two mount keys in one shadow host and cleans independently", () => {
    const primary = mountAgentationReactRoot({
      mountKey: "primary",
      // 用 createElement 写最小渲染，避免测试自身依赖 JSX 转换细节。
      render: () => createElement("span", { "data-mount-label": "primary" }, "primary"),
    });
    const secondary = mountAgentationReactRoot({
      mountKey: "secondary",
      render: () => createElement("span", { "data-mount-label": "secondary" }, "secondary"),
    });

    const host = document.getElementById(AGENTATION_REACT_HOST_ID);
    expect(host).not.toBeNull();
    expect(host?.shadowRoot?.querySelector('[data-mount-label="primary"]')).not.toBeNull();
    expect(host?.shadowRoot?.querySelector('[data-mount-label="secondary"]')).not.toBeNull();

    primary.unmount();
    expect(host?.shadowRoot?.querySelector('[data-mount-label="primary"]')).toBeNull();
    expect(host?.shadowRoot?.querySelector('[data-mount-label="secondary"]')).not.toBeNull();

    secondary.unmount();
    expect(document.getElementById(AGENTATION_REACT_HOST_ID)).toBeNull();
  });

  it("keeps latest mount alive when same key is remounted", () => {
    const first = mountAgentationReactRoot({
      mountKey: "stable",
      render: () => createElement("span", { "data-react-version": "v1" }, "v1"),
    });
    const second = mountAgentationReactRoot({
      mountKey: "stable",
      render: () => createElement("span", { "data-react-version": "v2" }, "v2"),
    });

    const host = document.getElementById(AGENTATION_REACT_HOST_ID);
    expect(host?.shadowRoot?.querySelector('[data-react-version="v1"]')).toBeNull();
    expect(host?.shadowRoot?.querySelector('[data-react-version="v2"]')).not.toBeNull();

    // first 已失效，调用 first.unmount 不应把 second 的挂载结果删掉。
    first.unmount();
    expect(host?.shadowRoot?.querySelector('[data-react-version="v2"]')).not.toBeNull();

    second.unmount();
    expect(document.getElementById(AGENTATION_REACT_HOST_ID)).toBeNull();
  });
});
