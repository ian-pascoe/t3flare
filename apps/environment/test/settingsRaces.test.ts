// @effect-diagnostics globalDate:off globalTimers:off
// Races around an Open change (ADR-0035, plan D8, D9, D12), SPI-1200 spec review:
// - a decline, Stop, cancel or timeout landing while another answer is applying the change waits for that outcome, never
//   reporting a failure it did not have (`closeOrSettle`), for an own agent's card, an Owner client's retry and `resume`;
// - a Stop closes the change before it withdraws the card;
// - a 2026 retry is refused naming the panel when the server is off (plan D2);
// - an Open change whose tool the owner hid since it opened applies nothing, on either door, naming the panel;
// - the call-stop registry: reads never register, a second registration under a running id shares it and never aborts
//   the first, and a stop that arrives before its call registers is remembered briefly and boundedly.
import { applyMcpChange } from "@t3flare/harness-registry";
import type { McpAsker } from "@t3flare/session-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EARLY_STOP_MS, EARLY_STOPS_MAX, forgetEarlyStopsForTests, stopCall, stoppableCall, withCallStop } from "../src/mcp/callStops.ts";
import { answerOpenChange, APPLYING_WAIT_MS, closeOrSettle, OWN_APPLYING_WAIT_MS, waitingOn } from "../src/settings/openChanges.ts";
import { REQUEST_BUDGET_MS } from "../src/skills/api.ts";
import { answerDepsOf, ownerOutcome } from "../src/settings/server.ts";
import { ASKED, bodyOf, endpointOf, modern, setAccess, structuredOf, SUB } from "./settingsEndpointFixture.ts";
import { settingsFixture, type SettingsFixture, structured, textOf, until } from "./settingsFixture.ts";

let fixture: SettingsFixture | undefined;
const world = (options: Parameters<typeof settingsFixture>[0] = {}) => (fixture = settingsFixture(options));
afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
  forgetEarlyStopsForTests();
  vi.useRealTimers();
});

const never = () => new Promise<never>(() => undefined);

/**
 * Starts the page's approval of `id` with an apply held until `release` (it answers revision 7): the change is
 * `applying` until then, whatever the caller awaits meanwhile.
 */
const approveOnPage = (f: SettingsFixture, id: string) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const deps = { ...answerDepsOf(f.deps), apply: async () => (await gate, { ok: true as const, revision: 7 }) };
  const pending = answerOpenChange(deps, id, { by: "page", answerer: { kind: "owner", subject: "owner-sub" }, action: "approve" });
  expect(f.deps.changes.get(id)?.state).toBe("applying");
  return { pending, release };
};

/**
 * Releases a held apply once `call` waits on change `id`'s outcome (`waiters` callers wait then, the call's own included),
 * then answers `call`'s result.
 */
const releasedAfter = async <T>(call: Promise<T>, release: () => void, id: string, waiters = 1): Promise<T> => {
  await until(() => waitingOn(id) >= waiters);
  release();
  return call;
};

