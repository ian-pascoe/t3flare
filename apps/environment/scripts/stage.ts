// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// Deploys, tests and destroys a stage of the environment Worker, with secrets made for that stage alone.
//
//   bun scripts/stage.ts deploy <stage> [--web]       build (and the web client with --web or when missing), alchemy deploy
//   bun scripts/stage.ts run <stage> <script> [args]  run scripts/<script>.ts against the stage, with its secrets
//   bun scripts/stage.ts destroy <stage>              alchemy destroy, and forget the stage's secrets
//
// The stage's bootstrap and admin tokens are random, made on its first deploy and kept in
// `.alchemy/stages/<stage>.env.json` (gitignored, 0600); its Access service token's credentials are written next
// to it by alchemy.run.ts. Nothing secret is printed. The alchemy profile is $ALCHEMY_PROFILE or `default`.
// CI passes the tokens in the environment instead (deploy-prod.yml: the laptop's prod tokens; CI never makes them).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { credentialsFile, secretsFile as secretsFileOf } from "../stage-files.ts";
import { buildWorker } from "../build.ts";
import { buildAgentsWorker } from "../../agents/build.ts";
import { isDurableObjectClassNotFound } from "./deploy-retry.ts";

const here = path.resolve(import.meta.dirname, "..");
const [command, stage, ...rest] = process.argv.slice(2);

/**
 * The stages this repo deploys to; anything else is refused, so a typo cannot create a stray stage. `prod` is the
 * owner's long-lived Environment, deployed from `main` only; step branches use their own throwaway stages.
 */
const STAGES = new Set(["prod", "step1", "bump", "step2a", "models", "step2a2", "step2b", "debug2b", "leftovers", "ghfix", "modefix", "costwins", "step3", "idlesafe", "attach", "truecaps", "noanalytics", "bigrepo", "step3plus", "step4a", "step4b", "spi992", "pre1061", "tools", "stock"]);

if (command === undefined || stage === undefined || !STAGES.has(stage)) {
  console.error(`usage: bun scripts/stage.ts deploy|run|destroy <${[...STAGES].join("|")}> …`);
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
    // them. The owner pastes it into Commissary's panel for the `fixture` toolkit, from this file.
    if (stage !== "prod" && kept.T3FLARE_FIXTURE_BEARER === undefined) {
      kept.T3FLARE_FIXTURE_BEARER = token();
      fs.writeFileSync(secretsFile, JSON.stringify(kept), { mode: 0o600 });
    }
    return kept;
  }
  if (stage === "prod" && inCI) {
    // New tokens would lock the owner's clients out of prod.
    console.error(`t3flare: CI needs prod's ${STAGE_SECRETS.join(" and ")} (the GitHub environment \`prod\`)`);
    process.exit(1);
  }
  const secrets = { T3_BOOTSTRAP_TOKEN: token(), T3FLARE_ADMIN_TOKEN: token(), ...(stage === "prod" ? {} : { T3FLARE_FIXTURE_BEARER: token() }) };
  fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
  fs.writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
  return secrets;
};

/**
 * The deploy-wide secrets (step 2a): the model proxy and the GitHub App, from the environment (CI) or else from
 * ~/.config/t3flare/dev.env (0600, outside the repo), which bash reads as it is written (multi-line values included).
 * Never printed.
 */
const DEPLOY_SECRETS = ["MODEL_PROXY_URL", "MODEL_PROXY_API_KEY", "T3FLARE_GITHUB_APP_ID", "T3FLARE_GITHUB_APP_PRIVATE_KEY", "COMMISSARY_CONTAINER_API_KEY"];
const deploySecrets = (): Record<string, string> => {
  const fromEnv = Object.fromEntries(DEPLOY_SECRETS.flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])));
  if (Object.keys(fromEnv).length === DEPLOY_SECRETS.length) return fromEnv;
  const file = path.join(process.env.HOME ?? "", ".config/t3flare/dev.env");
  if (!fs.existsSync(file)) return fromEnv;
  const script = `set -a; . "$1"; set +a; node -e 'process.stdout.write(JSON.stringify(Object.fromEntries(process.argv.slice(1).map((n) => [n, process.env[n] ?? ""]))))' ${DEPLOY_SECRETS.join(" ")}`;
  const result = spawnSync("bash", ["-c", script, "-", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("t3flare: could not read ~/.config/t3flare/dev.env");
  const fromFile = JSON.parse(result.stdout) as Record<string, string>;
  return { ...Object.fromEntries(Object.entries(fromFile).filter(([, value]) => value !== "")), ...fromEnv };
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
    if (rest.includes("--web") || !fs.existsSync(path.join(here, "dist/web/index.html"))) {
      const web = spawnSync("bun", ["run", "prepare:web"], { cwd: here, stdio: "inherit" });
      if (web.status !== 0) process.exit(web.status ?? 1);
    }
    await buildWorker();
    await buildAgentsWorker();
    const secrets = deploySecrets();
    const missing = DEPLOY_SECRETS.filter((name) => secrets[name] === undefined);
    if (missing.length > 0) {
      console.error(`t3flare: missing ${missing.join(", ")} (set them, or put them in ~/.config/t3flare/dev.env)`);
      process.exit(1);
    }
    const attempt = await alchemy(["deploy"], { ...stageSecrets(), ...secrets });
    let status = attempt.status;
    // Only a brand-new stage fails this way: each Worker's Durable Object binding to a class in the other does not
    // exist yet (isDurableObjectClassNotFound). Deploy both once without the cross-Worker bindings, then again with
    // them. Any other failure exits as is: the first pass would unbind a live stage.
    if (status !== 0 && isDurableObjectClassNotFound(attempt.output)) {
      console.error("t3flare: Durable Object class not found; retrying in two passes (the first without cross-Worker bindings)");
      const first = await alchemy(["deploy"], { ...stageSecrets(), ...secrets, T3FLARE_DEPLOY_BOOTSTRAP: "1" });
      status = first.status === 0 ? (await alchemy(["deploy"], { ...stageSecrets(), ...secrets })).status : first.status;
    }
    if (status === 0 && !fs.existsSync(credentialsFile(stage))) {
      console.error(`t3flare: deployed, but ${path.relative(here, credentialsFile(stage))} was not written`);
      process.exit(1);
    }
    process.exit(status);
  }
  case "run": {
    const [script, ...args] = rest;
    if (script === undefined) {
      console.error("usage: bun scripts/stage.ts run <stage> <script> [args]");
      process.exit(2);
    }
    const access = JSON.parse(fs.readFileSync(credentialsFile(stage), "utf8")) as { url: string; adminUrl?: string; clientId: string; clientSecret: string };
    const result = spawnSync("bun", [path.join(here, "scripts", `${script}.ts`), ...args], {
      cwd: here,
      stdio: "inherit",
      env: {
        ...process.env,
        ...stageSecrets(),
        ...deploySecrets(),
        T3_URL: access.url,
        T3FLARE_HARNESS_URL: access.url,
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
    const { status } = await alchemy(["destroy"], { ...stageSecrets(), ...deploySecrets() });
    if (status === 0) {
      fs.rmSync(secretsFile, { force: true });
      fs.rmSync(credentialsFile(stage), { force: true });
    }
    process.exit(status);
  }
  default:
    console.error(`unknown command ${command}`);
    process.exit(2);
}
