// The Workspaces section's routes (ADR-0044 §1, §4): `handleHarness` over a store and fixed Workspaces.
// The page's write guard holds for each action (no CSRF token, no change), the Purge needs the Workspace's own name typed
// and checked here, and each act is one audit entry under `workspaces`; the dry Sweep and a Workspace's usage are reads.
// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vitest";

import type { SweepReport } from "../src/agents/deletion.ts";
import type { WorkspacesApi } from "../src/agents/workspaceActions.ts";
import type { WorkspaceRecord } from "../src/agents/workspaces.ts";
import type { AccessCaller } from "../src/access.ts";
import { csrfToken } from "../src/harness/csrf.ts";
import { CSRF_HEADER, handleHarness } from "../src/harness/panel.ts";
import { harnessStore } from "../src/harness/store.ts";
import { record, t3Tables, viewDeps } from "./fixtures/workspaces.ts";

const HOST = "t3-admin.example.dev";
const NOW = Date.UTC(2026, 10, 21, 12);
const owner: AccessCaller = { kind: "owner", subject: "owner-sub" };
const BASE = `https://${HOST}/_t3flare/settings/api/workspaces`;

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
    keys: () => [...map.keys()],
  };
};

const REPORT: SweepReport = {
  at: new Date(NOW).toISOString(),
  dry: true,
  purging: true,
  graceMs: 7 * 86_400_000,
  purgingSince: null,
  ok: true,
  actions: [{ id: ".wt/acme/feat-a", action: "purge", why: "unreferenced since 2026-01-01T00:00:00.000Z" }],
  purged: [],
  sessions: ["t1"],
  costGuard: [],
  nextDue: new Date(NOW + 86_400_000).toISOString(),
};

const setup = (caller: AccessCaller = owner) => {
  const store = harnessStore(memory());
  const sql = t3Tables();
  sql.exec("INSERT INTO projection_projects VALUES ('p-live', 'Live', '/w/live', '2026-03-01T00:00:00Z', NULL, NULL)");
  const rows: Array<WorkspaceRecord> = [
    record({ id: "acme" }),
    record({ id: ".wt/acme/feat-a", kind: "worktree", parent: "acme", branch: "feat-a" }),
    record({ id: ".wt/acme/feat-b", kind: "worktree", parent: "acme", branch: "feat-b", state: "tombstoned", deletedAt: NOW, purgeAfter: NOW }),
    record({ id: "live" }),
  ];
  const calls: Array<string> = [];
  const sweeps: Array<boolean> = [];
  const workspaces: WorkspacesApi = {
    deps: {
      ...viewDeps(rows, { sql }),
      purge: async (id, threads) => {
        calls.push(`purge ${id}`);
        rows.splice(rows.findIndex((row) => row.id === id), 1);
        return { id, sessionsDestroyed: threads.map((thread) => thread.threadId), destroyed: true };
      },
      restore: async (id) => {
        calls.push(`restore ${id}`);
        return { ...rows.find((row) => row.id === id)!, state: "ready" };
      },
      stop: async (id) => void calls.push(`stop ${id}`),
      audit: (entry) => store.audit(entry),
      now: () => NOW,
    },
    usage: async (id) => (id === "acme" ? { bytes: 2_097_152, containerRunning: true } : { bytes: 0, containerRunning: false }),
    runSweep: async (dry) => {
      sweeps.push(dry);
      return { ...REPORT, dry };
    },
  };
  return { store, rows, calls, sweeps, deps: { caller, host: HOST, store, now: () => NOW, workspaces } };
};

const ownerHeaders = async (store: ReturnType<typeof setup>["store"]) => ({
  "content-type": "application/json",
  origin: `https://${HOST}`,
  "sec-fetch-site": "same-origin",
  [CSRF_HEADER]: await csrfToken(store.csrfKey(), "owner-sub", NOW),
});

const post = (deps: ReturnType<typeof setup>["deps"], route: string, body: unknown, headers: Record<string, string>) =>
  handleHarness(new Request(`${BASE}${route}`, { method: "POST", headers, body: JSON.stringify(body) }), deps);

const workspaceEntries = (store: ReturnType<typeof setup>["store"]) => store.auditLog(50).filter((entry) => entry.entity === "workspaces");

