// The isolated T3 Code (Nightly) instance the shots are recorded from, beside the Owner's own running app.
//
// Isolation is a separate HOME: the desktop takes its userData directory, and so its single-instance lock, from
// os.homedir(). T3CODE_HOME gives it its own server state; --use-mock-keychain keeps it off the Owner's Keychain.
// A scutil shim makes the laptop's label a neutral "MacBook Pro" (t3's ServerEnvironmentLabel runs `scutil --get
// ComputerName` by name). Auto-update is off: a nightly installed on quit would replace the bundle the Owner's app
// runs from. The window is parked on a spare AeroSpace workspace; the shots record the page over CDP, not the screen.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CAP = process.env.T3FLARE_DEMO_DIR ?? path.join(os.homedir(), ".cache", "t3flare-demo");
export const CDP_PORT = 9333;
const APP = "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)";
const SPARE_WORKSPACE = process.env.T3FLARE_DEMO_WORKSPACE ?? "9";

const home = path.join(CAP, "home");
const bin = path.join(CAP, "bin");

const sh = (cmd: string, args: ReadonlyArray<string>): string => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The fake HOME, the scutil shim, and the shell files that keep the shim first on PATH after path_helper. */
export const prepareHome = (): void => {
  for (const dir of [home, bin, path.join(CAP, "t3home"), path.join(CAP, "raw")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "scutil"),
    `#!/bin/sh\nif [ "$1" = "--get" ] && [ "$2" = "ComputerName" ]; then echo "MacBook Pro"; exit 0; fi\nexec /usr/sbin/scutil "$@"\n`,
    { mode: 0o755 },
  );
  const line = `export PATH="${bin}:$PATH"\n`;
  for (const file of [".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc"]) fs.writeFileSync(path.join(home, file), line);
};

export const instancePid = (): number | undefined => {
  try {
    const out = sh("pgrep", ["-f", `^${APP.replace(/[()]/g, "\\$&")} --remote-debugging-port=${CDP_PORT}`]);
    return out ? Number(out.split("\n")[0]) : undefined;
  } catch {
    return undefined;
  }
};

const windowOf = (pid: number): string | undefined =>
  sh("aerospace", ["list-windows", "--all", "--format", "%{window-id}|%{app-pid}"])
    .split("\n")
    .find((line) => line.endsWith(`|${pid}`))
    ?.split("|")[0];

export const launch = async (): Promise<number> => {
  const running = instancePid();
  if (running !== undefined) return running;
  prepareHome();
  const focused = sh("aerospace", ["list-workspaces", "--focused"]);
  const child = spawn(
    APP,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      "--use-mock-keychain",
      "--force-device-scale-factor=2",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
    ],
    {
      cwd: home,
      detached: true,
      stdio: ["ignore", fs.openSync(path.join(CAP, "instance.log"), "w"), fs.openSync(path.join(CAP, "instance.log"), "a")],
      env: {
        HOME: home,
        USER: os.userInfo().username,
        LOGNAME: os.userInfo().username,
        SHELL: "/bin/zsh",
        TMPDIR: os.tmpdir(),
        LANG: "en_US.UTF-8",
        PATH: `${bin}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        T3CODE_HOME: path.join(CAP, "t3home"),
        T3CODE_DISABLE_AUTO_UPDATE: "1",
        T3CODE_TELEMETRY_ENABLED: "false",
      },
    },
  );
  child.unref();
  const pid = child.pid!;
  for (let i = 0; i < 60; i++) {
    const window = windowOf(pid);
    if (window) {
      sh("aerospace", ["move-node-to-workspace", "--window-id", window, SPARE_WORKSPACE]);
      if (sh("aerospace", ["list-workspaces", "--focused"]) !== focused) sh("aerospace", ["workspace", focused]);
      break;
    }
    await sleep(500);
  }
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      if (res.ok && ((await res.json()) as Array<unknown>).length > 0) return pid;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error("the isolated instance did not expose CDP");
};

/**
 * Floats the instance's window, so the tiling manager leaves its size alone. Its page then sizes it (ab.ts attach):
 * at the window's real 2x scale Chrome's screencast stays full density, which emulating the scale would not.
 */
export const floatWindow = (): void => {
  const pid = instancePid();
  const window = pid === undefined ? undefined : windowOf(pid);
  if (!window) return;
  try {
    execFileSync("aerospace", ["layout", "floating", "--window-id", window], { stdio: "ignore" });
  } catch {
    // already floating
  }
};

export const stop = async (): Promise<void> => {
  const pid = instancePid();
  if (pid === undefined) return;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 40 && instancePid() !== undefined; i++) await sleep(250);
};
