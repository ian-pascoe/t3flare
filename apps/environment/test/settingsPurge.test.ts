// @effect-diagnostics globalDate:off
// T-purge (ADR-0044 §5–6): `purge_workspace` and `list_workspaces` on the Settings server. A
// Purge of a referenced or unknown Workspace is refused before anything opens; otherwise it is always asked, in every
// mode, as an Open change with no revision, answered on the owner-only card or the Change page; plan mode and Linked work
// refuse it; a reference appearing between the ask and the answer fails it, naming the reference; a declined Purge is
// not asked again for a while. It purges through `workspaceActions.ts` with the asker as the audit's actor.
import { applyMcpChange, EMPTY_HARNESS, PLAN_REFUSAL } from "@t3flare/harness-registry";
import { afterEach, describe, expect, it } from "vitest";

import type { PurgeReport } from "../src/agents/deletion.ts";
import type { WorkspaceActionsDeps } from "../src/agents/workspaceActions.ts";
import type { WorkspaceRecord } from "../src/agents/workspaces.ts";
import { renderChangePage } from "../src/harness/changePage.ts";
import { csrfToken } from "../src/harness/csrf.ts";
import { handleHarness } from "../src/harness/panel.ts";
import { CHANGES_API_PATH } from "../src/harness/paths.ts";
import type { AuditEntry } from "../src/harness/store.ts";
import { noteDurableModes } from "../src/provider/threadCaller.ts";
import { DECLINED_REPEAT_MS } from "../src/settings/openChanges.ts";
import { changeText } from "../src/settings/render.ts";
import { APPLIES_AT, LINKED_REFUSAL, READ_ONLY_REFUSAL, settingsOwnerCall } from "../src/settings/server.ts";
import { SETTINGS_INSTRUCTIONS, SETTINGS_OWNER_INSTRUCTIONS, SETTINGS_TOOLS } from "../src/settings/tools.ts";
import { GRACE, record, t3Tables, viewDeps } from "./fixtures/workspaces.ts";
import { HOST, NOW, settingsFixture, type SettingsFixture, structured, textOf, until } from "./settingsFixture.ts";

let fixture: SettingsFixture | undefined;
afterEach(() => fixture?.dispose());

const open = () => new Promise<never>(() => undefined);

/**
 * A deleted project `acme` with two Worktree Workspaces (one a Tombstone) and two deleted threads, and a live project
 * `live`; the Workspaces' acts over them, recording each purge and audit entry.
 */
const workspaces = () => {
  const sql = t3Tables();
  sql.exec("INSERT INTO projection_projects VALUES ('p-acme', 'Acme', '/w/acme', '2026-03-01T00:00:00Z', '2026-06-01T00:00:00Z', NULL)");
  sql.exec("INSERT INTO projection_projects VALUES ('p-live', 'Live', '/w/live', '2026-03-01T00:00:00Z', NULL, NULL)");
  sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t1', 'p-acme', 'Feature A', '2026-06-01T00:00:00Z', NULL, '{"worktreePath":"/w/.wt/acme/feat-a"}')`);
  sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t0', 'p-acme', 'Plain', '2026-06-01T00:00:00Z', NULL, '{"worktreePath":null}')`);
  const rows: Array<WorkspaceRecord> = [
    record({ id: "acme", unreferencedSince: Date.UTC(2026, 10, 10) }),
    record({ id: ".wt/acme/feat-a", kind: "worktree", parent: "acme", branch: "feat-a" }),
    record({ id: ".wt/acme/feat-b", kind: "worktree", parent: "acme", branch: "feat-b", state: "tombstoned", deletedAt: Date.UTC(2026, 10, 12), purgeAfter: Date.UTC(2026, 10, 19) }),
    record({ id: "live" }),
  ];
  const purged: Array<string> = [];
  const audit: Array<AuditEntry> = [];
  const deps: WorkspaceActionsDeps = {
    ...viewDeps(rows, { sql, purgingSince: null }),
    purge: async (id, threads): Promise<PurgeReport> => {
      purged.push(id);
      rows.splice(
        rows.findIndex((row) => row.id === id),
        1,
      );
      return { id, sessionsDestroyed: threads.map((thread) => thread.threadId), destroyed: true };
    },
    restore: async () => undefined,
    stop: async () => undefined,
    audit: (entry) => void audit.push(entry),
    now: () => Date.UTC(2026, 10, 21),
  };
  return { sql, rows, purged, audit, deps };
};

