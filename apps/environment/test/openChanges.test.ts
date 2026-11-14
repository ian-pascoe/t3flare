// @effect-diagnostics globalDate:off
// T-open (plan §5; ADR-0034, plan D8, D16), M4 (SPI-1199): the Open change. Single use; expiry at 10 minutes and lazy
// pruning two hours after closing (`CLOSED_KEPT_MS`); D8's answerer table, a wrong `sub`; a moved revision; two changes against one
// revision; the record surviving an Environment reset; a skill whose digest changed at apply; every cap of D16, and that
// a dropped stream or an expiry is not a strike for an Owner client.
import { afterEach, describe, expect, it } from "vitest";

import {
  APPLIED_CAP,
  CHANGE_TTL_MS,
  type ChangeCaller,
  type ChangeRecord,
  CLOSED_KEPT_MS,
  NETWORK_READ_CAP,
  newChangeId,
  settingsChanges,
  STRIKE_LOCK_MS,
  STRIKE_WINDOW_MS,
} from "../src/settings/changes.ts";
import {
  type AnswerDeps,
  answerOpenChange,
  capRefusal,
  closeOpenChange,
  DECLINED_REPEAT_MS,
  OPEN_ACROSS,
  OPEN_PER_OWNER,
  waitForChange,
} from "../src/settings/openChanges.ts";
import { answerDepsOf, changesApiOf, settingsOwnerCall } from "../src/settings/server.ts";
import { QUESTION_WAIT_MS } from "../src/mcp/host.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";
import { NOW, settingsFixture, type SettingsFixture, until } from "./settingsFixture.ts";
import { skillMd } from "./skillRepo.fixture.ts";

const OWN: ChangeCaller = { door: "own", key: "thread-1", principal: "agent", thread: "thread-1", agent: "piDurable" };
const OWNER: ChangeCaller = { door: "owner", key: "sub-1", principal: "owner", client: { name: "Claude Code", source: "clientInfo" } };
const TOKEN: ChangeCaller = { door: "owner", key: "service-token", principal: "service-token" };

/** A unit world: the table over Node's SQLite, a revision, and an apply that records its calls. */
const world = () => {
  let now = NOW;
  let revision = 4;
  const sql = nodeSqlStorage();
  const applied: Array<{ id: string; by: string; secret?: string }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const deps = (): AnswerDeps => ({
    changes: settingsChanges(sql, () => now, (event) => void logs.push(event)),
    now: () => now,
    revisionOf: () => revision,
    apply: async (record, input) => {
      applied.push({ id: record.id, by: input.by, ...(input.secret === undefined ? {} : { secret: input.secret }) });
      // A real apply is asynchronous: give a second answer the chance to arrive while it runs.
      await new Promise((resolve) => setTimeout(resolve, 1));
      revision += 1;
      return { ok: true, revision };
    },
  });
  const open = (caller: ChangeCaller, extra: Partial<ChangeRecord> = {}): ChangeRecord => {
    const record: ChangeRecord = {
      id: newChangeId(),
      entity: "environment",
      expectedRevision: revision,
      tool: "change_environment",
      args: { expectedRevision: revision, settings: { containerBudget: 4 } },
      hash: extra.hash ?? "hash-a",
      tier: "asked",
      mode: caller.door === "own" ? "card" : "browser",
      caller,
      createdAt: now,
      expiresAt: now + CHANGE_TTL_MS,
      state: "open",
      ...extra,
    };
    deps().changes.insert(record);
    return record;
  };
  return { sql, deps, open, applied, logs, advance: (ms: number) => (now += ms), now: () => now, revision: () => revision, setRevision: (value: number) => (revision = value) };
};

