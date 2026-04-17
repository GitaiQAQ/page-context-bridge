import { beforeEach, describe, expect, it } from "vitest";

import { getOrCreateUserscriptBridgeHub } from "./hub";
import type { UserscriptBridgeAdapter } from "./types";

describe("userscript bridge hub", () => {
  beforeEach(() => {
    delete window.__pageContextBridge__;
    delete window.__pageContextTools__;
    delete window.__pageContextUserscriptHub__;
  });

  it("merges multiple adapters on one shared bridge without replacing bridge object", () => {
    const hub = getOrCreateUserscriptBridgeHub(window, document);
    const alpha = createDummyAdapter("alpha", "alpha-adapter");
    const beta = createDummyAdapter("beta", "beta-adapter");

    hub.registerAdapter(alpha);
    const firstBridgeRef = window.__pageContextBridge__;
    hub.registerAdapter(beta);

    expect(window.__pageContextBridge__).toBe(firstBridgeRef);
    expect(window.__pageContextTools__).toBe(firstBridgeRef);
    expect(firstBridgeRef?.listNamespaces()).toEqual(["alpha", "beta"]);
    expect(firstBridgeRef?.getNamespace("alpha")?.getInstance("primary")?.listTools().map((tool) => tool.name)).toEqual(["read"]);

    const betaResource = firstBridgeRef?.readResource("beta.summary");
    expect(betaResource?.id).toBe("beta.summary");
    expect(JSON.parse(betaResource?.text ?? "{}")).toMatchObject({ namespace: "beta" });
  });

  it("keeps existing non-hub page bridge untouched", () => {
    const foreignBridge = {
      version: "foreign",
      listNamespaces: () => ["foreign"],
      getNamespace: () => undefined,
      getScene: () => "foreign",
      listResources: () => [],
      readResource: () => ({ id: "foreign.summary", mimeType: "application/json", text: "{}" }),
      listSkills: () => [],
      getSkill: () => undefined,
      getManifest: () => ({
        version: "foreign",
        app: "foreign",
        route: "/",
        scene: "foreign",
        namespaces: [],
        resources: [],
        skills: [],
        generatedAt: new Date().toISOString(),
      }),
    };
    window.__pageContextBridge__ = foreignBridge;

    const hub = getOrCreateUserscriptBridgeHub(window, document);
    hub.registerAdapter(createDummyAdapter("alpha", "alpha-adapter"));

    expect(window.__pageContextBridge__).toBe(foreignBridge);
    expect(hub.bridge.listNamespaces()).toEqual(["alpha"]);
    expect(hub.listDiagnostics().join("\n")).toContain("keeps page bridge untouched");
  });
});

function createDummyAdapter(namespace: string, adapterId: string): UserscriptBridgeAdapter {
  return {
    adapterId,
    namespace: {
      namespace,
      title: namespace.toUpperCase(),
      description: `${namespace} test adapter`,
      tags: ["test"],
    },
    listInstances: () => [
      {
        instanceId: "primary",
        listTools: () => [{ name: "read", description: "read", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
        callTool: () => ({ ok: true }),
      },
    ],
    listResources: () => [
      {
        id: `${namespace}.summary`,
        namespace,
        title: "Summary",
        mimeType: "application/json",
        kind: "json",
      },
      {
        id: `${namespace}.diagnostics`,
        namespace,
        title: "Diagnostics",
        mimeType: "application/json",
        kind: "json",
      },
    ],
    readResource: (id) => ({
      id,
      mimeType: "application/json",
      text: JSON.stringify({ namespace }),
    }),
    listSkills: () => [
      {
        id: `${namespace}.analyze`,
        namespace,
        title: "Analyze",
        description: "Analyze adapter",
        mode: "analysis",
      },
    ],
    getSkill: (id) => ({
      skill: {
        id,
        namespace,
        title: "Analyze",
        description: "Analyze adapter",
        mode: "analysis",
      },
      text: "test prompt",
    }),
    getSceneHint: () => namespace,
  };
}
