import type {
  ContextResourceDescriptor,
  ContextResourcePayload,
  ContextSkillDescriptor,
  ContextSkillPrompt,
  ContextNamespaceDescriptor,
  PageContextManifest,
} from "@page-context/shared-protocol";

type ToolInput = Record<string, unknown>;

interface PageToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolInstance {
  instanceId: string;
  listTools(): PageToolDescriptor[];
  callTool(name: string, input?: ToolInput): unknown;
}

interface ToolNamespace {
  namespace: string;
  listInstances(): string[];
  getInstance(instanceId: string): ToolInstance | undefined;
}

interface VersionedPageTools {
  version: string;
  listNamespaces(): string[];
  getNamespace(namespace: string): ToolNamespace | undefined;
  getScene(): string;
  listResources(): ContextResourceDescriptor[];
  readResource(id: string): ContextResourcePayload;
  listSkills(): ContextSkillDescriptor[];
  getSkill(id: string, input?: ToolInput): ContextSkillPrompt | undefined;
  getManifest(): PageContextManifest;
}

interface ExampleDomRefs {
  logArea: HTMLDivElement;
  itemsList: HTMLUListElement;
  itemsCount: HTMLDivElement;
  counterValue: HTMLDivElement;
  selectionPreview: HTMLDivElement;
  resultPanel: HTMLDivElement;
  toolsStatus: HTMLDivElement;
  registrySummary: HTMLDivElement;
  fixtureStatus: HTMLDivElement;
  fullNameInput: HTMLInputElement;
  emailInput: HTMLInputElement;
  roleSelect: HTMLSelectElement;
  notesInput: HTMLTextAreaElement;
  profilePreview: HTMLPreElement;
  qaResults: HTMLDivElement;
  addItemButton: HTMLButtonElement;
  clearItemsButton: HTMLButtonElement;
  newItemInput: HTMLInputElement;
}

interface ExampleState {
  counter: number;
  itemIdCounter: number;
  logs: string[];
}

export interface ExampleBootstrapResult {
  pageTools: VersionedPageTools;
  runSelfTestSuite(): SelfTestSummary;
}

export interface SelfTestSummary {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export function bootstrapExamplePage(win: Window, doc: Document): ExampleBootstrapResult {
  const refs = getDomRefs(doc);
  const state: ExampleState = {
    counter: 0,
    itemIdCounter: 2,
    logs: [],
  };

  const helpers = createHelpers(win, doc, refs, state);
  const pageTools = createVersionedPageTools(helpers, refs, state);
  const runSelfTestSuite = createSelfTestRunner(pageTools, helpers, refs, state);

  attachUiHandlers(win, doc, refs, pageTools, runSelfTestSuite, helpers, state);
  helpers.resetFixture();
  updateDerivedViews(refs, state, pageTools);

  const globalWindow = win as Window & {
    __pageContextBridge__?: VersionedPageTools;
    __pageContextTools__?: VersionedPageTools;
    __PAGE_CONTEXT_BRIDGE_TEST__?: (tool: string, args?: ToolInput) => unknown;
    __PAGE_CONTEXT_RUN_FULL_SUITE__?: () => SelfTestSummary;
    __testCounter?: number;
  };

  globalWindow.__pageContextBridge__ = pageTools;
  globalWindow.__pageContextTools__ = pageTools;
  globalWindow.__PAGE_CONTEXT_BRIDGE_TEST__ = (tool, args = {}) => invokeToolByQualifiedName(pageTools, tool, args);
  globalWindow.__PAGE_CONTEXT_RUN_FULL_SUITE__ = runSelfTestSuite;

  helpers.log("Test page loaded.");
  helpers.log(`Available namespaces: ${pageTools.listNamespaces().join(", ")}`);
  console.log("[PAGE-CONTEXT-TEST-PAGE] Page loaded and ready");