describe("an Open change has one answer", () => {
  it("two answers at once: one applies, the other finds it closed", async () => {
    const w = world();
    const record = w.open(OWN);
    const [first, second] = await Promise.all([
      answerOpenChange(w.deps(), record.id, { by: "card", answerer: { kind: "card" }, action: "approve" }),
      answerOpenChange(w.deps(), record.id, { by: "page", answerer: { kind: "owner", subject: "owner-sub" }, action: "approve" }),
    ]);
    expect(first).toMatchObject({ ok: true, outcome: { state: "applied", revision: 5, by: "card" } });
    expect(second).toMatchObject({ ok: false, status: 409 });
    expect(w.applied).toEqual([{ id: record.id, by: "card" }]);
    // A later answer finds it closed, with its outcome.
    expect(await answerOpenChange(w.deps(), record.id, { by: "page", answerer: { kind: "owner", subject: "owner-sub" }, action: "decline" })).toMatchObject({
      ok: false,
      status: 409,
      closed: { state: "applied", revision: 5 },
    });
  });

  it("a waiter learns the outcome of whoever answered", async () => {
    const w = world();
    const record = w.open(OWN);
    const waiter = waitForChange(record.id);
    await answerOpenChange(w.deps(), record.id, { by: "page", answerer: { kind: "owner", subject: "owner-sub" }, action: "decline" });
    expect(await waiter.closed).toMatchObject({ state: "declined", by: "page" });
  });
});

describe("expiry and pruning", () => {
  it("an Open change waits as long as the MCP host's question wait", () => {
    expect(CHANGE_TTL_MS).toBe(QUESTION_WAIT_MS);
  });

  it("expires at 10 minutes, and an answer after it applies nothing", async () => {
    const w = world();
    const record = w.open(OWN);
    w.advance(CHANGE_TTL_MS - 1);
    expect(w.deps().changes.get(record.id)?.state).toBe("open");
    w.advance(1);
    expect(w.deps().changes.get(record.id)).toMatchObject({ state: "expired", closed: { at: NOW + CHANGE_TTL_MS } });
    // An expiry is a log line (plan D15), `settings-change` as a change's own end, written once, by the table that closed it.
    w.deps().changes.get(record.id);
    expect(w.logs).toEqual([{ t3flare: "settings-change", via: "mcp", door: "own", tool: "change_environment", change: record.id, tier: "asked", mode: "card", outcome: "expired", answeredBy: null }]);
    expect(await answerOpenChange(w.deps(), record.id, { by: "card", answerer: { kind: "card" }, action: "approve" })).toMatchObject({ ok: false, status: 409 });
    expect(w.applied).toEqual([]);
  });

  it("prunes a row two hours after it closed (CLOSED_KEPT_MS), lazily", () => {
    const w = world();
    const record = w.open(OWN);
    closeOpenChange(w.deps(), record.id, "withdrawn", "stop");
    w.advance(CLOSED_KEPT_MS);
    expect(w.deps().changes.get(record.id)?.state).toBe("withdrawn");
    w.advance(1);
    expect(w.deps().changes.get(record.id)).toBeUndefined();
  });

  it("survives a new store instance (an Environment reset between the ask and the answer)", async () => {
    const w = world();
    const record = w.open(OWN);
    const fresh = settingsChanges(w.sql, w.now);
    expect(fresh.get(record.id)).toMatchObject({ id: record.id, state: "open", caller: OWN });
    expect(await answerOpenChange({ ...w.deps(), changes: fresh }, record.id, { by: "page", answerer: { kind: "owner", subject: "x" }, action: "approve" })).toMatchObject({
      ok: true,
      outcome: { state: "applied" },
    });
  });
});

