// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// Deploys, tests and destroys a stage of the environment Worker, with secrets made for that stage alone.
//
//   node scripts/stage.ts deploy <stage> [--web]
//                                                      build (and the web client with --web or when missing), alchemy deploy,
//                                                      then the stage's Model endpoint through the panel's API (SPI-1175)
//   node scripts/stage.ts run <stage> <script> [args]  run scripts/<script>.ts against the stage, with its secrets
//   node scripts/stage.ts destroy <stage>              alchemy destroy, and forget the stage's secrets
//
// The stage's bootstrap and admin tokens are random, made on its first deploy and kept in
// `.alchemy/stages/<stage>.env.json` (gitignored, 0600); its Access service token's credentials are written next
// to it by alchemy.run.ts. Nothing secret is printed. The alchemy profile is $ALCHEMY_PROFILE or `default`.
// CI passes the tokens in the environment instead (deploy-prod.yml: the laptop's prod tokens; CI never makes them).
//
// Every deploy needs the Deployment settings (docs/deploy.md; lib/deploymentSettings.ts), from the environment or else
// ~/.config/t3flare/dev.env, the environment winning, so one can be given on the command line:
//
//   T3FLARE_OWNER_EMAIL=you@example.com node scripts/stage.ts deploy <stage>
//
// A missing or malformed one is refused before anything is built.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { credentialsFile, secretsFile as secretsFileOf, standinFile } from "../stage-files.ts";
import { buildWorker } from "../build.ts";
import { t3ServerVersion } from "../serverVersion.ts";
import { buildAgentsWorker } from "../../agents/build.ts";
import { isDurableObjectClassNotFound } from "./deploy-retry.ts";
import { adminClient, ensureModelEndpoint } from "./lib/modelEndpoint.ts";
import { allDeploySettings, deployPlan, devEnvNames, OPTIONAL_DEPLOY_SETTINGS } from "./lib/deployPlan.ts";
import { MODEL_ENDPOINT_VAR, type ModelEndpointSpecResult } from "./lib/modelEndpointSpec.ts";

const here = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(here, "../..");
// Every pnpm command this script starts belongs to the root workspace, never t3code's (AGENTS.md; ADR-0030).
process.env.NPM_CONFIG_WORKSPACE_DIR = repoRoot;
const [command, stage, ...rest] = process.argv.slice(2);

/**
 * The stages this repo deploys to; anything else is refused, so a typo cannot create a stray stage. `prod` is the
 * owner's long-lived Environment, deployed from `main` only; step branches use their own throwaway stages.
 */
const STAGES = new Set(["prod", "step1", "bump", "step2a", "models", "step2a2", "step2b", "debug2b", "leftovers", "ghfix", "modefix", "costwins", "step3", "idlesafe", "attach", "truecaps", "noanalytics", "bigrepo", "step3plus", "step4a", "step4b", "spi992", "pre1061", "tools", "stock", "pnpm", "bump1", "spi1079", "panel", "link", "ports", "ports2", "p996", "p997", "p1100", "pbatch", "pbatch2", "previews", "profilesave", "spi1141", "spi1050", "p1001", "penv", "pcli", "pvars", "penvsk", "pmise", "pclienv", "pgitobj", "p1160", "p1161", "p1162", "p1163", "p1164", "p1165", "p1166", "p1167", "p1168", "p1169", "p1170", "p1171", "p1172", "p1173", "p1174", "p1175", "p1176", "psettings", "psmcp", "demo"]);

if (command === undefined || stage === undefined || !STAGES.has(stage)) {
  console.error(`usage: node scripts/stage.ts deploy|run|destroy <${[...STAGES].join("|")}> …`);
  process.exit(2);
}

const secretsFile = secretsFileOf(stage);
const token = () => randomBytes(32).toString("base64url");

