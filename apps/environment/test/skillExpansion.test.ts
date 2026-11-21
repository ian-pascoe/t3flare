// @effect-diagnostics nodeBuiltinImport:off
// Skill mentions and Slash commands in a Pi Durable message (SPI-1147 §4): `turnPrompt` expands them when its caller
// passes the thread's skills (the Pi Durable adapter, for a new turn and a steer; of the ACP flavors, OpenCode's only).
import * as NodeFs from "node:fs";

import { type ChatAttachment, MessageId, ProviderDriverKind, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { matchInlineSkills } from "@t3tools/shared/inlineSkills";
import type { SubmitTurnInput, SteerInput } from "@t3flare/session-protocol";
import { isMentionable, type PromptTemplate, SKILL_TOKEN_REGEX, type Skill, type SkillDiscovery } from "@t3flare/skills";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import { makeTurnInput } from "t3/src/orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import { describe, expect, it } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import type { SessionRpc } from "../src/agents/rpc.ts";
import { makePiDurableAdapter } from "../src/provider/adapter.ts";
import { normalise } from "../scripts/lib/upstreamFingerprint.ts";
import { type AttachmentReader, turnPrompt } from "../src/provider/attachments.ts";
import { acpInstanceFlavor } from "../src/provider/cli/acpDriver.ts";
import { CliTurn } from "../src/provider/cli/wrapper.ts";
import { messageSkillsFor, type MessageSkills, type SkillsAccess } from "../src/provider/skills.ts";

const SKILLS = "/workspace/repo/.agents/skills";
const skill = (name: string, extra: Partial<Skill> = {}): Skill => ({
  name,
  description: `${name} things`,
  filePath: `${SKILLS}/${name}/SKILL.md`,
  disableModelInvocation: false,
  ...extra,
});
const files: Record<string, string> = {
  [`${SKILLS}/fruit-code/SKILL.md`]: "---\nname: fruit-code\ndescription: The fruit code.\n---\n\nRead reference/code.md for the code.\n",
  [`${SKILLS}/veg/SKILL.md`]: "---\nname: veg\ndescription: Veg.\n---\nEat greens.",
  [`${SKILLS}/huge/SKILL.md`]: `---\nname: huge\ndescription: Huge.\n---\n${"h".repeat(130_000)}`,
  "/workspace/repo/.pi/prompts/echo.md": "---\ndescription: Echo\n---\nReply with exactly: ECHO $1 ${2:-none}",
};
const templates: ReadonlyArray<PromptTemplate> = [{ name: "echo", description: "Echo", filePath: "/workspace/repo/.pi/prompts/echo.md" }];

const fruitBlock = `<skill name="fruit-code" location="${SKILLS}/fruit-code/SKILL.md">\nReferences are relative to ${SKILLS}/fruit-code.\n\nRead reference/code.md for the code.\n</skill>`;
const vegBlock = `<skill name="veg" location="${SKILLS}/veg/SKILL.md">\nReferences are relative to ${SKILLS}/veg.\n\nEat greens.\n</skill>`;

const thread = (): MessageSkills & { loads: number } => {
  const state = {
    loads: 0,
    load: () =>
      Effect.sync(() => {
        state.loads++;
        return { skills: [skill("fruit-code"), skill("veg"), skill("huge")], templates, read: (path: string) => Effect.succeed(files[path] ?? null) };
      }),
  };
  return state;
};
const noFiles: AttachmentReader = { bytes: () => Effect.succeed(null), extractedText: () => Effect.succeed(null) };
/** `null`: no skills passed, as the ACP builder calls it. */
const expand = (text: string, skills: MessageSkills | null = thread(), attachments: ReadonlyArray<ChatAttachment> = []) =>
  Effect.runPromise(turnPrompt({ text, attachments }, { acceptsImages: true, reader: noFiles, ...(skills === null ? {} : { skills }) })).then((prompt) => prompt.text);

describe("Skill mentions", () => {
  it("appends a <skill name location> block for a $name, as t3's Pi provider does", async () => {
    expect(await expand("what is the code? $fruit-code")).toBe(`what is the code? $fruit-code\n\n${fruitBlock}`);
  });

  it("embeds two skills, and a repeated one once", async () => {
    expect(await expand("$fruit-code then $veg and $fruit-code again")).toBe(`$fruit-code then $veg and $fruit-code again\n\n${fruitBlock}\n\n${vegBlock}`);
  });

  it("leaves an unknown $foo, a URL and an inline code span untouched", async () => {
    for (const text of ["say $nope", "see https://example.com/?q=$fruit-code", "type `$fruit-code` to pick it", "type ` $fruit-code ` here"]) {
      expect(await expand(text)).toBe(text);
    }
  });

  it("names a skill whose body does not fit the 120,000-character budget, and does not embed it", async () => {
    expect(await expand("$huge please")).toBe(
      `$huge please\n\n[Skill "huge" is not embedded: it does not fit the message's 120,000-character budget. Its file is ${SKILLS}/huge/SKILL.md.]`,
    );
  });

  it("reads the thread's skills only for a message that could expand", async () => {
    const skills = thread();
    expect(await expand("a plain message", skills)).toBe("a plain message");
    expect(skills.loads).toBe(0);
    await expand("costs $5", skills);
    expect(skills.loads).toBe(1);
  });
});

describe("Slash commands", () => {
  it("expands a leading /skill:name with its arguments", async () => {
    expect(await expand("/skill:fruit-code tell me the code")).toBe(`${fruitBlock}\n\ntell me the code`);
    expect(await expand("/skill:fruit-code")).toBe(fruitBlock);
  });

  it("expands a leading /template with pi's substitution", async () => {
    expect(await expand("/echo a")).toBe("Reply with exactly: ECHO a none");
    expect(await expand(`/echo "a b" c`)).toBe("Reply with exactly: ECHO a b c");
  });

  it("leaves an unknown command, and one not at the start, as typed", async () => {
    expect(await expand("/nope a")).toBe("/nope a");
    expect(await expand("run /echo a")).toBe("run /echo a");
  });
});

describe("the caller's switch", () => {
  /** The Repo skills of the Workspace at `/w/proj`, as `SkillsAccess` finds them (no Environment skills). */
  const workspaceAccess = (): SkillsAccess => ({
    enabled: () => true,
    locate: (cwd) =>
      cwd.startsWith("/w/proj")
        ? {
            id: "proj",
            inner: "/workspace/repo",
            workspace: {
              skills: () => Promise.resolve({ skills: [skill("fruit-code"), skill("veg")], skipped: [], omitted: 0 }),
              prompts: () => Promise.resolve([]),
              readText: (path) => Promise.resolve(files[path] ?? null),
            },
          }
        : undefined,
  });

  it("does not expand without the thread's skills (the ACP builder's turnPrompt)", async () => {
    expect(await expand("/skill:fruit-code x $veg", null)).toBe("/skill:fruit-code x $veg");
  });

  it("of the ACP flavors an instance runs, only OpenCode's expands a message's skills (SPI-1151)", async () => {
    // The prompt hooks read attachments only; this message has none.
    const host = {} as ProviderHost.ProviderHost["Service"];
    const fileSystem = {} as FileSystem.FileSystem;
    const rewrite = (cli: "claude" | "opencode") => {
      const flavor = acpInstanceFlavor({ cli, driver: ProviderDriverKind.make(cli) }, host, fileSystem, workspaceAccess());
      return flavor.rewriteUserText === undefined
        ? Promise.resolve("(no rewrite)")
        : // Never spawns: the hooks' requirement is t3's, for flavors that run a process to rewrite.
          Effect.runPromise(flavor.rewriteUserText("$fruit-code", {} as ProviderAdapter.ProviderAdapterV2TurnInput).pipe(Effect.provideService(CliTurn, { cwd: "/w/proj" })) as Effect.Effect<string>);
    };
    // As OpenCode's skill tool returns it (cliSkillDispatch.test.ts pins the block).
    expect(await rewrite("opencode")).toContain(`$fruit-code\n\n<skill_content name="fruit-code">\n# Skill: fruit-code\n\nRead reference/code.md for the code.`);
    expect(await rewrite("claude")).toBe("(no rewrite)");
  });

  it("the Pi Durable adapter expands the thread's skills for a new turn and a steer, and carries the Environment skill set's hash on the turn (SPI-1148)", async () => {
    const submitted: Array<SubmitTurnInput> = [];
    const steered: Array<SteerInput> = [];
    const session: Partial<SessionRpc> = {
      open: () => Promise.resolve({ busy: false } as Awaited<ReturnType<SessionRpc["open"]>>),
      submitTurn: (input) => (submitted.push(input), Promise.resolve({ submissionId: "s1" })),
      steer: (input) => (steered.push(input), Promise.resolve({ submissionId: "s2" })),
    };
    bindEnvironmentServices({
      agents: { SESSIONS: { idFromName: (name: string) => name, get: () => session } },
      sql: { exec: () => ({ toArray: () => [] }) },
    } as unknown as EnvironmentServices);
    const mcpSessions = { read: () => Effect.succeed(undefined) } as unknown as McpProviderSessions.McpProviderSessions["Service"];
    const instanceId = ProviderInstanceId.make("piDurable");
    const access: SkillsAccess = { ...workspaceAccess(), environment: { entries: () => [], skillMd: () => undefined, hash: () => "env-hash" } };
    const adapter = makePiDurableAdapter(instanceId, mcpSessions, noFiles, access);
    const threadId = ThreadId.make("thread-skills");
    const modelSelection = { instanceId, model: "comm/claude-sonnet-5-5" } as const;
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({ runtimeMode: "full-access", interactionMode: "default", cwd: "/w/proj" });
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* adapter.openSession({ threadId, providerSessionId: ProviderSessionId.make("session-skills"), modelSelection, runtimePolicy });
        const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        const turn = makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now: yield* DateTime.now, modelSelection, messageText: "what is it? $fruit-code" });
        yield* runtime.startTurn(turn);
        yield* runtime.steerTurn({
          threadId,
          runId: turn.runId,
          providerThread,
          providerTurnId: submitted[0]!.providerTurnId as never,
          message: { ...turn.message, messageId: MessageId.make("message:steer"), text: "and $veg" },
        });
      }).pipe(Effect.scoped),
    );
    expect(submitted.map(({ text, environmentSkillsHash }) => ({ text, environmentSkillsHash }))).toEqual([
      { text: `what is it? $fruit-code\n\n${fruitBlock}`, environmentSkillsHash: "env-hash" },
    ]);
    expect(steered.map(({ text }) => text)).toEqual([`and $veg\n\n${vegBlock}`]);
  });

  it("expands nothing with the Harness switch off, or outside a Workspace", async () => {
    const discovery: SkillDiscovery = { skills: [skill("fruit-code")], skipped: [], omitted: 0 };
    const access = (enabled: boolean): SkillsAccess => ({
      enabled: () => enabled,
      locate: (cwd) =>
        cwd.startsWith("/w/proj")
          ? {
              id: "proj",
              inner: "/workspace/repo",
              workspace: { skills: () => Promise.resolve(discovery), prompts: () => Promise.resolve([]), readText: (path) => Promise.resolve(files[path] ?? null) },
            }
          : undefined,
    });
    expect(await expand("$fruit-code", messageSkillsFor("/w/proj", access(true)))).toBe(`$fruit-code\n\n${fruitBlock}`);
    expect(await expand("$fruit-code", messageSkillsFor("/w/proj", access(false)))).toBe("$fruit-code");
    expect(await expand("$fruit-code", messageSkillsFor("/elsewhere", access(true)))).toBe("$fruit-code");
  });
});

