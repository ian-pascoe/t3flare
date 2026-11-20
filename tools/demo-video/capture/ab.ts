// agent-browser, attached to the isolated instance over CDP, in its own session.
import { execFileSync } from "node:child_process";
import { CDP_PORT } from "./instance.ts";

const SESSION = "t3flare-demo";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const ab = (...args: ReadonlyArray<string>): string =>
  execFileSync("agent-browser", ["--session", SESSION, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Attach, and size the (floating) window to 1440 x 810 at its real 2x: frames are 2880 x 1620. */
export const attach = async (): Promise<void> => {
  ab("connect", String(CDP_PORT));
  ab("eval", "window.resizeTo(1440, 810)");
  await sleep(800);
};

export const evaluate = <T>(js: string): T => JSON.parse(JSON.parse(ab("eval", `JSON.stringify((() => { ${js} })())`)) as string) as T;

/** Waits until `js` (an expression) is truthy in the page. */
export const waitFor = async (js: string, timeoutMs = 60_000, label = js): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (evaluate<boolean>(`return Boolean(${js});`)) return;
    } catch {
      // the page may be navigating
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for: ${label}`);
};

/** Waits until the page's text contains `text`. */
export const waitForText = (text: string, timeoutMs = 60_000) =>
  waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, timeoutMs, text);

/** The ref of the first interactive element whose snapshot line matches. */
export const ref = (pattern: RegExp): string => {
  const line = ab("snapshot", "-i")
    .split("\n")
    .find((l) => pattern.test(l));
  const found = line?.match(/ref=(e\d+)/)?.[1];
  if (!found) throw new Error(`no element matches ${pattern}`);
  return `@${found}`;
};

export const tap = (pattern: RegExp): void => {
  ab("click", ref(pattern));
};

/**
 * Moves the (recorded) pointer onto an element and clicks it unless click is false. `target` is a CSS selector, or
 * a JS expression for the element when it starts with "js:".
 */
export const pointAt = async (target: string, { click = true, settleMs = 120 } = {}): Promise<void> => {
  const element = target.startsWith("js:") ? target.slice(3) : `document.querySelector(${JSON.stringify(target)})`;
  const at = evaluate<{ x: number; y: number } | null>(
    `const e = ${element}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`,
  );
  if (!at) throw new Error(`no element for ${target}`);
  ab("mouse", "move", String(at.x), String(at.y));
  await sleep(settleMs);
  if (click) {
    ab("mouse", "down");
    ab("mouse", "up");
  }
};