describe("the Workspaces routes (ADR-0044 §4)", () => {
  it("refuse every action without the page's CSRF token: nothing purged, restored, stopped or swept, nothing audited", async () => {
    const { store, deps, calls, sweeps } = setup();
    const { [CSRF_HEADER]: _token, ...noToken } = await ownerHeaders(store);
    for (const [route, body] of [
      ["/purge", { id: "acme", confirm: "acme" }],
      ["/restore", { id: ".wt/acme/feat-b" }],
      ["/stop", { id: "acme" }],
      ["/sweep", {}],
    ] as const) {
      const response = await post(deps, route, body, noToken);
      expect(response.status, route).toBe(403);
      expect(await response.text()).toContain("bad CSRF token");
    }
    // A form post from elsewhere is refused before anything else.
    expect((await handleHarness(new Request(`${BASE}/purge`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "id=acme&confirm=acme" }), deps)).status).toBe(403);
    expect(calls).toEqual([]);
    expect(sweeps).toEqual([]);
    expect(workspaceEntries(store)).toEqual([]);
  });

  it("refuse a Purge whose typed name is not the Workspace's own: the t3 title, another's name, or none", async () => {
    const { store, deps, calls } = setup();
    const headers = await ownerHeaders(store);
    for (const confirm of ["Acme", "feat-a", "", undefined]) {
      const response = await post(deps, "/purge", { id: "acme", confirm }, headers);
      expect(response.status, String(confirm)).toBe(400);
      expect(await response.text()).toContain("type acme");
    }
    expect((await post(deps, "/purge", { id: ".wt/acme/feat-a", confirm: ".wt/acme/feat-a" }, headers)).status).toBe(400);
    expect(calls).toEqual([]);
    expect(workspaceEntries(store)).toEqual([]);
  });

  it("purge with the typed name, the cascade first; audited once as workspace.purge with the ids and the Session count", async () => {
    const { store, deps, calls } = setup();
    const response = await post(deps, "/purge", { id: "acme", confirm: "acme" }, await ownerHeaders(store));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, ids: [".wt/acme/feat-a", ".wt/acme/feat-b", "acme"], sessions: 0 });
    expect(calls).toEqual(["purge .wt/acme/feat-a", "purge .wt/acme/feat-b", "purge acme"]);
    expect(workspaceEntries(store)).toEqual([
      { at: NOW, entity: "workspaces", caller: "owner:owner-sub", action: "workspace.purge", target: "acme", after: { purged: [".wt/acme/feat-a", ".wt/acme/feat-b", "acme"], sessions: 0 } },
    ]);
  });

  it("refuse a referenced Workspace with 409, naming its references; an unknown one with 404; neither audited", async () => {
    const { store, deps, calls } = setup();
    const headers = await ownerHeaders(store);
    const referenced = await post(deps, "/purge", { id: "live", confirm: "live" }, headers);
    expect(referenced.status).toBe(409);
    expect(await referenced.text()).toContain("live by project “Live”");
    expect((await post(deps, "/purge", { id: "nope", confirm: "nope" }, headers)).status).toBe(404);
    expect((await post(deps, "/purge", { confirm: "acme" }, headers)).status).toBe(400);
    // The page has no force: a body carrying one is still refused.
    expect((await post(deps, "/purge", { id: "live", confirm: "live", force: true }, headers)).status).toBe(409);
    expect(calls).toEqual([]);
    expect(workspaceEntries(store)).toEqual([]);
  });

  it("restore, stop and run the Sweep, each audited under its own action", async () => {
    const { store, deps, calls, sweeps } = setup();
    const headers = await ownerHeaders(store);
    expect((await post(deps, "/restore", { id: ".wt/acme/feat-b" }, headers)).status).toBe(200);
    expect((await post(deps, "/stop", { id: "acme" }, headers)).status).toBe(200);
    const swept = await post(deps, "/sweep", {}, headers);
    expect(swept.status).toBe(200);
    expect(await swept.json()).toMatchObject({ ok: true, summary: "The Sweep purged 0 Workspaces, destroyed 1 Session and stopped 0 Containers." });
    expect(calls).toEqual(["restore .wt/acme/feat-b", "stop acme"]);
    expect(sweeps).toEqual([false]);
    expect(workspaceEntries(store).map((entry) => [entry.action, entry.target, entry.caller])).toEqual([
      ["sweep.run", "sweep", "owner:owner-sub"],
      ["workspace.stop", "acme", "owner:owner-sub"],
      ["workspace.restore", ".wt/acme/feat-b", "owner:owner-sub"],
    ]);
    expect(workspaceEntries(store)[0]!.after).toEqual({ ok: true, purged: [], sessions: 1, containers: 0 });
    // A restore of what is not a Tombstone, and a stop of what is not ready, change nothing.
    expect((await post(deps, "/restore", { id: "acme" }, headers)).status).toBe(409);
    expect((await post(deps, "/stop", { id: ".wt/acme/feat-b" }, headers)).status).toBe(409);
    expect(workspaceEntries(store)).toHaveLength(3);
  });

  it("read the view, a Workspace's usage and the dry Sweep with GET, which changes nothing", async () => {
    const { store, deps, calls, sweeps } = setup();
    const view = (await (await handleHarness(new Request(BASE), deps)).json()) as { rows: Array<{ id: string; worktrees: Array<unknown> }> };
    expect(view.rows.map((row) => [row.id, row.worktrees.length])).toEqual([
      ["acme", 2],
      ["live", 0],
    ]);
    expect(await (await handleHarness(new Request(`${BASE}/usage?id=acme`), deps)).json()).toEqual({ bytes: 2_097_152, containerRunning: true });
    expect((await handleHarness(new Request(`${BASE}/usage?id=nope`), deps)).status).toBe(404);
    const preview = await (await handleHarness(new Request(`${BASE}/sweep`), deps)).json();
    expect(preview).toMatchObject({ ok: true, rows: [{ id: ".wt/acme/feat-a", action: "purge" }], sessions: ["t1"] });
    expect(sweeps).toEqual([true]);
    expect(calls).toEqual([]);
    expect(store.auditLog(50)).toEqual([]);
  });

  it("refuse an act whose reference read fails, with 503: nothing purged, nothing audited", async () => {
    const { store, deps, calls } = setup();
    const broken = { ...deps, workspaces: { ...deps.workspaces, deps: { ...deps.workspaces.deps, terminals: async () => Promise.reject(new Error("no answer")) } } };
    const response = await post(broken, "/purge", { id: "acme", confirm: "acme" }, await ownerHeaders(store));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("so nothing was purged: Error: no answer");
    expect(calls).toEqual([]);
    expect(workspaceEntries(store)).toEqual([]);
  });

  it("a script (service token) acts without a CSRF token and is audited as itself", async () => {
    const { store, deps } = setup({ kind: "service-token" });
    expect((await post(deps, "/stop", { id: "acme" }, { "content-type": "application/json" })).status).toBe(200);
    expect(workspaceEntries(store)).toMatchObject([{ caller: "service-token", action: "workspace.stop" }]);
  });
});
