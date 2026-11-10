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

const here = path.resolve(import.meta.dirname, "..");
const [command, stage, ...rest] = process.argv.slice(2);

/** The stages this repo deploys to; anything else is refused, so a typo cannot create a stray stage. */
const STAGES = new Set(["step1", "bump"]);

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
    if (rest.includes("--web") || !fs.existsSync(path.join(here, "dist/web/index.html"))) {
      const web = spawnSync("bun", ["run", "prepare:web"], { cwd: here, stdio: "inherit" });
      if (web.status !== 0) process.exit(web.status ?? 1);
    }
    await buildWorker();
    const status = alchemy(["deploy"], stageSecrets());
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
        T3_URL: access.url,
        T3FLARE_ACCESS_CLIENT_ID: access.clientId,
        T3FLARE_ACCESS_CLIENT_SECRET: access.clientSecret,
      },
    });
    process.exit(result.status ?? 1);
  }
  case "destroy": {
    const status = alchemy(["destroy"], stageSecrets());
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
