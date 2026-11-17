// In-app Updates (ADR-0037; in-app updates plan D6, D7, D9, D16): the target policy, the update records (press, re-press,
// refusal, run polling, expiry), the GitHub calls against a fake dispatch and runs endpoint, and the `prepareTrial`
// outcome a landed Update boots with.
import { describe, expect, it } from "vitest";

import { actionsClient, updateRepoOf, type ActionsClient, type WorkflowRun } from "../src/updates/actions.ts";
import { serverUpdateRefusal, tagOf } from "../src/updates/policy.ts";
import { QUEUED_CEILING_MS, UNLISTED_MS, UPDATE_EXPIRY_MS, UpdateRefused, updates, type PressRequest, type UpdateRecord } from "../src/updates/records.ts";
import { committedOutcome, FAILED_REPLAY_MS, failedOutcome, makeLauncherClient, readyWithOutcome } from "../src/updates/selfUpdate.ts";
import * as Effect from "effect/Effect";

const CURRENT = "0.1.11-nightly.20261117.4825";
const NEXT = "0.1.11-nightly.20261118.4830";

describe("the server Update's target policy", () => {
  it("accepts an exact nightly newer than the running one", () => {
    expect(serverUpdateRefusal({ targetVersion: NEXT }, CURRENT)).toBeUndefined();
    expect(serverUpdateRefusal({ targetVersion: "0.1.12-nightly.20261101.1" }, CURRENT)).toBeUndefined();
    expect(tagOf(NEXT)).toBe(`v${NEXT}`);
  });

  it("refuses the same or an older version, a non-nightly, a track switch and a staged update", () => {
    expect(serverUpdateRefusal({ targetVersion: CURRENT }, CURRENT)).toMatch(/not newer/);
    expect(serverUpdateRefusal({ targetVersion: "0.1.11-nightly.20261117.4824" }, CURRENT)).toMatch(/not newer/);
    expect(serverUpdateRefusal({ targetVersion: "0.1.12" }, CURRENT)).toMatch(/not an exact t3 nightly/);
    expect(serverUpdateRefusal({ targetVersion: "nightly" }, CURRENT)).toMatch(/not an exact t3 nightly/);
    expect(serverUpdateRefusal({ targetVersion: NEXT, channel: "nightly" } as never, CURRENT)).toMatch(/update tracks/);
    expect(serverUpdateRefusal({ targetVersion: NEXT, stageOnly: true }, CURRENT)).toMatch(/stage/);
  });
});

/** A fake GitHub Actions: dispatches are recorded; a dispatched run appears once listed and ends when told. */
const fakeActions = () => {
  const dispatched: Array<{ workflow: string; inputs: Readonly<Record<string, string>> }> = [];
  const runs = new Map<number, WorkflowRun & { name: string; workflow: string }>();
  let nextRun = 100;
  const client: ActionsClient = {
    dispatch: async (workflow, inputs) => {
      dispatched.push({ workflow, inputs });
    },
    findRun: async (workflow, runName) => [...runs.values()].find((run) => run.workflow === workflow && run.name === runName),
    getRun: async (id) => runs.get(id)!,
    failedStep: async () => "update / Bump (Update gate)",
  };
  return {
    client,
    dispatched,
    /** GitHub lists the run of the newest dispatch, named as its workflow names it. */
    start: (name: string, startedAt: number | null = 0) => {
      const id = nextRun++;
      const last = dispatched.at(-1)!;
      runs.set(id, { id, url: `https://github.com/o/r/actions/runs/${id}`, status: startedAt === null ? "pending" : "in_progress", conclusion: null, started: startedAt !== null, name, workflow: last.workflow });
      return id;
    },
    /** The run leaves the queue at `at`. */
    begin: (id: number) => runs.set(id, { ...runs.get(id)!, status: "in_progress", started: true }),
    end: (id: number, conclusion: string) => runs.set(id, { ...runs.get(id)!, status: "completed", conclusion }),
  };
};

const mapStore = () => {
  const map = new Map<string, unknown>();
  return { get: (key: string) => structuredClone(map.get(key)), put: (key: string, value: unknown) => void map.set(key, structuredClone(value)) };
};

