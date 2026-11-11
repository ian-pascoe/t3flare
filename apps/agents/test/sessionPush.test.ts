// The Session's push coalesce while streaming (cost audit F7). t3's default `paragraph` streaming shows assistant text
// at most every 400 ms (t3code apps/server/src/orchestration-v2/assistantStreaming.ts), so pushes faster than that are
// mostly filtered out again in the Environment; slower ones would hold back text t3 could show.
import { PUSH_COALESCE_MS } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

const T3_PARAGRAPH_CADENCE_MS = 400;

describe("PUSH_COALESCE_MS", () => {
  it("coalesces a streaming Session's commits for 300 ms, inside t3's paragraph cadence", () => {
    expect(PUSH_COALESCE_MS).toBe(300);
    expect(PUSH_COALESCE_MS).toBeLessThan(T3_PARAGRAPH_CADENCE_MS);
  });
});
