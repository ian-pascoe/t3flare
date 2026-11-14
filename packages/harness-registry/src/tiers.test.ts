// T-tier (plan §5, D5): every extension switch and setting, every `McpChange` shape, every Environment key and every
// skills op has an expected Change tier; a registry entry or key added without a row here fails the coverage checks.
import { describe, expect, it } from "vitest";

import { EMPTY_ENVIRONMENT, ENVIRONMENT_SETTINGS, type EnvironmentKey, type StoredEnvironment } from "./environment.ts";
import type { FieldSchema } from "./fields.ts";
import { applyChange, applyMcpChange, EMPTY_HARNESS, EXTENSIONS, SETTINGS_SERVER, type StoredHarness } from "./index.ts";
import { type McpTierChange, type SkillsTierChange, tierOf } from "./tiers.ts";

/** Each extension's switch: `switch` (off to on asked, on to off free), `guard` (both asked), or `unchangeable`. */
const SWITCHES: Readonly<Record<string, "switch" | "guard" | "unchangeable">> = {
  codemode: "switch",
  "tool-search": "switch",
  "offered-tools": "unchangeable",
  web: "switch",
  todo: "switch",
  context: "switch",
  termctrl: "switch",
  guardian: "guard",
  advisor: "switch",
  skills: "switch",
  "coding-tools": "unchangeable",
  files: "unchangeable",
  permissions: "unchangeable",
  "ask-user": "unchangeable",
  "t3-mcp": "unchangeable",
  "project-context": "unchangeable",
};

/** Each extension setting's rule: `free`, `down-free`, or `asked` (a Guard's settings and any without a declared tier). */
const SETTINGS: Readonly<Record<string, "free" | "down-free" | "asked">> = {
  "codemode.inlineBudget": "free",
  "offered-tools.preset": "free",
  "web.search": "down-free",
  "web.searchModel": "asked",
  "context.rolloverOnCompaction": "free",
  "termctrl.backgroundBash": "down-free",
  "termctrl.cols": "free",
  "termctrl.rows": "free",
  "guardian.model": "asked",
  "guardian.thinkingLevel": "asked",
  "guardian.tools": "asked",
  "guardian.commands": "asked",
  "guardian.policy": "asked",
  "advisor.model": "asked",
  "advisor.reviewEvery": "asked",
  "advisor.thinkingLevel": "asked",
  "advisor.correctiveTurns": "down-free",
};

/** Each Environment key: from, to, and the expected tier; `down` is the same key moved the other way. */
const ENVIRONMENT: Readonly<Record<EnvironmentKey, { readonly up: readonly [unknown, unknown, "free" | "asked"]; readonly down: readonly [unknown, unknown, "free" | "asked"] }>> = {
  containerSize: { up: ["cpu-1", "standard-4", "asked"], down: ["standard-4", "standard-1", "asked"] },
  containerIdleMinutes: { up: [2, 30, "free"], down: [30, 2, "free"] },
  containerBudget: { up: [3, 4, "asked"], down: [3, 2, "free"] },
  variables: { up: [{}, { A: "1" }, "asked"], down: [{ A: "1" }, {}, "asked"] },
  globalMiseConfig: { up: ["", "[tools]\nnode = '24'\n", "asked"], down: ["[tools]\nnode = '24'\n", "", "asked"] },
};

/** Two values of `schema` with `low` below `high` where that has a meaning (a boolean's false, a smaller integer). */
const twoValues = (schema: FieldSchema): readonly [unknown, unknown] => {
  switch (schema.type) {
    case "boolean":
      return [false, true];
    case "integer":
      return [schema.minimum, schema.minimum + 1];
    case "enum":
      return [schema.values[0], schema.values[1]];
    case "text":
    case "file":
      return ["", "x"];
  }
};

const withExtension = (extension: string, enabled?: boolean, settings?: Record<string, unknown>): StoredHarness => {
  const applied = applyChange(EMPTY_HARNESS, { extension, ...(enabled === undefined ? {} : { enabled }), ...(settings === undefined ? {} : { settings }) });
  if (!applied.ok) throw new Error(applied.error);
  return applied.harness;
};

const tier = (input: Parameters<typeof tierOf>[0]) => tierOf(input).tier;

