// T-ops (plan §5, D1, D14, D15): the transport-free Settings changes. The same change through the panel's handler and
// through the ops as the Settings server will call them stores the same state and the same audit entry, but for `via`
// and the actor fields; a stale `expectedRevision` is refused with the current revision, and skills do not retry when it
// is given; the set-header op stores the value, audits its mark and answers nothing of it; a removed server's secrets
// are gone; reads other than the panel's see no URL query and no Access subject.
import { sha256Hex } from "@t3flare/skills";
import { describe, expect, it } from "vitest";

import { CSRF_HEADER, handleHarness, type HarnessCaller } from "../src/harness/panel.ts";
import { csrfToken } from "../src/harness/csrf.ts";
import {
  addMcpServer,
  changeEnvironment,
  changeExtension,
  changeMcp,
  changeSkills,
  type OpOptions,
  type OpsDeps,
  readAudit,
  redactAudit,
  redactServer,
  setMcpHeader,
} from "../src/harness/ops.ts";
import { harnessSecrets } from "../src/harness/secrets.ts";
import { type AuditActor, type AuditEntry, harnessStore } from "../src/harness/store.ts";
import type { FetchedSkill } from "../src/skills/fetch.ts";
import { skillStore } from "../src/skills/store.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";
import { fakeGithub, skillMd } from "./skillRepo.fixture.ts";

const HOST = "t3-admin.example.dev";
const NOW = Date.UTC(2026, 10, 14, 10, 30);
const owner: HarnessCaller = { kind: "owner", subject: "owner-sub" };
/** An own agent's actor, as the Settings server will write it (plan D15). */
const agent: AuditActor = { caller: "agent:thread-1", via: "mcp", thread: "thread-1", agent: "piDurable", tier: "free" };
const ACTOR_FIELDS = ["caller", "via", "thread", "agent", "client", "tier", "mode", "answeredBy", "change"] as const;

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

const setup = (caller: HarnessCaller = owner, transactionSync: <T>(closure: () => T) => T = (closure) => closure()) => {
  const kv = memory();
  const store = harnessStore(kv);
  const secrets = harnessSecrets(kv, () => NOW);
  const forgotten: Array<string> = [];
  const skills = skillStore({ sql: nodeSqlStorage(), transactionSync, harness: store, kv });
  const github = fakeGithub();
  const skillsDeps = { store: skills, reader: async () => ({ reader: github.reader, how: "installation" as const }), unauthenticated: () => false };
  const oauth = {
    begin: async () => ({ ok: true as const, value: { authorizationUrl: "https://auth.example/authorize?state=x", registration: "dynamic" } }),
    status: () => ({ signedIn: false, expiresAt: null, refreshable: false }),
    forget: (server: string) => void forgotten.push(server),
  };
  const ops: OpsDeps = { store, secrets, oauth, skills: skillsDeps, now: () => NOW };
  const panel = { caller, host: HOST, store, secrets, oauth, skills: skillsDeps, now: () => NOW };
  return { kv, store, secrets, skills, github, ops, panel, forgotten };
};

const post = async (setupped: ReturnType<typeof setup>, path: string, body: unknown) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (setupped.panel.caller.kind === "owner") {
    headers.origin = `https://${HOST}`;
    headers[CSRF_HEADER] = await csrfToken(setupped.store.csrfKey(), "owner-sub", NOW);
  }
  return handleHarness(new Request(`https://${HOST}/_t3flare/harness/api/${path}`, { method: "POST", headers, body: JSON.stringify(body) }), setupped.panel);
};

const withoutActor = (entry: AuditEntry) => {
  const copy: Record<string, unknown> = { ...entry };
  for (const field of ACTOR_FIELDS) delete copy[field];
  return copy;
};

const viaAgent: OpOptions = { actor: agent };

