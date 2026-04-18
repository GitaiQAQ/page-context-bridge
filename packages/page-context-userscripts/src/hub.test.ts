import { beforeEach, describe, expect, it } from "vitest";

import { getOrCreatePageContextBridgeHost } from "./bridge-host";
import { getOrCreateUserscriptBridgeHub } from "./hub";
import type { UserscriptBridgeAdapter } from "./types";

describe("userscript bridge hub", () => {
  beforeEach(() => {
    delete window.__pageContextBridge__;
    delete window.__pageContextTools__;
    delete window.__pageContextUserscriptHub__;
    delete window.__pageContextBridgeHost__;
  });

  it("merges multiple adapters on one shared bridge without replacing bridge object", () => {
    getOrCreatePageContextBridgeHost(window, document);
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

  it("adopts existing page bridge and composes namespaces", () => {
    const foreignBridge = {
      version: "foreign",
      listNamespaces: () => ["foreign", "alpha"],
      getNamespace: (namespace: string) => {
        if (namespace !== "foreign" && namespace !== "alpha") {
          return undefined;
        }
        return {
          namespace,
          listInstances: () => ["primary"],
          getInstance: () => ({
            instanceId: "primary",
            listTools: () => [{ name: "foreignRead", description: "foreignRead", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
            callTool: () => ({ ok: true }),
          }),
        };
      },
      getScene: () => "foreign",
      listResources: () => [{ id: "foreign.summary", namespace: "foreign", title: "Summary", mimeType: "application/json", kind: "json" as const }],
      readResource: () => ({ id: "foreign.summary", mimeType: "application/json", text: "{}" }),
      listSkills: () => [{ id: "foreign.analyze", namespace: "foreign", title: "Analyze", description: "Analyze foreign", mode: "analysis" as const }],
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
    getOrCreatePageContextBridgeHost(window, document);

    const hub = getOrCreateUserscriptBridgeHub(window, document);
    hub.registerAdapter(createDummyAdapter("alpha", "alpha-adapter"));

    const activeBridge = window.__pageContextBridge__;
    expect(activeBridge).toBeDefined();
    expect(activeBridge).not.toBe(foreignBridge);
    expect(activeBridge?.listNamespaces()).toEqual(["alpha", "foreign"]);
    expect(activeBridge?.readResource("foreign.summary").id).toBe("foreign.summary");
    expect(activeBridge?.listSkills().map((skill) => skill.id)).toContain("foreign.analyze");
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