describe("tierOf: extensions", () => {
  it("covers every extension switch and every extension setting in the registry", () => {
    expect(Object.keys(SWITCHES).sort()).toEqual(EXTENSIONS.map((entry) => entry.id).sort());
    expect(Object.keys(SETTINGS).sort()).toEqual(EXTENSIONS.flatMap((entry) => Object.keys(entry.settings).map((key) => `${entry.id}.${key}`)).sort());
  });

  it("each switch: off to on asked; on to off free, asked for a Guard; an unchangeable switch stays refused", () => {
    for (const entry of EXTENSIONS) {
      const rule = SWITCHES[entry.id]!;
      if (rule === "unchangeable") {
        expect(applyChange(EMPTY_HARNESS, { extension: entry.id, enabled: false }).ok, entry.id).toBe(false);
        continue;
      }
      expect(tier({ entity: "extension", stored: withExtension(entry.id, false), change: { extension: entry.id, enabled: true } }), entry.id).toBe("asked");
      expect(tier({ entity: "extension", stored: withExtension(entry.id, true), change: { extension: entry.id, enabled: false } }), entry.id).toBe(rule === "guard" ? "asked" : "free");
    }
  });

  it("each setting follows its rule in both directions", () => {
    for (const entry of EXTENSIONS) {
      for (const [key, setting] of Object.entries(entry.settings)) {
        const name = `${entry.id}.${key}`;
        const [low, high] = twoValues(setting.schema);
        const up = tier({ entity: "extension", stored: withExtension(entry.id, undefined, { [key]: low }), change: { extension: entry.id, settings: { [key]: high } } });
        const down = tier({ entity: "extension", stored: withExtension(entry.id, undefined, { [key]: high }), change: { extension: entry.id, settings: { [key]: low } } });
        const rule = SETTINGS[name];
        expect([name, up, down]).toEqual([name, rule === "free" ? "free" : "asked", rule === "asked" ? "asked" : "free"]);
      }
    }
  });

  it("a setting with no declared tier is asked; a Guard's settings are asked whatever their own rule", () => {
    for (const entry of EXTENSIONS) {
      for (const [key, setting] of Object.entries(entry.settings)) {
        if (setting.tier === undefined || entry.guard === true) expect(SETTINGS[`${entry.id}.${key}`], `${entry.id}.${key}`).toBe("asked");
      }
    }
    expect(EXTENSIONS.filter((entry) => entry.guard === true).map((entry) => entry.id)).toEqual(["guardian", "permissions"]);
  });

  it("a change that moves nothing is unchanged; several parts are asked when any is", () => {
    expect(tier({ entity: "extension", stored: EMPTY_HARNESS, change: { extension: "codemode", enabled: true, settings: { inlineBudget: 2_000 } } })).toBe("unchanged");
    expect(tier({ entity: "extension", stored: EMPTY_HARNESS, change: { extension: "termctrl", settings: { cols: 200, backgroundBash: false } } })).toBe("free");
    expect(tierOf({ entity: "extension", stored: EMPTY_HARNESS, change: { extension: "web", settings: { search: true, searchModel: "claude-haiku-5-5" } } })).toEqual({
      tier: "asked",
      reasons: ["web.search: false to true (turned up)"],
    });
  });

  it("an unknown extension or setting is asked (fails closed)", () => {
    expect(tier({ entity: "extension", stored: EMPTY_HARNESS, change: { extension: "nope", enabled: false } })).toBe("asked");
    expect(tier({ entity: "extension", stored: EMPTY_HARNESS, change: { extension: "codemode", settings: { nope: 1 } } })).toBe("asked");
  });

  it("a switch that is not true or false is asked, whatever is stored (it would resolve to the default)", () => {
    const off = applyChange(EMPTY_HARNESS, { extension: "codemode", enabled: false });
    if (!off.ok) throw new Error(off.error);
    for (const enabled of [null, "false", 0]) {
      expect(tier({ entity: "extension", stored: off.harness, change: { extension: "codemode", enabled: enabled as unknown as boolean } })).toBe("asked");
    }
  });
});

