// The stage scripts' fetch, retried on a reset connection (scripts/lib/resetRetry.ts): the bump's acceptance test died
// of HTTP/2 stream resets at Cloudflare's edge.
import { describe, expect, it, vi } from "vitest";

import { isConnectionReset, withResetRetry } from "../scripts/lib/resetRetry.ts";

const reset = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });

describe("withResetRetry", () => {
  it("sends a bodiless or string-body request again after a reset, and answers with the retry's response", async () => {
    vi.useFakeTimers();
    try {
      const inner = vi.fn<typeof fetch>().mockRejectedValueOnce(reset()).mockResolvedValueOnce(new Response("ok"));
      const pending = withResetRetry(inner)("https://stage.example/api", { method: "POST", body: "{}" });
      await vi.runAllTimersAsync();
      expect(await (await pending).text()).toBe("ok");
      expect(inner).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after three attempts with the reset", async () => {
    vi.useFakeTimers();
    try {
      const inner = vi.fn<typeof fetch>().mockRejectedValue(reset());
      const pending = withResetRetry(inner)("https://stage.example/api").catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(isConnectionReset(await pending)).toBe(true);
      expect(inner).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry another failure, or a body it cannot send again", async () => {
    const refused = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    await expect(withResetRetry(refused)("https://stage.example/api")).rejects.toThrow("fetch failed");
    expect(refused).toHaveBeenCalledTimes(1);

    const streamed = vi.fn<typeof fetch>().mockRejectedValue(reset());
    await expect(withResetRetry(streamed)("https://stage.example/api", { method: "POST", body: new Uint8Array([1]) })).rejects.toThrow("fetch failed");
    expect(streamed).toHaveBeenCalledTimes(1);
  });
});
