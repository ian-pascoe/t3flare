// The key gate's counts for the ACP agents (step 4b, plan §4.1, §4.2; M0 P1, P2): Claude Code and OpenCode each ask
// once per process (Claude with its 24 h helper TTL, OpenCode's plugin at load); one more covers a 401's re-ask.
import { describe, expect, it } from "vitest";

import { ACP_KEY_GRANTS, ModelKeyGate } from "../src/workspace/modelKey.ts";

describe("the key gate for Claude Code and OpenCode", () => {
  for (const [cli, name] of [["claude", "Claude Code"], ["opencode", "OpenCode"]] as const) {
    it(`grants a ${name} process's nonce twice, then refuses it`, () => {
      let n = 0;
      const gate = new ModelKeyGate(() => `nonce-${++n}`);
      const nonce = gate.issue("proc-a", cli);
      const live = new Set(["proc-a"]);
      expect(ACP_KEY_GRANTS).toBe(2);
      expect(gate.decide(nonce, live)).toMatchObject({ grant: true, cli, grants: 1 });
      expect(gate.decide(nonce, live)).toMatchObject({ grant: true, grants: 2 });
      expect(gate.decide(nonce, live)).toEqual({ grant: false, why: `${name}'s grants are used up` });
      // Another process has its own count; a dead process's nonce is refused.
      const other = gate.issue("proc-b", cli);
      expect(gate.decide(other, new Set(["proc-b"]))).toMatchObject({ grant: true, grants: 1 });
      expect(gate.decide(nonce, new Set(["proc-b"]))).toEqual({ grant: false, why: "unknown nonce" });
    });
  }
});
