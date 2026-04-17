import { beforeEach, describe, expect, it } from "vitest";

import { executeContentScriptTool } from "@page-context/builtin-tools";

describe("executeContentScriptTool", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <h1 id="title">Hello</h1>
        <input id="name" />
        <ul>
          <li class="item">One</li>
          <li class="item">Two</li>
        </ul>
      </main>
    `;
    document.title = "Demo";
  });

  it("returns page info and queries elements", () => {
    const environment = { win: window, doc: document, consoleEntries: [] };
    expect(executeContentScriptTool("get_page_info", {}, environment)).toMatchObject({ title: "Demo" });
    expect(executeContentScriptTool("query_elements", { selector: ".item" }, environment)).toMatchObject({ count: 2 });
  });

  it("fills input fields with DOM events", () => {
    const events: string[] = [];
    document.getElementById("name")?.addEventListener("input", () => events.push("input"));
    document.getElementById("name")?.addEventListener("change", () => events.push("change"));

    const result = executeContentScriptTool("fill_input", { selector: "#name", value: "Trae" }, { win: window, doc: document, consoleEntries: [] });
    expect(result).toMatchObject({ filled: true, value: "Trae" });
    expect((document.getElementById("name") as HTMLInputElement).value).toBe("Trae");
    expect(events).toEqual(["input", "change"]);
  });
});