describe("D8's answerer table", () => {
  const owner = (subject: string) => ({ kind: "owner" as const, subject });
  it("card: only a change asked on a card", async () => {
    const w = world();
    const browser = w.open(OWNER);
    expect(await answerOpenChange(w.deps(), browser.id, { by: "card", answerer: { kind: "card" }, action: "approve" })).toMatchObject({ ok: false, status: 403 });
    const card = w.open(OWN);
    expect(await answerOpenChange(w.deps(), card.id, { by: "card", answerer: { kind: "card" }, action: "decline" })).toMatchObject({ ok: true, outcome: { state: "declined", by: "card" } });
  });

  it("page: any admitted owner for an own agent's change, never the service token", async () => {
    const w = world();
    const record = w.open(OWN);
    expect(await answerOpenChange(w.deps(), record.id, { by: "page", answerer: { kind: "service-token" }, action: "approve" })).toMatchObject({ ok: false, status: 403 });
    expect(await answerOpenChange(w.deps(), record.id, { by: "page", answerer: owner("anyone-admitted"), action: "approve" })).toMatchObject({ ok: true, outcome: { state: "applied" } });
  });

  it("page: an Owner client's change by the same sub only; a service-token change by the service token only", async () => {
    const w = world();
    const mine = w.open(OWNER);
    expect(await answerOpenChange(w.deps(), mine.id, { by: "page", answerer: owner("sub-2"), action: "approve" })).toMatchObject({ ok: false, status: 403 });
    expect(await answerOpenChange(w.deps(), mine.id, { by: "page", answerer: { kind: "service-token" }, action: "approve" })).toMatchObject({ ok: false, status: 403 });
    expect(await answerOpenChange(w.deps(), mine.id, { by: "page", answerer: owner("sub-1"), action: "approve" })).toMatchObject({ ok: true });
    const token = w.open(TOKEN, { expectedRevision: w.revision() });
    expect(await answerOpenChange(w.deps(), token.id, { by: "page", answerer: owner("sub-1"), action: "approve" })).toMatchObject({ ok: false, status: 403 });
    expect(await answerOpenChange(w.deps(), token.id, { by: "page", answerer: { kind: "service-token" }, action: "approve" })).toMatchObject({ ok: true });
  });

  it("client: native mode and the same sub; agent: model mode and the same sub", async () => {
    const w = world();
    const native = w.open(OWNER, { mode: "native" });
    expect(await answerOpenChange(w.deps(), native.id, { by: "agent", answerer: owner("sub-1"), action: "approve" })).toMatchObject({ ok: false, status: 403 });
    expect(await answerOpenChange(w.deps(), native.id, { by: "client", answerer: owner("sub-2"), action: "approve" })).toMatchObject({ ok: false, status: 403 });
    expect(await answerOpenChange(w.deps(), native.id, { by: "client", answerer: owner("sub-1"), action: "approve" })).toMatchObject({ ok: true, outcome: { by: "client" } });
    const model = w.open(OWNER, { mode: "model", expectedRevision: w.revision() });
    expect(await answerOpenChange(w.deps(), model.id, { by: "client", answerer: owner("sub-1"), action: "approve" })).toMatchObject({ ok: false, status: 403 });
    expect(await answerOpenChange(w.deps(), model.id, { by: "agent", answerer: owner("sub-1"), action: "approve" })).toMatchObject({ ok: true, outcome: { by: "agent" } });
  });

  it("a change that needs the page is approved there alone, and a secret one needs its value", async () => {
    const w = world();
    const record = w.open(OWN, { needsPage: "secret" });
    expect(await answerOpenChange(w.deps(), record.id, { by: "card", answerer: { kind: "card" }, action: "approve" })).toMatchObject({ ok: false, status: 403 });
    expect(await answerOpenChange(w.deps(), record.id, { by: "page", answerer: owner("o"), action: "approve" })).toMatchObject({ ok: false, status: 400 });
    expect(await answerOpenChange(w.deps(), record.id, { by: "page", answerer: owner("o"), action: "approve", secret: "v4lue" })).toMatchObject({ ok: true });
    expect(w.applied).toEqual([{ id: record.id, by: "page", secret: "v4lue" }]);
    // The secret is in no record.
    expect(JSON.stringify(w.deps().changes.get(record.id))).not.toContain("v4lue");
    // Anyone who may answer may decline it.
    const other = w.open(OWN, { needsPage: "oversize" });
    expect(await answerOpenChange(w.deps(), other.id, { by: "card", answerer: { kind: "card" }, action: "decline" })).toMatchObject({ ok: true, outcome: { state: "declined" } });
  });
});

describe("revisions", () => {
  it("a moved revision closes as moved and applies nothing", async () => {
    const w = world();
    const record = w.open(OWN);
    w.setRevision(9);
    expect(await answerOpenChange(w.deps(), record.id, { by: "card", answerer: { kind: "card" }, action: "approve" })).toMatchObject({ ok: true, outcome: { state: "moved", revision: 9 } });
    expect(w.applied).toEqual([]);
  });

  it("two changes open against one revision: the first accept applies, the second is moved", async () => {
    const w = world();
    const first = w.open(OWN);
    const second = w.open({ ...OWN, key: "thread-2", thread: "thread-2" });
    expect(await answerOpenChange(w.deps(), first.id, { by: "card", answerer: { kind: "card" }, action: "approve" })).toMatchObject({ ok: true, outcome: { state: "applied" } });
    expect(await answerOpenChange(w.deps(), second.id, { by: "card", answerer: { kind: "card" }, action: "approve" })).toMatchObject({ ok: true, outcome: { state: "moved" } });
    expect(w.applied.map((each) => each.id)).toEqual([first.id]);
  });
});