const serverPress = (target: string): PressRequest => ({
  key: "t3",
  target,
  from: CURRENT,
  label: `t3@${target}`,
  workflow: "bump.yml",
  runName: (id) => `Update ${id}`,
  inputs: (id) => ({ tag: tagOf(target), land: "true", gate: "update", update_id: id }),
});

const setup = () => {
  const actions = fakeActions();
  let now = 1_000_000;
  let ids = 0;
  const store = mapStore();
  const subject = updates({ store, actions: actions.client, now: () => now, newId: () => `id-${++ids}` });
  return { actions, subject, store, advance: (ms: number) => (now += ms), now: () => now };
};

describe("the update records", () => {
  it("dispatches bump.yml with the Update's inputs and records it", async () => {
    const { actions, subject } = setup();
    const { record, attached } = await subject.press(serverPress(NEXT));
    expect(attached).toBe(false);
    expect(actions.dispatched).toEqual([{ workflow: "bump.yml", inputs: { tag: `v${NEXT}`, land: "true", gate: "update", update_id: "id-1" } }]);
    expect(record).toMatchObject({ id: "id-1", key: "t3", target: NEXT, from: CURRENT, runName: "Update id-1", run: null, outcome: null });
  });

  it("re-attaches the same target to the Update in flight, and refuses another", async () => {
    const { actions, subject } = setup();
    await subject.press(serverPress(NEXT));
    const again = await subject.press(serverPress(NEXT));
    expect(again).toMatchObject({ attached: true, record: { id: "id-1" } });
    await expect(subject.press(serverPress("0.1.11-nightly.20261119.4900"))).rejects.toBeInstanceOf(UpdateRefused);
    expect(actions.dispatched).toHaveLength(1);
  });

  it("finds the run by its name, then settles it from its conclusion", async () => {
    const { actions, subject } = setup();
    await subject.press(serverPress(NEXT));
    expect((await subject.settle("t3"))?.run).toBeNull();
    const run = actions.start("Update id-1");
    expect((await subject.settle("t3"))?.run).toEqual({ id: run, url: `https://github.com/o/r/actions/runs/${run}` });
    actions.end(run, "failure");
    const settled = await subject.settle("t3");
    expect(settled?.outcome?.status).toBe("failed");
    expect(settled?.outcome?.reason).toContain('at "update / Bump (Update gate)"');
    expect(settled?.outcome?.reason).toContain(`/actions/runs/${run}`);
  });

  it("settles a passed run as succeeded, and a later press dispatches anew", async () => {
    const { actions, subject } = setup();
    await subject.press(serverPress(NEXT));
    const run = actions.start("Update id-1");
    actions.end(run, "success");
    expect((await subject.settle("t3"))?.outcome?.status).toBe("succeeded");
    const next = await subject.press(serverPress("0.1.11-nightly.20261119.4900"));
    expect(next).toMatchObject({ attached: false, record: { id: "id-2" } });
  });

  it("expires an Update to failed 60 minutes after its run started; pressing again is the retry", async () => {
    const { actions, subject, advance, now } = setup();
    await subject.press(serverPress(NEXT));
    actions.start("Update id-1", now());
    await subject.settle("t3");
    advance(UPDATE_EXPIRY_MS - 1);
    expect((await subject.settle("t3"))?.outcome).toBeNull();
    advance(2);
    const settled = await subject.settle("t3");
    expect(settled?.outcome?.status).toBe("failed");
    expect(settled?.outcome?.reason).toMatch(/did not finish within 60 minutes of its start/);
    expect(await subject.press(serverPress(NEXT))).toMatchObject({ attached: false, record: { id: "id-2" } });
  });

  it("does not expire a run waiting its turn in the bump group; measures from when the DO first sees it started (review A2, A10)", async () => {
    const { actions, subject, advance, now } = setup();
    await subject.press(serverPress(NEXT));
    const run = actions.start("Update id-1", null);
    advance(UPDATE_EXPIRY_MS * 2);
    expect((await subject.settle("t3"))?.outcome).toBeNull();
    actions.begin(run);
    expect((await subject.settle("t3"))?.startedAt).toBe(now());
    advance(UPDATE_EXPIRY_MS - 1);
    expect((await subject.settle("t3"))?.outcome).toBeNull();
  });

  it("fails a run still queued past the ceiling, and a dispatch GitHub never lists", async () => {
    const queued = setup();
    await queued.subject.press(serverPress(NEXT));
    queued.actions.start("Update id-1", null);
    queued.advance(QUEUED_CEILING_MS + 1);
    expect((await queued.subject.settle("t3"))?.outcome?.reason).toMatch(/waited its turn for 3 hours/);
    const unlisted = setup();
    await unlisted.subject.press(serverPress(NEXT));
    unlisted.advance(UNLISTED_MS + 1);
    expect((await unlisted.subject.settle("t3"))?.outcome?.reason).toMatch(/never started/);
  });

  it("returns a dispatch error at press time, and leaves nothing in flight", async () => {
    const store = mapStore();
    const subject = updates({
      store,
      actions: { ...fakeActions().client, dispatch: async () => Promise.reject(new Error("GitHub answered POST … with 403: Resource not accessible by integration")) },
      now: () => 0,
      newId: () => "x",
    });
    await expect(subject.press(serverPress(NEXT))).rejects.toThrow(/403/);
    expect(subject.record("t3")?.outcome?.status).toBe("failed");
  });

  it("refuses every press on a stage without an update target", async () => {
    const subject = updates({ store: mapStore(), actions: undefined, now: () => 0, newId: () => "x" });
    expect(subject.configured).toBe(false);
    await expect(subject.press(serverPress(NEXT))).rejects.toThrow(/only prod/);
  });
});