const PURGE = { workspace: "acme" };
const REASON = "acme: purged, with its files, 2 Worktree Workspaces and 2 Sessions";

/** The owner's POST from the Change page. */
const pagePost = async (run: SettingsFixture, id: string, body: Record<string, unknown>) => {
  const csrf = await csrfToken(run.store.csrfKey(), "owner-sub", run.now());
  return handleHarness(
    new Request(`https://${HOST}${CHANGES_API_PATH}/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `https://${HOST}`, "sec-fetch-site": "same-origin", "x-t3flare-csrf": csrf },
      body: JSON.stringify(body),
    }),
    run.panel(),
  );
};

describe("purge_workspace: planning (ADR-0044 §5)", () => {
  it("refuses a referenced Workspace before anything opens, naming the reference and saying to delete it in t3 first", async () => {
    const ws = workspaces();
    fixture = settingsFixture({ workspaces: ws.deps });
    const run = fixture;
    const answer = await run.call(run.durable("thread-a", "full-access"), "purge_workspace", { workspace: "live" });
    expect(structured(answer)).toEqual({ status: "refused" });
    expect(textOf(answer)).toContain("project “Live”");
    expect(textOf(answer)).toContain("Delete the project or thread in t3 first.");
    expect(run.cards).toEqual([]);
    expect(run.deps.changes.open()).toEqual([]);
    expect(ws.purged).toEqual([]);
    expect(ws.audit).toEqual([]);
  });

  it("refuses a project whose worktree is referenced, and an unknown Workspace", async () => {
    const ws = workspaces();
    ws.sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t9', 'p-live', 'Still working', NULL, NULL, '{"worktreePath":"/w/.wt/acme/feat-a"}')`);
    fixture = settingsFixture({ workspaces: ws.deps });
    const run = fixture;
    const held = await run.call(run.durable("thread-a", "full-access"), "purge_workspace", PURGE);
    expect(textOf(held)).toContain(".wt/acme/feat-a by thread “Still working”");
    const unknown = await run.call(run.durable("thread-a", "full-access"), "purge_workspace", { workspace: "nope" });
    expect(textOf(unknown)).toBe("Not changed: no Workspace nope");
    expect(run.cards).toEqual([]);
    expect(run.deps.changes.open()).toEqual([]);
    expect(ws.purged).toEqual([]);
  });

  it("is refused in plan mode, for Linked work and with the server read-only, before the references are read", async () => {
    const ws = workspaces();
    let reads = 0;
    const counted: WorkspaceActionsDeps = { ...ws.deps, terminals: async (id) => (reads++, ws.deps.terminals(id)) };
    fixture = settingsFixture({ workspaces: counted, links: { "thread-linked": "linked" } });
    const run = fixture;
    const owner = {};
    noteDurableModes("thread-plan", { runtimeMode: "full-access", interactionMode: "plan" }, owner);
    expect(textOf(await run.call({ door: "own", thread: "thread-plan", agent: "piDurable" }, "purge_workspace", PURGE))).toBe(PLAN_REFUSAL);
    expect(textOf(await run.call(run.durable("thread-linked", "full-access"), "purge_workspace", PURGE))).toBe(LINKED_REFUSAL);
    const readOnly = applyMcpChange(EMPTY_HARNESS, { op: "server", server: "settings", writes: false });
    if (!readOnly.ok) throw new Error(readOnly.error);
    run.store.save(readOnly.harness);
    expect(textOf(await run.call(run.durable("thread-a", "full-access"), "purge_workspace", PURGE))).toBe(READ_ONLY_REFUSAL);
    expect(reads).toBe(0);
    expect(run.cards).toEqual([]);
    expect(ws.purged).toEqual([]);
  });
});