describe("the panel and the ops make the same change", () => {
  it("extension, Environment, MCP server and add: the same stored state, the same audit entry but for the actor", async () => {
    const panel = setup();
    const server = setup();
    expect((await post(panel, "extensions", { extension: "codemode", settings: { inlineBudget: 3000 } })).status).toBe(200);
    expect(changeExtension(server.ops, { extension: "codemode", settings: { inlineBudget: 3000 } }, viaAgent)).toMatchObject({ ok: true, revision: 1 });
    expect((await post(panel, "environment", { settings: { containerIdleMinutes: 9 } })).status).toBe(200);
    expect(await changeEnvironment(server.ops, { containerIdleMinutes: 9 }, viaAgent)).toMatchObject({ ok: true, revision: 1 });
    expect((await post(panel, "mcp/servers", { server: "fixture", url: "https://fixture.example/mcp", auth: { kind: "none" } })).status).toBe(200);
    expect(await addMcpServer(server.ops, { server: "fixture", url: "https://fixture.example/mcp", auth: { kind: "none" } }, viaAgent)).toMatchObject({ ok: true, revision: 2 });
    expect((await post(panel, "mcp", { op: "server", server: "fixture", exposure: "hidden" })).status).toBe(200);
    expect(changeMcp(server.ops, { op: "server", server: "fixture", exposure: "hidden" }, viaAgent)).toMatchObject({ ok: true, revision: 3 });

    expect(server.store.load()).toEqual(panel.store.load());
    expect(server.store.loadEnvironment()).toEqual(panel.store.loadEnvironment());
    const fromPanel = panel.store.auditLog(10);
    const fromServer = server.store.auditLog(10);
    expect(fromServer.map(withoutActor)).toEqual(fromPanel.map(withoutActor));
    // The panel's entries carry no `via` (they read as the panel's); the server's carry every actor field.
    for (const entry of fromPanel) expect(entry).toMatchObject({ caller: "owner:owner-sub" });
    for (const entry of fromPanel) expect(entry.via).toBeUndefined();
    for (const entry of fromServer) expect(entry).toMatchObject(agent);
  });

  it("skills: the same rows and audit entry but for the actor", async () => {
    const panel = setup();
    const server = setup();
    const commit = panel.github.push("o/r", { "skills/a/SKILL.md": skillMd("a") });
    expect(server.github.push("o/r", { "skills/a/SKILL.md": skillMd("a") })).toBe(commit);
    expect((await post(panel, "skills/install", { source: "o/r", commit, folders: ["skills/a"] })).status).toBe(200);
    expect(await changeSkills(server.ops, "/install", { source: "o/r", commit, folders: ["skills/a"] }, { actor: agent, expectedRevision: 0 })).toMatchObject({ status: 200 });
    expect(server.skills.list().map(({ savedAt: _at, ...row }) => row)).toEqual(panel.skills.list().map(({ savedAt: _at, ...row }) => row));
    expect(server.store.auditLog(5).map(withoutActor)).toEqual(panel.store.auditLog(5).map(withoutActor));
    expect(server.store.auditLog(1)[0]).toMatchObject(agent);
  });
});