describe("the outcome a server Update reports", () => {
  const record = (patch: Partial<UpdateRecord>): UpdateRecord => ({
    id: "u1",
    key: "t3",
    target: NEXT,
    from: CURRENT,
    label: `t3@${NEXT}`,
    workflow: "bump.yml",
    runName: "Update u1",
    dispatchedAt: 0,
    run: null,
    outcome: null,
    ...patch,
  });

  it("is committed at boot when the stored target is the stamped version, and nothing otherwise", () => {
    expect(committedOutcome(record({}), NEXT)).toEqual({ id: "u1", fromVersion: CURRENT, targetVersion: NEXT, status: "committed" });
    expect(committedOutcome(record({}), CURRENT)).toBeUndefined();
    expect(committedOutcome(undefined, NEXT)).toBeUndefined();
  });

  it("prepareTrial reads storage only and never fails", async () => {
    const committed = makeLauncherClient({ version: NEXT, updates: () => ({ record: () => record({}) }) as never });
    expect(await Effect.runPromise(committed.prepareTrial({ baseDir: "/" }))).toMatchObject({ id: "u1", status: "committed" });
    const broken = makeLauncherClient({ version: NEXT, updates: () => ({ record: () => { throw new Error("storage"); } }) as never });
    expect(await Effect.runPromise(broken.prepareTrial({ baseDir: "/" }))).toBeUndefined();
    expect(await Effect.runPromise(makeLauncherClient({ version: NEXT, updates: () => undefined }).prepareTrial({ baseDir: "/" }))).toBeUndefined();
  });

  it("is failed, with the reason, while the client may still wait for it", () => {
    const failed = record({ outcome: { status: "failed", reason: "The update failed: https://x", at: 1000 } });
    expect(failedOutcome(failed, CURRENT, 2000)).toEqual({ id: "u1", fromVersion: CURRENT, targetVersion: NEXT, status: "failed", reason: "The update failed: https://x" });
    expect(failedOutcome(failed, CURRENT, 1000 + FAILED_REPLAY_MS + 1)).toBeUndefined();
    // Running the target already, the update did land: committed says so.
    expect(failedOutcome(failed, NEXT, 2000)).toBeUndefined();
  });

  it("goes out as the original ready again, with the outcome", () => {
    const ready = { version: 1, type: "ready", sequence: 3, payload: { at: "2026-11-17T00:00:00.000Z", environment: { serverVersion: CURRENT } } } as never;
    const welcome = { version: 1, type: "welcome", sequence: 2, payload: {} } as never;
    const outcome = { id: "u1", fromVersion: CURRENT, targetVersion: NEXT, status: "failed" as const, reason: "r" };
    expect(readyWithOutcome([welcome, ready], outcome)).toEqual({
      version: 1,
      type: "ready",
      payload: { at: "2026-11-17T00:00:00.000Z", environment: { serverVersion: CURRENT }, updateOutcome: outcome },
    });
    expect(readyWithOutcome([welcome], outcome)).toBeUndefined();
  });
});

