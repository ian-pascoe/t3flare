// The shots. Each prepares the client off camera, records one raw take over CDP while logging the times of its named
// events (seconds from the take's start), and is normalised into public/footage/<shot>.mp4 (constant 30 fps,
// a keyframe each second) with <shot>.json beside it. The scenes trim to those events.
//
// The Cloud Environment is the paired Stage, labelled "t3flare"; the project is the fixture repository cloned there
// (README.md, Setup). Pi Durable runs the threads; each take starts on a new worktree, so takes do not pile up.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ab, pointAt, ref, sleep, tap, waitFor, waitForText } from "./ab.ts";
import { CAP } from "./instance.ts";

const FOOTAGE = path.resolve(import.meta.dirname, "..", "public", "footage");
const ENVIRONMENT_LABEL = "t3flare";
const MODEL = /option "PD Claude Sonnet 5\.5 , Pi Durable Commissary Add/;

export type Take = {
  /** Marks a named moment, in seconds from the start of the take. */
  readonly mark: (event: string) => void;
};

type Shot = {
  /** Off camera: put the client where the take starts. */
  readonly prepare: () => Promise<void>;
  readonly record: (take: Take) => Promise<void>;
  /** Show the pointer (interaction shots). */
  readonly cursor?: boolean;
};

const runningTurn = `document.querySelector('button[aria-label="Stop generation"]')`;
const modelButton = `js:[...document.querySelectorAll("button")].find((b) => /^(PD\\s*)?(Sonnet|Haiku|Claude)/.test(b.textContent.trim()))`;
const turnIdle = `!${runningTurn}`;