describe("D16's caps", () => {
  it("one open per own-agent thread, naming it; two per Owner sub", () => {
    const w = world();
    const record = w.open(OWN);
    expect(capRefusal(w.deps().changes, OWN, "hash-b", w.now())).toMatchObject({ reason: "open-thread", changeId: record.id });
    for (let index = 0; index < OPEN_PER_OWNER; index++) {
      expect(capRefusal(w.deps().changes, OWNER, `hash-${index}`, w.now())).toBeUndefined();
      w.open(OWNER, { hash: `hash-${index}` });
    }
    expect(capRefusal(w.deps().changes, OWNER, "hash-z", w.now())).toMatchObject({ reason: "open-owner" });
  });

  it(`at most ${OPEN_ACROSS} across the Environment, naming the panel's list; the 17th child is refused`, () => {
    const w = world();
    for (let index = 0; index < OPEN_ACROSS; index++) w.open({ ...OWN, key: `child-${index}`, thread: `child-${index}` });
    const refusal = capRefusal(w.deps().changes, { ...OWN, key: "child-16", thread: "child-16" }, "hash-a", w.now(), "https://h/_t3flare/harness#changes");
    expect(refusal).toMatchObject({ reason: "open-across" });
    expect(refusal!.text).toContain("https://h/_t3flare/harness#changes");
  });

  it("the same change after a decline is refused for 10 minutes", async () => {
    const w = world();
    const record = w.open(OWN);
    await answerOpenChange(w.deps(), record.id, { by: "card", answerer: { kind: "card" }, action: "decline" });
    expect(capRefusal(w.deps().changes, OWN, "hash-a", w.now())).toMatchObject({ reason: "declined-repeat" });
    expect(capRefusal(w.deps().changes, OWN, "hash-other", w.now())).toBeUndefined();
    w.advance(DECLINED_REPEAT_MS + 1);
    expect(capRefusal(w.deps().changes, OWN, "hash-a", w.now())).toBeUndefined();
  });

  it("three declined or unanswered in a row lock an own agent out for an hour; an applied one breaks the run", async () => {
    const w = world();
    const strike = async (index: number, how: "decline" | "expire") => {
      const record = w.open(OWN, { hash: `hash-${index}` });
      if (how === "decline") await answerOpenChange(w.deps(), record.id, { by: "card", answerer: { kind: "card" }, action: "decline" });
      else w.advance(CHANGE_TTL_MS);
      w.advance(1_000);
    };
    await strike(1, "decline");
    await strike(2, "expire");
    expect(capRefusal(w.deps().changes, OWN, "hash-9", w.now())).toBeUndefined();
    await strike(3, "decline");
    expect(capRefusal(w.deps().changes, OWN, "hash-9", w.now())).toMatchObject({ reason: "strikes" });
    // Another caller is not locked.
    expect(capRefusal(w.deps().changes, { ...OWN, key: "thread-9", thread: "thread-9" }, "hash-9", w.now())).toBeUndefined();
    w.advance(STRIKE_LOCK_MS);
    expect(capRefusal(w.deps().changes, OWN, "hash-9", w.now())).toBeUndefined();
    // Two strikes, an applied change, one strike: no run of three.
    const fresh = world();
    for (const [index, how] of [
      [1, "decline"],
      [2, "decline"],
    ] as const) {
      const record = fresh.open(OWN, { hash: `hash-${index}` });
      await answerOpenChange(fresh.deps(), record.id, { by: "card", answerer: { kind: "card" }, action: how });
      fresh.advance(1_000);
    }
    const applied = fresh.open(OWN, { hash: "hash-ok" });
    await answerOpenChange(fresh.deps(), applied.id, { by: "card", answerer: { kind: "card" }, action: "approve" });
    fresh.advance(1_000);
    const last = fresh.open(OWN, { hash: "hash-3", expectedRevision: fresh.revision() });
    await answerOpenChange(fresh.deps(), last.id, { by: "card", answerer: { kind: "card" }, action: "decline" });
    expect(capRefusal(fresh.deps().changes, OWN, "hash-9", fresh.now())).toBeUndefined();
  });

  it("for an Owner client, only declines strike: a dropped stream (withdrawn) or an expiry is not a strike", async () => {
    const w = world();
    for (let index = 0; index < 3; index++) {
      const record = w.open(OWNER, { hash: `w-${index}` });
      closeOpenChange(w.deps(), record.id, "withdrawn");
      const expiring = w.open(OWNER, { hash: `e-${index}` });
      w.advance(CHANGE_TTL_MS);
      expect(w.deps().changes.get(expiring.id)?.state).toBe("expired");
    }
    expect(capRefusal(w.deps().changes, OWNER, "hash-9", w.now())).toBeUndefined();
    for (let index = 0; index < 3; index++) {
      const record = w.open(OWNER, { hash: `d-${index}` });
      await answerOpenChange(w.deps(), record.id, { by: "page", answerer: { kind: "owner", subject: "sub-1" }, action: "decline" });
    }
    expect(capRefusal(w.deps().changes, OWNER, "hash-9", w.now())).toMatchObject({ reason: "strikes" });
  });

  it(`${APPLIED_CAP} applied changes of any tier per caller per hour`, () => {
    const w = world();
    const changes = w.deps().changes;
    for (let index = 0; index < APPLIED_CAP; index++) {
      changes.recordApplied({ id: newChangeId(), entity: "harness", tool: "change_extension", args: {}, hash: `h${index}`, tier: index % 2 === 0 ? "free" : "asked", caller: OWN, createdAt: w.now(), state: "applied", closed: { at: w.now() } });
    }
    expect(capRefusal(changes, OWN, "hash-a", w.now())).toMatchObject({ reason: "applied-cap" });
    w.advance(60 * 60_000 + 1);
    expect(capRefusal(changes, OWN, "hash-a", w.now())).toBeUndefined();
  });
});

