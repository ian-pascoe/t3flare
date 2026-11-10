// The host's pure parts: the boot record and safe mode, the redacting Console, and the idle queries over
// t3's tables (on Node's SQLite).
import { describe, expect, it } from "vitest";

import * as BootState from "../src/host/bootState.ts";
import * as Idle from "../src/host/idle.ts";
import { redact, redactingConsole, redactions } from "../src/host/redactingConsole.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const memoryKv = (): BootState.KeyValue => {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      map.set(key, structuredClone(value));
    },
    delete: async (key: string) => map.delete(key),
  };
};

describe("boot record and safe mode", () => {
  const now = new Date("2026-11-10T12:00:00Z");

  it("enters safe mode after three boots in a row fail, and leaves it by hand", async () => {
    const kv = memoryKv();
    for (let i = 0; i < BootState.SAFE_MODE_AFTER_FAILURES; i++) {
      const decision = await BootState.beginBoot(kv, now);
      expect(decision.start).toBe(true);
      await BootState.bootFailed(kv, new Error(`boom ${i}`));
    }
    const refused = await BootState.beginBoot(kv, now);
    expect(refused).toEqual({ start: false, safeMode: { on: true, reason: "boot-failures", since: now.toISOString() } });
    expect((await BootState.readBootRecord(kv)).lastError).toBe("Error: boom 2");

    await BootState.setSafeMode(kv, false, null, now);
    expect((await BootState.readBootRecord(kv)).consecutiveFailures).toBe(0);
    expect((await BootState.beginBoot(kv, now)).start).toBe(true);
  });

  it("counts a boot that never reports back as failed, and a success resets the run", async () => {
    const kv = memoryKv();
    await BootState.beginBoot(kv, now);
    await BootState.beginBoot(kv, now);
    expect((await BootState.readBootRecord(kv)).consecutiveFailures).toBe(2);
    await BootState.bootSucceeded(kv, now);
    expect(await BootState.readBootRecord(kv)).toMatchObject({ boots: 2, consecutiveFailures: 0, lastSucceededAt: now.toISOString() });
  });

  it("manual safe mode refuses boots until turned off", async () => {
    const kv = memoryKv();
    await BootState.setSafeMode(kv, true, "manual", now);
    expect(await BootState.beginBoot(kv, now)).toMatchObject({ start: false, safeMode: { reason: "manual" } });
  });

  it("injected failures are taken one at a time", async () => {
    const kv = memoryKv();
    await BootState.injectBootFailures(kv, 2);
    expect(await BootState.takeInjectedFailure(kv)).toBe(true);
    expect(await BootState.takeInjectedFailure(kv)).toBe(true);
    expect(await BootState.takeInjectedFailure(kv)).toBe(false);
  });
});

describe("redacting Console", () => {
  it("drops t3's pairing-URL line and redacts credentials", () => {
    const lines: Array<Array<unknown>> = [];
    const target = { log: (...args: Array<unknown>) => lines.push(args), error: (...args: Array<unknown>) => lines.push(args) } as unknown as Console;
    const console = redactingConsole(target);
    const before = redactions.droppedPairingLines;
    console.log("  pairingUrl: http://localhost:443/pair#token=ABCDEFGH1234");
    console.log("Authentication required. Open T3 Code using the pairing URL.");
    console.error({ url: "https://x/pair?token=SECRET123&next=1", auth: "Bearer abcdefghijklmnop" });
    expect(redactions.droppedPairingLines).toBe(before + 1);
    expect(lines[0]).toEqual(["Authentication required. Open T3 Code using the pairing URL."]);
    expect(String(lines[1]![0])).not.toContain("SECRET123");
    expect(String(lines[1]![0])).not.toContain("abcdefghijklmnop");
    expect(redact("see #token=abc and &credential=def")).toBe("see #token=<redacted> and &credential=<redacted>");
  });
});

describe("idle queries", () => {
  const t3Tables = () => {
    const sql = nodeSqlStorage();
    sql.exec("CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, status TEXT)");
    sql.exec("CREATE TABLE orchestration_v2_projection_provider_sessions (session_id TEXT, status TEXT)");
    sql.exec("CREATE TABLE orchestration_v2_effect_outbox (effect_id TEXT, status TEXT, available_at TEXT)");
    sql.exec("CREATE TABLE scheduled_tasks (task_id TEXT, enabled INTEGER, next_run_at TEXT)");
    return sql;
  };
  const now = new Date("2026-11-10T12:00:00.000Z");

  it("finds open runs, sessions and claimable effects", () => {
    const sql = t3Tables();
    expect(Idle.hasOpenWork(Idle.openWork(sql, now))).toBe(false);
    sql.exec("INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 'completed'), ('r2', 'waiting')");
    sql.exec("INSERT INTO orchestration_v2_effect_outbox VALUES ('e1', 'pending', '2026-11-10T11:00:00.000Z'), ('e2', 'pending', '2026-11-10T13:00:00.000Z')");
    expect(Idle.openWork(sql, now)).toEqual({ openRuns: 1, openProviderSessions: 0, claimableEffects: 1 });
  });

  it("takes the next due time from the outbox and scheduled tasks", () => {
    const sql = t3Tables();
    expect(Idle.nextDue(sql).at).toBeNull();
    sql.exec("INSERT INTO scheduled_tasks VALUES ('t1', 1, '2026-11-10T15:00:00.000Z'), ('t2', 0, '2026-11-10T13:00:00.000Z')");
    expect(Idle.nextDue(sql).at?.toISOString()).toBe("2026-11-10T15:00:00.000Z");
    sql.exec("INSERT INTO orchestration_v2_effect_outbox VALUES ('e2', 'pending', '2026-11-10T14:00:00.000Z')");
    expect(Idle.nextDue(sql).at?.toISOString()).toBe("2026-11-10T14:00:00.000Z");
  });

  it("treats tables t3 has not created as empty", () => {
    const sql = nodeSqlStorage();
    expect(Idle.openWork(sql, now)).toEqual({ openRuns: 0, openProviderSessions: 0, claimableEffects: 0 });
    expect(Idle.nextDue(sql).at).toBeNull();
  });

  it("resets only with no socket, no request and the idle delay passed", () => {
    const sql = t3Tables();
    Object.assign(Idle.activity, { sockets: 1, inFlight: 0, idleSince: now.getTime() - 120_000 });
    expect(Idle.idleVerdict(sql, now).reset).toBe(false);
    Idle.socketClosed();
    expect(Idle.activity.idleSince).not.toBe(now.getTime() - 120_000);
    Object.assign(Idle.activity, { idleSince: now.getTime() - 30_000 });
    expect(Idle.idleVerdict(sql, now)).toEqual({ reset: false, why: "not idle long enough" });
    Object.assign(Idle.activity, { idleSince: now.getTime() - 61_000 });
    expect(Idle.idleVerdict(sql, now).reset).toBe(true);
  });
});
