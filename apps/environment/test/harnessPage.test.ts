// The harness panel's page structure (SPI-1086): a snapshot of its markup from the fixture state, and checks over the
// parsed tags (balanced, ids unique, every section in the navigation, every control named), every state it draws, the
// CSP's limits (no inline style or handler, one script), and escaping of hostile strings in every server-supplied field.
import { EMPTY_HARNESS, resolveHarness } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { escapeHtml, type McpRow, renderPage } from "../src/harness/page.ts";
import { FIXTURE_MCP, FIXTURE_NOW, fixturePage } from "./fixtures/harnessPage.ts";

interface Tag {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly index: number;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** The page's markup with its constant stylesheet and script bodies left out. */
const markup = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "<style></style>").replace(/<script>[\s\S]*?<\/script>/, "<script></script>");

/** Every tag, in order, with its attributes (values unescaped only as far as the checks need: not at all). */
const tagsOf = (html: string): Array<Tag> => {
  const tags: Array<Tag> = [];
  for (const match of markup(html).matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g)) {
    const attrs: Record<string, string> = {};
    for (const attr of match[3]!.matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) attrs[attr[1]!] = attr[2] ?? "";
    tags.push({ name: match[2]!.toLowerCase(), attrs, closing: match[1] === "/", selfClosing: match[4] === "/", index: match.index });
  }
  return tags;
};

/** The open elements at the end, or the first mismatch. */
const balance = (tags: ReadonlyArray<Tag>): string => {
  const stack: Array<string> = [];
  for (const tag of tags) {
    if (tag.name === "!doctype" || VOID.has(tag.name) || tag.selfClosing) continue;
    if (!tag.closing) stack.push(tag.name);
    else if (stack.pop() !== tag.name) return `mismatched </${tag.name}> at ${tag.index}`;
  }
  return stack.length === 0 ? "balanced" : `unclosed: ${stack.join(" > ")}`;
};

/** The text inside the element opened by `tags[start]` (tags stripped). */
const textOf = (html: string, tags: ReadonlyArray<Tag>, start: number): string => {
  let depth = 0;
  for (let i = start; i < tags.length; i++) {
    const tag = tags[i]!;
    if (tag.name !== tags[start]!.name) continue;
    depth += tag.closing ? -1 : 1;
    if (depth === 0) return markup(html).slice(tags[start]!.index, tag.index).replace(/<[^>]*>/g, "").trim();
  }
  return "";
};

