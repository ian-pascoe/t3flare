// T-caller (plan §5, D3), M3 (SPI-1198): the Settings server's caller is derived by the Environment and fails closed.
// Linked work from t3's projection (a missing row is unknown, a link origin linked, a child of a linked thread linked);
// a Durable thread's modes from the adapter's record, written at `open` and `submitTurn` and cleared at unregister; and
// a write from linked, unknown or mode-less work refused while its reads run.
import { describe, expect, it } from "vitest";

import { harnessStore } from "../src/harness/store.ts";
import { McpHost } from "../src/mcp/host.ts";
import { DURABLE_AGENT, durableModeRecord, durableModes, forgetDurableModes, noteDurableModes, threadLinkIn } from "../src/provider/threadCaller.ts";
import { settingsChanges } from "../src/settings/changes.ts";
import { LINKED_REFUSAL, NO_MODES_REFUSAL, type OwnCaller, settingsCall, UNKNOWN_REFUSAL } from "../src/settings/server.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const projection = () => {
  const sql = nodeSqlStorage();
  sql.exec("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT)");
  const thread = (id: string, payload: Record<string, unknown> | string) =>
    sql.exec("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL)", id, typeof payload === "string" ? payload : JSON.stringify(payload));
  const lineage = (parent: string | null) => ({ parentThreadId: parent, relationshipToParent: parent === null ? null : "subagent", rootThreadId: parent ?? "x" });
  thread("own", { lineage: lineage(null) });
  thread("linked", { lineage: lineage(null), linkOrigin: { sessionId: "s", label: "laptop", access: "full-access" } });
  thread("malformed-origin", { lineage: lineage(null), linkOrigin: "not an origin" });
  thread("child-of-own", { lineage: lineage("own") });
  thread("child-of-linked", { lineage: lineage("linked") });
  thread("grandchild-of-linked", { lineage: lineage("child-of-linked") });
  thread("child-of-gone", { lineage: lineage("gone") });
  thread("loop-a", { lineage: lineage("loop-b") });
  thread("loop-b", { lineage: lineage("loop-a") });
  thread("not-json", "{");
  thread("parent-number", { lineage: { parentThreadId: 42 } });
  thread("parent-object", { lineage: { parentThreadId: { id: "own" } } });
  thread("parent-empty", { lineage: { parentThreadId: "" } });
  thread("parent-absent", { lineage: {} });
  return sql;
};

describe("threadLinkIn", () => {
  const sql = projection();

  it("a thread with no projection row is unknown", () => {
    expect(threadLinkIn(sql, "missing")).toBe("unknown");
    expect(threadLinkIn(nodeSqlStorage(), "own")).toBe("unknown");
  });

  it("own work is own; a link origin, well-formed or not, is linked", () => {
    expect(threadLinkIn(sql, "own")).toBe("own");
    expect(threadLinkIn(sql, "child-of-own")).toBe("own");
    expect(threadLinkIn(sql, "linked")).toBe("linked");
    expect(threadLinkIn(sql, "malformed-origin")).toBe("linked");
  });

  it("a child of a linked thread is linked even without the origin; a broken lineage is unknown", () => {
    expect(threadLinkIn(sql, "child-of-linked")).toBe("linked");
    expect(threadLinkIn(sql, "grandchild-of-linked")).toBe("linked");
    expect(threadLinkIn(sql, "child-of-gone")).toBe("unknown");
    expect(threadLinkIn(sql, "loop-a")).toBe("unknown");
    expect(threadLinkIn(sql, "not-json")).toBe("unknown");
  });

  it("a parent that is present but not a thread id reads as unknown, not as no parent (M3 review)", () => {
    expect(threadLinkIn(sql, "parent-number")).toBe("unknown");
    expect(threadLinkIn(sql, "parent-object")).toBe("unknown");
    expect(threadLinkIn(sql, "parent-empty")).toBe("unknown");
    expect(threadLinkIn(sql, "parent-absent")).toBe("own");
  });
});

describe("the Durable mode record", () => {
  it("follows open and submitTurn, and is cleared at unregister by its own session only", () => {
    const session = {};
    noteDurableModes("thread-m", { runtimeMode: "approval-required", interactionMode: "default" }, session);
    expect(durableModes("thread-m")).toEqual({ runtimeMode: "approval-required", interactionMode: "default" });
    // The next turn's modes replace the open's.
    noteDurableModes("thread-m", { runtimeMode: "full-access", interactionMode: "plan" }, session);
    expect(durableModes("thread-m")).toEqual({ runtimeMode: "full-access", interactionMode: "plan" });
    // A newer session for the thread took over: the old one's unregister leaves the new record.
    const newer = {};
    noteDurableModes("thread-m", { runtimeMode: "auto-accept-edits", interactionMode: "default" }, newer);
    forgetDurableModes("thread-m", session);
    expect(durableModes("thread-m")?.runtimeMode).toBe("auto-accept-edits");
    forgetDurableModes("thread-m", newer);
    expect(durableModes("thread-m")).toBeUndefined();
  });
});

