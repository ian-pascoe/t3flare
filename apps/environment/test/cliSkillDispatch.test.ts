// @effect-diagnostics nodeBuiltinImport:off globalDate:off
// A picked Skill in a CLI agent's message (SPI-1151 §3): Claude Code gets stock's rewrite (`planClaudeSkillDispatch`)
// in the wrapper's `startTurn`, a mention that opens the message becoming the native `/name rest` and any other an inline
// `/name` with a note in stock's wording naming its `SKILL.md`; OpenCode gets the Skill embedded as its own skill tool returns it.
// Through t3's ACP adapter and our flavors, against the scripted agent (fixtures/fake-acp-agent.mjs), as acpAdapter.test.ts.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAcpAdapterV2, type AcpAdapterV2RuntimeInput } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { type CliAgent, type PromptTemplate, SKILL_TOKEN_REGEX, type SkillDiscovery } from "@t3flare/skills";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import * as TestProviderHost from "../../../t3code/packages/provider-testing/src/TestProviderHost.ts";
import { makeTurnInput } from "t3/src/orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import { acpFlavor, acpPromptBuilder } from "../src/provider/cli/acpDriver.ts";
import { CLAUDE_SKILL_NOTE, claudeMentionRewrite, claudeSkillText } from "../src/provider/cli/claudeSkills.ts";
import { wrapCliAdapter } from "../src/provider/cli/wrapper.ts";
import type { SkillsAccess } from "../src/provider/skills.ts";

const AGENT = path.join(import.meta.dirname, "fixtures/fake-acp-agent.mjs");
const INNER = "/workspace/repo/.claude/skills";
const T3 = "/w/proj/.claude/skills";

describe("Claude Code's rewrite of a Skill mention (stock's planClaudeSkillDispatch)", () => {
  const skills = [
    { name: "fruit-code", path: `${T3}/fruit-code/SKILL.md` },
    { name: "veg", path: `${T3}/veg/SKILL.md` },
  ];
  const note = (name: string) => ` [The user invoked this skill. Follow the instructions at: ${T3}/${name}/SKILL.md]`;

  it("makes a mention that opens the message Claude's native /name, its rest the arguments", () => {
    expect(claudeSkillText("$fruit-code what is the code?", skills)).toBe("/fruit-code what is the code?");
    expect(claudeSkillText("  $fruit-code", skills)).toBe("/fruit-code");
  });

  it("makes any other mention an inline /name with a note in stock's wording naming its SKILL.md, once per Skill", () => {
    expect(claudeSkillText("what is the code? $fruit-code", skills)).toBe(`what is the code? /fruit-code${note("fruit-code")}`);
    expect(claudeSkillText("use $veg then $fruit-code and $veg", skills)).toBe(`use /veg${note("veg")} then /fruit-code${note("fruit-code")} and /veg`);
  });

  it("keeps an opening mention native, unnoted, when others follow: the rest are noted (Claude expands one Skill a message)", () => {
    expect(claudeSkillText("$fruit-code then $veg and $fruit-code", skills)).toBe(`/fruit-code then /veg${note("veg")} and /fruit-code`);
    expect(claudeSkillText("  $fruit-code then $veg", skills)).toBe(`/fruit-code then /veg${note("veg")}`);
  });

  it("changes nothing but the mentions in a message with leading spaces and no opening mention", () => {
    expect(claudeSkillText("  hi $veg", skills)).toBe(`  hi /veg${note("veg")}`);
  });

  it("leaves a message with no known mention as typed", () => {
    for (const text of ["say $nope", "costs $5", "plain", "x$fruit-code"]) expect(claudeSkillText(text, skills)).toBe(text);
  });

  it("finds the mentions the planner does: its SKILL_MENTION_PATTERN is the copied SKILL_TOKEN_REGEX (ClaudeSkillDispatch.ts)", () => {
    const source = fs.readFileSync(new URL("../../../t3code/apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts", import.meta.url), "utf8");
    const planner = /const SKILL_MENTION_PATTERN =\s*\/(.+)\/([a-z]*);/.exec(source);
    expect(planner, "t3 moved SKILL_MENTION_PATTERN; re-read U65").not.toBeNull();
    expect({ source: SKILL_TOKEN_REGEX.source, flags: SKILL_TOKEN_REGEX.flags }).toEqual({ source: planner![1], flags: planner![2] });
  });

  it("words the note as stock does (ClaudeSkillDispatch.ts)", () => {
    const source = fs.readFileSync(new URL("../../../t3code/apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts", import.meta.url), "utf8");
    expect(source, "t3 changed its Claude skill note; re-read U65").toContain(`\` ${CLAUDE_SKILL_NOTE}\${mention.skill.path}]\``);
  });

  it("asks the Workspace at Claude Code's roots only for a message with a sigil, and keeps the text when it cannot answer", async () => {
    const asked: Array<string> = [];
    const access = (fail = false): SkillsAccess => ({
      enabled: () => false,
      locate: (cwd) =>
        cwd === "/w/proj"
          ? {
              id: "proj",
              inner: "/workspace/repo",
              workspace: {
                skills: (_inner, agent) => (asked.push(String(agent)), fail ? Promise.reject(new Error("down")) : Promise.resolve(discovery(["fruit-code"]))),
                prompts: () => Promise.resolve([]),
                readText: () => Promise.resolve(null),
              },
            }
          : undefined,
    });
    const rewrite = (text: string, cwd: string | null, fail = false) => Effect.runPromise(claudeMentionRewrite(access(fail))(text, cwd));
    expect(await rewrite("plain", "/w/proj")).toBe("plain");
    expect(asked).toEqual([]);
    expect(await rewrite("$fruit-code go", "/w/proj")).toBe("/fruit-code go");
    expect(asked).toEqual(["claude"]);
    expect(await rewrite("$fruit-code go", "/elsewhere")).toBe("$fruit-code go");
    expect(await rewrite("$fruit-code go", "/w/proj", true)).toBe("$fruit-code go");
  });
});

