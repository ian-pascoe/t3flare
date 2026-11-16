// What the sign-in vendors share of OAuth (credentials/oauth.ts): every request bounded, by its own timeout and by the
// caller's overall deadline (ChatGPT's revocation), never following a redirect; and an error answer read as an error
// object only when it is one (an OAuth error or Anthropic's API error), its OAuth code only from a string `error`.
import { describe, expect, it } from "vitest";

import { oauthErrorCode, oauthErrorOf, oauthRequestOptions } from "../src/credentials/oauth.ts";

describe("the vendors' shared OAuth pieces", () => {
  it("bounds a request by the caller's deadline as well as its own timeout, and never follows a redirect", () => {
    const deadline = new AbortController();
    const options = oauthRequestOptions({ deadline: deadline.signal });
    expect(options.redirect).toBe("manual");
    expect(options.signal?.aborted).toBe(false);
    deadline.abort();
    expect(options.signal?.aborted).toBe(true);
    expect(oauthRequestOptions().signal?.aborted).toBe(false);
  });

  it("reads an error object and its OAuth code, and nothing else as one", async () => {
    const read = (body: string) => oauthErrorOf(new Response(body, { status: 400 }));
    expect(await read(JSON.stringify({ error: "invalid_grant", error_description: "x" }))).toEqual({ errorObject: true, code: "invalid_grant" });
    expect(await read(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "x" } }))).toEqual({ errorObject: true, code: undefined });
    for (const body of ['"Forbidden"', "null", "403", '[{"error":"invalid_grant"}]', '{"title":"Forbidden","status":403}', "<html></html>", ""]) {
      expect(await read(body), body).toEqual({ errorObject: false, code: undefined });
    }
    // ChatGPT's reading: only a string `error` of OAuth's form gives a code.
    expect(await oauthErrorCode(new Response(JSON.stringify({ error: "Not A Code!" }), { status: 400 }))).toBeUndefined();
    expect(await oauthErrorCode(new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }))).toBe("invalid_client");
  });
});