describe("expectedRevision", () => {
  it("each op refuses a stale one with the current revision and stores nothing", async () => {
    const { ops, store, secrets } = setup();
    expect(changeExtension(ops, { extension: "codemode", settings: { inlineBudget: 3000 } }, { actor: agent, expectedRevision: 0 })).toMatchObject({ ok: true, revision: 1 });
    const stale = { actor: agent, expectedRevision: 0 };
    expect(changeExtension(ops, { extension: "codemode", settings: { inlineBudget: 4000 } }, stale)).toEqual({
      ok: false,
      status: 409,
      error: "the Harness settings are at revision 1, not 0; read them again",
      revision: 1,
    });
    expect(await addMcpServer(ops, { server: "x", url: "https://x.example/mcp", auth: { kind: "header", header: "Authorization" }, value: "v" }, stale)).toMatchObject({ ok: false, status: 409, revision: 1 });
    expect(secrets.read("x", "header")).toBeUndefined();
    expect(changeMcp(ops, { op: "server", server: "commissary", enabled: false }, stale)).toMatchObject({ ok: false, status: 409, revision: 1 });
    expect(await changeEnvironment(ops, { containerIdleMinutes: 9 }, { actor: agent, expectedRevision: 3 })).toMatchObject({ ok: false, status: 409, revision: 0 });
    expect(store.load().revision).toBe(1);
    expect(store.loadEnvironment().revision).toBe(0);
    expect(store.auditLog(10)).toHaveLength(1);
    // The registry's refusal comes first (plan D7's order): a malformed change with a stale revision is a 400.
    expect(changeExtension(ops, { extension: "permissions", enabled: false }, stale)).toMatchObject({ ok: false, status: 400 });
  });

  it("the panel takes one in the body: a stale one is 409, a malformed one 400, and none keeps the form working", async () => {
    const env = setup({ kind: "service-token" });
    expect((await post(env, "extensions", { extension: "tool-search", enabled: false, expectedRevision: 0 })).status).toBe(200);
    const stale = await post(env, "extensions", { extension: "tool-search", enabled: true, expectedRevision: 0 });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toBe("the Harness settings are at revision 1, not 0; read them again\n");
    expect((await post(env, "extensions", { extension: "tool-search", enabled: true, expectedRevision: "1" })).status).toBe(400);
    expect((await post(env, "environment", { settings: { containerIdleMinutes: 9 }, expectedRevision: 1 })).status).toBe(409);
    expect((await post(env, "mcp", { op: "server", server: "commissary", enabled: false, expectedRevision: 0 })).status).toBe(409);
    expect((await post(env, "skills/remove", { name: "a", expectedRevision: 5 })).status).toBe(409);
    expect((await post(env, "extensions", { extension: "tool-search", enabled: true })).status).toBe(200);
    // The change stored is the change alone, never the revision it named.
    expect(JSON.stringify(env.store.load())).not.toContain("expectedRevision");
  });

  it("skills: a stale one is refused before GitHub is read, and the store does not retry when one is given", async () => {
    let moves = 0;
    let calls = 0;
    const holder: { store?: ReturnType<typeof harnessStore> } = {};
    // Another change lands while the set's hash is made: the revision moves between the check and the write.
    const racing = <T>(closure: () => T): T => {
      calls++;
      if (moves > 0) {
        moves--;
        const environment = holder.store!.loadEnvironment();
        holder.store!.saveEnvironment({ ...environment, revision: environment.revision + 1 });
      }
      return closure();
    };
    const env = setup(owner, racing);
    holder.store = env.store;
    const commit = env.github.push("o/r", { "skills/a/SKILL.md": skillMd("a") });
    env.github.reset();
    expect(await changeSkills(env.ops, "/install", { source: "o/r", commit, folders: ["skills/a"] }, { actor: agent, expectedRevision: 4 })).toEqual({
      status: 409,
      text: "the Environment settings are at revision 0, not 4; read them again",
    });
    expect(env.github.requests).toEqual([]);

    const skill: FetchedSkill = {
      name: "b",
      description: "b",
      path: "skills/b",
      disableModelInvocation: false,
      digest: "d",
      bytes: 1,
      files: { "SKILL.md": { text: "b", blob: "blob-b", size: 1, sha256: await sha256Hex("b") } },
    };
    const source = { repo: "o/r", path: "skills/b", ref: null, commit };
    moves = 1;
    calls = 0;
    expect(await env.skills.apply({ kind: "install", skill, source }, agent, NOW, 0)).toEqual({
      ok: false,
      error: "the Environment settings are at revision 1, not 0; read them again",
      moved: { revision: 1 },
    });
    expect(calls).toBe(1);
    expect(env.skills.get("b")).toBeUndefined();
    // Without one, it tries again and keeps the change.
    moves = 1;
    calls = 0;
    expect(await env.skills.apply({ kind: "install", skill, source }, agent, NOW)).toMatchObject({ ok: true, action: "skill-install", revision: 3 });
    expect(calls).toBe(2);
  });

  it("skills: an install of several expects the revision of the first, then each next one the revision the last left", async () => {
    const env = setup();
    const commit = env.github.push("o/r", { "skills/a/SKILL.md": skillMd("a"), "skills/b/SKILL.md": skillMd("b") });
    const answer = await changeSkills(env.ops, "/install", { source: "o/r", commit, folders: ["skills/a", "skills/b"] }, { actor: agent, expectedRevision: 0 });
    expect(answer).toMatchObject({ status: 200, json: { results: [{ name: "a", action: "skill-install" }, { name: "b", action: "skill-install" }] } });
    expect(env.store.loadEnvironment().revision).toBe(2);
    expect(await changeSkills(env.ops, "/enable", { name: "a", enabled: false }, { actor: agent, expectedRevision: 1 })).toEqual({
      status: 409,
      text: "the Environment settings are at revision 2, not 1; read them again",
    });
    expect(await changeSkills(env.ops, "/enable", { name: "a", enabled: false }, { actor: agent, expectedRevision: 2 })).toMatchObject({ status: 200, json: { action: "skill-disable", revision: 3 } });
  });
});