describe("through the Settings server", () => {
  let fixture: SettingsFixture | undefined;
  afterEach(() => fixture?.dispose());

  it("a skill install keeps each skill's digest at ask time, and one that differs at apply is refused", async () => {
    let release: (() => void) | undefined;
    fixture = settingsFixture({ answer: () => new Promise((resolve) => (release = () => resolve({ decision: "accept" }))) });
    const run = fixture;
    const commit = run.github.push("o/r", { "skills/a/SKILL.md": skillMd("a", "Do <b>a</b>."), "skills/a/x.md": "x" });
    const pending = run.call(run.durable(), "change_skills", { expectedRevision: 0, op: "install", source: "o/r", commit, folders: ["skills/a"] });
    await until(() => run.cards.length === 1);
    const [record] = run.deps.changes.open();
    const item = record!.shown!.items[0]!;
    expect(item).toMatchObject({ kind: "skills", op: "install", commit, skills: [{ name: "a", path: "skills/a", files: 2, skillMd: skillMd("a", "Do <b>a</b>."), paths: ["SKILL.md", "x.md"] }] });
    // The files at the commit differ from what the owner was shown: the apply refuses them and keeps nothing.
    if (item.kind !== "skills") throw new Error("not a skills item");
    const tampered: ChangeRecord = { ...record!, shown: { ...record!.shown!, items: [{ ...item, skills: [{ ...item.skills[0]!, digest: "0".repeat(64) }] }] } };
    expect(run.deps.changes.replace(record!.id, ["open"], tampered)).toBe(true);
    // The card offers only "Opened it" for an install (its SKILL.md text is on the page alone): the page approves it.
    release!();
    await changesApiOf(run.deps).answer(record!.id, { answerer: { kind: "owner", subject: "owner-sub" }, action: "approve" });
    const answer = await pending;
    expect(answer).toMatchObject({ kind: "result", isError: true, structured: { status: "refused" } });
    expect(answer.kind === "result" ? answer.text : "").toContain("differ from what the owner was shown");
    expect(run.skills.store.list()).toEqual([]);
    expect(run.deps.changes.get(record!.id)?.state).toBe("failed");
  });

  it("a skill install is approved on the page alone, its card offering only \"Opened it\", and the page's approval keeps it", async () => {
    fixture = settingsFixture();
    const run = fixture;
    const commit = run.github.push("o/r", { "skills/a/SKILL.md": skillMd("a") });
    const pending = run.call(run.durable(), "change_skills", { expectedRevision: 0, op: "install", source: "o/r", commit, folders: ["skills/a"] });
    await until(() => run.cards.length === 1);
    expect(run.cards[0]!.options?.map((option) => option.label)).toEqual(["Opened it", "Decline", "Cancel"]);
    expect(run.cards[0]!.prompt).toContain("SKILL.md text and files are shown on the Change page");
    const [record] = run.deps.changes.open();
    expect(record?.needsPage).toBe("skills");
    expect(await answerOpenChange(answerDepsOf(run.deps), record!.id, { by: "card", answerer: { kind: "card" }, action: "approve" })).toMatchObject({ ok: false, status: 403 });
    await changesApiOf(run.deps).answer(record!.id, { answerer: { kind: "owner", subject: "owner-sub" }, action: "approve" });
    const answer = await pending;
    expect(answer).toMatchObject({ kind: "result", isError: false, structured: { status: "applied", revision: 1 } });
    expect(run.skills.store.list().map((skill) => skill.name)).toEqual(["a"]);
  });

  it("a second asked call on the same thread is refused while one is open, naming it", async () => {
    fixture = settingsFixture({ answer: () => new Promise(() => undefined) });
    const run = fixture;
    void run.call(run.durable(), "change_environment", { expectedRevision: 0, settings: { containerBudget: 4 } });
    await until(() => run.cards.length === 1);
    const [record] = run.deps.changes.open();
    const second = await run.call(run.durable(), "change_environment", { expectedRevision: 0, settings: { containerSize: "standard-3" } });
    expect(second).toMatchObject({ kind: "result", isError: true, structured: { status: "refused", reason: "open-thread", changeId: record!.id } });
    expect(run.cards.length).toBe(1);
    const status = await run.call(run.durable(), "get_status");
    expect(status.kind === "result" ? status.structured : undefined).toMatchObject({ openChanges: [{ changeId: record!.id, url: `${"https://t3.example.dev/_t3flare/harness"}/changes/${record!.id}`, tool: "change_environment" }] });
  });
});

