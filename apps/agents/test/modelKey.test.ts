// The key route's gate (step 4a, ADR-0016 A′, review F4): only a live CLI process's nonce gets the CLI agents' model
// key, a Codex process's at most three times (M0: it asks twice as it starts, then keeps it), pi's at every request.
import { describe, expect, it } from "vitest";

import { CODEX_KEY_GRANTS, ModelKeyGate } from "../src/workspace/modelKey.ts";

describe("ModelKeyGate", () => {
  it("refuses with no CLI process, or a nonce it never issued (a Durable agent's shell, a Codex shell without one)", () => {
    const gate = new ModelKeyGate(() => "n1");
    expect(gate.decide(null, new Set())).toEqual({ grant: false, why: "no CLI process lives here" });
    gate.issue("proc-a", "codex");
    expect(gate.decide(null, new Set(["proc-a"]))).toEqual({ grant: false, why: "unknown nonce" });
    expect(gate.decide("guess", new Set(["proc-a"]))).toEqual({ grant: false, why: "unknown nonce" });
  });

  it("grants a Codex process's nonce a bounded number of times, and pi's at every request", () => {
    let n = 0;
    const gate = new ModelKeyGate(() => `n${++n}`);
    const codex = gate.issue("proc-a", "codex");
    const pi = gate.issue("proc-b", "pi");
    const live = new Set(["proc-a", "proc-b"]);
    for (let i = 1; i <= CODEX_KEY_GRANTS; i++) expect(gate.decide(codex, live)).toMatchObject({ grant: true, grants: i });
    expect(gate.decide(codex, live)).toEqual({ grant: false, why: "Codex's grants are used up" });
    for (let i = 0; i < 20; i++) expect(gate.decide(pi, live).grant).toBe(true);
  });

  it("forgets a nonce once its process no longer runs", () => {
    const gate = new ModelKeyGate(() => "n1");
    const nonce = gate.issue("proc-a", "pi");
    expect(gate.decide(nonce, new Set(["proc-a"])).grant).toBe(true);
    expect(gate.decide(nonce, new Set(["proc-b"]))).toEqual({ grant: false, why: "unknown nonce" });
    expect(gate.decide(nonce, new Set(["proc-a"]))).toEqual({ grant: false, why: "unknown nonce" });
  });
});
