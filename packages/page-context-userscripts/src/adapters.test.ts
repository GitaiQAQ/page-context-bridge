import { beforeEach, describe, expect, it, vi } from "vitest";

import { createApolloUserscriptAdapter } from "./adapters/apollo-adapter";
import { createJotaiUserscriptAdapter } from "./adapters/jotai-adapter";
import { createNextjsUserscriptAdapter } from "./adapters/nextjs-adapter";
import { createNuxtUserscriptAdapter } from "./adapters/nuxt-adapter";
import { createReactUserscriptAdapter } from "./adapters/react-adapter";
import { createReduxDevtoolsUserscriptAdapter } from "./adapters/redux-devtools-adapter";
import { createTanstackQueryUserscriptAdapter } from "./adapters/tanstack-query-adapter";

interface FiberNodeLike {
  key?: unknown;
  type?: unknown;
  memoizedProps?: unknown;
  memoizedState?: unknown;
  return?: FiberNodeLike | null;
  child?: FiberNodeLike | null;
  sibling?: FiberNodeLike | null;
}

describe("userscript adapters", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><p id="selection-target">selection target</p></main>`;

    delete (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    delete (window as Window & { __APOLLO_CLIENT__?: unknown }).__APOLLO_CLIENT__;
    delete (window as Window & { TANSTACK_QUERY_CLIENT?: unknown }).TANSTACK_QUERY_CLIENT;
    delete (globalThis as { __JOTAI_DEFAULT_STORE__?: unknown }).__JOTAI_DEFAULT_STORE__;
    delete (window as Window & { __REDUX_DEVTOOLS_EXTENSION__?: unknown }).__REDUX_DEVTOOLS_EXTENSION__;
    delete (window as Window & { __NEXT_DATA__?: unknown }).__NEXT_DATA__;
    delete (window as Window & { __NUXT__?: unknown }).__NUXT__;
  });

  it("react adapter supports detect + degrade path", () => {
    const adapter = createReactUserscriptAdapter(window, document);
    const instance = adapter.listInstances()[0]!;

    const noReact = instance.callTool("listRoots", {}) as { reactDetected: boolean };
    expect(noReact.reactDetected).toBe(false);

    installMockReactRuntime();
    const withReact = instance.callTool("listRoots", {}) as { reactDetected: boolean; roots: Array<{ componentCount: number }> };
    expect(withReact.reactDetected).toBe(true);
    expect(withReact.roots[0]?.componentCount).toBeGreaterThan(0);
  });

  it("apollo adapter reads cache/query data and degrades when client missing", () => {
    const adapter = createApolloUserscriptAdapter(window, document);
    const instance = adapter.listInstances()[0]!;
    const missing = instance.callTool("listActiveQueries", {}) as { detected: boolean };
    expect(missing.detected).toBe(false);

    (window as Window & { __APOLLO_CLIENT__?: unknown }).__APOLLO_CLIENT__ = createMockApolloClient();
    const active = instance.callTool("listActiveQueries", {}) as { detected: boolean; queryCount: number };
    expect(active.detected).toBe(true);
    expect(active.queryCount).toBe(1);

    const cache = instance.callTool("inspectCache", {}) as { entityCount: number };
    expect(cache.entityCount).toBeGreaterThanOrEqual(1);
  });

  it("tanstack query adapter reads query/mutation snapshots", () => {
    const adapter = createTanstackQueryUserscriptAdapter(window, document);
    const instance = adapter.listInstances()[0]!;

    const missing = instance.callTool("listQueries", {}) as { detected: boolean };
    expect(missing.detected).toBe(false);

    (window as Window & { TANSTACK_QUERY_CLIENT?: unknown }).TANSTACK_QUERY_CLIENT = createMockTanstackClient();
    const queries = instance.callTool("listQueries", {}) as { detected: boolean; queryCount: number };
    expect(queries.detected).toBe(true);
    expect(queries.queryCount).toBe(1);

    const mutations = instance.callTool("listMutations", {}) as { mutationCount: number };
    expect(mutations.mutationCount).toBe(1);
  });

  it("jotai adapter reads mounted atoms and falls back cleanly", () => {
    const adapter = createJotaiUserscriptAdapter(window, document);
    const instance = adapter.listInstances()[0]!;

    const missing = instance.callTool("listMountedAtoms", {}) as { detected: boolean };
    expect(missing.detected).toBe(false);

    (globalThis as { __JOTAI_DEFAULT_STORE__?: unknown }).__JOTAI_DEFAULT_STORE__ = createMockJotaiStore();
    const mounted = instance.callTool("listMountedAtoms", {}) as { detected: boolean; atomCount: number };
    expect(mounted.detected).toBe(true);
    expect(mounted.atomCount).toBe(1);

    const inspect = instance.callTool("inspectAtom", { atomId: "atom:0" }) as { ok: boolean };
    expect(inspect.ok).toBe(true);
  });

  it("redux devtools adapter records late extension connect/init/send flow", () => {
    const adapter = createReduxDevtoolsUserscriptAdapter(window, document);
    const instance = adapter.listInstances()[0]!;

    const initial = instance.callTool("listStores", {}) as { extensionDetected: boolean; storeCount: number };
    expect(initial.extensionDetected).toBe(false);
    expect(initial.storeCount).toBe(0);

    const subscribers: Array<(message: unknown) => void> = [];
    const rawConnection = {
      init: vi.fn(),
      send: vi.fn(),
      subscribe: vi.fn((listener: (message: unknown) => void) => {
        subscribers.push(listener);
        return () => undefined;
      }),
    };
    const originalConnect = vi.fn((_options?: Record<string, unknown>) => rawConnection);
    const extension = { connect: originalConnect };

    // The adapter installs a setter, so this simulates the extension appearing later on window.
    (window as Window & { __REDUX_DEVTOOLS_EXTENSION__?: unknown }).__REDUX_DEVTOOLS_EXTENSION__ = extension;
    const wrappedConnection = extension.connect({ name: "app-store" });
    wrappedConnection.init?.({ count: 0 });
    wrappedConnection.send?.({ type: "INCREMENT" }, { count: 1 });
    subscribers.forEach((listener) => listener({ type: "DISPATCH", state: JSON.stringify({ count: 2 }) }));

    expect(originalConnect).toHaveBeenCalledTimes(1);
    const stores = instance.callTool("listStores", {}) as { storeCount: number; stores: Array<{ storeId: string }> };
    expect(stores.storeCount).toBe(1);

    const actions = instance.callTool("listRecentActions", { storeId: stores.stores[0]?.storeId }) as {
      ok: boolean;
      actions: Array<{ type: string }>;
    };
    expect(actions.ok).toBe(true);
    expect(actions.actions.map((action) => action.type)).toContain("INCREMENT");
  });

  it("nextjs adapter reads __NEXT_DATA__ and degrades when missing", () => {
    const adapter = createNextjsUserscriptAdapter(window, document);
    const instance = adapter.listInstances()[0]!;

    const missing = instance.callTool("getSummary", {}) as { detected: boolean };
    expect(missing.detected).toBe(false);

    (window as Window & { __NEXT_DATA__?: unknown }).__NEXT_DATA__ = {
      buildId: "build-1",
      page: "/demo",
      query: { q: "x" },
      props: { pageProps: { user: { id: 1, name: "Ada" } } },
    };

    const summary = instance.callTool("getSummary", {}) as { detected: boolean; page: string };
    expect(summary.detected).toBe(true);
    expect(summary.page).toBe("/demo");

    const peek = instance.callTool("readNextData", { path: "props.pageProps.user.name" }) as { ok: boolean; preview: string };
    expect(peek.ok).toBe(true);
    expect(peek.preview).toContain("Ada");
  });

  it("nuxt adapter reads __NUXT__ and degrades when missing", () => {
    const adapter = createNuxtUserscriptAdapter(window, document);
    const instance = adapter.listInstances()[0]!;

    const missing = instance.callTool("getSummary", {}) as { detected: boolean };
    expect(missing.detected).toBe(false);

    (window as Window & { __NUXT__?: unknown }).__NUXT__ = {
      state: { auth: { user: { id: 1, name: "Ada" } } },
      data: [{ route: "/" }],
      serverRendered: true,
    };

    const summary = instance.callTool("getSummary", {}) as { detected: boolean };
    expect(summary.detected).toBe(true);

    const peek = instance.callTool("readNuxtPayload", { path: "state.auth.user.name" }) as { ok: boolean; preview: string };
    expect(peek.ok).toBe(true);
    expect(peek.preview).toContain("Ada");
  });
});

function installMockReactRuntime(): void {
  function App() {
    return null;
  }
  function Panel() {
    return null;
  }
  const appFiber: FiberNodeLike = {
    type: App,
    memoizedProps: { page: "demo" },
    memoizedState: { mounted: true },
  };
  const panelFiber: FiberNodeLike = {
    type: Panel,
    memoizedProps: { id: "selection-target" },
    memoizedState: { expanded: true },
    return: appFiber,
  };
  const hostFiber: FiberNodeLike = {
    type: "div",
    memoizedProps: {},
    memoizedState: null,
    return: panelFiber,
  };
  appFiber.child = panelFiber;
  panelFiber.child = hostFiber;

  const rootCurrent: FiberNodeLike = { child: appFiber };
  appFiber.return = rootCurrent;
  const root = { current: rootCurrent, containerInfo: document.getElementById("app")! };

  (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map([[1, { rendererPackageName: "react-dom" }]]),
    getFiberRoots: (rendererId: number) => (rendererId === 1 ? new Set([root]) : new Set()),
  };

  const selectionTarget = document.getElementById("selection-target") as HTMLElement & Record<string, unknown>;
  selectionTarget.__reactFiber$bridgeTest = panelFiber;
}

function createMockApolloClient() {
  return {
    cache: {
      extract: () => ({
        ROOT_QUERY: { __typename: "Query" },
        "User:1": { __typename: "User", id: 1, name: "Ada" },
      }),
    },
    queryManager: {
      queries: new Map([
        [
          "query-1",
          {
            observableQuery: {
              options: {
                query: {
                  definitions: [{ name: { value: "GetUser" } }],
                },
                variables: { id: 1 },
              },
              queryInfo: { networkStatus: 7 },
            },
          },
        ],
      ]),
    },
  };
}

function createMockTanstackClient() {
  return {
    getQueryCache: () => ({
      getAll: () => [
        {
          queryHash: "user-1",
          state: { status: "success", fetchStatus: "idle", data: { id: 1, name: "Ada" } },
          observers: [{}, {}],
        },
      ],
    }),
    getMutationCache: () => ({
      getAll: () => [
        {
          mutationId: 42,
          state: { status: "pending", variables: { id: 1 } },
        },
      ],
    }),
    isFetching: () => 1,
    isMutating: () => 1,
  };
}

function createMockJotaiStore() {
  const atom = { debugLabel: "countAtom" };
  const weakMap = new WeakMap<object, unknown>();
  weakMap.set(atom, { v: 42 });
  return {
    dev4_get_mounted_atoms: () => new Set([atom]),
    dev4_get_internal_weak_map: () => weakMap,
    get: () => 42,
  };
}