describe("the set-header op", () => {
  const VALUE = "s3cr3t-header-VALUE-5678";

  it("stores the value, audits its mark as mcp.secret.set, bumps no revision, and answers nothing of the value", async () => {
    const env = setup({ kind: "service-token" });
    expect((await post(env, "mcp/servers", { server: "fixture", url: "https://fixture.example/mcp", auth: { kind: "header", header: "Authorization" }, value: "first" })).status).toBe(200);
    const revision = env.store.load().revision;
    const response = await post(env, "mcp/secret", { server: "fixture", value: VALUE });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: true, revision, secret: { set: true, setAt: NOW, fingerprint: expect.stringMatching(/^[0-9a-f]{4}$/) } });
    expect(env.secrets.read("fixture", "header")).toBe(VALUE);
    expect(env.store.load().revision).toBe(revision);
    expect(env.store.auditLog(1)).toEqual([{ caller: "service-token", entity: "harness", at: NOW, action: "mcp.secret.set", target: "fixture", after: { secret: env.secrets.mark("fixture", "header") } }]);
    for (const shown of [text, JSON.stringify(env.store.auditLog(10)), JSON.stringify(env.store.load())]) {
      expect(shown).not.toContain(VALUE);
      expect(shown).not.toContain(btoa(VALUE));
    }
  });

  it("refuses an unknown server, Commissary, a server with another sign-in, an empty value and a stale revision, storing nothing", async () => {
    const env = setup();
    await addMcpServer(env.ops, { server: "open", url: "https://open.example/mcp", auth: { kind: "oauth" } }, viaAgent);
    await addMcpServer(env.ops, { server: "keyed", url: "https://keyed.example/mcp", auth: { kind: "header", header: "X-Key" }, value: "k" }, viaAgent);
    expect(await setMcpHeader(env.ops, { server: "nope", value: VALUE }, viaAgent)).toEqual({ ok: false, status: 404, error: "no such direct server" });
    expect(await setMcpHeader(env.ops, { server: "commissary", value: VALUE }, viaAgent)).toEqual({ ok: false, status: 404, error: "no such direct server" });
    expect(await setMcpHeader(env.ops, { server: "open", value: VALUE }, viaAgent)).toEqual({ ok: false, status: 400, error: "open does not sign in with a header" });
    expect(await setMcpHeader(env.ops, { server: "keyed", value: "" }, viaAgent)).toEqual({ ok: false, status: 400, error: "a header sign-in needs its value" });
    expect(await setMcpHeader(env.ops, { server: "keyed", value: 7 }, viaAgent)).toEqual({ ok: false, status: 400, error: "a header sign-in needs its value" });
    expect(await setMcpHeader(env.ops, { server: "keyed", value: VALUE }, { actor: agent, expectedRevision: 0 })).toMatchObject({ ok: false, status: 409, revision: 2 });
    expect(env.secrets.read("keyed", "header")).toBe("k");
    expect(await setMcpHeader(env.ops, { server: "keyed", value: VALUE }, { actor: agent, expectedRevision: 2 })).toMatchObject({ ok: true, revision: 2 });
    expect(env.secrets.read("keyed", "header")).toBe(VALUE);
  });
});

describe("removing a server", () => {
  it("deletes its header value and forgets its OAuth sign-in at once", async () => {
    const env = setup();
    await addMcpServer(env.ops, { server: "keyed", url: "https://keyed.example/mcp", auth: { kind: "header", header: "X-Key" }, value: "k" }, viaAgent);
    expect(env.secrets.read("keyed", "header")).toBe("k");
    expect(changeMcp(env.ops, { op: "remove", server: "keyed" }, viaAgent)).toMatchObject({ ok: true });
    expect(env.secrets.read("keyed", "header")).toBeUndefined();
    expect(env.secrets.mark("keyed", "header")).toEqual({ set: false, setAt: null, fingerprint: null });
    expect(env.forgotten).toEqual(["keyed"]);
    expect(env.store.auditLog(1)[0]).toMatchObject({ action: "mcp.remove", target: "keyed", after: null });
  });
});