describe("an answer applying meanwhile is waited for", () => {
  it("closeOrSettle waits for the applying answer's outcome, and gives up after its bound with the state as it is", async () => {
    const f = world({ answer: never });
    void f.call(f.durable(), "change_environment", ASKED);
    await until(() => f.cards.length === 1);
    const [record] = f.deps.changes.open();
    const { pending: applying, release } = approveOnPage(f, record!.id);
    expect(await releasedAfter(closeOrSettle(answerDepsOf(f.deps), record!.id, "withdrawn", "stop"), release, record!.id)).toMatchObject({ state: "applied", by: "page", revision: 7 });
    await applying;
    // Forced to applying with nothing to finish it: the wait is bounded.
    const other = { ...record!, id: `${record!.id.slice(0, -1)}X`, hash: "other", state: "applying" as const };
    f.deps.changes.insert(other);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const giving = closeOrSettle(answerDepsOf(f.deps), other.id, "withdrawn", "stop", { waitMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    const gaveUp = await giving;
    vi.useRealTimers();
    expect(gaveUp).toMatchObject({ state: "applying" });
    // That is an outcome not known yet, never "the change failed" (SPI-1201 review).
    const answer = ownerOutcome(gaveUp!, other);
    expect(answer).toMatchObject({ kind: "result", isError: false, structured: { status: "waiting", changeId: other.id } });
    expect(answer.kind === "result" ? answer.text : "").toContain("an answer is applying this change now");
    expect(answer.kind === "result" ? answer.text : "").not.toContain("failed");
  });

  it("an own agent's close waits at least as long as the longest apply (a skills install within its request budget)", () => {
    expect(OWN_APPLYING_WAIT_MS).toBeGreaterThan(REQUEST_BUDGET_MS);
    expect(APPLYING_WAIT_MS).toBeLessThan(60_000);
  });

  it("an own agent's Stop while the page's approval applies answers applied", async () => {
    const f = world({ answer: never });
    const stop = new AbortController();
    const pending = f.call(f.durable(), "change_environment", ASKED, { signal: stop.signal });
    await until(() => f.cards.length === 1);
    const [record] = f.deps.changes.open();
    const { pending: applying, release } = approveOnPage(f, record!.id);
    stop.abort();
    // The call's own card wait, and the Stop's wait for the applying answer.
    expect(structured(await releasedAfter(pending, release, record!.id, 2))).toMatchObject({ status: "applied", revision: 7 });
    await applying;
  });

  it("an Owner client's 2026 decline retry while the page's approval applies answers applied", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const first = await bodyOf(await endpoint(modern("tools/call", { name: "change_environment", arguments: ASKED })));
    const [record] = f.deps.changes.open();
    const { pending: applying, release } = approveOnPage(f, record!.id);
    const retry = modern("tools/call", { name: "change_environment", arguments: ASKED, requestState: first.result?.requestState, inputResponses: { change: { action: "decline" } } }, { id: 2 });
    expect(await structuredOf(await releasedAfter(endpoint(retry), release, record!.id))).toMatchObject({ status: "applied", revision: 7 });
    await applying;
  });

  it("resume's cancel while the page's approval applies answers applied", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    await endpoint(modern("tools/call", { name: "change_environment", arguments: ASKED }, { query: "?elicitation_mode=model" }));
    const [record] = f.deps.changes.open();
    const { pending: applying, release } = approveOnPage(f, record!.id);
    const resume = modern("tools/call", { name: "resume", arguments: { requestId: record!.id, response: { action: "cancel" } } }, { query: "?elicitation_mode=model", id: 3 });
    expect(await structuredOf(await releasedAfter(endpoint(resume), release, record!.id))).toMatchObject({ status: "applied", revision: 7 });
    await applying;
  });
});

describe("a Stop closes the change before the card", () => {
  it("the card is withdrawn only after the change is closed by stop", async () => {
    const f = world();
    const states: Array<string | undefined> = [];
    let id: string | undefined;
    const asker: McpAsker = {
      ask: async () => never(),
      withdraw: () => void states.push(id === undefined ? undefined : f.deps.changes.get(id)?.state),
    };
    const stop = new AbortController();
    const pending = f.call(f.durable(), "change_environment", ASKED, { signal: stop.signal, asker });
    await until(() => f.deps.changes.open().length === 1);
    id = f.deps.changes.open()[0]!.id;
    stop.abort();
    expect(structured(await pending)).toMatchObject({ status: "withdrawn" });
    expect(states).toEqual(["withdrawn"]);
  });
});

describe("the access switch on a 2026 retry (plan D2)", () => {
  it.each([
    [{ enabled: false }, "Harness panel"],
    [{ writes: false }, "read-only"],
  ] as const)("%o: the retry is refused naming the panel, and the change stays as it was", async (access, words) => {
    const f = world();
    const endpoint = endpointOf(f);
    const first = await bodyOf(await endpoint(modern("tools/call", { name: "change_environment", arguments: ASKED }, { query: "?elicitation_mode=native" })));
    const [record] = f.deps.changes.open();
    setAccess(f, access);
    const retry = await bodyOf(
      await endpoint(
        modern("tools/call", { name: "change_environment", arguments: ASKED, requestState: first.result?.requestState, inputResponses: { change: { action: "accept" } } }, { query: "?elicitation_mode=native", id: 2 }),
      ),
    );
    expect(retry.result).toMatchObject({ isError: true, structuredContent: { status: "refused" } });
    expect(JSON.stringify(retry.result?.content)).toContain(words);
    expect(f.deps.changes.get(record!.id)?.state).toBe("open");
    expect(f.store.loadEnvironment().revision).toBe(0);
    expect(record!.caller.key).toBe(SUB);
  });
});