describe("GitHub Actions through a fake dispatch and runs endpoint", () => {
  const repo = updateRepoOf("ian-pascoe/t3flare")!;

  const fakeGitHub = () => {
    const requests: Array<{ method: string; url: string; body?: unknown; authorization: string | null }> = [];
    const fetch = async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      requests.push({ method: init.method ?? "GET", url, ...(init.body === undefined ? {} : { body: JSON.parse(init.body as string) }), authorization: headers.get("authorization") });
      const { pathname } = new URL(url);
      if (pathname.endsWith("/dispatches")) return new Response(null, { status: 204 });
      if (pathname.endsWith("/runs")) {
        return Response.json({
          workflow_runs: [
            { id: 7, html_url: "https://github.com/ian-pascoe/t3flare/actions/runs/7", status: "queued", conclusion: null, name: "Nightly bump", display_title: "Update other" },
            { id: 8, html_url: "https://github.com/ian-pascoe/t3flare/actions/runs/8", status: "in_progress", conclusion: null, name: "Nightly bump", display_title: "Update u1" },
          ],
        });
      }
      if (pathname.endsWith("/runs/8")) return Response.json({ id: 8, html_url: "https://github.com/ian-pascoe/t3flare/actions/runs/8", status: "completed", conclusion: "failure" });
      if (pathname.endsWith("/runs/8/jobs")) {
        return Response.json({ jobs: [{ name: "bump", conclusion: "success", steps: [] }, { name: "land / land", conclusion: "failure", steps: [{ name: "Checkout", conclusion: "success" }, { name: "Check the branch", conclusion: "failure" }] }] });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    };
    let minted = 0;
    return { requests, client: actionsClient({ repo, token: async () => `token-${++minted}`, fetch }) };
  };

  it("dispatches on main, with a fresh token per request", async () => {
    const { requests, client } = fakeGitHub();
    await client.dispatch("bump.yml", { tag: `v${NEXT}`, land: "true", gate: "update", update_id: "u1" });
    await client.dispatch("bump.yml", { tag: `v${NEXT}`, land: "true", gate: "update", update_id: "u2" });
    expect(requests[0]).toMatchObject({ method: "POST", url: "https://api.github.com/repos/ian-pascoe/t3flare/actions/workflows/bump.yml/dispatches", body: { ref: "main", inputs: { update_id: "u1" } }, authorization: "Bearer token-1" });
    expect(requests[1]?.authorization).toBe("Bearer token-2");
  });

  it("finds the run by its run-name among the dispatches since, and names its failed step", async () => {
    const { requests, client } = fakeGitHub();
    const run = await client.findRun("bump.yml", "Update u1", Date.UTC(2026, 10, 17, 12, 0, 0, 500));
    expect(run).toEqual({ id: 8, url: "https://github.com/ian-pascoe/t3flare/actions/runs/8", status: "in_progress", conclusion: null, started: true });
    expect(decodeURIComponent(requests[0]!.url)).toContain("event=workflow_dispatch");
    expect(decodeURIComponent(requests[0]!.url)).toContain("created=>=2026-11-17T12:00:00Z");
    expect(await client.getRun(8)).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(await client.failedStep(8)).toBe("land / land / Check the branch");
  });

  it("tells GitHub's refusal plainly", async () => {
    const { client } = fakeGitHub();
    await expect(client.getRun(9)).rejects.toThrow(/404: Not Found/);
  });

  it("reads only an owner/name target", () => {
    expect(updateRepoOf("ian-pascoe/t3flare")).toEqual({ owner: "ian-pascoe", name: "t3flare" });
    expect(updateRepoOf(undefined)).toBeUndefined();
    expect(updateRepoOf("https://github.com/x/y")).toBeUndefined();
  });
});
