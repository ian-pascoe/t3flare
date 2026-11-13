// The Advisor (SPI-1059) on a real pi-durable Harness over pi-ai's faux provider, the agent and its Advisor Session
// answered from two scripts (told apart by the Advisor's instructions): a Review under the `turn` cadence steers the
// running agent with an attributed Concern; under `request`, the final Review's findings become notes in the same run and
// a Blocker continues it once; findings that cite no evidence are dropped; a failed Review pauses the Advisor without
// stopping the agent, and nothing it does starts a run of its own.
// @effect-diagnostics asyncFunction:off newPromise:off
import { type AssistantMessage, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, type EntryRecord, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";

import { ADVICE_ENTRY, AdvisorObserver, type AdvisorSettings, advisorExtension, parseFindings, validFinding } from "../src/extensions/advisor.ts";
import { capText, toolCallRef } from "../src/extensions/advisor/evidence.ts";
import { context, memoryKv } from "./harness.fixture.ts";

type Step = AssistantMessage | (() => AssistantMessage | Promise<AssistantMessage>);

const run = async (settings: AdvisorSettings, agent: Array<Step>, advisor: Array<Step>) => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const advisorPrompts: Array<string> = [];
  const next = async (list: Array<Step>) => {
    const step = list.shift();
    if (step === undefined) throw new Error("script ran out");
    return typeof step === "function" ? step() : step;
  };
  faux.setResponses(
    Array.from({ length: 30 }, () => (transcript: { messages: ReadonlyArray<{ role: string; content: unknown }> }) => {
      // The faux transcript has no system prompt: the Advisor Session is the one whose first user message is a Review.
      if (JSON.stringify(transcript.messages.find((message) => message.role === "user")?.content ?? "").includes("Review this observed-agent evidence")) {
        const last = transcript.messages.at(-1);
        if (last?.role === "user") advisorPrompts.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
        return next(advisor);
      }
      return next(agent);
    }) as never,
  );
  const registry = createRegistry();
  const ran: Array<string> = [];
  registry.install(
    defineExtension({
      name: "coding-tools",
      tools: [
        defineTool({ name: "bash", description: "run", parameters: obj({ command: str() }), execute: async (args) => (ran.push(args.command), { output: [{ type: "text" as const, text: `ran ${args.command}` }] }) }),
        defineTool({ name: "read", description: "read", parameters: obj({ path: str() }), execute: async () => ({ output: [{ type: "text" as const, text: "contents" }] }) }),
      ],
    }),
  );
  let harness: Harness | undefined;
  const observer = new AdvisorObserver(() => Promise.resolve(harness!), memoryKv(), settings);
  registry.install(advisorExtension(observer));
  harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  const submission = await root.submit({ type: "input", content: "update the changelog and run the tests" }, context);
  harness.resume();
  await root.waitForIdle(context);
  const page = await root.entries({ order: "ascending" }, 200, undefined, context);
  return { observer, root, entries: page.items, status: await submission.status(context), advisorPrompts, ran };
};

const bash = (command: string, id: string) => fauxAssistantMessage([fauxToolCall("bash", { command }, { id })], { stopReason: "toolUse" });
const report = (findings: ReadonlyArray<unknown>) => fauxAssistantMessage(`Checked.\n${JSON.stringify({ findings })}`);
const model = (entry: EntryRecord) => JSON.stringify(entry.model?.[0] ?? null);

const SETTINGS: AdvisorSettings = { model: "inherit", reviewEvery: "turn", thinkingLevel: "off", correctiveTurns: 1 };