describe("reads outside the panel", () => {
  it("a Direct server's URL is shown without its query", () => {
    expect(redactServer({ kind: "direct", url: "https://mcp.executor.example/mcp?connection=conn_1&key=s3cr3t", auth: { kind: "oauth" }, enabled: true, exposure: "deferred" })).toEqual({
      kind: "direct",
      url: "https://mcp.executor.example/mcp",
      auth: { kind: "oauth" },
      enabled: true,
      exposure: "deferred",
    });
    expect(redactServer({ kind: "commissary", enabled: true, exposure: "deferred" })).toEqual({ kind: "commissary", enabled: true, exposure: "deferred" });
  });

  it("the audit log drops every URL's query and the owner's Access subject, and pages newest first", async () => {
    const env = setup();
    expect((await post(env, "mcp/servers", { server: "executor", url: "https://mcp.executor.example/mcp?key=s3cr3t", auth: { kind: "none" } })).status).toBe(200);
    expect((await post(env, "mcp", { op: "server", server: "executor", exposure: "hidden" })).status).toBe(200);
    for (let index = 0; index < 3; index++) changeExtension(env.ops, { extension: "termctrl", settings: { cols: 100 + index } }, viaAgent);
    const all = JSON.stringify(readAudit(env.ops, { limit: 50 }));
    expect(all).not.toContain("s3cr3t");
    expect(all).not.toContain("owner-sub");
    expect(all).toContain("https://mcp.executor.example/mcp");
    expect(redactAudit(env.store.auditLog(5)[4]!)).toMatchObject({ caller: "owner", action: "mcp.add", after: { url: "https://mcp.executor.example/mcp" } });
    // Paged: 2 at a time, newest first, `before` naming where the next page starts.
    const first = readAudit(env.ops, { limit: 2 });
    expect(first.entries.map((entry) => entry.after)).toMatchObject([{ settings: { cols: 102 } }, { settings: { cols: 101 } }]);
    const second = readAudit(env.ops, { limit: 2, before: first.before! });
    expect(second.entries.map((entry) => entry.action)).toEqual(["extension.change", "mcp.server"]);
    const third = readAudit(env.ops, { limit: 2, before: second.before! });
    expect(third).toEqual({ entries: [expect.objectContaining({ action: "mcp.add" })] });
    expect(readAudit(env.ops, { limit: 500 }).entries).toHaveLength(5);
    expect(readAudit(env.ops).entries).toHaveLength(5);
  });

  it("the audit log drops a secret's fingerprint, and keeps the Variables' values whole", async () => {
    const env = setup();
    expect((await post(env, "mcp/servers", { server: "fixture", url: "https://fixture.example/mcp", auth: { kind: "header", header: "Authorization" }, value: "first" })).status).toBe(200);
    expect(JSON.stringify(env.store.auditLog(1))).toContain("fingerprint");
    expect(await changeEnvironment(env.ops, { variables: { DOCS_URL: "https://docs.example/?page=2" } }, viaAgent)).toMatchObject({ ok: true });
    const all = JSON.stringify(readAudit(env.ops, { limit: 50 }));
    expect(all).not.toContain("fingerprint");
    expect(all).toContain("https://docs.example/?page=2");
  });

  it("the Workers Logs line names the door, tier, mode and answer, and never a value", () => {
    const env = setup();
    const logged: Array<string> = [];
    const log = console.log;
    console.log = (line: string) => void logged.push(line);
    try {
      changeExtension(env.ops, { extension: "codemode", settings: { inlineBudget: 3000 } }, { actor: { ...agent, tier: "asked", mode: "card", answeredBy: "card", change: "chg_x" } });
    } finally {
      console.log = log;
    }
    expect(logged.map((line) => JSON.parse(line))).toEqual([
      { t3flare: "harness-change", entity: "harness", caller: "agent", action: "extension.change", target: "codemode", via: "mcp", tier: "asked", mode: "card", answeredBy: "card" },
    ]);
  });
});
