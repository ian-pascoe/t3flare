// @effect-diagnostics globalDate:off
// The Settings server's reads after the SPI-1198 review (plan D14, D16): a read writes no audit entry, so reads
// cannot evict the log of changes; reads are capped per caller, and those that reach GitHub or an MCP server more
// tightly; `preview_skills` (it mints a GitHub App token) is for a caller that may write; and only what describes the MCP
// server set is scrubbed of URL queries, so Variables, the Global mise config and a SKILL.md read as they are and a
// read-then-write round-trips unchanged.
import { afterEach, describe, expect, it } from "vitest";

import { DURABLE_AGENT, forgetDurableModes, noteDurableModes } from "../src/provider/threadCaller.ts";
import { NETWORK_READ_CAP, READ_CAP } from "../src/settings/changes.ts";
import { LINKED_REFUSAL, NO_MODES_REFUSAL, UNKNOWN_REFUSAL } from "../src/settings/server.ts";
import { settingsFixture, type SettingsFixture, structured, textOf } from "./settingsFixture.ts";
import { skillMd } from "./skillRepo.fixture.ts";

let fixture: SettingsFixture | undefined;
afterEach(() => fixture?.dispose());


describe("reads leave the audit log alone and are capped", () => {
  it("test_mcp_server through the server writes no audit entry, however often it runs", async () => {
    fixture = settingsFixture();
    const run = fixture;
    for (let index = 0; index < 5; index++) await run.call(run.durable(), "test_mcp_server", { server: "commissary" });
    expect(run.store.auditLog(1_000)).toEqual([]);
  });

  it(`at most ${NETWORK_READ_CAP} reads that reach the network and ${READ_CAP} reads in all, per thread per hour`, async () => {
    fixture = settingsFixture();
    const run = fixture;
    for (let index = 0; index < NETWORK_READ_CAP; index++) expect(structured(await run.call(run.durable(), "test_mcp_server", { server: "commissary" }))).toBeDefined();
    const capped = await run.call(run.durable(), "test_mcp_server", { server: "commissary" });
    expect(capped).toMatchObject({ kind: "result", isError: true });
    expect(textOf(capped)).toContain(`${NETWORK_READ_CAP} reads that reach GitHub or an MCP server`);
    // Other reads still run, until the overall cap.
    for (let index = NETWORK_READ_CAP; index < READ_CAP; index++) expect(await run.call(run.durable(), "get_status")).toMatchObject({ isError: false });
    expect(textOf(await run.call(run.durable(), "get_status"))).toContain(`${READ_CAP} settings reads in the last hour`);
    // Another thread has its own count; an hour later the first reads again.
    expect(await run.call(run.durable("thread-other"), "get_status")).toMatchObject({ isError: false });
    run.advance(60 * 60_000 + 1);
    expect(await run.call(run.durable(), "get_status")).toMatchObject({ isError: false });
  });
});

describe("preview_skills is for a caller that may write", () => {
  it("is refused to Linked, unknown, mode-less and plan-mode threads, and runs for the owner's own thread", async () => {
    fixture = settingsFixture({ links: { "thread-linked": "linked", "thread-unknown": "unknown" } });
    const run = fixture;
    run.github.push("o/r", { "skills/a/SKILL.md": skillMd("a") });
    const before = run.github.requests.length;
    const linked = await run.call(run.durable("thread-linked"), "preview_skills", { source: "o/r" });
    expect(textOf(linked)).toContain(LINKED_REFUSAL);
    expect(textOf(await run.call(run.durable("thread-unknown"), "preview_skills", { source: "o/r" }))).toContain(UNKNOWN_REFUSAL);
    expect(textOf(await run.call({ door: "own", thread: "thread-fresh", agent: DURABLE_AGENT }, "preview_skills", { source: "o/r" }))).toContain(NO_MODES_REFUSAL);
    const owner = {};
    noteDurableModes("thread-plan", { runtimeMode: "full-access", interactionMode: "plan" }, owner);
    try {
      expect(textOf(await run.call({ door: "own", thread: "thread-plan", agent: DURABLE_AGENT }, "preview_skills", { source: "o/r" }))).toContain("plan mode");
    } finally {
      forgetDurableModes("thread-plan", owner);
    }
    // None of them reached GitHub.
    expect(run.github.requests.length).toBe(before);
    const own = await run.call(run.durable(), "preview_skills", { source: "o/r" });
    expect(structured(own)).toMatchObject({ skills: [{ name: "a" }] });
  });

  it("counts toward the network read cap", async () => {
    fixture = settingsFixture();
    const run = fixture;
    run.github.push("o/r", { "skills/a/SKILL.md": skillMd("a") });
    for (let index = 0; index < NETWORK_READ_CAP; index++) await run.call(run.durable(), "preview_skills", { source: "o/r" });
    expect(textOf(await run.call(run.durable(), "preview_skills", { source: "o/r" }))).toContain("reach GitHub or an MCP server");
  });
});

describe("reads show Variables, the Global mise config and a SKILL.md as they are (plan D14)", () => {
  const VARIABLES = { DOCS_URL: "https://docs.example/path?token=abc&x=1", NOTE: "see https://a.example/?q=1" };
  const MISE = '[env]\nMIRROR = "https://mirror.example/simple?index=2"\n';

  it("get_settings answers them unchanged, and writing back what was read is unchanged", async () => {
    fixture = settingsFixture();
    const run = fixture;
    run.store.saveEnvironment({ revision: 3, settings: { variables: VARIABLES, globalMiseConfig: MISE } });
    const read = structured(await run.call(run.durable(), "get_settings", { entity: "environment" }))!;
    const value = (key: string) => read.settings.find((setting: { key: string }) => setting.key === key).value;
    expect(value("variables")).toEqual(VARIABLES);
    expect(value("globalMiseConfig")).toBe(MISE);
    const written = await run.call(run.durable(), "change_environment", { expectedRevision: read.revision, settings: { variables: value("variables"), globalMiseConfig: value("globalMiseConfig") } });
    expect(structured(written)).toEqual({ status: "unchanged", revision: 3 });
    expect(run.cards).toEqual([]);
  });

  it("list_skills answers a SKILL.md with its URLs whole; list_mcp_servers still drops a Direct server's query", async () => {
    fixture = settingsFixture();
    const run = fixture;
    const text = "Read https://docs.example/guide?version=2 first.";
    const commit = run.github.push("o/r", { "skills/a/SKILL.md": skillMd("a", text) });
    const { changeSkills } = await import("../src/harness/ops.ts");
    expect((await changeSkills(run.deps.ops, "/install", { source: "o/r", commit, folders: ["skills/a"] }, { actor: { caller: "owner:o" } })).status).toBe(200);
    expect(structured(await run.call(run.durable(), "list_skills", { name: "a" }))!.skillMd).toContain(text);
    const { addMcpServer } = await import("../src/harness/ops.ts");
    await addMcpServer(run.deps.ops, { server: "keyed", url: "https://keyed.example/mcp?key=q-s3cr3t", auth: { kind: "none" } }, { actor: { caller: "owner:o" } });
    const listed = JSON.stringify(await run.call(run.durable(), "list_mcp_servers"));
    expect(listed).toContain("https://keyed.example/mcp");
    expect(listed).not.toContain("q-s3cr3t");
  });
});
