// `node scripts/updates-ci.ts <command> …`: the steps of the update workflows that decide or publish (ADR-0037; review
// F1, F2, A1, A3, A5). They run in trusted jobs, on runners where no upstream or dependency code ran, with plain Node and
// nothing installed. Every value from a bump job's report or a workflow input is validated here with the patterns in
// `apps/environment/src/updates/pins.ts` before it is used; outputs go to $GITHUB_OUTPUT as `name=value` lines.
//
//   plan-t3 --event <e> [--tag <t>] [--land true] [--verify <what>]   bump.yml: skip, bump or land (outputs mode, tag)
//   read-report --kind t3|cli --file <f> [--tag <t>] [--cli <c>] [--running <v>]
//                                                                      a bump job's report, validated (changed, to, land)
//   land-plan (--kind t3 --tag <t> | --kind cli --cli <c> --version <v>)   land.yml: land or deploy-only (mode, branch)
//   landed-branches (pin as land-plan)                                the `bump/*` branches a land deletes, one a line
//   set-proven --sha <sha> --gate update|full --url <run url>          the `t3flare/proven` status (A1)
//   issue-body --verify <what> [--file <report>] [--url <run url>]    a failed verify run's issue body (A3)
//   install-yaml                                                       `yaml` at main's locked version, for land-check
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { clisField } from "../apps/environment/scripts/lib/cliPins.ts";
import { landMode, planT3, readBumpReport } from "../apps/environment/scripts/lib/land.ts";
import { branchOf, COMMIT, landedBranches, newestNightly, NIGHTLY_TAG, pinOf, type Pin } from "../apps/environment/src/updates/pins.ts";
import { branchTipOf, bumpBranches, git, nightlyTagsOf, provenGateOf, setProven } from "./lib/updatesGit.ts";

const root = path.resolve(import.meta.dirname, "..");
const [command, ...args] = process.argv.slice(2);
const option = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);

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

const pinFromArgs = (): Pin => {
  const pin = pinOf({ kind: option("kind"), tag: option("tag"), cli: option("cli"), version: option("version") });
  return typeof pin === "string" ? fail(pin) : pin;
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
      branch = {
        gate: await provenGateOf(tip),
        mainIsAncestor: git(["merge-base", "--is-ancestor", "HEAD", tip], root).ok,
        commits: Number(git(["rev-list", "--count", `HEAD..${tip}`], root).out || "0"),
      };
    }
    const plan = planT3({ event: event as "schedule" | "workflow_dispatch", tag: tagInput, land: option("land") === "true", verify: (option("verify") ?? "") !== "", newest, mainTag, branch });
    if (typeof plan === "string") fail(plan);
    const decided = plan as Exclude<typeof plan, string>;
    console.error(`plan: ${decided.mode}: ${decided.reason}`);
    output({ mode: decided.mode, tag: decided.tag });
    break;
  }
  case "read-report": {
    const kind = option("kind");
    const file = option("file") ?? fail("--file is required");
    if (kind !== "t3" && kind !== "cli") fail(`not a kind of bump: ${String(kind)}`);
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : fail(`${file} is missing`);
    const read = readBumpReport(text, kind === "t3" ? { kind, tag: option("tag") || undefined } : { kind: "cli", cli: option("cli") ?? "", running: option("running") || undefined });
    if (typeof read === "string") fail(read);
    const report = read as Exclude<typeof read, string>;
    output({ changed: String(report.changed), to: report.to, gate: report.gate, land: String(report.land) });
    break;
  }
  case "land-plan": {
    const pin = pinFromArgs();
    let mode;
    if (pin.kind === "t3") {
      mode = landMode(pin, { tag: tagOfGitlink("origin/main", nightlyTagsOf(submoduleUrl())) });
    } else {
      const clis = git(["show", "origin/main:apps/sandbox-image/src/clis.ts"], root);
      if (!clis.ok) fail("main has no clis.ts");
      mode = landMode(pin, { cliVersion: clisField(clis.raw, pin.cli, pin.cli === "claude" ? "packageVersion" : "version") });
    }
    output({ mode, branch: branchOf(pin) });
    break;
  }
  case "landed-branches": {
    for (const branch of landedBranches(pinFromArgs(), bumpBranches())) console.log(branch);
    break;
  }
  case "set-proven": {
    const sha = option("sha") ?? "";
    const gate = option("gate");
    const url = option("url") ?? "";
    if (!COMMIT.test(sha)) fail(`not a commit: ${sha}`);
    if (gate !== "update" && gate !== "full") fail(`not a gate: ${String(gate)}`);
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(url)) fail(`not a run URL: ${url}`);
    await setProven(sha, gate as "update" | "full", url);
    console.log(`${sha}: ${gate} gate`);
    break;
  }
  case "issue-body": {
    const verify = (option("verify") ?? "").replace(/[^\w .:@/+-]/g, "").slice(0, 120) || "an Update";
    const url = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(option("url") ?? "") ? option("url")! : "(no run URL)";
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
        `- Run: ${url}`,
        "",
        "Prod runs it. Recovery: Safe mode, then a revert by the owner (in-app updates plan D15).",
      ].join("\n"),
    );
    break;
  }
  case "install-yaml": {
    // main's own locked `yaml`, checked against the lock's integrity, installed with no scripts.
    const lock = fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
    const match = /\n {2}yaml@(\d+\.\d+\.\d+):\n {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}/.exec(lock);
    if (match === null) fail("main's lock holds no yaml");
    const [, version, integrity] = match!;
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