describe("D16's caps under parallel calls (SPI-1199 review)", () => {
  let fixture: SettingsFixture | undefined;
  afterEach(() => fixture?.dispose());

  it("parallel skill installs on one thread open one change; the others are refused naming it", async () => {
    fixture = settingsFixture({ answer: () => new Promise(() => undefined) });
    const run = fixture;
    const commit = run.github.push("o/r", { "skills/a/SKILL.md": skillMd("a"), "skills/b/SKILL.md": skillMd("b"), "skills/c/SKILL.md": skillMd("c") });
    const caller = run.durable();
    const calls = ["skills/a", "skills/b", "skills/c"].map((folder) => run.call(caller, "change_skills", { expectedRevision: 0, op: "install", source: "o/r", commit, folders: [folder] }));
    // Two of the three answer at once, refused; the third waits on its card.
    const refused: Array<unknown> = [];
    for (const each of calls) void each.then((answer) => refused.push(answer));
    await until(() => refused.length === 2 && run.cards.length === 1);
    const open = run.deps.changes.open();
    expect(open).toHaveLength(1);
    for (const each of refused) expect(each).toMatchObject({ kind: "result", structured: { status: "refused", reason: "open-thread", changeId: open[0]!.id } });
  });

  it("parallel asked calls of one Owner sub open at most two", async () => {
    fixture = settingsFixture();
    const run = fixture;
    const commit = run.github.push("o/r", { "skills/a/SKILL.md": skillMd("a"), "skills/b/SKILL.md": skillMd("b"), "skills/c/SKILL.md": skillMd("c"), "skills/d/SKILL.md": skillMd("d") });
    const answers = await Promise.all(
      ["skills/a", "skills/b", "skills/c", "skills/d"].map((folder) =>
        settingsOwnerCall(run.deps, { tool: "change_skills", args: { expectedRevision: 0, op: "install", source: "o/r", commit, folders: [folder] }, caller: { door: "owner", kind: "owner", key: "sub-1" }, mode: "browser" }),
      ),
    );
    expect(answers.filter((each) => each.kind === "open")).toHaveLength(OPEN_PER_OWNER);
    expect(run.deps.changes.open()).toHaveLength(OPEN_PER_OWNER);
    for (const each of answers.filter((answer) => answer.kind === "result")) expect(each).toMatchObject({ answer: { structured: { status: "refused", reason: "open-owner" } } });
  });
});