const STAGE_SECRETS = ["T3_BOOTSTRAP_TOKEN", "T3FLARE_ADMIN_TOKEN"];
const inCI = process.env.GITHUB_ACTIONS === "true";
const stageSecrets = (): Record<string, string> => {
  if (STAGE_SECRETS.every((name) => process.env[name])) return Object.fromEntries(STAGE_SECRETS.map((name) => [name, process.env[name]!]));
  if (fs.existsSync(secretsFile)) {
    const kept = JSON.parse(fs.readFileSync(secretsFile, "utf8")) as Record<string, string>;
    // The tools step's fixture MCP server's bearer (test stages): made once, kept with the stage's tokens, destroyed with
    // them. The owner pastes it into the fixture MCP server's settings for the `fixture` toolkit, from this file.
    if (stage !== "prod" && kept.T3FLARE_FIXTURE_BEARER === undefined) {
      kept.T3FLARE_FIXTURE_BEARER = token();
      fs.writeFileSync(secretsFile, JSON.stringify(kept), { mode: 0o600 });
    }
    // Parity batch 2's probe Worker's key (test stages): its stand-ins' credentials and the log's bearer.
    if (stage !== "prod" && kept.T3FLARE_PROBE_KEY === undefined) {
      kept.T3FLARE_PROBE_KEY = token();
      fs.writeFileSync(secretsFile, JSON.stringify(kept), { mode: 0o600 });
    }
    return kept;
  }
  if (stage === "prod" && inCI) {
    // New tokens would lock the owner's clients out of prod.
    console.error(`t3flare: CI needs prod's ${STAGE_SECRETS.join(" and ")} (the GitHub environment \`prod\`)`);
    process.exit(1);
  }
  const secrets = { T3_BOOTSTRAP_TOKEN: token(), T3FLARE_ADMIN_TOKEN: token(), ...(stage === "prod" ? {} : { T3FLARE_FIXTURE_BEARER: token(), T3FLARE_PROBE_KEY: token() }) };
  fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
  fs.writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
  return secrets;
};

/**
 * The deploy-wide settings (step 2a): the GitHub App and the Deployment settings (lib/deployPlan.ts lists them), and `extra`, from the environment
 * (CI) or else ~/.config/t3flare/dev.env (0600,
 * outside the repo), which bash reads as it is written (multi-line values included). Shell variables win. Never printed.
 */