const discovery = (names: ReadonlyArray<string>): SkillDiscovery => ({
  skills: names.map((name) => ({ name, description: `${name} things`, filePath: `${INNER}/${name}/SKILL.md`, disableModelInvocation: false })),
  skipped: [],
  omitted: 0,
});

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

const INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { close: {}, fork: {}, resume: {} } },
  authMethods: [],
  agentInfo: { name: "agent", version: "0" },
};
const SESSION_NEW = {
  sessionId: "session",
  configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "claude-sonnet-5-5", options: ["claude-sonnet-5-5", "t3flare/claude-sonnet-5-5"].map((value) => ({ value, name: value })) }],
};

/** The prompt the scripted agent received for one turn of `text`, through the wrapper and t3's adapter. */
/** `rows`: the Environment skills (SPI-1153), each name's `SKILL.md`. */
const promptFor = (cli: "claude" | "opencode", text: string, files: Record<string, string>, rows: Record<string, string> = {}, order?: Array<string>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3flare-skill-" });
    const scriptPath = path.join(dir, "script.json");
    const logPath = path.join(dir, "agent.log");
    fs.writeFileSync(scriptPath, JSON.stringify({ initialize: INITIALIZE, sessionNew: SESSION_NEW, prompts: [[]] }));
    fs.writeFileSync(logPath, "");
    const cwd = "/w/proj";
    const asked: Array<CliAgent | undefined> = [];
    const access: SkillsAccess = {
      enabled: () => false,
      environment: {
        entries: () => Object.keys(rows).map((name) => ({ name, description: `The Environment's ${name}.`, disableModelInvocation: false })),
        skillMd: (name) => rows[name],
        hash: () => "h",
      },
      locate: (at) =>
        at === cwd
          ? {
              id: "proj",
              inner: "/workspace/repo",
              workspace: {
                skills: (_inner, agent) => (asked.push(agent), order?.push(`skills ${agent}`), Promise.resolve(discovery(Object.keys(files).map((file) => file.split("/").at(-2)!)))),
                prompts: (_inner, agent): Promise<ReadonlyArray<PromptTemplate>> => (asked.push(agent), Promise.resolve([])),
                readText: (file) => Promise.resolve(files[file] ?? null),
              },
            }
          : undefined,
    };
    const spawn = (input: AcpAdapterV2RuntimeInput) =>
      Effect.gen(function* () {
        const { processEnvironment: _env, runtimePolicy: _policy, mcpServers: _mcp, acpMcpServers: _acp, httpMcpServers: _http, ...options } = input;
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            ...options,
            cwd: dir,
            spawn: { command: process.execPath, args: [AGENT], cwd: dir, env: { PATH: process.env.PATH ?? "", FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_LOG: logPath }, extendEnv: false },
            authenticateOnAuthRequired: false,
            ownDetachedProcessGroup: true,
            processGroupPlatform: process.platform,
          }),
        );
        return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
      });
    const driver = ProviderDriverKind.make(cli === "claude" ? "claudeAgent" : "opencode");
    const instanceId = ProviderInstanceId.make(cli === "claude" ? "claudeAgent" : "opencode");
    const buildPrompt = acpPromptBuilder(yield* ProviderHost.ProviderHost, fileSystem, cli === "opencode" ? access : undefined);
    const adapter = yield* makeAcpAdapterV2({ instanceId, flavor: acpFlavor(cli, driver, { spawn, buildPrompt }), selfInvocation: { command: "none", entrypoint: undefined } });
    const wrapped = wrapCliAdapter(adapter, {
      sessions: new Map(),
      ...(cli === "claude" ? { rewriteTurnText: claudeMentionRewrite(access) } : {}),
      ...(order === undefined ? {} : { takeEnvironmentSkills: (at: string | null) => Effect.sync(() => void order.push(`take ${at}`)) }),
    });
    const threadId = ThreadId.make(`thread-${cli}`);
    const modelSelection = { instanceId, model: "anthropic/claude-sonnet-5-5" } as const;
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({ runtimeMode: "full-access", interactionMode: "default", cwd });
    const runtime = yield* wrapped.openSession({ threadId, providerSessionId: ProviderSessionId.make(`session-${cli}`), modelSelection, runtimePolicy });
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    yield* runtime.events.pipe(Stream.runForEach((event) => Queue.offer(events, event)), Effect.forkScoped);
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    yield* runtime.startTurn(makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now: yield* DateTime.now, modelSelection, messageText: text }));
    yield* Effect.gen(function* () {
      while ((yield* Queue.take(events)).type !== "turn.terminal");
    }).pipe(Effect.timeout("20 seconds"));
    const prompt = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { received?: string; params?: { prompt?: ReadonlyArray<{ type: string; text?: string }> } })
      .find((entry) => entry.received === "session/prompt")?.params?.prompt;
    return { blocks: prompt ?? [], asked };
  });

