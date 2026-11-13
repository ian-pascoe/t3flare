// Parity G13 (SPI-1003): t3's ACP registry lists every agent with its standing here, and refuses every install.
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { annotated, refusingCatalog, standingOf } from "../src/provider/acpRegistry.ts";

const agent = (id: string, description = "An agent.") => ({
  id,
  name: id,
  version: "1.0.0",
  description,
  authors: [],
  license: null,
  website: null,
  repository: null,
  icon: null,
  distribution: "npx" as const,
  integrity: "registry" as const,
});

const stock = {
  search: () => Effect.succeed({ agents: [agent("claude-acp"), agent("cursor"), agent("gemini")] }),
  prepare: () => Effect.die("stock prepare must not run"),
  inspect: () => Effect.die("stock inspect must not run"),
  resolve: () => Effect.die("stock resolve must not run"),
  uninstallManagedBinary: () => Effect.die("stock uninstall must not run"),
};

describe("the ACP registry here", () => {
  it("names each agent's standing: built in, vendor sign-in (D3), or key from its environment (ADR-0016)", () => {
    expect(standingOf("claude-acp")).toEqual({ kind: "built-in", provider: "Claude" });
    expect(standingOf("codex-acp")).toEqual({ kind: "built-in", provider: "Codex" });
    expect(standingOf("opencode-v2")).toEqual({ kind: "built-in", provider: "OpenCode" });
    expect(standingOf("pi-acp")).toEqual({ kind: "built-in", provider: "Pi" });
    expect(standingOf("cursor").kind).toBe("vendor-sign-in");
    expect(standingOf("github-copilot-cli").kind).toBe("vendor-sign-in");
    expect(standingOf("gemini").kind).toBe("key-from-environment");
    expect(standingOf("an-agent-added-tomorrow").kind).toBe("key-from-environment");
  });

  it("lists the registry as t3 does, each description led by the standing", async () => {
    const catalog = refusingCatalog(stock as never);
    const { agents } = await Effect.runPromise(catalog.search({ query: "" }));
    expect(agents.map((a) => a.id)).toEqual(["claude-acp", "cursor", "gemini"]);
    expect(agents[0]?.description).toMatch(/^Built in here: add the Claude provider.*An agent\.$/);
    expect(agents[1]?.description).toMatch(/signs in with its vendor's account.*D3/);
    expect(agents[2]?.description).toMatch(/key helper \(ADR-0016\)/);
  });

  it("keeps a description within t3's 1,024 characters", () => {
    expect(annotated(agent("gemini", "x".repeat(1_024))).description.length).toBe(1_024);
  });

  it("refuses to prepare, inspect or resolve any agent, with its standing as the reason", async () => {
    const catalog = refusingCatalog(stock as never);
    const prepared = await Effect.runPromise(Effect.flip(catalog.prepare({ agentId: "claude-acp" })));
    expect(prepared.detail).toMatch(/add the Claude provider/);
    const custom = await Effect.runPromise(Effect.flip(catalog.resolve({ agentId: "" } as never, "/w/x")));
    expect(custom.detail).toMatch(/custom ACP command/);
    expect(await Effect.runPromise(catalog.uninstallManagedBinary({ agentId: "gemini" }))).toEqual({ agentId: "gemini", removed: false });
  });
});