describe("purge_workspace: always asked (ADR-0044 §5)", () => {
  it("asks on the owner-only card in full access, with no revision, and Approve purges the set with the card as answerer", async () => {
    const ws = workspaces();
    fixture = settingsFixture({ workspaces: ws.deps });
    const run = fixture;
    const answer = await run.call(run.durable("thread-a", "full-access"), "purge_workspace", PURGE);
    expect(structured(answer)).toMatchObject({ status: "applied", changeId: expect.stringMatching(/^chg_/) });
    expect(structured(answer).revision).toBeUndefined();
    expect(textOf(answer)).toBe(`Purged: the owner approved it on the card. ${REASON}. It cannot be undone.`);
    expect(run.cards).toHaveLength(1);
    const prompt = run.cards[0]!.prompt;
    expect(prompt.startsWith("A Purge of the Workspace acme:")).toBe(true);
    expect(prompt).not.toContain("revision");
    expect(prompt).toContain(`It waits for the owner because:\n- ${REASON}`);
    expect(prompt).toContain("With it, its Worktree Workspaces: .wt/acme/feat-a (unreferenced), .wt/acme/feat-b (tombstone).");
    expect(prompt).not.toContain("Kept Tombstones");
    expect(prompt).toContain(APPLIES_AT.purge);
    expect(ws.purged).toEqual([".wt/acme/feat-a", ".wt/acme/feat-b", "acme"]);
    expect(ws.audit).toEqual([
      {
        at: Date.UTC(2026, 10, 21),
        entity: "workspaces",
        caller: "agent:thread-a",
        via: "mcp",
        thread: "thread-a",
        agent: "piDurable",
        tier: "asked",
        mode: "card",
        answeredBy: "card",
        change: structured(answer).changeId,
        action: "workspace.purge",
        target: "acme",
        after: { purged: [".wt/acme/feat-a", ".wt/acme/feat-b", "acme"], sessions: 2 },
      },
    ]);
    // The record: entity workspaces at the constant revision 0, the purge item (ADR-0044 §5).
    const [closed] = run.deps.changes.closedBy("own:thread-a", 0);
    expect(closed).toMatchObject({ entity: "workspaces", expectedRevision: 0, state: "applied", shown: { entity: "workspaces", revision: 0, appliesAt: APPLIES_AT.purge } });
    expect(closed!.shown!.items).toEqual([
      {
        kind: "purge",
        id: "acme",
        workspaceKind: "project",
        title: "Acme",
        status: "unreferenced",
        worktrees: [
          { id: ".wt/acme/feat-a", status: "unreferenced" },
          { id: ".wt/acme/feat-b", status: "tombstone" },
        ],
        sessions: 2,
        purgeDue: NOW + GRACE,
      },
    ]);
  });

  it("is applied from the Change page, the card left open", async () => {
    const ws = workspaces();
    fixture = settingsFixture({ workspaces: ws.deps, answer: open });
    const run = fixture;
    const pending = run.call(run.durable("thread-a", "approval-required"), "purge_workspace", { workspace: ".wt/acme/feat-b" });
    await until(() => run.cards.length === 1);
    const [record] = run.deps.changes.open();
    expect(record).toMatchObject({ tool: "purge_workspace", entity: "workspaces", mode: "card" });
    expect(record!.needsPage).toBeUndefined();
    const page = renderChangePage(record!, { csrf: "tok", now: run.now() });
    expect(page).toContain("A Purge of the Workspace .wt/acme/feat-b");
    expect(page).toContain("Approve and purge");
    const posted = await pagePost(run, record!.id, { action: "approve" });
    expect(posted.status).toBe(200);
    expect(structured(await pending)).toMatchObject({ status: "applied", changeId: record!.id });
    expect(ws.purged).toEqual([".wt/acme/feat-b"]);
    expect(ws.audit).toMatchObject([{ entity: "workspaces", action: "workspace.purge", target: ".wt/acme/feat-b", answeredBy: "page", caller: "agent:thread-a" }]);
    expect(run.withdrawn).toEqual([run.cards[0]!.id]);
  });

  it("fails, naming the reference, when one appeared between the ask and the answer; nothing is purged", async () => {
    const ws = workspaces();
    fixture = settingsFixture({
      workspaces: ws.deps,
      answer: async () => {
        // A thread in t3 takes the worktree while the card waits.
        ws.sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t7', 'p-live', 'Took it back', NULL, NULL, '{"worktreePath":"/w/.wt/acme/feat-a"}')`);
        return { decision: "accept" };
      },
    });
    const run = fixture;
    const answer = await run.call(run.durable("thread-a", "full-access"), "purge_workspace", PURGE);
    expect(structured(answer)).toMatchObject({ status: "refused", changeId: expect.stringMatching(/^chg_/) });
    expect(textOf(answer)).toContain(".wt/acme/feat-a by thread “Took it back”");
    expect(textOf(answer)).toContain("Delete the project or thread in t3 first.");
    expect(run.deps.changes.get(structured(answer).changeId)).toMatchObject({ state: "failed" });
    expect(ws.purged).toEqual([]);
    expect(ws.audit).toEqual([]);
  });

  it("does not say nothing was purged when the Purge fails after purging", async () => {
    const ws = workspaces();
    const deps: WorkspaceActionsDeps = {
      ...ws.deps,
      audit: () => {
        throw new Error("audit log full");
      },
    };
    fixture = settingsFixture({ workspaces: deps });
    const run = fixture;
    const answer = await run.call(run.durable("thread-a", "full-access"), "purge_workspace", PURGE);
    expect(textOf(answer)).toContain("the Purge could not finish: Error: audit log full; list_workspaces shows what is left");
    expect(textOf(answer)).not.toContain("nothing was purged");
    expect(ws.purged.length).toBeGreaterThan(0);
  });

  it("fails cleanly, with the reason, when the references cannot be read at the answer; nothing is purged", async () => {
    const ws = workspaces();
    // The ask's plan and the answer's plan read acme's Terminals; the Purge's own read, the third, fails.
    let reads = 0;
    const deps: WorkspaceActionsDeps = {
      ...ws.deps,
      terminals: async (id) => (id === "acme" && ++reads === 3 ? Promise.reject(new Error("Workspace DO unreachable")) : ws.deps.terminals(id)),
    };
    fixture = settingsFixture({ workspaces: deps });
    const run = fixture;
    const answer = await run.call(run.durable("thread-a", "full-access"), "purge_workspace", PURGE);
    expect(structured(answer)).toMatchObject({ status: "refused", changeId: expect.stringMatching(/^chg_/) });
    expect(textOf(answer)).toContain("the Workspace's references could not be read, so nothing was purged");
    expect(textOf(answer)).toContain("Workspace DO unreachable");
    expect(run.deps.changes.get(structured(answer).changeId)).toMatchObject({ state: "failed" });
    expect(ws.purged).toEqual([]);
    expect(ws.audit).toEqual([]);
  });

  it("a declined Purge is not asked again for the same Workspace for 10 minutes; another Workspace is", async () => {
    const ws = workspaces();
    fixture = settingsFixture({ workspaces: ws.deps, answer: { decision: "decline" } });
    const run = fixture;
    const caller = run.durable("thread-a", "full-access");
    expect(structured(await run.call(caller, "purge_workspace", PURGE))).toMatchObject({ status: "declined" });
    const again = await run.call(caller, "purge_workspace", PURGE);
    expect(structured(again)).toMatchObject({ status: "refused", reason: "declined-repeat" });
    expect(run.cards).toHaveLength(1);
    expect(structured(await run.call(caller, "purge_workspace", { workspace: ".wt/acme/feat-b" }))).toMatchObject({ status: "declined" });
    expect(run.cards).toHaveLength(2);
    run.advance(DECLINED_REPEAT_MS + 1);
    expect(structured(await run.call(caller, "purge_workspace", PURGE))).toMatchObject({ status: "declined" });
    expect(run.cards).toHaveLength(3);
    expect(ws.purged).toEqual([]);
  });

  it("an Owner client's Purge is an Open change in its mode, answered on the Change page", async () => {
    const ws = workspaces();
    fixture = settingsFixture({ workspaces: ws.deps });
    const run = fixture;
    const opened = await settingsOwnerCall(run.deps, { tool: "purge_workspace", args: PURGE, caller: { door: "owner", kind: "owner", key: "owner-sub" }, mode: "browser" });
    expect(opened.kind).toBe("open");
    if (opened.kind !== "open") return;
    expect(opened.record).toMatchObject({ entity: "workspaces", expectedRevision: 0, mode: "browser" });
    expect((await pagePost(run, opened.record.id, { action: "approve" })).status).toBe(200);
    expect(ws.purged).toEqual([".wt/acme/feat-a", ".wt/acme/feat-b", "acme"]);
    expect(ws.audit).toMatchObject([{ caller: "owner:owner-sub", answeredBy: "page", action: "workspace.purge" }]);
  });
});

