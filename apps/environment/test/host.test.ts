// The host's pure parts: the boot record and safe mode, the redacting Console, the idle queries over t3's
// tables (on Node's SQLite), and the Pairing window's alarm and bootstrap refusal.
import { describe, expect, it } from "vitest";

import * as BootState from "../src/host/bootState.ts";
import * as Idle from "../src/host/idle.ts";
import * as Pairing from "../src/host/pairing.ts";
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
    sql.exec("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT)");
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

  it("wakes for a usage-limit recovery, as t3's getLimitRecoveryWakeAt reads it", () => {
    const sql = t3Tables();
    const payload = (resetAt: string, autoResume: boolean) => JSON.stringify({ limitRecovery: { resetAt, autoResume } });
    sql.exec("INSERT INTO orchestration_v2_projection_threads VALUES ('a', ?, NULL), ('b', ?, NULL), ('c', ?, NULL)",
      payload("2026-11-10T12:30:00.000Z", true), payload("2026-11-10T12:10:00.000Z", false), payload("2026-11-10T11:00:00.000Z", true));
    const due = Idle.nextDue(sql, now);
    expect(due.at?.toISOString()).toBe("2026-11-10T12:30:00.000Z");
    expect(due.sources.usageLimitResets).toBe("2026-11-10T12:30:00.000Z");
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

/** A DO's storage as the Pairing window uses it: one alarm, which firing clears (ADR-0003). */
const memoryStorage = () => {
  const kv = memoryKv();
  let alarm: number | null = null;
  return {
    ...kv,
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
    /** The alarm fires: workerd clears it before `alarm()` runs. */
    fire: () => {
      alarm = null;
    },
  };
};

describe("Pairing window", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

  it("an earlier alarm that fires while the window is open leaves the window's close pending", async () => {
    const storage = memoryStorage();
    const until = await Pairing.arm(storage, 30, now);
    await Pairing.keepWindowClosing(storage);
    expect(await storage.getAlarm()).toBe(until.getTime());

    // The sweep takes the one alarm for an earlier time, and fires.
    await storage.setAlarm(minutes(5).getTime());
    storage.fire();
    expect(await Pairing.onAlarm(storage, { seeded: true }, minutes(5))).toBe("keep");
    expect(await storage.getAlarm()).toBe(until.getTime());

    // At the close, the seeded grant must go.
    storage.fire();
    expect(await Pairing.onAlarm(storage, { seeded: true }, until)).toBe("close-window");
  });

  it("keeps an earlier pending alarm, and moves a later one up to the window's close", async () => {
    const storage = memoryStorage();
    const until = await Pairing.arm(storage, 30, now);
    await storage.setAlarm(minutes(5).getTime());
    await Pairing.keepWindowClosing(storage);
    expect(await storage.getAlarm()).toBe(minutes(5).getTime());

    await storage.setAlarm(minutes(60).getTime());
    expect(await Pairing.onAlarm(storage, { seeded: true }, minutes(10))).toBe("keep");
    expect(await storage.getAlarm()).toBe(until.getTime());
  });

  it("caps the window at an hour and closes it on disarm", async () => {
    const storage = memoryStorage();
    expect(await Pairing.arm(storage, 600, now)).toEqual(minutes(Pairing.MAX_ARM_MINUTES));
    expect(await Pairing.isArmed(storage, now)).toBe(true);
    await Pairing.disarm(storage);
    expect(await Pairing.isArmed(storage, now)).toBe(false);
    expect(await Pairing.onAlarm(storage, { seeded: false }, now)).toBe("keep");
    expect(await storage.getAlarm()).toBeNull();
  });

  it("finds the bootstrap token in the parsed credential, however it is encoded", () => {
    const token = "boot-token-1";
    const presents = (body: string) => Pairing.presentsBootstrapToken(body, token);
    expect(presents(JSON.stringify({ credential: token }))).toBe(true);
    // JSON escapes dodge a substring match; t3 trims the credential it reads.
    expect(presents('{"credential":"\\u0062oot-token-1"}')).toBe(true);
    expect(presents(JSON.stringify({ credential: `  ${token}\n` }))).toBe(true);
    // The token exchange is form-encoded; percent-escapes dodge a substring match too.
    expect(presents(`grant_type=x&subject_token=${token}&client_label=laptop`)).toBe(true);
    expect(presents("subject_token=%62oot-token-1")).toBe(true);
    expect(presents(JSON.stringify({ subject_token: token }))).toBe(true);

    expect(presents(JSON.stringify({ credential: "a-pairing-token" }))).toBe(false);
    expect(presents("subject_token=a-pairing-token")).toBe(false);
    expect(presents("not a body")).toBe(false);
    expect(presents("")).toBe(false);
  });

  it("finds the bootstrap token spent as an MCP pairing code (step 3, L2), and guards the decision route", () => {
    const token = "boot-token-1";
    const decision = (code: string) =>
      JSON.stringify({ authorization: { client_id: "c", state: "s" }, decision: { _tag: "pairing-code", access: "full-access", code } });
    expect(Pairing.presentsBootstrapToken(decision(token), token)).toBe(true);
    expect(Pairing.presentsBootstrapToken(decision(` ${token} `), token)).toBe(true);
    expect(Pairing.presentsBootstrapToken(decision("ABCD2345EFGH"), token)).toBe(false);
    expect(Pairing.BOOTSTRAP_EXCHANGE_PATHS.has("/oauth/mcp/decision")).toBe(true);
    expect(Pairing.BOOTSTRAP_EXCHANGE_PATHS.has("/api/auth/browser-session")).toBe(true);
    expect(Pairing.BOOTSTRAP_EXCHANGE_PATHS.has("/oauth/token")).toBe(true);
  });
});