const deploySecrets = (extra: ReadonlyArray<string> = []): Record<string, string> => {
  const names = allDeploySettings(extra);
  const fromEnv = Object.fromEntries(names.flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])));
  const wanted = devEnvNames(fromEnv, extra);
  const file = path.join(process.env.HOME ?? "", ".config/t3flare/dev.env");
  if (wanted.length === 0 || !fs.existsSync(file)) return fromEnv;
  const script = `set -a; . "$1"; set +a; node -e 'process.stdout.write(JSON.stringify(Object.fromEntries(process.argv.slice(1).map((n) => [n, process.env[n] ?? ""]))))' ${wanted.join(" ")}`;
  const result = spawnSync("bash", ["-c", script, "-", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("t3flare: could not read ~/.config/t3flare/dev.env");
  const fromFile = JSON.parse(result.stdout) as Record<string, string>;
  return { ...Object.fromEntries(Object.entries(fromFile).filter(([, value]) => value !== "")), ...fromEnv };
};

/**
 * SPI-1175: the stage's Model endpoints after a good deploy, through the panel's API with the stage's service token and
 * admin token (lib/modelEndpoint.ts). prod keeps an endpoint already there as the owner left it; a test stage saves it
 * again. Text generation follows the endpoints' default unless the owner picked. The exit status.
 */
const setUpEndpoint = async (endpoint: ModelEndpointSpecResult): Promise<number> => {
  if (!endpoint.ok) {
    console.log(`t3flare: no Model endpoint set up: ${endpoint.reason}`);
    return 0;
  }
  const access = JSON.parse(fs.readFileSync(credentialsFile(stage), "utf8")) as { url: string; clientId: string; clientSecret: string };
  const admin = adminClient({ url: access.url, adminToken: stageSecrets().T3FLARE_ADMIN_TOKEN!, clientId: access.clientId, clientSecret: access.clientSecret });
  for (const spec of endpoint.specs) {
    const result = await ensureModelEndpoint(admin, spec, { overwrite: stage !== "prod", waitMs: 5 * 60_000 });
    if (!result.ok) {
      console.error(`t3flare: deployed, but the Model endpoint "${spec.id}" was not set up: ${result.error}`);
      return 1;
    }
    console.log(`t3flare: Model endpoint "${result.id}" ${result.outcome} (from ${endpoint.source}, ${result.models} models; its small model ${result.turnModel})`);
  }
  return 0;
};

/** Runs alchemy, streaming its output live (it prints no secrets) while keeping a copy for the retry decision. */
const alchemy = (args: Array<string>, env: Record<string, string>) =>
  new Promise<{ status: number; output: string }>((resolve) => {
    const child = spawn(path.join(here, "node_modules/.bin/alchemy"), [...args, "--stage", stage, "--yes", "--no-input"], {
      cwd: here,
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      console.error(`t3flare: could not run alchemy: ${error.message}`);
      resolve({ status: 1, output });
    });
    child.on("close", (code) => resolve({ status: code ?? 1, output }));
  });

switch (command) {
  case "deploy": {
    if (stage === "prod") {
      const git = (...args: Array<string>) => spawnSync("git", args, { cwd: here, encoding: "utf8" }).stdout.trim();
      // CI checks out a detached HEAD; the pushed ref says which branch it is.
      const branch = inCI ? process.env.GITHUB_REF : `refs/heads/${git("branch", "--show-current")}`;
      if (branch !== "refs/heads/main" || git("status", "--porcelain") !== "") {
        console.error("t3flare: prod deploys only from a clean checkout of main");
        process.exit(2);
      }
      // prod is served at its custom domain (alchemy.run.ts); a deploy without it would drop that host from Access.
      if (!process.env.T3FLARE_DOMAIN) {
        console.error("t3flare: set T3FLARE_DOMAIN (prod's custom domain) to deploy prod");
        process.exit(2);
      }
    }
    // A pnpm or vp command run inside t3code/ installs it as its own workspace and repoints t3's packages.
    if (fs.existsSync(path.join(repoRoot, "t3code/node_modules/.pnpm"))) {
      console.error("t3flare: t3code/node_modules/.pnpm exists (a pnpm command ran inside t3code/); remove t3code/node_modules and run `pnpm install`");
      process.exit(2);
    }
    // SPI-1175: what is bound and set up, decided before anything is built (lib/deployPlan.ts): the stage's Model endpoints
    // come from T3FLARE_MODEL_ENDPOINT, else a logged skip (the stage then starts in the setup state).
    const plan = deployPlan({ stage, args: rest, read: deploySecrets([MODEL_ENDPOINT_VAR, ...OPTIONAL_DEPLOY_SETTINGS]), env: process.env });
    if (!plan.ok) {
      console.error(plan.error);
      process.exit(1);
    }
    for (const note of plan.notes) console.log(`t3flare: ${note}`);
    // The Server version (in-app updates plan D1): the pin's tag, stamped into the Worker (build.ts) and the web client
    // (APP_VERSION). prod is always on a tag: a stock client compares its own version with it to offer an Update.
    const serverVersion = t3ServerVersion();
    if (stage === "prod" && !serverVersion.exact) {
      console.error("t3flare: t3code is not at an exact tag (git -C t3code describe --tags --exact-match HEAD); prod deploys only a tagged pin");
      process.exit(2);
    }
    if (rest.includes("--web") || !fs.existsSync(path.join(here, "dist/web/index.html"))) {
      const web = spawnSync("pnpm", ["run", "prepare:web"], { cwd: here, stdio: "inherit", env: { ...process.env, APP_VERSION: serverVersion.version } });
      if (web.status !== 0) process.exit(web.status ?? 1);
    }
    await buildWorker();
    await buildAgentsWorker();
    const env = { ...stageSecrets(), ...plan.alchemyEnv };
    const attempt = await alchemy(["deploy"], env);
    let status = attempt.status;
    // Only a brand-new stage fails this way: each Worker's Durable Object binding to a class in the other does not
    // exist yet (isDurableObjectClassNotFound). Deploy both once without the cross-Worker bindings, then again with
    // them. Any other failure exits as is: the first pass would unbind a live stage.
    if (status !== 0 && isDurableObjectClassNotFound(attempt.output)) {
      console.error("t3flare: Durable Object class not found; retrying in two passes (the first without cross-Worker bindings)");
      const first = await alchemy(["deploy"], { ...env, T3FLARE_DEPLOY_BOOTSTRAP: "1" });
      status = first.status === 0 ? (await alchemy(["deploy"], env)).status : first.status;
    }
    if (status === 0 && !fs.existsSync(credentialsFile(stage))) {
      console.error(`t3flare: deployed, but ${path.relative(here, credentialsFile(stage))} was not written`);
      process.exit(1);
    }
    if (status !== 0) process.exit(status);
    process.exit(await setUpEndpoint(plan.endpoint));
  }
  case "run": {
    const [script, ...args] = rest;
    if (script === undefined) {
      console.error("usage: node scripts/stage.ts run <stage> <script> [args]");
      process.exit(2);
    }
    const access = JSON.parse(fs.readFileSync(credentialsFile(stage), "utf8")) as { url: string; adminUrl?: string; settingsMcpUrl?: string; clientId: string; clientSecret: string };
    // Each script's fetch retries a connection Cloudflare's edge reset (lib/resetRetry.ts).
    const installResetRetry = url.pathToFileURL(path.join(here, "scripts/lib/installResetRetry.ts")).href;
    const result = spawnSync(process.execPath, ["--import", installResetRetry, path.join(here, "scripts", `${script}.ts`), ...args], {
      cwd: here,
      stdio: "inherit",
      env: {
        ...process.env,
        ...stageSecrets(),
        // The Model endpoint's setting too (SPI-1175): acceptance.ts sets it up before its turns. And the Deployment
        // settings, the fixture repository among them, which the scripts read through lib/scriptSettings.ts.
        ...deploySecrets([MODEL_ENDPOINT_VAR, ...OPTIONAL_DEPLOY_SETTINGS]),
        T3_URL: access.url,
        T3FLARE_HARNESS_URL: access.url,
        // The Settings server's Owner-client endpoint (ADR-0035, plan D13), for the stage's MCP clients.
        ...(access.settingsMcpUrl === undefined ? {} : { T3FLARE_SETTINGS_MCP_URL: access.settingsMcpUrl }),
        T3FLARE_ACCESS_CLIENT_ID: access.clientId,
        T3FLARE_ACCESS_CLIENT_SECRET: access.clientSecret,
      },
    });
    process.exit(result.status ?? 1);
  }
  case "destroy": {
    if (stage === "prod" && !rest.includes("--really-destroy-prod")) {
      console.error("t3flare: prod holds the owner's threads; pass --really-destroy-prod to destroy it");
      process.exit(2);
    }
    const { status } = await alchemy(["destroy"], { ...stageSecrets(), ...deploySecrets(OPTIONAL_DEPLOY_SETTINGS) });
    if (status === 0) {
      fs.rmSync(secretsFile, { force: true });
      fs.rmSync(credentialsFile(stage), { force: true });
      fs.rmSync(standinFile(stage), { force: true });
    }
    process.exit(status);
  }
  default:
    console.error(`unknown command ${command}`);
    process.exit(2);
}