describe("Environment skills in a message (SPI-1148)", () => {
  const ENV = "/workspace/.agents/skills";
  const repoFruit = { skills: [skill("fruit-code")], skipped: [], omitted: 0 };
  const access = (rows: Array<{ name: string; description: string; disableModelInvocation: boolean }>, held: SkillDiscovery = repoFruit): SkillsAccess & { repoOnly: Array<boolean> } => {
    const repoOnly: Array<boolean> = [];
    return {
      repoOnly,
      enabled: () => true,
      environment: {
        entries: () => rows,
        skillMd: (name) => (name === "fruit-code" ? "---\nname: fruit-code\ndescription: The Environment's.\n---\nThe code is PLUM-9.\n" : undefined),
        hash: () => "h",
      },
      locate: () => ({
        id: "proj",
        inner: "/workspace/repo",
        workspace: {
          skills: (_inner, _agent, options) => (repoOnly.push(options?.repoOnly === true), Promise.resolve(held)),
          prompts: () => Promise.resolve([]),
          readText: (path) => Promise.resolve(files[path] ?? null),
        },
      }),
    };
  };

  it("embeds the Environment's row for $name, beating the Repo skill of that name, and asks the Workspace for Repo skills only", async () => {
    const skills = access([{ name: "fruit-code", description: "The Environment's.", disableModelInvocation: false }]);
    expect(await expand("$fruit-code", messageSkillsFor("/w/proj", skills))).toBe(
      `$fruit-code\n\n<skill name="fruit-code" location="${ENV}/fruit-code/SKILL.md">\nReferences are relative to ${ENV}/fruit-code.\n\nThe code is PLUM-9.\n</skill>`,
    );
    expect(skills.repoOnly).toEqual([true]);
  });

  it("expands the Repo skill again once the Environment skill is gone from the rows", async () => {
    expect(await expand("$fruit-code", messageSkillsFor("/w/proj", access([])))).toBe(`$fruit-code\n\n${fruitBlock}`);
  });
});

