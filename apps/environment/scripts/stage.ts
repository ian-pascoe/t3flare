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
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { credentialsFile, secretsFile as secretsFileOf } from "../stage-files.ts";
import { buildWorker } from "../build.ts";
import { buildAgentsWorker } from "../../agents/build.ts";

const here = path.resolve(import.meta.dirname, "..");
const [command, stage, ...rest] = process.argv.slice(2);

/**
 * The stages this repo deploys to; anything else is refused, so a typo cannot create a stray stage. `prod` is the
 * owner's long-lived Environment, deployed from `main` only; step branches use their own throwaway stages.
 */
const STAGES = new Set(["prod", "step1", "bump", "step2a", "models"]);

if (command === undefined || stage === undefined || !STAGES.has(stage)) {
  console.error(`usage: bun scripts/stage.ts deploy|run|destroy <${[...STAGES].join("|")}> …`);
  process.exit(2);
}

const secretsFile = secretsFileOf(stage);
const token = () => randomBytes(32).toString("base64url");

const stageSecrets = (): Record<string, string> => {
  if (fs.existsSync(secretsFile)) return JSON.parse(fs.readFileSync(secretsFile, "utf8"));
  const secrets = { T3_BOOTSTRAP_TOKEN: token(), T3FLARE_ADMIN_TOKEN: token() };
  fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
  fs.writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
  return secrets;
};

/**
 * The deploy-wide secrets (step 2a): the model proxy and the GitHub App, from the environment (CI) or else from
 * ~/.config/t3flare/dev.env (0600, outside the repo), which bash reads as it is written (multi-line values included).
 * Never printed.
 */
const DEPLOY_SECRETS = ["MODEL_PROXY_URL", "MODEL_PROXY_API_KEY", "T3FLARE_GITHUB_APP_ID", "T3FLARE_GITHUB_APP_PRIVATE_KEY"];
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

const alchemy = (args: Array<string>, env: Record<string, string>) => {
  const result = spawnSync(path.join(here, "node_modules/.bin/alchemy"), [...args, "--stage", stage, "--yes", "--no-input"], {
    cwd: here,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  return result.status ?? 1;
};

switch (command) {
  case "deploy": {
    if (stage === "prod") {
      const git = (...args: Array<string>) => spawnSync("git", args, { cwd: here, encoding: "utf8" }).stdout.trim();
      if (git("branch", "--show-current") !== "main" || git("status", "--porcelain") !== "") {
        console.error("t3flare: prod deploys only from a clean checkout of main");
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
    let status = alchemy(["deploy"], { ...stageSecrets(), ...secrets });
    if (status !== 0) {
      // On a stage whose Workers do not exist yet, each Worker's Durable Object binding to a class in the other fails
      // (DurableObjectClassNotFound). Deploy both once without the cross-Worker bindings, then again with them.
      console.error("t3flare: deploy failed; retrying in two passes (the first without cross-Worker bindings)");
      const first = alchemy(["deploy"], { ...stageSecrets(), ...secrets, T3FLARE_DEPLOY_BOOTSTRAP: "1" });
      status = first === 0 ? alchemy(["deploy"], { ...stageSecrets(), ...secrets }) : first;
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
    const access = JSON.parse(fs.readFileSync(credentialsFile(stage), "utf8")) as { url: string; clientId: string; clientSecret: string };
    const result = spawnSync("bun", [path.join(here, "scripts", `${script}.ts`), ...args], {
      cwd: here,
      stdio: "inherit",
      env: {
        ...process.env,
        ...stageSecrets(),
        ...deploySecrets(),
        T3_URL: access.url,
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
    const status = alchemy(["destroy"], { ...stageSecrets(), ...deploySecrets() });
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
