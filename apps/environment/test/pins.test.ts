// @effect-diagnostics nodeBuiltinImport:off
// The pins an Update moves, named once (ADR-0037; review A1, A5, A6): nightly tags, branch names and what a land deletes,
// the proof a trusted job records, and the CLI list the workflow offers.
import * as fs from "node:fs";
import * as path from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { branchOf, landedBranches, newestNightly, parsePin, pinOf, pinOfBranch, pinText, proofRunRefusal, provenStatus, UPDATABLE_CLIS } from "../src/updates/pins.ts";

describe("nightly tags", () => {
  it("orders by date, then run", () => {
    expect(newestNightly(["v0.1.11-nightly.20261117.4851", "v0.1.11-nightly.20261117.999", "v0.1.10-nightly.20261118.1", "v0.2.0", "nightly"])).toBe("v0.1.10-nightly.20261118.1");
    expect(newestNightly(["v0.2.0"])).toBeUndefined();
  });
});

describe("bump branches", () => {
  it("are made and parsed in one place, and only valid pins make one", () => {
    expect(branchOf({ kind: "t3", tag: "v0.1.11-nightly.20261117.4851" })).toBe("bump/v0.1.11-nightly.20261117.4851");
    expect(branchOf({ kind: "cli", cli: "codex", version: "0.169.0" })).toBe("bump/cli-codex-0.169.0");
    expect(pinOfBranch("bump/cli-codex-0.169.0")).toEqual({ kind: "cli", cli: "codex", version: "0.169.0" });
    expect(pinOfBranch("bump/cli-codex-0.169.0-rc.1")).toBeUndefined();
    expect(pinOfBranch("main")).toBeUndefined();
    expect(pinOf({ kind: "cli", cli: "opencode", version: "1.0.0" })).toMatch(/not an updatable CLI/);
    expect(pinOf({ kind: "cli", cli: "codex", version: "1.0.0; rm" })).toMatch(/not an exact version/);
    expect(pinOf({ kind: "t3", tag: "v0.1.11-nightly.20261117.4851" })).toEqual({ kind: "t3", tag: "v0.1.11-nightly.20261117.4851" });
  });

  it("a land deletes only its kind's and CLI's branches at or below its version (A5)", () => {
    const branches = [
      "bump/v0.1.11-nightly.20261117.4825",
      "bump/v0.1.11-nightly.20261117.4851",
      "bump/v0.1.11-nightly.20261118.1",
      "bump/cli-codex-0.167.2",
      "bump/cli-codex-0.169.0",
      "bump/cli-codex-0.170.0",
      "bump/cli-claude-0.100.0",
      "bump/cli-pi-0.0.1-beta",
      "feature/x",
    ];
    expect(landedBranches({ kind: "t3", tag: "v0.1.11-nightly.20261117.4851" }, branches)).toEqual(["bump/v0.1.11-nightly.20261117.4825", "bump/v0.1.11-nightly.20261117.4851"]);
    expect(landedBranches({ kind: "cli", cli: "codex", version: "0.169.0" }, branches)).toEqual(["bump/cli-codex-0.167.2", "bump/cli-codex-0.169.0"]);
  });
});

describe("the proven status (A1, B1)", () => {
  const url = "https://github.com/ian-pascoe/t3flare/actions/runs/42";
  const status = (patch: Record<string, unknown>) => ({ context: "t3flare/proven", state: "success", description: "gate=full", target_url: url, creator: { login: "github-actions[bot]" }, ...patch });

  it("reads the newest t3flare/proven success set by GitHub Actions, with the run it names", () => {
    expect(provenStatus([status({})])).toEqual({ gate: "full", runId: 42, repository: "ian-pascoe/t3flare" });
    expect(provenStatus([status({ description: "gate=update" }), status({})])?.gate).toBe("update");
    expect(provenStatus([{ context: "ci", state: "success" }, status({})])?.gate).toBe("full");
  });

  it("ignores a status anyone else set, a failure, a strange gate, or one naming no run", () => {
    expect(provenStatus([status({ creator: { login: "t3flare[bot]" } })])).toBeUndefined();
    expect(provenStatus([status({ state: "failure" })])).toBeUndefined();
    expect(provenStatus([status({ description: "gate=anything" })])).toBeUndefined();
    expect(provenStatus([status({ target_url: "https://evil.example/actions/runs/42" })])).toBeUndefined();
    expect(provenStatus([])).toBeUndefined();
  });

  it("counts only a run of a proving workflow, on main, from a schedule or a dispatch, in this repository", () => {
    const run = (patch: Record<string, unknown>) => ({ path: ".github/workflows/bump.yml", head_branch: "main", event: "workflow_dispatch", repository: { full_name: "o/r" }, head_repository: { full_name: "o/r" }, ...patch });
    expect(proofRunRefusal(run({}), "o/r")).toBeUndefined();
    expect(proofRunRefusal(run({ path: ".github/workflows/cli-bump.yml", event: "schedule" }), "o/r")).toBeUndefined();
    expect(proofRunRefusal(run({ path: ".github/workflows/forge.yml" }), "o/r")).toMatch(/not a proving workflow/);
    expect(proofRunRefusal(run({ head_branch: "agent/branch" }), "o/r")).toMatch(/not main/);
    expect(proofRunRefusal(run({ event: "push" }), "o/r")).toMatch(/started by push/);
    expect(proofRunRefusal(run({ head_repository: { full_name: "fork/r" } }), "o/r")).toMatch(/not this repository/);
  });
});

describe("a pin as one string (A12)", () => {
  it("round-trips, and refuses anything else", () => {
    for (const pin of [{ kind: "t3", tag: "v0.1.11-nightly.20261117.4851" }, { kind: "cli", cli: "claude", version: "0.108.0" }] as const) expect(parsePin(pinText(pin))).toEqual(pin);
    expect(parsePin("cli:codex:0.169.0:x")).toMatch(/not a pin/);
    expect(parsePin("cli:codex:main")).toMatch(/not an exact version/);
    expect(parsePin("t3:main")).toMatch(/not a nightly tag/);
    expect(parsePin(undefined)).toMatch(/not a pin/);
  });
});

describe("the CLI list", () => {
  it("is cli-bump.yml's choice of CLIs", () => {
    const workflow = parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../../.github/workflows/cli-bump.yml"), "utf8")) as { on: { workflow_dispatch: { inputs: { cli: { options: Array<string> } } } } };
    expect(workflow.on.workflow_dispatch.inputs.cli.options).toEqual([...UPDATABLE_CLIS]);
  });
});
