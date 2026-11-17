// `node scripts/updates-ci.ts <command> …`: the steps of the update workflows that decide, check or publish (ADR-0037;
// review F1, F2, A1, A3, A5, A12, B1). They run in trusted jobs, on runners where no upstream or dependency code ran,
// with plain Node and nothing installed but main's locked `yaml` (`install-yaml`). Every value from a bump job's report
// or a workflow input is validated against `apps/environment/src/updates/pins.ts`'s patterns before it is used. Outputs
// go to $GITHUB_OUTPUT as `name=value` lines. A pin travels as one string (`t3:<tag>`, `cli:<cli>:<version>`).
//
//   plan-t3 --event <e> [--tag <t>] [--land true] [--verify <what>]   bump.yml: skip, bump or land (mode, tag, pin, sha)
//   check-proposal --kind t3|cli --dir <artifact dir> (--gate <g> [--tag <t>] | --cli <c> [--running <v>])
//                       no token: the report read and the bundled commit checked (changed, pin, sha, gate, call_land)
//   publish-proposal --pin <pin> --sha <sha> --gate <g>      token: push `bump/*`, mark the commit proven
//   land-plan --pin <pin> [--sha <sha>]   land.yml: land (the branch's tip is `sha`, proven) or deploy-only
//                                         (mode, branch, sha, verify)
//   landed-branches --pin <pin>           the `bump/*` branches a land deletes, one a line
//   issue-body --verify <what> [--file <report>]                       a failed verify run's issue body (A3)
//   install-yaml                          `yaml` at main's locked version, checked against the lock's integrity
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { clisField } from "../apps/environment/scripts/lib/cliPins.ts";
import { landBindingRefusal, landMode, planT3, readBumpReport } from "../apps/environment/scripts/lib/land.ts";
import { branchOf, COMMIT, landedBranches, newestNightly, NIGHTLY_TAG, parsePin, type Pin, pinOf, pinText } from "../apps/environment/src/updates/pins.ts";
import { branchTipOf, bumpBranches, git, nightlyTagsOf, optionOf, provenGateOf, setProven, thisRunUrl } from "./lib/updatesGit.ts";

const root = path.resolve(import.meta.dirname, "..");
const [command, ...args] = process.argv.slice(2);
const option = optionOf(args);

const fail = (reason: string): never => {
  console.error(`updates-ci ${command}: ${reason}`);
  process.exit(1);
};

/** Writes `name=value` outputs; values are validated before they get here, and may hold no line break. */
const output = (values: Readonly<Record<string, string>>) => {
  const lines = Object.entries(values).map(([name, value]) => {
    if (/[\r\n]/.test(value)) fail(`output ${name} has a line break`);
    return `${name}=${value}`;
  });
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
};

const pinArg = (): Pin => {
  const pin = parsePin(option("pin"));
  return typeof pin === "string" ? fail(pin) : pin;
};

const gateArg = (): "update" | "full" => {
  const gate = option("gate") || "full";
  return gate === "update" || gate === "full" ? gate : fail(`not a gate: ${gate}`);
};

const submoduleUrl = () => git(["config", "-f", ".gitmodules", "submodule.t3code.url"], root).out;

/** The nightly tag `ref`'s t3code gitlink is, if any. */
const tagOfGitlink = (ref: string, tags: ReadonlyMap<string, string>): string | undefined => {
  const gitlink = /^160000 commit ([0-9a-f]{40})\tt3code$/m.exec(git(["ls-tree", ref, "t3code"], root).out)?.[1];
  return gitlink === undefined ? undefined : newestNightly([...tags].filter(([, sha]) => sha === gitlink).map(([tag]) => tag));
};