const run = <A>(body: Effect.Effect<A, unknown, Layer.Success<typeof layerTest> | import("effect/Scope").Scope>) => Effect.runPromise(body.pipe(Effect.scoped, Effect.provide(layerTest)) as never) as Promise<A>;

const ENVIRONMENT_SKILL = "---\nname: env\ndescription: The Environment's.\n---\n\nInterview the owner.\n";
const SKILL = "---\nname: fruit-code\ndescription: The fruit code.\n---\n\nRead reference/code.md for the code.\n";

describe("through t3's ACP adapter", () => {
  it("Claude Code gets a leading mention as its native /name, sent alone (t3's native-slash rule)", async () => {
    const { blocks, asked } = await run(promptFor("claude", "$fruit-code what is it?", { [`${INNER}/fruit-code/SKILL.md`]: SKILL }));
    expect(blocks[0]).toEqual({ type: "text", text: "/fruit-code what is it?" });
    expect(blocks.filter((block) => block.type === "text")).toHaveLength(1);
    expect(asked).toEqual(["claude"]);
  });

  it("Claude Code gets any other mention inline with the note naming its SKILL.md in the Container's t3 path", async () => {
    const { blocks } = await run(promptFor("claude", "what is it? $fruit-code", { [`${INNER}/fruit-code/SKILL.md`]: SKILL }));
    expect(blocks[0]?.text).toContain(`what is it? /fruit-code [The user invoked this skill. Follow the instructions at: ${T3}/fruit-code/SKILL.md]`);
  });

  it("OpenCode gets the Skill embedded as its skill tool returns it: the body and its base directory", async () => {
    const { blocks, asked } = await run(promptFor("opencode", "what is it? $fruit-code", { [`${INNER}/fruit-code/SKILL.md`]: SKILL }));
    const text = blocks[0]?.text ?? "";
    expect(text).toContain("what is it? $fruit-code");
    expect(text).toContain(
      `<skill_content name="fruit-code">\n# Skill: fruit-code\n\nRead reference/code.md for the code.\n\nBase directory for this skill: ${T3}/fruit-code\nRelative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.\n</skill_content>`,
    );
    expect(asked).toEqual(["opencode"]);
  });

  it("Claude Code gets an Environment skill's mention noted at the mount, and the Environment's of a same-named pair (SPI-1153)", async () => {
    const mount = "/workspace/.agents/skills";
    const { blocks } = await run(promptFor("claude", "what is it? $grill-me then $fruit-code", { [`${INNER}/fruit-code/SKILL.md`]: SKILL }, { "grill-me": ENVIRONMENT_SKILL, "fruit-code": ENVIRONMENT_SKILL }));
    expect(blocks[0]?.text).toContain(`/grill-me [The user invoked this skill. Follow the instructions at: ${mount}/grill-me/SKILL.md]`);
    expect(blocks[0]?.text).toContain(`/fruit-code [The user invoked this skill. Follow the instructions at: ${mount}/fruit-code/SKILL.md]`);
  });

  it("OpenCode gets an Environment skill embedded from its row with the mount as its base, and the Repo's of a same-named pair (SPI-1153)", async () => {
    const { blocks } = await run(promptFor("opencode", "go $grill-me $fruit-code", { [`${INNER}/fruit-code/SKILL.md`]: SKILL }, { "grill-me": ENVIRONMENT_SKILL, "fruit-code": ENVIRONMENT_SKILL }));
    const text = blocks[0]?.text ?? "";
    expect(text).toContain('<skill_content name="grill-me">\n# Skill: grill-me\n\nInterview the owner.\n\nBase directory for this skill: /workspace/.agents/skills/grill-me\n');
    expect(text).toContain(`<skill_content name="fruit-code">\n# Skill: fruit-code\n\nRead reference/code.md for the code.\n\nBase directory for this skill: ${T3}/fruit-code\n`);
  });

  it("has the thread's Workspace take the Environment skill set before the turn's text is read and sent (SPI-1153)", async () => {
    for (const cli of ["claude", "opencode"] as const) {
      const order: Array<string> = [];
      const { blocks } = await run(promptFor(cli, "$fruit-code go", { [`${INNER}/fruit-code/SKILL.md`]: SKILL }, {}, order));
      expect(blocks.length).toBeGreaterThan(0);
      expect(order, cli).toEqual(["take /w/proj", `skills ${cli}`]);
    }
  });

  it("OpenCode's own commands reach it as typed: no Prompt template expands", async () => {
    const { blocks, asked } = await run(promptFor("opencode", "/review now", {}));
    expect(blocks[0]?.text).toBe("/review now");
    expect(asked).toEqual(["opencode"]);
  });
});