  return { pageTools, runSelfTestSuite };
}

function getDomRefs(doc: Document): ExampleDomRefs {
  return {
    logArea: byId<HTMLDivElement>(doc, "log-area"),
    itemsList: byId<HTMLUListElement>(doc, "items-list"),
    itemsCount: byId<HTMLDivElement>(doc, "items-count"),
    counterValue: byId<HTMLDivElement>(doc, "counter-value"),
    selectionPreview: byId<HTMLDivElement>(doc, "selection-preview"),
    resultPanel: byId<HTMLDivElement>(doc, "test-result"),
    toolsStatus: byId<HTMLDivElement>(doc, "tools-status"),
    registrySummary: byId<HTMLDivElement>(doc, "registry-summary"),
    fixtureStatus: byId<HTMLDivElement>(doc, "fixture-status"),
    fullNameInput: byId<HTMLInputElement>(doc, "full-name-input"),
    emailInput: byId<HTMLInputElement>(doc, "email-input"),
    roleSelect: byId<HTMLSelectElement>(doc, "role-select"),
    notesInput: byId<HTMLTextAreaElement>(doc, "notes-input"),
    profilePreview: byId<HTMLPreElement>(doc, "profile-preview"),
    qaResults: byId<HTMLDivElement>(doc, "qa-results"),
    addItemButton: byId<HTMLButtonElement>(doc, "add-item-btn"),
    clearItemsButton: byId<HTMLButtonElement>(doc, "clear-items-btn"),
    newItemInput: byId<HTMLInputElement>(doc, "new-item-input"),
  };
}

function createHelpers(win: Window, doc: Document, refs: ExampleDomRefs, state: ExampleState) {
  const updateItemsCount = () => {
    refs.itemsCount.textContent = String(refs.itemsList.children.length);
    refs.fixtureStatus.textContent = `${refs.itemsList.children.length} items · counter ${state.counter}`;
  };

  const log = (message: string, type = "info") => {
    state.logs.push(message);
    if (state.logs.length > 50) {
      state.logs.shift();
    }
    const line = doc.createElement("span");
    line.appendChild(doc.createTextNode(`[${new Date().toLocaleTimeString()}] `));
    const typed = doc.createElement("span");
    typed.className = type;
    typed.appendChild(doc.createTextNode(`${message}\n`));
    line.appendChild(typed);
    refs.logArea.appendChild(line);
    refs.logArea.scrollTop = refs.logArea.scrollHeight;
  };

  const removeItemAt = (index: number) => {
    const target = refs.itemsList.children[index];
    target?.remove();
    updateItemsCount();
  };

  const addItem = (text: string) => {
    const item = doc.createElement("li");
    const label = doc.createElement("span");
    label.textContent = text;
    const button = doc.createElement("button");
    button.className = "remove-btn";
    button.textContent = "✕";
    button.addEventListener("click", () => removeItemAt(Array.from(refs.itemsList.children).indexOf(item)));
    item.append(label, button);
    refs.itemsList.appendChild(item);
    updateItemsCount();
    log(`Added item: "${text}"`, "success");
  };

  const getItems = () => Array.from(refs.itemsList.querySelectorAll("li > span")).map((node) => node.textContent ?? "");

  const setCounter = (value: number) => {
    state.counter = value;
    refs.counterValue.textContent = String(state.counter);
    updateItemsCount();
  };

  const getProfile = () => ({
    fullName: refs.fullNameInput.value,
    email: refs.emailInput.value,
    role: refs.roleSelect.value,
    notes: refs.notesInput.value,
  });

  const setProfile = (patch: Partial<ReturnType<typeof getProfile>>) => {
    refs.fullNameInput.value = patch.fullName ?? refs.fullNameInput.value;
    refs.emailInput.value = patch.email ?? refs.emailInput.value;
    refs.roleSelect.value = patch.role ?? refs.roleSelect.value;
    refs.notesInput.value = patch.notes ?? refs.notesInput.value;
    updateProfilePreview();
  };

  const updateProfilePreview = () => {
    refs.profilePreview.textContent = JSON.stringify(getProfile(), null, 2);
  };

  const showResult = (ok: boolean, text: string) => {
    refs.resultPanel.className = `test-result ${ok ? "ok" : "fail"}`;
    refs.resultPanel.textContent = text;
  };

  const updateSelection = () => {
    const text = win.getSelection()?.toString() ?? "";
    refs.selectionPreview.textContent = text || "No selection";
    refs.selectionPreview.style.color = text ? "var(--text)" : "var(--muted)";
  };

  const resetFixture = () => {
    refs.itemsList.innerHTML = "";
    addItem("Initial item 1");
    addItem("Initial item 2");
    state.itemIdCounter = 2;
    setCounter(0);
    setProfile({
      fullName: "Page Context Demo User",
      email: "demo@example.com",
      role: "analyst",
      notes: "Selection target and form fixture.",
    });
    refs.qaResults.textContent = "Ready";
    refs.logArea.innerHTML = "";
    state.logs.length = 0;
    log("Fixture reset", "warn");
  };

  return {
    updateItemsCount,
    log,
    addItem,
    getItems,
    removeItemAt,
    setCounter,
    getProfile,
    setProfile,
    updateProfilePreview,
    showResult,
    updateSelection,
    resetFixture,
  };
}

function createVersionedPageTools(
  helpers: ReturnType<typeof createHelpers>,
  refs: ExampleDomRefs,
  state: ExampleState,
): VersionedPageTools {
  const namespaceDescriptors: ContextNamespaceDescriptor[] = [
    { namespace: "page", title: "Page", description: "Page-level context inspection and summary", tags: ["inspect", "summary"] },
    { namespace: "catalog", title: "Catalog", description: "Catalog manipulation and seed fixtures", tags: ["mutation", "items"] },
    { namespace: "form", title: "Form", description: "Profile form read and write operations", tags: ["form", "profile"] },
    { namespace: "metrics", title: "Metrics", description: "Read-only dashboard and recent logs", tags: ["readonly", "logs"] },
    { namespace: "qa", title: "QA", description: "Smoke suite and fixture reset workflows", tags: ["macro", "qa"] },
  ];

  const buildResources = (): ContextResourceDescriptor[] => [
    { id: "page.summary", namespace: "page", title: "Active Page Summary", description: "Current route, counters, selection and tool registry summary", mimeType: "application/json", kind: "json", tags: ["summary", "scene"] },
    { id: "catalog.items", namespace: "catalog", title: "Catalog Items", description: "Current item list and counts for the catalog fixture", mimeType: "application/json", kind: "json", tags: ["items"] },
    { id: "form.profile", namespace: "form", title: "Profile Snapshot", description: "Current profile form values", mimeType: "application/json", kind: "json", tags: ["form", "profile"] },
    { id: "metrics.logs", namespace: "metrics", title: "Recent Logs", description: "Most recent action logs emitted by the page", mimeType: "application/json", kind: "json", tags: ["logs"] },
    { id: "qa.suite", namespace: "qa", title: "QA Suite Summary", description: "Smoke suite summary and fixture state", mimeType: "application/json", kind: "json", tags: ["qa"] },
  ];

  const buildResourcePayload = (id: string): ContextResourcePayload => {
    switch (id) {
      case "page.summary":
        return {
          id,
          mimeType: "application/json",
          text: JSON.stringify({
            title: document.title,
            route: window.location.pathname,
            scene: "example-fixture",
            selection: refs.selectionPreview.textContent,
            fixtureStatus: refs.fixtureStatus.textContent,
            namespaces: namespaceDescriptors.map((entry) => entry.namespace),
          }, null, 2),
        };
      case "catalog.items":
        return {
          id,
          mimeType: "application/json",
          text: JSON.stringify({
            items: helpers.getItems(),
            itemCount: refs.itemsList.children.length,
            instances: ["catalog.primary", "catalog.secondary"],
          }, null, 2),
        };
      case "form.profile":
        return {
          id,
          mimeType: "application/json",
          text: JSON.stringify(helpers.getProfile(), null, 2),
        };
      case "metrics.logs":
        return {
          id,
          mimeType: "application/json",
          text: JSON.stringify({ entries: state.logs.slice(-10), total: state.logs.length }, null, 2),
        };
      case "qa.suite": {
        const suite = createSelfTestRunner(pageTools, helpers, refs, state)();
        return {
          id,
          mimeType: "application/json",
          text: JSON.stringify(suite, null, 2),
        };
      }
      default:
        throw new Error(`Unknown resource: ${id}`);
    }
  };

  const buildSkills = (): ContextSkillDescriptor[] => [
    {
      id: "page.inspect-active-page",
      namespace: "page",
      title: "Inspect Active Page",
      description: "Summarize the current page state using read-only resources and page inspection tools.",
      intentTags: ["inspect", "summarize", "understand"],
      resourceIds: ["page.summary", "metrics.logs"],
      toolNames: ["get_page_info", "query_elements", "page.getPageInfo", "metrics.dashboard.getSummary"],
      mode: "analysis",
    },
    {
      id: "catalog.manage-items",
      namespace: "catalog",
      title: "Manage Catalog Items",
      description: "Inspect, add, remove, or seed catalog fixture items using instance-specific tools.",
      intentTags: ["catalog", "items", "mutation"],
      resourceIds: ["catalog.items"],
      toolNames: ["catalog.primary.getItems", "catalog.primary.addItem", "catalog.primary.removeItem", "catalog.secondary.getItems", "catalog.secondary.seedItems"],
      mode: "mutation",
    },
    {
      id: "form.update-profile",
      namespace: "form",
      title: "Update Profile Form",
      description: "Read and update the profile form while validating its preview state.",
      intentTags: ["form", "profile", "fill"],
      resourceIds: ["form.profile", "page.summary"],
      toolNames: ["fill_input", "get_element_text", "form.profile.getProfile", "form.profile.setProfile"],
      mode: "mutation",
    },
    {
      id: "qa.run-smoke-suite",
      namespace: "qa",
      title: "Run Smoke Suite",
      description: "Execute the example smoke suite and interpret its results.",
      intentTags: ["qa", "smoke", "verify"],
      resourceIds: ["qa.suite", "page.summary"],
      toolNames: ["qa.smoke.runSuite", "qa.smoke.resetFixture", "get_console_logs"],
      mode: "macro",
    },
  ];

  const buildSkillPrompt = (skillId: string, input: ToolInput = {}): ContextSkillPrompt | undefined => {
    const skill = buildSkills().find((entry) => entry.id === skillId);
    if (!skill) {
      return undefined;
    }

    const goal = typeof input.goal === "string" && input.goal.length > 0 ? input.goal : "Complete the page task for the current skill";
    const prompt = [
      `You are using the Page Context Bridge skill '${skill.title}'.`,
      `Goal: ${goal}`,
      `Namespace: ${skill.namespace}`,
      `Description: ${skill.description}`,
      `Recommended resources: ${(skill.resourceIds ?? []).join(", ") || "(none)"}`,
      `Allowed tools: ${(skill.toolNames ?? []).join(", ") || "(none)"}`,
      "Rules:",
      "1. Read the recommended resources first before taking actions.",
      "2. Prefer tools from the listed namespace and avoid unrelated namespaces.",
      "3. Keep the action plan minimal and explain why each tool is used.",
      skill.mode === "mutation" || skill.mode === "macro"
        ? "4. Because this skill may mutate state, verify the result after each write step."
        : "4. Stay in read-only mode unless the user explicitly asks to mutate state.",
    ].join("\n");

    return { skill, text: prompt };
  };

  const pageDefault = createInstance("default", () => [
    descriptor("getPageInfo", "Get page title, URL, item count, and counter value"),
    descriptor("getFixtureStatus", "Get quick summary for the whole example page"),
  ], (name) => {
    switch (name) {
      case "getPageInfo":
        return {
          title: document.title,
          url: window.location.href,
          itemCount: refs.itemsList.children.length,
          counter: state.counter,
          timestamp: new Date().toISOString(),
        };
      case "getFixtureStatus":
        return {
          toolsStatus: refs.toolsStatus.textContent,
          registrySummary: refs.registrySummary.textContent,
          fixtureStatus: refs.fixtureStatus.textContent,
        };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  const catalogPrimary = createInstance("primary", () => [
    descriptor("getItems", "List current catalog items", { properties: { limit: { type: "number" } } }),
    descriptor("addItem", "Add a catalog item", { required: ["text"], properties: { text: { type: "string" } } }),
    descriptor("removeItem", "Remove a catalog item by index", { required: ["index"], properties: { index: { type: "integer" } } }),
  ], (name, input) => {
    const payload = input ?? {};
    switch (name) {
      case "getItems":
        return { items: helpers.getItems().slice(0, Number(payload.limit ?? refs.itemsList.children.length)), total: refs.itemsList.children.length };
      case "addItem":
        helpers.addItem(String(payload.text ?? `Dynamic item ${++state.itemIdCounter}`));
        return { added: true, itemCount: refs.itemsList.children.length };
      case "removeItem": {
        const index = Number(payload.index);
        if (Number.isNaN(index) || index < 0 || index >= refs.itemsList.children.length) {
          throw new Error(`Invalid index: ${String(payload.index)}`);
        }
        helpers.removeItemAt(index);
        return { removed: true, itemCount: refs.itemsList.children.length };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  const catalogSecondary = createInstance("secondary", () => [
    descriptor("getItems", "List current catalog items from secondary instance", { properties: { limit: { type: "number" } } }),
    descriptor("seedItems", "Seed multiple demo items", {
      required: ["items"],
      properties: { items: { type: "array", items: { type: "string" } } },
    }),
    descriptor("getInstanceSummary", "Return secondary instance specific summary"),
  ], (name, input) => {
    if (name !== "seedItems") {
      if (name === "getItems") {
        const payload = input ?? {};
        return {
          instanceId: "secondary",
          items: helpers.getItems().slice(0, Number(payload.limit ?? refs.itemsList.children.length)),
          total: refs.itemsList.children.length,
        };
      }
      if (name === "getInstanceSummary") {
        return {
          instanceId: "secondary",
          canSeed: true,
          currentItems: refs.itemsList.children.length,
        };
      }
      throw new Error(`Unknown tool: ${name}`);
    }
    const payload = input ?? {};
    const items = Array.isArray(payload.items) ? payload.items.map((value) => String(value)) : [];
    items.forEach((item) => helpers.addItem(item));
    return { seeded: items.length, itemCount: refs.itemsList.children.length };
  });

  const formProfile = createInstance("profile", () => [
    descriptor("getProfile", "Get current profile form values"),
    descriptor("setProfile", "Update profile fields", {
      properties: {
        fullName: { type: "string" },
        email: { type: "string" },
        role: { enum: ["analyst", "developer", "reviewer"] },
        notes: { type: "string" },
      },
    }),
  ], (name, input) => {
    const payload = input ?? {};
    switch (name) {
      case "getProfile":
        return helpers.getProfile();
      case "setProfile":
        helpers.setProfile({
          fullName: payload.fullName as string | undefined,
          email: payload.email as string | undefined,
          role: payload.role as string | undefined,
          notes: payload.notes as string | undefined,
        });
        helpers.log("Profile updated via page tool", "success");
        return helpers.getProfile();
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  const metricsDashboard = createInstance("dashboard", () => [
    descriptor("getSummary", "Get dashboard metrics for the example page"),
    descriptor("getRecentLogs", "Get recent action logs", { properties: { limit: { type: "integer" } } }),
  ], (name, input) => {
    const payload = input ?? {};
    switch (name) {
      case "getSummary":
        return {
          totalItems: refs.itemsList.children.length,
          counter: state.counter,
          selectedText: refs.selectionPreview.textContent,
          profileRole: refs.roleSelect.value,
          namespaces: 4,
        };
      case "getRecentLogs":
        return { entries: state.logs.slice(-Number(payload.limit ?? 10)) };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  const qaSmoke = createInstance("smoke", () => [
    descriptor("runSuite", "Run the full self test suite for the example page"),
    descriptor("resetFixture", "Reset the example fixture to a known state"),
  ], (name) => {
    switch (name) {
      case "runSuite":
        return createSelfTestRunner(pageTools, helpers, refs, state)();
      case "resetFixture":
        helpers.resetFixture();
        return { ok: true };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  const namespaces = new Map<string, ToolNamespace>([
    ["page", createNamespace("page", [pageDefault])],
    ["catalog", createNamespace("catalog", [catalogPrimary, catalogSecondary])],
    ["form", createNamespace("form", [formProfile])],
    ["metrics", createNamespace("metrics", [metricsDashboard])],
    ["qa", createNamespace("qa", [qaSmoke])],
  ]);

  const pageTools: VersionedPageTools = {
    version: "2.0.0",
    listNamespaces: () => [...namespaces.keys()],
    getNamespace: (namespace) => namespaces.get(namespace),
    getScene: () => "example-fixture",
    listResources: () => buildResources(),
    readResource: (id) => buildResourcePayload(id),
    listSkills: () => buildSkills(),
    getSkill: (id, input) => buildSkillPrompt(id, input),
    getManifest: () => ({
      version: "0.1.0",
      app: "page-context-example",
      route: window.location.pathname,
      scene: "example-fixture",
      namespaces: namespaceDescriptors,
      resources: buildResources(),
      skills: buildSkills(),
      generatedAt: new Date().toISOString(),
    }),
  };

  return pageTools;
}

function createSelfTestRunner(
  pageTools: VersionedPageTools,
  helpers: ReturnType<typeof createHelpers>,
  refs: ExampleDomRefs,
  state: ExampleState,
) {
  return () => {
    helpers.resetFixture();

    const checks: SelfTestSummary["checks"] = [];
    const check = (name: string, assertion: () => void) => {
      try {
        assertion();
        checks.push({ name, ok: true, detail: "ok" });
      } catch (error) {
        checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    };

    check("namespaces registered", () => {
      const namespaces = pageTools.listNamespaces();
      if (namespaces.length !== 5) {
        throw new Error(`Expected 5 namespaces, got ${namespaces.length}`);
      }
    });

    check("catalog.primary.addItem", () => {
      invokeToolByQualifiedName(pageTools, "catalog.primary.addItem", { text: "Suite item" });
      if (!helpers.getItems().includes("Suite item")) {
        throw new Error("Added item was not found");
      }
    });

    check("catalog.secondary.seedItems", () => {
      invokeToolByQualifiedName(pageTools, "catalog.secondary.seedItems", { items: ["alpha", "beta"] });
      if (refs.itemsList.children.length !== 5) {
        throw new Error(`Expected 5 items after seeding, got ${refs.itemsList.children.length}`);
      }
    });

    check("catalog.primary.getItems vs catalog.secondary.getItems", () => {
      const primary = invokeToolByQualifiedName(pageTools, "catalog.primary.getItems") as { items: string[]; total: number };
      const secondary = invokeToolByQualifiedName(pageTools, "catalog.secondary.getItems") as { instanceId: string; items: string[]; total: number };
      if (primary.total !== secondary.total || secondary.instanceId !== "secondary") {
        throw new Error("Instance-specific routing did not preserve instance identity");
      }
    });

    check("form.profile.setProfile", () => {
      invokeToolByQualifiedName(pageTools, "form.profile.setProfile", { fullName: "Trae QA", role: "reviewer" });
      if (helpers.getProfile().fullName !== "Trae QA") {
        throw new Error("Profile fullName did not update");
      }
    });

    check("metrics.dashboard.getSummary", () => {
      const summary = invokeToolByQualifiedName(pageTools, "metrics.dashboard.getSummary") as { totalItems: number; counter: number };
      if (summary.totalItems < 2 || typeof summary.counter !== "number") {
        throw new Error("Invalid dashboard summary");
      }
    });

    check("page.default.getPageInfo", () => {
      const info = invokeToolByQualifiedName(pageTools, "page.getPageInfo") as { title: string };
      if (!info.title.includes("Page Context Bridge")) {
        throw new Error("Title does not match test page");
      }
    });

    const summary: SelfTestSummary = {
      ok: checks.every((item) => item.ok),
      total: checks.length,
      passed: checks.filter((item) => item.ok).length,
      failed: checks.filter((item) => !item.ok).length,
      checks,
    };

    refs.qaResults.textContent = `${summary.passed}/${summary.total} checks passed`;
    return summary;
  };
}

function attachUiHandlers(
  win: Window,
  doc: Document,
  refs: ExampleDomRefs,
  pageTools: VersionedPageTools,
  runSelfTestSuite: () => SelfTestSummary,
  helpers: ReturnType<typeof createHelpers>,
  state: ExampleState,
): void {
  doc.addEventListener("selectionchange", () => helpers.updateSelection());

  refs.addItemButton.addEventListener("click", () => {
    helpers.addItem(refs.newItemInput.value.trim() || `Dynamic item ${++state.itemIdCounter}`);
    refs.newItemInput.value = "";
  });
  refs.clearItemsButton.addEventListener("click", () => {
    refs.itemsList.innerHTML = "";
    helpers.updateItemsCount();
    helpers.log("Cleared all items", "warn");
  });
  refs.newItemInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      refs.addItemButton.click();
    }
  });

  byId<HTMLButtonElement>(doc, "counter-inc").addEventListener("click", () => helpers.setCounter(state.counter + 1));
  byId<HTMLButtonElement>(doc, "counter-dec").addEventListener("click", () => helpers.setCounter(state.counter - 1));
  byId<HTMLButtonElement>(doc, "counter-reset").addEventListener("click", () => helpers.setCounter(0));
  byId<HTMLButtonElement>(doc, "counter-set").addEventListener("click", () => helpers.setCounter(42));
  byId<HTMLButtonElement>(doc, "profile-apply-btn").addEventListener("click", () => {
    helpers.updateProfilePreview();
    helpers.log("Profile preview updated", "info");
  });
  byId<HTMLButtonElement>(doc, "fixture-reset-btn").addEventListener("click", () => helpers.resetFixture());
  byId<HTMLButtonElement>(doc, "qa-run-suite-btn").addEventListener("click", () => {
    const summary = runSelfTestSuite();
    helpers.showResult(summary.ok, JSON.stringify(summary, null, 2));
  });

  byId<HTMLButtonElement>(doc, "test-page-info").addEventListener("click", () => {
    helpers.showResult(true, JSON.stringify(invokeToolByQualifiedName(pageTools, "page.getPageInfo"), null, 2));
  });
  byId<HTMLButtonElement>(doc, "test-selected-text").addEventListener("click", () => {
    helpers.showResult(true, `Selected text: "${win.getSelection()?.toString() ?? ""}"`);
  });
  byId<HTMLButtonElement>(doc, "test-query-h1").addEventListener("click", () => {
    const results = Array.from(doc.querySelectorAll("h1, h2")).map((element) => ({ tag: element.tagName, text: element.textContent }));
    helpers.showResult(true, JSON.stringify(results, null, 2));
  });
  byId<HTMLButtonElement>(doc, "test-execute-js").addEventListener("click", () => {
    (win as Window & { __testCounter?: number }).__testCounter = state.counter;
    // SECURITY: eval used for demo purposes only — not part of production code path.
    const result = eval('document.title + " | Items: " + document.querySelectorAll("#items-list li").length + " | Counter: " + window.__testCounter');
    helpers.showResult(true, `Result: ${String(result)}`);
  });
  byId<HTMLButtonElement>(doc, "test-console-logs").addEventListener("click", () => {
    console.log("[PAGE-CONTEXT-TEST] This is a test log message");
    console.warn("[PAGE-CONTEXT-TEST] This is a test warning");
    console.error("[PAGE-CONTEXT-TEST] This is a test error");
    helpers.showResult(true, "Emitted 3 test console messages.");
  });
  byId<HTMLButtonElement>(doc, "test-screenshot").addEventListener("click", () => {
    helpers.showResult(true, "Call screenshot_tab from MCP to capture this page.");
  });
  byId<HTMLButtonElement>(doc, "test-page-tool-suite").addEventListener("click", () => {
    const summary = invokeToolByQualifiedName(pageTools, "qa.smoke.runSuite") as SelfTestSummary;
    helpers.showResult(summary.ok, JSON.stringify(summary, null, 2));
  });
}

function updateDerivedViews(refs: ExampleDomRefs, state: ExampleState, pageTools: VersionedPageTools): void {
  refs.toolsStatus.textContent = "Active";
  refs.registrySummary.textContent = `${pageTools.listNamespaces().length} namespaces registered`;
  refs.fixtureStatus.textContent = `${refs.itemsList.children.length} items · counter ${state.counter}`;
  refs.profilePreview.textContent = JSON.stringify({
    fullName: refs.fullNameInput.value,
    email: refs.emailInput.value,
    role: refs.roleSelect.value,
    notes: refs.notesInput.value,
  }, null, 2);
  refs.qaResults.textContent = "Ready";
}

function byId<T extends HTMLElement>(doc: Document, id: string): T {
  return doc.getElementById(id) as T;
}

function descriptor(name: string, description: string, schema: Record<string, unknown> = { type: "object", properties: {} }): PageToolDescriptor {
  return { name, description, inputSchema: { type: "object", ...schema } };
}

function createInstance(instanceId: string, listTools: () => PageToolDescriptor[], callTool: (name: string, input?: ToolInput) => unknown): ToolInstance {
  return { instanceId, listTools, callTool };
}

function createNamespace(namespace: string, instances: ToolInstance[]): ToolNamespace {
  const map = new Map(instances.map((instance) => [instance.instanceId, instance]));
  return {
    namespace,
    listInstances: () => [...map.keys()],
    getInstance: (instanceId) => map.get(instanceId),
  };
}

function invokeToolByQualifiedName(pageTools: VersionedPageTools, tool: string, args: ToolInput = {}): unknown {
  const parts = tool.split(".");
  const namespace = parts[0] ?? "page";
  const maybeInstance = parts.length >= 3 ? parts[1] : "default";
  const toolName = parts.length >= 3 ? parts[2] : parts[1] ?? parts[0];
  const namespaceObject = pageTools.getNamespace(namespace);
  if (!namespaceObject) {
    throw new Error(`Namespace not found: ${namespace}`);
  }
  const instance = namespaceObject.getInstance(maybeInstance);
  if (!instance) {
    throw new Error(`Instance not found: ${maybeInstance}`);
  }
  return instance.callTool(toolName, args);
}