describe("a tool the owner hid after its change opened (SPI-1195 review)", () => {
  const hide = (f: SettingsFixture, change: { readonly exposure?: "hidden"; readonly toolExposure?: Readonly<Record<string, "hidden">> }) => {
    const applied = applyMcpChange(f.store.load(), { op: "server", server: "settings", ...change });
    if (!applied.ok) throw new Error(applied.error);
    f.store.save(applied.harness);
  };
  const BY_TOOL = { toolExposure: { change_environment: "hidden" } } as const;
  const BY_SERVER = { exposure: "hidden" } as const;

  it.each([
    ["its own exposure", BY_TOOL],
    ["the server's exposure", BY_SERVER],
  ] as const)("hidden by %s: an Owner client's 2026 accept retry is refused naming the panel, and nothing applies", async (_name, change) => {
    const f = world();
    const endpoint = endpointOf(f);
    const first = await bodyOf(await endpoint(modern("tools/call", { name: "change_environment", arguments: ASKED }, { query: "?elicitation_mode=native" })));
    const [record] = f.deps.changes.open();
    hide(f, change);
    const retry = await bodyOf(
      await endpoint(
        modern("tools/call", { name: "change_environment", arguments: ASKED, requestState: first.result?.requestState, inputResponses: { change: { action: "accept" } } }, { query: "?elicitation_mode=native", id: 2 }),
      ),
    );
    expect(retry.result).toMatchObject({ isError: true, structuredContent: { status: "refused" } });
    expect(JSON.stringify(retry.result?.content)).toContain("Harness panel");
    expect(f.deps.changes.get(record!.id)?.state).toBe("open");
    expect(f.store.loadEnvironment().revision).toBe(0);
  });

  it.each([
    ["its own exposure", BY_TOOL],
    ["the server's exposure", BY_SERVER],
  ] as const)("hidden by %s: the page's approval of an Owner client's change applies nothing, naming the panel", async (_name, change) => {
    const f = world();
    await endpointOf(f)(modern("tools/call", { name: "change_environment", arguments: ASKED }));
    const [record] = f.deps.changes.open();
    hide(f, change);
    const outcome = await answerOpenChange(answerDepsOf(f.deps), record!.id, { by: "page", answerer: { kind: "owner", subject: SUB }, action: "approve" });
    expect(outcome).toMatchObject({ ok: true, outcome: { state: "failed", by: "page" } });
    expect(outcome.ok ? outcome.outcome.error : "").toContain("Harness panel");
    expect(f.store.loadEnvironment().revision).toBe(0);
  });

  it.each([
    ["its own exposure", BY_TOOL],
    ["the server's exposure", BY_SERVER],
  ] as const)("hidden by %s: an own agent's change approved on its card afterwards applies nothing, naming the panel", async (_name, change) => {
    let f!: SettingsFixture;
    f = world({
      answer: async () => {
        hide(f, change);
        return { decision: "accept" };
      },
    });
    const answer = await f.call(f.durable(), "change_environment", ASKED);
    expect(structured(answer)).toMatchObject({ status: "refused" });
    expect(textOf(answer)).toContain("Harness panel");
    expect(f.store.loadEnvironment().revision).toBe(0);
  });
});

describe("the call-stop registry (mcp/callStops.ts)", () => {
  const recordingHost = () => {
    const signals: Array<AbortSignal | undefined> = [];
    return { signals, host: { call: async (input: { readonly signal?: AbortSignal }) => (signals.push(input.signal), { kind: "result" as const, isError: false, text: "ok" }) } };
  };

  it("registers writes only", async () => {
    const { signals, host } = recordingHost();
    await stoppableCall(host)({ server: "settings", tool: "get_settings", args: {}, judged: "read", stopId: "read-1" });
    await stoppableCall(host)({ server: "settings", tool: "change_environment", args: {}, judged: "write", stopId: "write-1" });
    expect(signals[0]).toBeUndefined();
    expect(signals[1]).toBeInstanceOf(AbortSignal);
  });

  it("a second registration under a running id shares its signal and never aborts the first", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const seen: Array<AbortSignal | undefined> = [];
    const first = withCallStop("dup-1", async (signal) => (seen.push(signal), await held));
    const second = withCallStop("dup-1", async (signal) => (seen.push(signal), await held));
    expect(seen[0]?.aborted).toBe(false);
    expect(seen[1]).toBe(seen[0]);
    stopCall("dup-1");
    expect(seen[0]?.aborted).toBe(true);
    release();
    await Promise.all([first, second]);
    // Both ended: the id is free, and the stop that aborted them is not carried to the next call under it.
    expect(await withCallStop("dup-1", async (signal) => signal?.aborted)).toBe(false);
  });

  it("a stop before the call registers is remembered for EARLY_STOP_MS, then forgotten; at most EARLY_STOPS_MAX are kept", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    stopCall("early-1");
    expect(await withCallStop("early-1", async (signal) => signal?.aborted)).toBe(true);
    // Used once: a later call under it starts unstopped.
    expect(await withCallStop("early-1", async (signal) => signal?.aborted)).toBe(false);
    stopCall("early-2");
    vi.setSystemTime(1_000_000 + EARLY_STOP_MS + 1);
    expect(await withCallStop("early-2", async (signal) => signal?.aborted)).toBe(false);
    for (let index = 0; index <= EARLY_STOPS_MAX; index++) stopCall(`bounded-${index}`);
    expect(await withCallStop("bounded-0", async (signal) => signal?.aborted)).toBe(false);
    expect(await withCallStop(`bounded-${EARLY_STOPS_MAX}`, async (signal) => signal?.aborted)).toBe(true);
  });
});
