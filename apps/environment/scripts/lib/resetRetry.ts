// @effect-diagnostics globalConsole:off globalTimers:off
// The stage scripts' fetch, retried when the connection resets. Node's fetch (undici) speaks HTTP/2 to Cloudflare's
// edge, which now and then resets a stream (`ECONNRESET`, `http2ErrorCode` set) before the Worker sees the request: the
// bump's acceptance test died of it at random points while every request the Worker logged succeeded. A request with
// no body or a string body is sent again, at most twice; a reset after the Worker acted on a POST would send it twice,
// which these test clients accept over dying. WebSockets are not covered. `stage.ts run` installs it in every script it
// runs (`--import ./lib/installResetRetry.ts`), before the script's own first fetch.
const RESET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ERR_HTTP2_STREAM_ERROR", "ERR_HTTP2_SESSION_ERROR", "ERR_HTTP2_GOAWAY_SESSION"]);
const ATTEMPTS = 3;

/** A fetch failure that is a reset connection, not an answer. */
export const isConnectionReset = (error: unknown): boolean => {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return error instanceof TypeError && typeof cause?.code === "string" && RESET_CODES.has(cause.code);
};

const replayable = (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): boolean =>
  !(input instanceof Request && input.body !== null) && (init?.body === undefined || init.body === null || typeof init.body === "string");

export const withResetRetry = (inner: typeof fetch): typeof fetch => {
  const retried = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await inner(input, init);
      } catch (error) {
        if (attempt >= ATTEMPTS || !isConnectionReset(error) || !replayable(input, init) || init?.signal?.aborted === true) throw error;
        const url = input instanceof Request ? input.url : String(input);
        console.error(`fetch ${init?.method ?? "GET"} ${url}: connection reset, attempt ${attempt + 1} of ${ATTEMPTS}`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  };
  return retried as typeof fetch;
};