/** A new draft thread on the Cloud Environment, a new worktree, Pi Durable's Sonnet. Off camera. */
const cloudDraft = async (): Promise<void> => {
  ab("press", "Escape");
  tap(/button "New thread"/);
  await waitFor(`document.querySelector('textarea, [contenteditable=true]')`);
  await sleep(800);
  const runOn = ab("snapshot", "-i").match(/combobox "Run on"[^\n]*: (.*)$/m)?.[1];
  if (runOn?.trim() !== ENVIRONMENT_LABEL) {
    tap(/combobox "Run on"/);
    await sleep(500);
    tap(new RegExp(`option "${ENVIRONMENT_LABEL}`));
    await sleep(800);
  }
  tap(/combobox "Workspace"/);
  await sleep(500);
  tap(/option "New worktree"/);
  await sleep(500);
  tap(/button "(PD )?(Claude|Sonnet|Haiku|GPT)/);
  await sleep(600);
  await pointAt('button[aria-label="Pi Durable"]');
  await sleep(400);
  tap(MODEL);
  await sleep(400);
  ab("press", "Escape");
  ab("mouse", "move", "1500", "900");
};

const option = (label: string) =>
  `js:[...document.querySelectorAll('[role=option]')].find((o) => o.textContent.trim().startsWith(${JSON.stringify(label)}))`;

const typePrompt = (text: string, delayMs = 0): void => {
  const box = ref(/textbox "Message/);
  if (delayMs > 0) ab("type", box, "--delay", String(delayMs), "--", text);
  else ab("fill", box, text);
};

export const SHOTS: Record<string, Shot> = {
  // Beats 1 and 2: one continuous Pi Durable turn. The prompt is in the composer when the take starts; it is sent
  // at 1 s; the rest of the take is the turn working in the cloud: tool calls, the diff, the summary.
  "hook-turn": {
    prepare: async () => {
      await cloudDraft();
      typePrompt(
        "Add subtract.sh, multiply.sh and divide.sh (divide refuses a zero divisor) beside src/add.sh, cover each in test.sh, run the checks, and summarise.",
      );
    },
    record: async ({ mark }) => {
      await sleep(1000);
      ab("press", "Enter");
      mark("submit");
      await waitFor(runningTurn, 30_000, "turn running");
      mark("working");
      await waitFor(turnIdle, 240_000, "turn finished");
      mark("done");
      await sleep(2500);
    },
  },

  // Beat 3: the composer's environment selector lists the laptop and the cloud; the cloud is chosen.
  switcher: {
    cursor: true,
    prepare: async () => {
      await cloudDraft();
      ab("mouse", "move", "900", "560");
    },
    record: async ({ mark }) => {
      await sleep(800);
      await pointAt('[aria-label="Run on"]');
      await waitFor(`document.querySelectorAll('[role=option]').length >= 2`, 5000, "environment options");
      mark("open");
      await sleep(1300);
      await pointAt(option("MacBook Pro"), { click: false });
      mark("laptop");
      await sleep(900);
      await pointAt(option(ENVIRONMENT_LABEL), { click: false });
      mark("cloud");
      await sleep(900);
      ab("mouse", "down");
      ab("mouse", "up");
      mark("chosen");
      await sleep(1500);
    },
  },

  // Beat 4: a Pi Durable turn inside a bash call; the Environment restarts (POST /_t3flare/restart); t3 cancels
  // the run and RestartContinuation resumes it; the turn completes.
  "durable-restart": {
    prepare: async () => {
      await cloudDraft();
      typePrompt("Run ./test.sh five times, three seconds apart (sleep 3 between runs, one bash call per run), and report each result in a short table.");
    },
    record: async ({ mark }) => {
      await sleep(800);
      ab("press", "Enter");
      mark("submit");
      await waitForText("Running", 60_000);
      await sleep(5000);
      mark("restart");
      execFileSync("node", ["scripts/stage.ts", "run", process.env.T3FLARE_DEMO_STAGE ?? "demo", "admin", "POST", "/_t3flare/restart"], {
        cwd: path.resolve(import.meta.dirname, "..", "..", "..", "apps", "environment"),
        stdio: "ignore",
      });
      await waitForText("restarted and resumed this turn", 120_000);
      mark("notice");
      await waitFor(turnIdle, 180_000, "turn finished");
      mark("done");
      await sleep(3000);
    },
  },

  // Beat 5: the provider picker on the Cloud Environment, every agent in turn.
  providers: {
    cursor: true,
    prepare: async () => {
      await cloudDraft();
      ab("mouse", "move", "900", "560");
    },
    record: async ({ mark }) => {
      await sleep(700);
      await pointAt(modelButton);
      mark("open");
      await sleep(900);
      for (const provider of ["Codex", "Claude", "OpenCode", "Pi", "Pi Durable"]) {
        await pointAt(`button[aria-label="${provider}"]`);
        mark(provider);
        await sleep(1100);
      }
      await sleep(800);
    },
  },

  // Beat 6: written once the laptop's Peer link is set up (README.md, Beat 6).
  "remote-task": {
    prepare: async () => {
      throw new Error("remote-task: not recorded yet; the scene falls back to its placeholder");
    },
    record: async () => {},
  },
};

export const recordShot = async (name: string): Promise<void> => {
  const shot = SHOTS[name];
  if (!shot) throw new Error(`no shot ${name}`);
  fs.mkdirSync(FOOTAGE, { recursive: true });
  await shot.prepare();
  const raw = path.join(CAP, "raw", `${name}.mp4`);
  const events: Record<string, number> = {};
  ab("record", "start", raw, "--fps", "30", ...(shot.cursor ? ["--cursor"] : []));
  const start = Date.now();
  try {
    await shot.record({ mark: (event) => (events[event] = Math.round((Date.now() - start) / 100) / 10) });
  } finally {
    ab("record", "stop");
  }
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", raw,
    "-vf", "fps=30", "-c:v", "libx264", "-crf", "14", "-g", "30", "-pix_fmt", "yuv420p", "-an",
    path.join(FOOTAGE, `${name}.mp4`),
  ]);
  fs.writeFileSync(path.join(FOOTAGE, `${name}.json`), `${JSON.stringify(events, null, 2)}\n`);
  console.log(`${name}: ${JSON.stringify(events)}`);
};
