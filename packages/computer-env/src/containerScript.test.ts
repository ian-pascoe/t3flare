// The Durable agent's Container commands start with the Environment skills' lock (SPI-1148, ADR-0033): its `bash`
// reaches the Container through computer's stub, not the Workspace DO's `exec`, so the lock is in its wrapper too.
import { SKILLS_LOCK_SCRIPT } from "@t3flare/workspace-client";
import { describe, expect, it, vi } from "vitest";

// env.ts loads computer, whose module loads `cloudflare:` URLs Node cannot; nothing of it runs here.
vi.mock("@cloudflare/computer", () => ({ shellQuote: (word: string) => `'${word.replaceAll("'", "'\\''")}'`, getWorkspace: () => ({}) }));

const { BACKENDS } = await import("./env.ts");
const { inBash } = await import("./shell.ts");

describe("BACKENDS.container", () => {
  it("puts the lock before the command's bash, and leaves the command as it was", () => {
    expect(BACKENDS.container.script("echo hi")).toBe(`${SKILLS_LOCK_SCRIPT}${inBash("echo hi")}`);
  });

  it("leaves the Worker Shell's commands alone", () => {
    expect(BACKENDS.worker.script("echo hi")).toBe("echo hi");
  });
});
