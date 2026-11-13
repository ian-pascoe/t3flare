// The `propose_plan` tool (SPI-996, parity G5): how a Durable agent in plan mode hands its plan to t3, as Claude Code's
// `ExitPlanMode` does for t3's Claude adapter (t3code `ClaudeAdapterV2.ts`, `claudeProposedPlan`): the plan's Markdown
// is the call's argument, the differ shows the call as t3's proposed plan (`proposed_plan` turn item and plan artifact),
// and the owner implements it from t3 as with any provider. The call ends the run (`control.terminate`) so the turn
// settles on the plan, as Claude's adapter tells the model to stop there. Outside plan mode it refuses and changes
// nothing, so the tool list stays the same in both modes (one prompt cache).
// @effect-diagnostics asyncFunction:off
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { InteractionMode } from "@t3flare/session-protocol";

export const PROPOSE_PLAN_TOOL = "propose_plan";

/** Most characters of a plan: t3 keeps it in one projection row. */
export const MAX_PLAN = 64_000;

/** Added to t3's plan-mode instruction while the thread is in plan mode. */
export const PROPOSE_PLAN_INSTRUCTION = `When the plan is decision complete, call \`${PROPOSE_PLAN_TOOL}\` once with the whole plan in Markdown, starting with a \`#\` title. The owner reviews it in T3 Code and may implement it; to revise it, call \`${PROPOSE_PLAN_TOOL}\` again with the whole revised plan.`;

/** What the call answers once t3 has the plan (Claude's adapter's denial text, as a success). */
export const PLAN_CAPTURED =
  "T3 Code captured your proposed plan and shows it to the owner. Stop here and wait for their feedback or implementation request in a later turn.";

export const PLAN_OUTSIDE_PLAN_MODE =
  "Refused: this thread is not in plan mode, so there is no plan to propose. Carry on with the work the owner asked for.";

export const proposePlan = (interaction: () => InteractionMode): Extension =>
  defineExtension({
    name: "propose-plan",
    tools: [
      defineTool({
        name: PROPOSE_PLAN_TOOL,
        description:
          "Plan mode only: hand your finished implementation plan to the owner, who reviews it in T3 Code and may implement it. Pass the whole plan in Markdown, starting with a `#` title. The call ends your turn.",
        parameters: obj({ plan: str({ description: "The whole plan in Markdown, starting with a `#` title." }) }),
        // A script cannot end the run, and a plan is the model's own answer.
        callers: ["model"],
        replay: "safe",
        async execute(args) {
          if (interaction() !== "plan") return { output: [{ type: "text" as const, text: PLAN_OUTSIDE_PLAN_MODE }], isError: true };
          const plan = args.plan.trim();
          if (plan === "") return { output: [{ type: "text" as const, text: "Refused: the plan is empty." }], isError: true };
          if (plan.length > MAX_PLAN) {
            return { output: [{ type: "text" as const, text: `Refused: the plan has ${plan.length} characters; at most ${MAX_PLAN}. Shorten it and call again.` }], isError: true };
          }
          // The differ reads the plan from the call's arguments (unbounded in a push; `details` are cut at 64 KiB).
          return { output: [{ type: "text" as const, text: PLAN_CAPTURED }], details: { proposedPlan: true }, control: { terminate: true } };
        },
      }),
    ],
    sections: [section("t3flare_propose_plan", () => (interaction() === "plan" ? PROPOSE_PLAN_INSTRUCTION : undefined))],
  });