describe("the Advisor", () => {
  it("steers the running agent with an attributed Concern after a Review under the turn cadence", async () => {
    let reviewed: () => void = () => {};
    const done = new Promise<void>((resolve) => (reviewed = resolve));
    const { entries, status, advisorPrompts } = await run(
      SETTINGS,
      [bash("echo changelog >> CHANGELOG.md", "c1"), async () => (await done, bash("true", "c2")), fauxAssistantMessage("All done, tests pass.")],
      [
        () => {
          reviewed();
          return report([{ severity: "concern", message: "The tests were never run; the agent ran `true` instead.", evidence: { refs: [toolCallRef("c1")] } }]);
        },
        report([]),
      ],
    );
    expect(status.status).toBe("done");
    expect(advisorPrompts[0]).toContain("Current context seed.");
    expect(advisorPrompts[0]).toContain(`"ref":"${toolCallRef("c1")}"`);
    const advice = entries.filter((entry) => entry.kind === ADVICE_ENTRY);
    expect(advice).toHaveLength(1);
    expect(advice[0]?.data).toMatchObject({ severity: "concern", message: "The tests were never run; the agent ran `true` instead." });
    expect(model(advice[0]!)).toContain("Advisor concern: The tests were never run");
    // The steer joined the run: an answer came after it.
    expect(entries.findIndex((entry) => entry.kind === ADVICE_ENTRY)).toBeLessThan(entries.length - 1);
    // The next Review is incremental.
    expect(advisorPrompts[1]).toContain("Incremental update.");
  });

  it("reviews once at the end under the request cadence: a Nit is a note, a Blocker continues the same run once", async () => {
    const { entries, status, advisorPrompts } = await run(
      { ...SETTINGS, reviewEvery: "request" },
      [bash("rm CHANGELOG.md", "c1"), fauxAssistantMessage("Updated the changelog."), fauxAssistantMessage("Restored it; sorry.")],
      [
        report([
          { severity: "nit", message: "The answer could name the file.", evidence: { quote: "Updated the changelog." } },
          { severity: "blocker", message: "The agent deleted CHANGELOG.md but claims it updated it.", evidence: { refs: [toolCallRef("c1")], quote: "Updated the changelog." } },
          { severity: "concern", message: "Cites nothing." },
          { severity: "concern", message: "Cites a ref it never saw.", evidence: { refs: ["nope"] } },
        ]),
      ],
    );
    expect(advisorPrompts).toHaveLength(1);
    expect(status.status).toBe("done");
    const advice = entries.filter((entry) => entry.kind === ADVICE_ENTRY).map((entry) => (entry.data as { severity: string }).severity);
    expect(advice).toEqual(["blocker", "nit"]);
    const continued = entries.findIndex((entry) => JSON.stringify(entry.model ?? []).includes("Address the recorded Advisor blocker"));
    expect(continued).toBeGreaterThan(-1);
    expect(model(entries.at(-1)!)).toContain("Restored it; sorry.");
  });

  it("pauses on a failed Review, leaving the agent running, and starts no run of its own", async () => {
    const { entries, status, observer } = await run(
      { ...SETTINGS, reviewEvery: "request" },
      [bash("ls", "c1"), fauxAssistantMessage("Listed.")],
      [fauxAssistantMessage("I have no report for you.")],
    );
    expect(status.status).toBe("done");
    expect(observer.paused).toContain("held no JSON report");
    const paused = entries.filter((entry) => entry.kind === ADVICE_ENTRY);
    expect(paused.map((entry) => (entry.data as { severity: string }).severity)).toEqual(["paused"]);
    expect(paused[0]?.model).toBeUndefined();
    expect(model(entries.at(-1)!)).toContain("Listed.");
  });

  it("parses the last report, keeps findings that cite known evidence, and caps tool results", () => {
    expect(parseFindings('example {"findings": [1]} then {"findings": []}')).toEqual([]);
    expect(parseFindings("none")).toBeUndefined();
    const known = new Set(["r1"]);
    expect(validFinding({ severity: "nit", message: "x", evidence: { refs: ["r1"] } }, known)).toEqual({ severity: "nit", message: "x", evidence: { refs: ["r1"] } });
    expect(validFinding({ severity: "nit", message: "x", evidence: { refs: ["r2"] } }, known)).toBeUndefined();
    expect(validFinding({ severity: "urgent", message: "x", evidence: { quote: "q" } }, known)).toBeUndefined();
    const capped = capText("a".repeat(5_000));
    expect(capped).toContain("1000 characters omitted from this tool result");
    expect(capped.startsWith("a".repeat(2_000))).toBe(true);
  });
});