switch (command) {
  case "plan-t3": {
    const event = option("event");
    if (event !== "schedule" && event !== "workflow_dispatch") fail(`not an event this plans: ${String(event)}`);
    const tags = nightlyTagsOf(submoduleUrl());
    const newest = newestNightly([...tags.keys()]);
    const mainTag = tagOfGitlink("HEAD", tags);
    const tagInput = option("tag") || undefined;
    if (tagInput !== undefined && !NIGHTLY_TAG.test(tagInput)) fail(`not a nightly tag: ${JSON.stringify(tagInput)}`);
    const target = event === "schedule" ? newest : tagInput;
    let branch;
    const tip = target === undefined ? undefined : branchTipOf(`bump/${target}`);
    if (target !== undefined && tip !== undefined && COMMIT.test(tip)) {
      git(["fetch", "--quiet", "origin", `+refs/heads/bump/${target}:refs/remotes/origin/bump/${target}`], root);
      const proof = await provenGateOf(tip);
      if (proof.gate === undefined) console.error(`plan: bump/${target}: ${proof.reason}`);
      branch = {
        gate: proof.gate,
        mainIsAncestor: git(["merge-base", "--is-ancestor", "HEAD", tip], root).ok,
        commits: Number(git(["rev-list", "--count", `HEAD..${tip}`], root).out || "0"),
      };
    }
    const plan = planT3({ event: event as "schedule" | "workflow_dispatch", tag: tagInput, land: option("land") === "true", verify: (option("verify") ?? "") !== "", newest, mainTag, branch });
    if (typeof plan === "string") fail(plan);
    const decided = plan as Exclude<typeof plan, string>;
    console.error(`plan: ${decided.mode}: ${decided.reason}`);
    // The proven tip the fast path lands: land.yml lands exactly it (review B1).
    output({ mode: decided.mode, tag: decided.tag, pin: decided.tag === "" ? "" : pinText({ kind: "t3", tag: decided.tag }), sha: decided.proven === true ? tip! : "" });
    break;
  }
  case "check-proposal": {
    // No token in this step's environment (review A9): it runs npm (a CLI pin made again) and git on the bundle.
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) fail("runs without a token");
    const kind = option("kind");
    const dir = option("dir") ?? fail("--dir is required");
    if (kind !== "t3" && kind !== "cli") fail(`not a kind of bump: ${String(kind)}`);
    const reportFile = path.join(dir, kind === "t3" ? "bump-report.json" : "cli-bump-report.json");
    const text = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, "utf8") : fail(`${reportFile} is missing`);
    const read = readBumpReport(text, kind === "t3" ? { kind, gate: gateArg(), tag: option("tag") || undefined } : { kind: "cli", cli: option("cli") ?? "", running: option("running") || undefined });
    if (typeof read === "string") fail(read);
    const report = read as Exclude<typeof read, string>;
    const pin = pinOf(kind === "t3" ? { kind, tag: report.to } : { kind, cli: option("cli"), version: report.to });
    if (typeof pin === "string") fail(pin);
    let sha = "";
    if (report.changed) {
      const bundle = path.join(dir, "pin.bundle");
      if (!git(["bundle", "verify", bundle], root).ok) fail("the pin's bundle does not verify");
      if (!git(["fetch", "--quiet", bundle, "HEAD:refs/remotes/candidate"], root).ok) fail("could not fetch the pin's bundle");
      sha = git(["rev-parse", "refs/remotes/candidate"], root).out;
      const checked = spawnSync(process.execPath, ["scripts/land-check.ts", "--ref", "refs/remotes/candidate", "--pin", pinText(pin as Pin)], { cwd: root, stdio: "inherit" });
      if (checked.status !== 0) fail("the land check refused the proposed pin");
    }
    output({ changed: String(report.changed), pin: pinText(pin as Pin), sha, gate: report.gate, call_land: String(report.callLand) });
    break;
  }
  case "publish-proposal": {
    const pin = pinArg();
    const sha = option("sha") ?? "";
    if (!COMMIT.test(sha) || git(["rev-parse", "refs/remotes/candidate"], root).out !== sha) fail(`not the checked candidate: ${sha}`);
    const token = process.env.GH_TOKEN ?? fail("GH_TOKEN is required");
    const pushed = git(["push", "--force", `https://x-access-token:${token}@github.com/${process.env.GITHUB_REPOSITORY}.git`, `${sha}:refs/heads/${branchOf(pin)}`], root);
    if (!pushed.ok) fail(`push: ${pushed.err.replaceAll(token, "***")}`);
    await setProven(sha, gateArg());
    output({ branch: branchOf(pin) });
    break;
  }
  case "land-plan": {
    const pin = pinArg();
    let mode;
    if (pin.kind === "t3") {
      mode = landMode(pin, { tag: tagOfGitlink("origin/main", nightlyTagsOf(submoduleUrl())) });
    } else {
      const clis = git(["show", "origin/main:apps/sandbox-image/src/clis.ts"], root);
      if (!clis.ok) fail("main has no clis.ts");
      mode = landMode(pin, { cliVersion: clisField(clis.raw, pin.cli, pin.cli === "claude" ? "packageVersion" : "version") });
    }
    const branch = branchOf(pin);
    // What the verify run is named after (D18).
    const verify = pin.kind === "t3" ? `t3code ${pin.tag}` : `${pin.cli} ${pin.version}`;
    if (mode === "deploy-only") {
      output({ mode, branch, sha: git(["rev-parse", "origin/main"], root).out, verify });
      break;
    }
    // Review B1: land exactly the commit a trusted job proved, and only while the branch still points at it.
    const sha = option("sha") || undefined;
    const tip = branchTipOf(branch);
    const proof = sha !== undefined && COMMIT.test(sha) && tip === sha ? await provenGateOf(sha) : undefined;
    const refusal = landBindingRefusal({ branch, sha, tip, proof: proof ?? (sha !== undefined && tip === sha ? undefined : { gate: undefined, reason: "" }) });
    if (refusal !== undefined) fail(refusal);
    if (!git(["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], root).ok) fail(`could not fetch ${branch}`);
    output({ mode, branch, sha: sha!, verify });
    break;
  }
  case "landed-branches": {
    for (const branch of landedBranches(pinArg(), bumpBranches())) console.log(branch);
    break;
  }
  case "issue-body": {
    const verify = (option("verify") ?? "").replace(/[^\w .:@/+-]/g, "").slice(0, 120) || "an Update";
    let step = "setup, before the report";
    const file = option("file");
    if (file !== undefined && fs.existsSync(file)) {
      try {
        const report = JSON.parse(fs.readFileSync(file, "utf8")) as { steps?: Array<{ name?: unknown; ok?: unknown }> };
        const failed = report.steps?.find((candidate) => candidate.ok === false)?.name;
        // Untrusted text: only plain characters, short, and shown as code.
        if (typeof failed === "string") step = failed.replace(/[^\w .,:()/'-]/g, "").slice(0, 160) || step;
      } catch {
        step = "unreadable report";
      }
    }
    console.log(
      [
        `The Full gate did not pass on main after **${verify}** landed through an in-app Update (ADR-0037).`,
        "",
        `- Failed step: \`${step}\``,
        `- Run: ${thisRunUrl()}`,
        "",
        "Prod runs it. Recovery: Safe mode, then a revert by the owner (in-app updates plan D15).",
      ].join("\n"),
    );
    break;
  }
  case "install-yaml": {
    // main's own locked `yaml`, checked against the lock's integrity, installed with no scripts.
    const lock = fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
    const match = /\n {2}yaml@(\d+\.\d+\.\d+):\n {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}/.exec(lock) ?? fail("main's lock holds no yaml");
    const [, version, integrity] = match;
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "yaml-"));
    const installed = spawnSync("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", `yaml@${version}`], { encoding: "utf8", cwd: prefix });
    if (installed.status !== 0) fail(`npm install yaml@${version}: ${installed.stderr}`);
    const resolved = (JSON.parse(fs.readFileSync(path.join(prefix, "package-lock.json"), "utf8")) as { packages: Record<string, { integrity?: string }> }).packages["node_modules/yaml"]?.integrity;
    if (resolved !== integrity) fail(`npm installed yaml@${version} with integrity ${String(resolved)}, not the lock's`);
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    if (!fs.existsSync(path.join(root, "node_modules/yaml"))) fs.symlinkSync(path.join(prefix, "node_modules/yaml"), path.join(root, "node_modules/yaml"));
    console.log(`yaml@${version} installed`);
    break;
  }
  default:
    fail("unknown command");
}
