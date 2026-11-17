// SPI-1176: the setup state in each driver's own snapshot (Pi Durable, Codex, Claude Code, OpenCode; pi's is
// `piDriver.test.ts`): with no Model endpoint for the driver, t3's `warning` with no model and a message pointing to the
// Harness panel; with one, ready with its models.
import type { EndpointApi, ModelEndpoints } from "@t3flare/models/endpoints";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { snapshotOf as acpSnapshotOf } from "../src/provider/cli/acpDriver.ts";
import { snapshotOf as codexSnapshotOf } from "../src/provider/cli/codexDriver.ts";
import { snapshotOf as durableSnapshotOf } from "../src/provider/driver.ts";
import { snapshotModels } from "../src/provider/models.ts";

const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text" as const], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false });
const endpoint = (id: string, api: EndpointApi, models: ReadonlyArray<string>) => ({ id, label: id, api, baseUrl: `https://${id}.example`, auth: "api-key" as const, headers: {}, models: models.map(model) });
const bind = (...endpoints: Array<ReturnType<typeof endpoint>>) => {
  const value: ModelEndpoints = { revision: 1, endpoints };
  bindEnvironmentServices({ modelEndpoints: () => value } as unknown as EnvironmentServices);
  return value;
};
const HARNESS = /Harness panel \(\/_t3flare\/harness\), under Model endpoints\.$/;
const view = (snapshot: { status: string; message?: string; models: ReadonlyArray<{ slug: string }> }) => ({ status: snapshot.status, message: snapshot.message, models: snapshot.models.map((entry) => entry.slug) });

const acp = (cli: "claude" | "opencode") => acpSnapshotOf({ cli, driver: ProviderDriverKind.make(cli === "claude" ? "claudeAgent" : "opencode"), presentation: { displayName: cli } as never, version: "1" }, true);

describe("the setup state in the drivers' snapshots", () => {
  it("Pi Durable: needs setup with no endpoint's model, ready with one", async () => {
    const empty = view(await Effect.runPromise(durableSnapshotOf({ enabled: true, models: snapshotModels(bind()) })));
    expect(empty).toEqual({ status: "warning", message: "No Model endpoint is set up: add one in the Harness panel (/_t3flare/harness), under Model endpoints.", models: [] });
    const ready = view(await Effect.runPromise(durableSnapshotOf({ enabled: true, models: snapshotModels(bind(endpoint("comm", "anthropic-messages", ["c"]))) })));
    expect(ready).toMatchObject({ status: "ready", models: ["comm/c"] });
  });

  it("Codex: needs setup without an OpenAI Responses endpoint, even with another API's", async () => {
    bind(endpoint("comm", "anthropic-messages", ["c"]));
    const empty = view(await Effect.runPromise(codexSnapshotOf(true, undefined)));
    expect(empty).toMatchObject({ status: "warning", models: [] });
    expect(empty.message).toMatch(/^Codex has no Model endpoint to run on: it needs one that speaks OpenAI Responses/);
    expect(empty.message).toMatch(HARNESS);
    bind(endpoint("resp", "openai-responses", ["r"]));
    expect(view(await Effect.runPromise(codexSnapshotOf(true, undefined)))).toMatchObject({ status: "ready", models: ["resp/r"] });
  });

  it("Claude Code: needs setup without an Anthropic Messages endpoint", async () => {
    bind(endpoint("resp", "openai-responses", ["r"]));
    const empty = view(await Effect.runPromise(acp("claude")));
    expect(empty).toMatchObject({ status: "warning", models: [] });
    expect(empty.message).toMatch(/^Claude Code has no Model endpoint to run on: it needs one that speaks Anthropic Messages/);
    expect(empty.message).toMatch(HARNESS);
    bind(endpoint("comm", "anthropic-messages", ["c"]));
    expect(view(await Effect.runPromise(acp("claude")))).toMatchObject({ status: "ready", models: ["comm/c"] });
  });

  it("OpenCode: needs setup with no endpoint of its APIs", async () => {
    bind(endpoint("gem", "google-generative-ai", ["g"]));
    const empty = view(await Effect.runPromise(acp("opencode")));
    expect(empty).toMatchObject({ status: "warning", models: [] });
    expect(empty.message).toMatch(/^OpenCode has no Model endpoint to run on/);
    expect(empty.message).toMatch(HARNESS);
    bind(endpoint("comm", "anthropic-messages", ["c"]));
    expect(view(await Effect.runPromise(acp("opencode")))).toMatchObject({ status: "ready" });
  });
});