describe("harness page", () => {
  const html = renderPage(fixturePage());
  const tags = tagsOf(html);

  it("matches its snapshot (markup only; the stylesheet and script are constants under their own hashes)", async () => {
    await expect(markup(html)).toMatchFileSnapshot("./__snapshots__/harnessPage.html");
  });

  it("is well formed, with unique ids", () => {
    expect(balance(tags)).toBe("balanced");
    const ids = tags.flatMap((tag) => (tag.attrs.id === undefined ? [] : [tag.attrs.id]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("links every section from the navigation, in order, each with its heading", () => {
    const nav = tags.filter((tag) => tag.name === "a" && tag.attrs.href?.startsWith("#") && tag.attrs.href !== "#main" && tag.attrs.href !== "#add-server");
    expect(nav.map((tag) => tag.attrs.href)).toEqual(["#extensions", "#mcp", "#skills", "#status", "#audit"]);
    for (const link of nav) {
      const section = tags.find((tag) => tag.name === "section" && tag.attrs.id === link.attrs.href!.slice(1));
      expect(section?.attrs["aria-labelledby"]).toBeDefined();
      expect(tags.some((tag) => tag.name === "h2" && tag.attrs.id === section!.attrs["aria-labelledby"])).toBe(true);
    }
    expect(tags.filter((tag) => tag.name === "h1" && !tag.closing)).toHaveLength(1);
  });

  it("names every control: a label, aria-labelledby or aria-label for each field, text or aria-label for each button", () => {
    const labelled = new Set(tags.filter((tag) => tag.name === "label" && tag.attrs.for !== undefined).map((tag) => tag.attrs.for));
    tags.forEach((tag, index) => {
      if (tag.closing) return;
      if (tag.name === "input" || tag.name === "select") {
        const insideLabel = tags.slice(0, index).reduce((depth, other) => (other.name === "label" ? depth + (other.closing ? -1 : 1) : depth), 0) > 0;
        expect(insideLabel || labelled.has(tag.attrs.id) || tag.attrs["aria-labelledby"] !== undefined || tag.attrs["aria-label"] !== undefined, `${tag.name} ${JSON.stringify(tag.attrs)}`).toBe(true);
      }
      if (tag.name === "button") expect(tag.attrs["aria-label"] ?? textOf(html, tags, index), JSON.stringify(tag.attrs)).not.toBe("");
    });
  });

  it("draws each server's state: connected, error with its last error, not listed, signed out, a header set by fingerprint", () => {
    expect(html).toContain('<span class="pill pill-ok">Connected</span>');
    expect(html).toContain('<span class="pill pill-err">Error</span>');
    expect(html).toContain("Unreachable: The server is unavailable (HTTP 530)");
    expect(html).toContain('<span class="pill">Not listed yet</span>');
    expect(html).toContain("OAuth, signed out");
    expect(html).toContain('data-mcp-oauth="linear"');
    expect(html).toContain("#9e2b");
    expect(html).toMatch(/<span class="flag" role="img" aria-label="1 server failing">/);
    // Every server has its switch, its Test and its result line; only direct servers can be removed.
    for (const row of FIXTURE_MCP) {
      expect(html).toContain(`data-mcp-test="${row.name}"`);
      expect(html).toContain(`data-test-result="${row.name}"`);
      expect(html).toContain(escapeHtml(JSON.stringify({ op: "server", server: row.name, enabled: false })));
      expect(html.includes(escapeHtml(JSON.stringify({ op: "remove", server: row.name })))).toBe(row.setting.kind === "direct");
    }
    // The owner's class override is marked, with a way back to the tool's hint.
    expect(html).toContain("Set by you; its hint says read");
    expect(html).toContain(escapeHtml(JSON.stringify({ op: "class", server: "fixture", tool: "fixture_echo", class: null })));
    expect(html).toContain("1 tool refused");
  });

  it("draws the add form's three sign-in kinds, the header fields hidden until chosen", () => {
    for (const kind of ["oauth", "header", "none"]) expect(tags.some((tag) => tag.name === "input" && tag.attrs.name === "auth" && tag.attrs.value === kind)).toBe(true);
    expect(tags.find((tag) => tag.attrs["data-header-fields"] !== undefined)?.attrs.hidden).toBe("");
    expect(tags.find((tag) => tag.attrs.name === "value")?.attrs.type).toBe("password");
  });

  it("draws the extension forms from the registry's schemas: switches, settings, locked core extensions", () => {
    expect(tags.filter((tag) => tag.name === "form" && tag.attrs["data-extension"] !== undefined).map((tag) => tag.attrs["data-extension"])).toEqual(["codemode", "tool-search", "offered-tools"]);
    expect(tags.find((tag) => tag.attrs["data-setting"] === "inlineBudget")).toMatchObject({ attrs: { type: "number", min: "500", max: "20000", value: "3000" } });
    expect(tags.find((tag) => tag.attrs["data-setting"] === "preset")?.name).toBe("select");
    expect(tags.filter((tag) => tag.attrs["data-enabled"] !== undefined)).toHaveLength(2);
    expect(html).toContain("locked: the thread&#39;s modes and the link fence depend on it");
  });

  it("draws the empty states: no server, no audit entry, and the Skills placeholder", () => {
    const empty = renderPage(fixturePage({ mcp: [], audit: [] }));
    expect(empty).toContain("No MCP servers");
    expect(empty).toContain("No changes yet");
    expect(empty).toContain("Skills aren't here yet");
    expect(empty).toContain("data-mcp-add");
    expect(balance(tagsOf(empty))).toBe("balanced");
  });

  it("stays within its CSP: one script, one stylesheet, no style attribute, no inline handler, nothing fetched", () => {
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<style/g)).toHaveLength(1);
    for (const tag of tags) {
      expect(Object.keys(tag.attrs).filter((name) => name === "style" || /^on/i.test(name)), tag.name).toEqual([]);
      if (tag.name === "use") expect(tag.attrs.href).toMatch(/^#i-/);
      expect(["img", "link", "iframe", "object", "embed"]).not.toContain(tag.name);
    }
  });

  it("escapes hostile strings in every server-supplied field", () => {
    const hostile = `"><img src=x onerror=alert(1)>'&<script>`;
    const row: McpRow = {
      name: hostile,
      setting: { kind: "direct", enabled: true, exposure: hostile, url: hostile, auth: { kind: "header", header: hostile } },
      secret: { set: true, setAt: FIXTURE_NOW, fingerprint: hostile },
      status: "failed",
      listedAt: FIXTURE_NOW,
      error: hostile,
      tools: [{ name: hostile, upstream: hostile, class: "write", hinted: hostile, exposure: hostile }],
      overrides: { [hostile]: "write" },
      refused: [{ tool: hostile, reason: hostile }],
    };
    const page = renderPage({
      resolved: resolveHarness(EMPTY_HARNESS),
      csrf: hostile,
      // A stored `enabled` is not type-checked by the registry: a string must not reach an attribute raw.
      mcp: [row, { ...row, setting: { ...row.setting, enabled: hostile as unknown as boolean, auth: { kind: hostile } }, status: hostile }],
      audit: [{ at: FIXTURE_NOW, caller: hostile, action: hostile, target: hostile, after: { note: hostile } }],
      status: { [hostile]: hostile },
    });
    expect(page).not.toContain("<img");
    expect(page.match(/<script/g)).toHaveLength(1);
    expect(page).toContain(escapeHtml(hostile));
    const parsed = tagsOf(page);
    expect(balance(parsed)).toBe("balanced");
    expect(parsed.some((tag) => Object.keys(tag.attrs).some((name) => /^on/i.test(name)))).toBe(false);
  });
});