describe("upstream pins (U64)", () => {
  it("matchInlineSkills matches a $name after whitespace, with a letter, up to whitespace", () => {
    const skills = [{ name: "fruit-code" }, { name: "ns:tool_1" }];
    const names = (text: string) => [...matchInlineSkills(text, skills)].map((match) => match.rawText);
    expect(names("$fruit-code and $ns:tool_1")).toEqual(["$fruit-code", "$ns:tool_1"]);
    expect(names("x$fruit-code $fruit-code. `$fruit-code` $5 $nope")).toEqual([]);
  });

  it("discovery's isMentionable agrees with matchInlineSkills on which names t3 can mention", () => {
    const names = ["_private", "-x", ":ns", "5k", "2e5", "123", "fruit-code", "ns:tool_1", "a", "x9", "A-b_c:d", "5kiwi", "e5", "a".repeat(64)];
    for (const name of names) {
      expect(isMentionable(name), name).toBe([...matchInlineSkills(`$${name}`, [{ name }])].length === 1);
    }
    expect(names.filter((name) => isMentionable(name))).toEqual(["fruit-code", "ns:tool_1", "a", "x9", "A-b_c:d", "5kiwi", "e5", "a".repeat(64)]);
  });

  it("discovery's copy of t3's mention token is still t3's (inlineSkills.ts)", () => {
    const source = NodeFs.readFileSync(new URL("../../../t3code/packages/shared/src/inlineSkills.ts", import.meta.url), "utf8");
    const t3 = /const SKILL_TOKEN_REGEX =\s*\/(.+)\/([a-z]*);/.exec(source);
    expect(t3, "t3 moved SKILL_TOKEN_REGEX; re-read U64").not.toBeNull();
    expect({ source: SKILL_TOKEN_REGEX.source, flags: SKILL_TOKEN_REGEX.flags }).toEqual({ source: t3![1], flags: t3![2] });
  });

  // Not a fingerprint literal: that would watch ChatComposer.tsx byte for byte, and t3 changes it most nights.
  it("t3's composer inserts `$<name> ` for a picked skill (ChatComposer.tsx)", () => {
    const source = NodeFs.readFileSync(new URL("../../../t3code/apps/web/src/components/chat/ChatComposer.tsx", import.meta.url), "utf8");
    expect(normalise(source), "t3's composer changed what it inserts for a skill; re-read U64").toContain(normalise('if (item.type === "skill") { const replacement = `$${item.skill.name} `;'));
    // `normalise` drops the space before the backtick; the template itself is text a reformat leaves alone.
    expect(source).toContain("`$${item.skill.name} `");
  });
});