describe("list_workspaces and the texts (ADR-0044 §5)", () => {
  it("reads the Workspaces as the page's view, without usage", async () => {
    const ws = workspaces();
    fixture = settingsFixture({ workspaces: ws.deps });
    const run = fixture;
    const listed = structured(await run.call(run.durable("thread-a", "approval-required"), "list_workspaces"));
    expect(listed).toMatchObject({ purging: true, graceDays: 7 });
    expect(listed.rows.map((row: { id: string }) => row.id)).toEqual(["acme", "live"]);
    expect(listed.rows[0]).toMatchObject({ title: "Acme", can: { purge: true }, worktrees: [{ id: ".wt/acme/feat-a" }, { id: ".wt/acme/feat-b" }] });
    expect(listed.rows[1]).toMatchObject({ status: "in use", references: ["project “Live”"], can: { purge: false } });
    expect(JSON.stringify(listed)).not.toContain("bytes");
    expect(run.cards).toEqual([]);
  });

  it("are tools of fixed class; the instructions name the Workspaces and say a Purge always waits and names no revision", () => {
    expect(SETTINGS_TOOLS.find((tool) => tool.name === "list_workspaces")?.class).toBe("read");
    const purge = SETTINGS_TOOLS.find((tool) => tool.name === "purge_workspace")!;
    expect(purge.class).toBe("write");
    expect(purge.inputSchema).toMatchObject({ required: ["workspace"], properties: { workspace: { type: "string" } }, additionalProperties: false });
    expect(JSON.stringify(purge.inputSchema)).not.toContain("expectedRevision");
    expect(JSON.stringify(purge.inputSchema)).not.toContain("force");
    // GLOSSARY: the owner answers an Open change; a Purge is never "deleted" or "removed" (t3's words).
    expect(purge.description).toContain("read again when the owner answers");
    for (const text of [SETTINGS_INSTRUCTIONS, SETTINGS_OWNER_INSTRUCTIONS]) {
      expect(text).toContain("purge_workspace");
      expect(text).toContain("names no revision and always waits for the owner's answer");
    }
  });

  it("a kept Tombstone in the set is called out on the card and the Change page: work a removal could not check", async () => {
    const ws = workspaces();
    ws.rows.splice(2, 1, record({ id: ".wt/acme/feat-b", kind: "worktree", parent: "acme", branch: "feat-b", state: "tombstoned", deletedAt: Date.UTC(2026, 10, 12), purgeAfter: null }));
    fixture = settingsFixture({ workspaces: ws.deps, answer: open });
    const run = fixture;
    void run.call(run.durable("thread-a", "approval-required"), "purge_workspace", PURGE);
    await until(() => run.cards.length === 1);
    const prompt = run.cards[0]!.prompt;
    expect(prompt).toContain(".wt/acme/feat-b (tombstone (kept))");
    expect(prompt).toContain("Kept Tombstones, holding work a removal could not check, go with it for good: .wt/acme/feat-b.");
    const page = renderChangePage(run.deps.changes.open()[0]!, { csrf: "tok", now: run.now() });
    expect(page).toContain("<li><code>.wt/acme/feat-b</code> tombstone (kept)</li>");
    expect(page).toContain("Kept Tombstones, holding work a removal could not check, go with it for good: .wt/acme/feat-b.");
  });

  it("the card's text and the Change page render the purge item", () => {
    const view = {
      entity: "workspaces" as const,
      subject: "the Workspace acme",
      revision: 0,
      appliesAt: APPLIES_AT.purge,
      reasons: [REASON],
      items: [
        {
          kind: "purge" as const,
          id: "acme",
          workspaceKind: "project" as const,
          title: "<b>Acme</b>",
          status: "unreferenced" as const,
          worktrees: [{ id: ".wt/acme/feat-a", status: "unreferenced" as const }],
          sessions: 2,
          purgeDue: Date.UTC(2026, 10, 24),
        },
      ],
      lines: [],
    };
    const text = changeText(view);
    expect(text).toContain('- Purge the project Workspace acme ("<b>Acme</b>", unreferenced) now, with its files, for good.');
    expect(text).toContain("The Sweep would purge it at 2026-11-24T00:00:00.000Z.");
    expect(text).toContain("Applies at once; it cannot be undone.");
    const page = renderChangePage(
      { id: "chg_x", entity: "workspaces", expectedRevision: 0, tool: "purge_workspace", args: PURGE, hash: "h", tier: "asked", shown: view, mode: "card", caller: { door: "own", key: "t", principal: "agent", thread: "t", agent: "piDurable" }, createdAt: 0, expiresAt: 1, state: "applied" },
      { csrf: "tok", now: 0 },
    );
    expect(page).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(page).toContain("<li><code>.wt/acme/feat-a</code> unreferenced</li>");
    expect(page).toContain("Sessions destroyed</dt><dd>2</dd>");
    expect(page).not.toContain("settings at 0");
  });
});
