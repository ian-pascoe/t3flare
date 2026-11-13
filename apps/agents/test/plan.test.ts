// SPI-996: plan mode's `propose_plan` on a real pi-durable Harness. In plan mode the call hands the plan over and ends the
// run (no model request after it); outside plan mode it refuses and the run goes on.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { InteractionMode } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { ALWAYS_OFFERED } from "../src/extensions/codemode.ts";
import { allowedByDefault } from "../src/extensions/guardian/policy.ts";
import { PLAN_CAPTURED, PLAN_OUTSIDE_PLAN_MODE, PROPOSE_PLAN_INSTRUCTION, PROPOSE_PLAN_TOOL, proposePlan } from "../src/extensions/plan.ts";
import { context, restartingHarness, textOf, until } from "./harness.fixture.ts";

const PLAN = "# Add a cache\n\n1. Read the config.\n2. Add the cache.";
const propose = () => fauxAssistantMessage([fauxToolCall(PROPOSE_PLAN_TOOL, { plan: PLAN }, { id: "plan-1" })], { stopReason: "toolUse" });

describe("propose_plan", () => {
  it("in plan mode hands the plan over and ends the run without another model request", async () => {
    const harness = await restartingHarness([proposePlan(() => "plan")], [propose(), fauxAssistantMessage("AFTER THE PLAN")]);
    await until(async () => (await harness.lastToolResult()) !== undefined, "the result");
    const result = await harness.lastToolResult();
    expect(textOf(result)).toBe(PLAN_CAPTURED);
    expect(result?.isError).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await harness.messages()).some((message) => message.text.includes("AFTER THE PLAN"))).toBe(false);
  });

  it("outside plan mode refuses, and the run goes on", async () => {
    const harness = await restartingHarness([proposePlan(() => "default")], [propose(), fauxAssistantMessage("carried on")]);
    await until(async () => (await harness.messages()).some((message) => message.text === "carried on"), "the next answer");
    const result = await harness.lastToolResult();
    expect(textOf(result)).toBe(PLAN_OUTSIDE_PLAN_MODE);
    expect(result?.isError).toBe(true);
  });

  it("is told to the model only in plan mode, is never deferred, and the Guardian lets it through", async () => {
    const render = (mode: InteractionMode) => proposePlan(() => mode).sections![0]!.render({} as never, context);
    expect(await render("default")).toBeUndefined();
    expect(await render("plan")).toBe(PROPOSE_PLAN_INSTRUCTION);
    expect(ALWAYS_OFFERED).toContain(PROPOSE_PLAN_TOOL);
    expect(allowedByDefault).toContain(PROPOSE_PLAN_TOOL);
  });
});