describe("the adapter's part of the record (durableModeRecord, as makePiDurableAdapter wires it)", () => {
  it("notes each thread at open and each submitTurn, and forgets all of them, and only them, at unregister", () => {
    // As the adapter's openSession: one record per provider session; `open` (register) and `submitTurn` note; the
    // scope's finalizer (unregister) forgets.
    const first = durableModeRecord();
    first.note("thread-a", { runtimeMode: "approval-required", interactionMode: "default" });
    first.note("thread-b", { runtimeMode: "full-access", interactionMode: "default" });
    first.note("thread-a", { runtimeMode: "full-access", interactionMode: "plan" });
    expect(durableModes("thread-a")).toEqual({ runtimeMode: "full-access", interactionMode: "plan" });
    const second = durableModeRecord();
    second.note("thread-b", { runtimeMode: "auto-accept-edits", interactionMode: "default" });
    first.forgetAll();
    expect(durableModes("thread-a")).toBeUndefined();
    expect(durableModes("thread-b")).toEqual({ runtimeMode: "auto-accept-edits", interactionMode: "default" });
    second.forgetAll();
    expect(durableModes("thread-b")).toBeUndefined();
  });
});

describe("a Settings server write from a caller the Environment cannot vouch for", () => {
  const setup = () => {
    const map = new Map<string, unknown>();
    const kv = { get: <T>(key: string) => map.get(key) as T | undefined, put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)) };
    const store = harnessStore(kv);
    const sql = projection();
    const host: McpHost = new McpHost({
      kv,
      engine: undefined,
      commissary: { url: undefined, key: undefined },
      settings: () => store.load(),
      settingsServer: (input) =>
        settingsCall(
          {
            ops: { store, mcp: host, now: () => 0 },
            link: (thread) => threadLinkIn(sql, thread),
            modes: (caller) => (caller.thread === undefined ? undefined : durableModes(caller.thread)),
            changes: settingsChanges(nodeSqlStorage(), () => 0),
            origin: () => undefined,
          },
          input,
        ),
    });
    const owner = {};
    for (const thread of ["own", "linked", "child-of-linked", "missing"]) noteDurableModes(thread, { runtimeMode: "full-access", interactionMode: "default" }, owner);
    const caller = (thread: string): OwnCaller => ({ door: "own", thread, agent: DURABLE_AGENT });
    const call = (thread: string, tool: string, args: Record<string, unknown>) => host.call({ server: "settings", tool, args, caller: caller(thread) });
    return { store, call, done: () => ["own", "linked", "child-of-linked", "missing"].forEach((thread) => forgetDurableModes(thread, owner)) };
  };
  const write = { expectedRevision: 0, settings: { containerIdleMinutes: 9 } };
  const text = (answer: Awaited<ReturnType<ReturnType<typeof setup>["call"]>>) => (answer.kind === "result" ? answer.text : answer.message);

  it("linked work and its children: reads run, writes are refused", async () => {
    const run = setup();
    for (const thread of ["linked", "child-of-linked"]) {
      expect(await run.call(thread, "get_settings", { entity: "environment" })).toMatchObject({ kind: "result", isError: false });
      expect(text(await run.call(thread, "change_environment", write))).toBe(LINKED_REFUSAL);
    }
    expect(run.store.loadEnvironment().revision).toBe(0);
    run.done();
  });

  it("a thread with no projection row: its write is refused", async () => {
    const run = setup();
    expect(text(await run.call("missing", "change_environment", write))).toBe(UNKNOWN_REFUSAL);
    run.done();
  });

  it("own work with no mode record: its write is refused; with one it runs", async () => {
    const run = setup();
    run.done();
    expect(text(await run.call("own", "change_environment", write))).toBe(NO_MODES_REFUSAL);
    noteDurableModes("own", { runtimeMode: "full-access", interactionMode: "default" }, run);
    expect(await run.call("own", "change_environment", write)).toMatchObject({ kind: "result", isError: false });
    forgetDurableModes("own", run);
    expect(run.store.loadEnvironment().revision).toBe(1);
  });
});
