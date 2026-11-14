// The Workspace DO's Environment skill set (SPI-1148, plan §4.1) over a real computer Workspace in a real Durable
// Object: a take serves the set read-only at the mount (computer patched with `remount()`), a later take replaces it
// whole, the listing follows, and a copy that fails leaves the set held before (else the empty set), read-only.
import { env } from "cloudflare:workers";
import { skillSetOf } from "@t3flare/skills";
import { describe, expect, it } from "vitest";

import type { SkillSetProbe } from "./workerd.fixture.ts";

const bindings = env as unknown as { SKILL_SET_PROBE: DurableObjectNamespace<SkillSetProbe> };
const probe = () => bindings.SKILL_SET_PROBE.get(bindings.SKILL_SET_PROBE.newUniqueId());
const md = (name: string, body = "Steps.") => `---\nname: ${name}\ndescription: What ${name} does.\n---\n${body}\n`;

describe("the Environment skill set in a Workspace", () => {
  it("serves a set read-only at the mount, and replaces it whole on the next take", async () => {
    const p = probe();
    expect(await p.find()).toEqual([]);
    const first = await skillSetOf({ "a/SKILL.md": md("a", "PLUM-9"), "a/refs/x.md": "x", "b/SKILL.md": md("b") });
    expect(await p.take(first)).toEqual({ hash: first.hash });
    expect(await p.read("/workspace/.agents/skills/a/SKILL.md")).toBe(md("a", "PLUM-9"));
    expect((await p.listing()).map((skill) => [skill.name, skill.filePath])).toEqual([
      ["a", "/workspace/.agents/skills/a/SKILL.md"],
      ["b", "/workspace/.agents/skills/b/SKILL.md"],
    ]);
    expect(await p.write("/workspace/.agents/skills/a/new.md")).toMatch(/read-only mount at \/workspace\/\.agents\/skills/);
    expect(await p.write("/workspace/.agents/skills/c/SKILL.md")).toMatch(/read-only mount/);
    const second = await skillSetOf({ "a/SKILL.md": md("a", "PLUM-10") });
    expect(await p.take(second)).toEqual({ hash: second.hash });
    expect(await p.read("/workspace/.agents/skills/a/SKILL.md")).toBe(md("a", "PLUM-10"));
    expect(await p.read("/workspace/.agents/skills/b/SKILL.md")).toBeNull();
    expect((await p.listing()).map((skill) => skill.name)).toEqual(["a"]);
  });

  it("keeps the set held before when a copy fails, read-only", async () => {
    const p = probe();
    const held = await skillSetOf({ "a/SKILL.md": md("a") });
    await p.take(held);
    const failing = await skillSetOf({ "boom/SKILL.md": md("boom") });
    const answer = await p.take(failing);
    expect(answer.error).toMatch(/^The Environment skill set could not be mounted, and the Workspace keeps the one it held: .*boom/);
    expect(answer.hash).toBe(held.hash);
    expect(await p.read("/workspace/.agents/skills/a/SKILL.md")).toBe(md("a"));
    expect(await p.write("/workspace/.agents/skills/a/x.md")).toMatch(/read-only mount/);
  });

  it("falls back to the empty set, read-only, when the set held before cannot be copied again either", async () => {
    const p = probe();
    const held = await skillSetOf({ "a/SKILL.md": md("a") });
    await p.take(held);
    await p.failAll(true);
    const answer = await p.take(await skillSetOf({ "b/SKILL.md": md("b") }));
    expect(answer.error).toMatch(/could not be mounted/);
    expect(answer.hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await p.find()).toEqual([]);
    expect(await p.write("/workspace/.agents/skills/a/SKILL.md")).toMatch(/read-only mount/);
  });
});