describe("tierOf: the MCP server set", () => {
  const withDirect = (setting: Record<string, unknown> = {}): StoredHarness => {
    const added = applyMcpChange(EMPTY_HARNESS, { op: "add", server: "fixture", url: "https://fixture.example/mcp", auth: { kind: "none" } });
    if (!added.ok) throw new Error(added.error);
    return { ...added.harness, mcp: { servers: { ...added.harness.mcp!.servers, fixture: { ...added.harness.mcp!.servers.fixture!, ...setting } } } };
  };
  /** The Settings server's entry as it is implied (plan D2). */
  const withSettings: StoredHarness = EMPTY_HARNESS;
  /** A Direct server stored under the reserved name before it was reserved: ignored, and not the Settings server. */
  const withStaleDirect: StoredHarness = { ...EMPTY_HARNESS, mcp: { servers: { [SETTINGS_SERVER]: { kind: "direct", url: "https://x.example/mcp", enabled: true, exposure: "deferred" } } } };
  const mcp = (stored: StoredHarness, change: McpTierChange, hint?: "read" | "write") => tier({ entity: "mcp", stored, change, hintedClass: () => hint });
  const ops = new Set<string>();
  const covered = (change: McpTierChange) => {
    ops.add(change.op);
    return change;
  };

  it("enabled: off to on asked, on to off free", () => {
    expect(mcp(withDirect({ enabled: false }), covered({ op: "server", server: "fixture", enabled: true }))).toBe("asked");
    expect(mcp(withDirect(), { op: "server", server: "fixture", enabled: false })).toBe("free");
    expect(mcp(withDirect(), { op: "server", server: "fixture", enabled: true })).toBe("unchanged");
    expect(mcp(withDirect({ enabled: false }), { op: "server", server: "fixture", enabled: null as unknown as boolean })).toBe("asked");
  });

  it("a name inherited from Object.prototype is not a server in the set (asked)", () => {
    for (const server of ["constructor", "toString", "__proto__"]) {
      expect(mcp(withDirect(), { op: "server", server, enabled: false })).toBe("asked");
      expect(applyMcpChange(withDirect(), { op: "server", server, enabled: false })).toEqual({ ok: false, error: `${server}: no such server` });
    }
  });

  it("a tool named after an Object.prototype key is a tool like any other (SPI-1198 review)", () => {
    for (const tool of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      // On a hidden server, a tool of that name made direct widens: asked, never compared against the prototype's value.
      expect(mcp(withDirect({ exposure: "hidden", toolExposure: {} }), { op: "server", server: "fixture", toolExposure: { [tool]: "direct" } }), tool).toBe("asked");
      expect(mcp(withDirect({ exposure: "hidden" }), { op: "server", server: "fixture", toolExposure: { [tool]: "direct" } }), tool).toBe("asked");
      // Its class from the prototype is no class: to read is asked, back to an unknown hint is unchanged.
      expect(mcp(withDirect({ classes: {} }), { op: "class", server: "fixture", tool, class: "read" }), tool).toBe("asked");
      expect(mcp(withDirect({ classes: {} }), { op: "class", server: "fixture", tool, class: null }), tool).toBe("unchanged");
    }
    // Stored as an own key, never as the object's prototype.
    const stored = applyMcpChange(withDirect(), { op: "server", server: "fixture", toolExposure: JSON.parse('{"__proto__":"direct"}') as Record<string, "direct"> });
    if (!stored.ok) throw new Error(stored.error);
    const exposures = stored.harness.mcp!.servers.fixture!.toolExposure!;
    expect(Object.hasOwn(exposures, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(exposures)).toBe(Object.prototype);
  });

  it("Exposure up asked, down and sideways free, server-wide and per tool against the tool's effective Exposure", () => {
    expect(mcp(withDirect({ exposure: "codemode" }), { op: "server", server: "fixture", exposure: "deferred" })).toBe("asked");
    expect(mcp(withDirect({ exposure: "hidden" }), { op: "server", server: "fixture", exposure: "codemode" })).toBe("asked");
    expect(mcp(withDirect(), { op: "server", server: "fixture", exposure: "codemode" })).toBe("free");
    expect(mcp(withDirect(), { op: "server", server: "fixture", exposure: "direct" })).toBe("free");
    expect(mcp(withDirect({ exposure: "direct" }), { op: "server", server: "fixture", exposure: "deferred" })).toBe("free");
    // A tool with no Exposure of its own follows the server's (deferred).
    expect(mcp(withDirect(), { op: "server", server: "fixture", toolExposure: { search: "hidden" } })).toBe("free");
    expect(mcp(withDirect(), { op: "server", server: "fixture", toolExposure: { search: "direct" } })).toBe("free");
    expect(mcp(withDirect({ toolExposure: { search: "hidden" } }), { op: "server", server: "fixture", toolExposure: { search: "codemode" } })).toBe("asked");
    // null returns the tool to the server's Exposure: compared the same way.
    expect(mcp(withDirect({ toolExposure: { search: "hidden" } }), { op: "server", server: "fixture", toolExposure: { search: null } })).toBe("asked");
    expect(mcp(withDirect({ exposure: "hidden", toolExposure: { search: "direct" } }), { op: "server", server: "fixture", toolExposure: { search: null } })).toBe("free");
    // The tool's after is the server's new Exposure when both move in one change.
    expect(mcp(withDirect({ toolExposure: { search: "codemode" } }), { op: "server", server: "fixture", exposure: "hidden", toolExposure: { search: null } })).toBe("free");
    expect(mcp(withDirect({ toolExposure: { search: "codemode" } }), { op: "server", server: "fixture", exposure: "hidden", toolExposure: { search: "direct", other: "hidden" } })).toBe("asked");
  });

  it("class: to read asked, to write free, to null by the tool's own hint (unknown asked)", () => {
    expect(mcp(withDirect(), covered({ op: "class", server: "fixture", tool: "search", class: "read" }))).toBe("asked");
    expect(mcp(withDirect(), { op: "class", server: "fixture", tool: "search", class: "write" })).toBe("free");
    expect(mcp(withDirect({ classes: { search: "write" } }), { op: "class", server: "fixture", tool: "search", class: null }, "read")).toBe("asked");
    expect(mcp(withDirect({ classes: { search: "write" } }), { op: "class", server: "fixture", tool: "search", class: null }, "write")).toBe("free");
    expect(mcp(withDirect({ classes: { search: "read" } }), { op: "class", server: "fixture", tool: "search", class: null }, "write")).toBe("free");
    expect(mcp(withDirect({ classes: { search: "read" } }), { op: "class", server: "fixture", tool: "search", class: null }, "read")).toBe("free");
    expect(mcp(withDirect({ classes: { search: "write" } }), { op: "class", server: "fixture", tool: "search", class: null })).toBe("asked");
    expect(mcp(withDirect({ classes: { search: "read" } }), { op: "class", server: "fixture", tool: "search", class: null })).toBe("asked");
    expect(mcp(withDirect(), { op: "class", server: "fixture", tool: "search", class: null }, "read")).toBe("unchanged");
  });

  it("add and remove are asked; a header add, a header value and a sign-in need the page", () => {
    expect(tierOf({ entity: "mcp", stored: EMPTY_HARNESS, change: covered({ op: "add", server: "x", url: "https://x.example/mcp", auth: { kind: "none" } }) })).toEqual({ tier: "asked", reasons: ["x: a new server"] });
    expect(tierOf({ entity: "mcp", stored: EMPTY_HARNESS, change: { op: "add", server: "x", url: "https://x.example/mcp", auth: { kind: "oauth" } } }).needsPage).toBeUndefined();
    expect(tierOf({ entity: "mcp", stored: EMPTY_HARNESS, change: { op: "add", server: "x", url: "https://x.example/mcp", auth: { kind: "header", header: "Authorization" } } })).toMatchObject({ tier: "asked", needsPage: "secret" });
    expect(tierOf({ entity: "mcp", stored: withDirect(), change: covered({ op: "remove", server: "fixture" }) })).toMatchObject({ tier: "asked" });
    expect(tierOf({ entity: "mcp", stored: withDirect(), change: covered({ op: "header-value", server: "fixture" }) })).toMatchObject({ tier: "asked", needsPage: "secret" });
    expect(tierOf({ entity: "mcp", stored: withDirect(), change: covered({ op: "sign-in", server: "fixture" }) })).toMatchObject({ tier: "asked", needsPage: "sign-in" });
  });

  it("every change to the Settings server's own entry is asked, narrowing included", () => {
    for (const change of [
      { op: "server", server: SETTINGS_SERVER, enabled: false },
      { op: "server", server: SETTINGS_SERVER, exposure: "hidden" },
      { op: "server", server: SETTINGS_SERVER, toolExposure: { change_mcp: "hidden" } },
      { op: "server", server: SETTINGS_SERVER, writes: false },
      { op: "class", server: SETTINGS_SERVER, tool: "change_mcp", class: "write" },
    ] as const) {
      expect(mcp(withSettings, change), JSON.stringify(change)).toBe("asked");
      // A stale Direct server under the name is ignored: the change still reaches the Settings server's entry.
      expect(mcp(withStaleDirect, change), JSON.stringify(change)).toBe("asked");
    }
  });

  it("the writes switch is the Settings server's alone", () => {
    expect(mcp(withDirect(), { op: "server", server: "fixture", writes: false })).toBe("asked");
    expect(applyMcpChange(withDirect(), { op: "server", server: "fixture", writes: false })).toMatchObject({ ok: false });
  });

  it("an unknown server is asked; every MCP change shape is covered", () => {
    expect(mcp(EMPTY_HARNESS, { op: "server", server: "nope", enabled: false })).toBe("asked");
    expect([...ops].sort()).toEqual(["add", "class", "header-value", "remove", "server", "sign-in"]);
  });
});

describe("tierOf: the Environment settings", () => {
  const stored = (key: EnvironmentKey, value: unknown): StoredEnvironment => ({ revision: 1, settings: { ...EMPTY_ENVIRONMENT.settings, [key]: value as never } });

  it("covers every key, each in both directions", () => {
    expect(Object.keys(ENVIRONMENT).sort()).toEqual(Object.keys(ENVIRONMENT_SETTINGS).sort());
    for (const [key, { up, down }] of Object.entries(ENVIRONMENT) as Array<[EnvironmentKey, (typeof ENVIRONMENT)[EnvironmentKey]]>) {
      for (const [from, to, expected] of [up, down]) {
        expect([key, from, tier({ entity: "environment", stored: stored(key, from), change: { settings: { [key]: to } } })]).toEqual([key, from, expected]);
      }
    }
  });

  it("a multi-key change is asked when any key is; nothing moved is unchanged", () => {
    expect(tier({ entity: "environment", stored: EMPTY_ENVIRONMENT, change: { settings: { containerIdleMinutes: 5, containerBudget: 2 } } })).toBe("free");
    expect(tierOf({ entity: "environment", stored: EMPTY_ENVIRONMENT, change: { settings: { containerIdleMinutes: 5, containerBudget: 4 } } })).toEqual({ tier: "asked", reasons: ["containerBudget: 3 to 4 (turned up)"] });
    expect(tier({ entity: "environment", stored: EMPTY_ENVIRONMENT, change: { settings: { containerIdleMinutes: 2, containerSize: "cpu-1" } } })).toBe("unchanged");
    expect(tier({ entity: "environment", stored: EMPTY_ENVIRONMENT, change: { settings: { nope: 1 } } })).toBe("asked");
  });
});

describe("tierOf: the Environment skills", () => {
  it("install, update, enable and remove are asked; disable is free", () => {
    const cases: ReadonlyArray<readonly [SkillsTierChange, "free" | "asked"]> = [
      [{ op: "install" }, "asked"],
      [{ op: "update", name: "a" }, "asked"],
      [{ op: "enable", name: "a", enabled: true }, "asked"],
      [{ op: "enable", name: "a", enabled: false }, "free"],
      [{ op: "remove", name: "a" }, "asked"],
    ];
    for (const [change, expected] of cases) expect(tier({ entity: "skills", change }), JSON.stringify(change)).toBe(expected);
  });

  it("an install or update needs the page, which alone shows its SKILL.md text (SPI-1199 review); the rest do not", () => {
    expect(tierOf({ entity: "skills", change: { op: "install" } }).needsPage).toBe("skills");
    expect(tierOf({ entity: "skills", change: { op: "update", name: "a" } }).needsPage).toBe("skills");
    for (const change of [{ op: "remove", name: "a" }, { op: "enable", name: "a", enabled: true }, { op: "enable", name: "a", enabled: false }] as const) {
      expect(tierOf({ entity: "skills", change }).needsPage).toBeUndefined();
    }
  });
});
