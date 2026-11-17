// CLI updates from t3's provider-update button (ADR-0037; in-app updates plan D21, D16): the drivers' maintenance
// capabilities (a real `update` only with an update target), the npm advisory per CLI, and the command the process router
// answers by dispatching `cli-bump.yml` and following its run.
import { ProviderDriverKind } from "@t3tools/contracts";
import { CLIS } from "@t3flare/sandbox-image/clis";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { CLI_UPDATE_COMMAND, cliMaintenance, lookupLatestCliVersion, runCliUpdate } from "../src/updates/cliUpdate.ts";
import { updates, type UpdateStore } from "../src/updates/records.ts";
import type { ActionsClient, WorkflowRun } from "../src/updates/actions.ts";

const npm = (documents: Record<string, unknown>) => async (url: string) => {
  const path = decodeURIComponent(new URL(url).pathname.slice(1));
  return path in documents ? Response.json(documents[path]) : new Response("{}", { status: 404 });
};

describe("the CLIs' latest versions (the card's advisory)", () => {
  const registry = npm({
    "@openai/codex/latest": { version: "0.169.0" },
    "@earendil-works/pi-coding-agent/latest": { version: "1.6.0" },
    "@agentclientprotocol/claude-agent-acp/latest": { version: "0.108.0", dependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.326" } },
    "@anthropic-ai/claude-agent-sdk/0.3.326": { version: "0.3.326", claudeCodeVersion: "2.1.326" },
  });

  it("reads Codex and pi from npm, and Claude Code from the SDK the newest adapter pins", async () => {
    expect(await lookupLatestCliVersion("codex", registry)).toBe("0.169.0");
    expect(await lookupLatestCliVersion("pi", registry)).toBe("1.6.0");
    expect(await lookupLatestCliVersion("claude", registry)).toBe("2.1.326");
  });

  it("says nothing when npm does not answer", async () => {
    expect(await lookupLatestCliVersion("codex", npm({}))).toBeNull();
    expect(await lookupLatestCliVersion("claude", async () => Promise.reject(new Error("offline")))).toBeNull();
  });
});

describe("the CLI drivers' maintenance capabilities", () => {
  const codex = ProviderDriverKind.make("codex");

  it("has a real update, run through the process router, on a stage with an update target", async () => {
    const capabilities = cliMaintenance(codex, "codex", { configured: true, fetch: npm({ "@openai/codex/latest": { version: "0.169.0" } }) });
    expect(capabilities.update).toMatchObject({ executable: CLI_UPDATE_COMMAND, args: ["codex"], lockKey: "t3flare-cli:codex", command: `${CLI_UPDATE_COMMAND} codex` });
    expect(capabilities.latestVersion).toBeNull();
    expect(await Effect.runPromise(capabilities.lookupLatestVersion!)).toBe("0.169.0");
  });

  it("stays manual-only elsewhere (ADR-0024)", () => {
    expect(cliMaintenance(codex, "codex", { configured: false }).update).toBeNull();
  });
});

const mapStore = (): UpdateStore => {
  const map = new Map<string, unknown>();
  return { get: (key) => structuredClone(map.get(key)), put: (key, value) => void map.set(key, structuredClone(value)) };
};

const fakeRuns = (conclusion: string) => {
  const dispatched: Array<Readonly<Record<string, string>>> = [];
  let polls = 0;
  const run = (): WorkflowRun => ({ id: 5, url: "https://github.com/o/r/actions/runs/5", status: polls > 1 ? "completed" : "in_progress", conclusion: polls > 1 ? conclusion : null, startedAt: 0 });
  const client: ActionsClient = {
    dispatch: async (_workflow, inputs) => void dispatched.push(inputs),
    findRun: async (workflow, runName) => (workflow === "cli-bump.yml" && runName === `CLI update ${dispatched.at(-1)?.update_id}` ? run() : undefined),
    getRun: async () => {
      polls++;
      return run();
    },
    failedStep: async () => "bump / acceptance (the CLI's sub-test)",
  };
  return { client, dispatched };
};

describe("t3flare-cli-update", () => {
  const options = (client: ActionsClient) => ({
    updates: updates({ store: mapStore(), actions: client, now: () => 0, newId: () => "c1" }),
    now: () => 0,
    sleep: async () => {},
  });

  it("dispatches cli-bump.yml for the CLI and exits 0 once its run lands", async () => {
    const { client, dispatched } = fakeRuns("success");
    const answer = await runCliUpdate(["pi"], options(client));
    expect(dispatched).toEqual([{ cli: "pi", update_id: "c1", dry_run: "false", running: CLIS.pi.version }]);
    expect(answer.exitCode).toBe(0);
  });

  it("exits 1 with the failed step and the run's URL", async () => {
    const { client } = fakeRuns("failure");
    const answer = await runCliUpdate(["codex"], options(client));
    expect(answer.exitCode).toBe(1);
    expect(answer.stderr).toContain('"bump / acceptance (the CLI\'s sub-test)"');
    expect(answer.stderr).toContain("https://github.com/o/r/actions/runs/5");
  });

  it("refuses an unknown CLI, and every CLI where no update target is configured", async () => {
    expect((await runCliUpdate(["opencode"], options(fakeRuns("success").client))).exitCode).toBe(2);
    expect((await runCliUpdate(["claude"], { updates: undefined })).stderr).toMatch(/only prod/);
  });

  it("starts from the image's pin", async () => {
    const store = mapStore();
    const subject = updates({ store, actions: fakeRuns("success").client, now: () => 0, newId: () => "c1" });
    await runCliUpdate(["claude"], { updates: subject, now: () => 0, sleep: async () => {} });
    expect(subject.record("cli:claude")).toMatchObject({ from: CLIS.claude.version, target: "latest", runName: "CLI update c1", workflow: "cli-bump.yml" });
  });
});