describe("SPI-1199 review: the strike lock, the declined-repeat hash, a skill preview's GitHub read", () => {
  let fixture: SettingsFixture | undefined;
  afterEach(() => fixture?.dispose());

  it("the strike lock runs an hour from the third strike, not the first", async () => {
    const w = world();
    const decline = async (hash: string) => {
      const record = w.open(OWN, { hash });
      await answerOpenChange(w.deps(), record.id, { by: "card", answerer: { kind: "card" }, action: "decline" });
    };
    await decline("s-1");
    w.advance(50 * 60_000);
    await decline("s-2");
    w.advance(5 * 60_000);
    await decline("s-3");
    const third = w.now();
    // An hour after the first strike, the lock still holds: it runs from the third.
    w.advance(15 * 60_000);
    expect(capRefusal(w.deps().changes, OWN, "hash-9", w.now())).toMatchObject({ reason: "strikes" });
    w.advance(third + STRIKE_LOCK_MS - 1 - w.now());
    expect(capRefusal(w.deps().changes, OWN, "hash-9", w.now())).toMatchObject({ reason: "strikes" });
    w.advance(1);
    expect(capRefusal(w.deps().changes, OWN, "hash-9", w.now())).toBeUndefined();
  });

  it("three strikes spread over more than the run's window lock nothing", async () => {
    const w = world();
    for (const hash of ["s-1", "s-2", "s-3"]) {
      const record = w.open(OWN, { hash });
      await answerOpenChange(w.deps(), record.id, { by: "card", answerer: { kind: "card" }, action: "decline" });
      w.advance(STRIKE_WINDOW_MS / 2 + 60_000);
    }
    expect(capRefusal(w.deps().changes, OWN, "hash-9", w.now())).toBeUndefined();
  });

  it("a declined change asked again with junk keys added is still the same change", async () => {
    fixture = settingsFixture({ answer: { decision: "decline" } });
    const run = fixture;
    expect(await run.call(run.durable(), "change_environment", { expectedRevision: 0, settings: { containerBudget: 4 } })).toMatchObject({ structured: { status: "declined" } });
    const again = await run.call(run.durable(), "change_environment", { expectedRevision: 0, settings: { containerBudget: 4 }, junk: 1, also: "x" });
    expect(again).toMatchObject({ structured: { status: "refused", reason: "declined-repeat" } });
    const mcp = await run.call(run.durable("thread-2"), "change_mcp", { expectedRevision: 0, change: { op: "add", server: "x", url: "https://x.example/mcp", auth: { kind: "none" } } });
    expect(mcp).toMatchObject({ structured: { status: "declined" } });
    const junked = await run.call(run.durable("thread-2"), "change_mcp", { expectedRevision: 0, change: { op: "add", server: "x", url: "https://x.example/mcp", auth: { kind: "none", extra: true }, note: "please" } });
    expect(junked).toMatchObject({ structured: { status: "refused", reason: "declined-repeat" } });
  });

  it("an install's preview counts toward the GitHub read cap, and past it is refused before reaching GitHub", async () => {
    fixture = settingsFixture({ answer: { decision: "decline" } });
    const run = fixture;
    const commit = run.github.push("o/r", { "skills/a/SKILL.md": skillMd("a") });
    await run.call(run.durable(), "change_skills", { expectedRevision: 0, op: "install", source: "o/r", commit, folders: ["skills/missing"] });
    expect(run.deps.changes.readsSince("thread-d", "network", 0)).toBe(1);
    for (let index = 1; index < NETWORK_READ_CAP; index++) run.deps.changes.noteRead("thread-d", "network", run.now());
    const refused = await run.call(run.durable(), "change_skills", { expectedRevision: 0, op: "install", source: "o/r", commit, folders: ["skills/a"] });
    expect(refused).toMatchObject({ structured: { status: "refused" } });
    expect(JSON.stringify(refused)).toContain(`${NETWORK_READ_CAP} reads that reach GitHub`);
    expect(run.deps.changes.open()).toEqual([]);
  });
});
