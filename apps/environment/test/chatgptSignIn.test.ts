// @effect-diagnostics globalDate:off
// ChatGPT plan usage ("Sign in with ChatGPT", SPI-1164) against a fake of OpenAI's authorization server: the authorize
// URL as OpenAI's docs give it, a pasted loopback redirect in the forms a phone gives, the code exchange with PKCE, the
// ID token's checks, the plan-usage scope, refresh and revocation. Each failure is a fixed text that never holds a token.
import { describe, expect, it } from "vitest";

import { CHATGPT_REDIRECT_URI, completeChatGptSignIn, refreshChatGpt, revokeChatGpt, startChatGptSignIn } from "../src/credentials/chatgpt.ts";
import { FAKE_URLS, fakeOpenAI } from "./fixtures/fakeOpenAIAuth.ts";

const HOST = "urn:uuid:0b6f6a8e-5d43-4a59-9d8e-6f1f2b3c4d5e";

describe("ChatGPT plan usage sign-in", () => {
  it("starts with OpenAI's authorize URL for a first registration", async () => {
    const { authorizeUrl, pending } = await startChatGptSignIn({ hostId: HOST, now: () => 1_000 });
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(FAKE_URLS.authorize);
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "t3flare",
      ext_agent_host_id: HOST,
      response_type: "code",
      redirect_uri: "http://127.0.0.1:1455/auth/callback",
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      code_challenge_method: "S256",
    });
    expect(params.state).toBe(pending.state);
    expect(params.nonce).toBe(pending.nonce);
    expect(params.code_challenge).not.toBe(pending.verifier);
    expect(pending).toMatchObject({ redirectUri: CHATGPT_REDIRECT_URI, clientId: null, startedAt: 1_000 });
  });

  it("reuses a saved registration's issued client id, without the name hint", async () => {
    const { authorizeUrl } = await startChatGptSignIn({ hostId: HOST, registration: { clientId: "oaiapp_saved", email: "owner@example.com" } });
    const params = new URL(authorizeUrl).searchParams;
    expect(params.get("client_id")).toBe("oaiapp_saved");
    expect(params.get("login_hint")).toBe("owner@example.com");
    expect(params.has("agent_name_hint")).toBe(false);
  });

  it("completes from a pasted redirect, with or without its scheme, and checks the ID token", async () => {
    for (const shape of ["full", "no-scheme", "query"] as const) {
      const vendor = await fakeOpenAI();
      const { authorizeUrl, pending } = await startChatGptSignIn({ hostId: HOST });
      const callback = vendor.approve(authorizeUrl, { sub: "user-42", email: "owner@example.com" });
      const pasted = shape === "full" ? callback : shape === "no-scheme" ? callback.replace(/^http:\/\//, "") : `  ${new URL(callback).search}\n`;
      const result = await completeChatGptSignIn({ fetch: vendor.fetch, now: Date.now }, pending, pasted);
      expect(result.ok, shape).toBe(true);
      if (!result.ok) continue;
      expect(result.credential).toMatchObject({ type: "oauth", subject: "user-42", email: "owner@example.com" });
      expect(result.credential.clientId).toMatch(/^oaiapp_/);
      expect(result.credential.scopes).toContain("chatgpt.tokens.use.direct");
      expect(result.credential.expires).toBeGreaterThan(Date.now() + 3_000_000);
      // The ID token was checked, then dropped: nothing sends it on.
      expect(result.credential).not.toHaveProperty("idToken");
      expect(vendor.counts.exchanges).toBe(1);
    }
  });

  it("says plainly why a sign-in failed, never echoing a code or token", async () => {
    const cases: Array<{ readonly name: string; readonly set: (vendor: Awaited<ReturnType<typeof fakeOpenAI>>) => void; readonly paste: (callback: string) => string; readonly expected: RegExp }> = [
      { name: "a Free plan's refusal", set: (vendor) => (vendor.options.exchangeError = "invalid_grant"), paste: (callback) => callback, expected: /refused the sign-in code \(invalid_grant\).*Plus or Pro/ },
      { name: "another sign-in's redirect", set: () => undefined, paste: (callback) => callback.replace(/state=[^&]+/, "state=other"), expected: /does not belong to the sign-in in progress/ },
      { name: "a declined consent", set: () => undefined, paste: () => `${CHATGPT_REDIRECT_URI}?error=access_denied&state=STATE`, expected: /declined/ },
      { name: "no plan usage granted", set: (vendor) => (vendor.options.grantedScope = "openid profile email offline_access"), paste: (callback) => callback, expected: /did not allow ChatGPT plan usage/ },
      { name: "text that is not a redirect", set: () => undefined, paste: () => "hello", expected: /Paste the whole address/ },
      { name: "another host", set: () => undefined, paste: (callback) => callback.replace("127.0.0.1:1455", "evil.example"), expected: /127\.0\.0\.1/ },
    ];
    for (const entry of cases) {
      const vendor = await fakeOpenAI();
      entry.set(vendor);
      const { authorizeUrl, pending } = await startChatGptSignIn({ hostId: HOST });
      const callback = vendor.approve(authorizeUrl);
      const result = await completeChatGptSignIn({ fetch: vendor.fetch, now: Date.now }, pending, entry.paste(callback).replace("STATE", pending.state));
      expect(result.ok, entry.name).toBe(false);
      if (result.ok) continue;
      expect(result.problem, entry.name).toMatch(entry.expected);
      const code = new URL(callback).searchParams.get("code")!;
      for (const secret of [code, pending.verifier, ...vendor.issued]) expect(result.problem).not.toContain(secret);
    }
  });

  it("refuses an ID token for another attempt's nonce", async () => {
    const vendor = await fakeOpenAI();
    const first = await startChatGptSignIn({ hostId: HOST });
    const second = await startChatGptSignIn({ hostId: HOST });
    const callback = vendor.approve(first.authorizeUrl);
    // The code was issued for the first attempt's nonce; completing it as the second (state and verifier forged) fails.
    const forged = { ...second.pending, state: first.pending.state, verifier: first.pending.verifier };
    const result = await completeChatGptSignIn({ fetch: vendor.fetch, now: Date.now }, forged, callback);
    expect(result).toMatchObject({ ok: false, problem: expect.stringMatching(/could not be verified/) });
  });

  // Each way an ID token can be wrong, on its own: the sign-in is refused, nothing is kept.
  for (const wrong of ["bad-signature", "wrong-iss", "wrong-aud", "expired", "alg-hs256"] as const) {
    it(`refuses an ID token with ${wrong}`, async () => {
      const vendor = await fakeOpenAI({ idToken: wrong });
      const { authorizeUrl, pending } = await startChatGptSignIn({ hostId: HOST });
      const result = await completeChatGptSignIn({ fetch: vendor.fetch, now: Date.now }, pending, vendor.approve(authorizeUrl));
      expect(result).toMatchObject({ ok: false, spent: true, problem: expect.stringMatching(/could not be verified/) });
      // The grant it will not keep is revoked at OpenAI.
      expect(vendor.revoked.has(vendor.currentRefresh()!)).toBe(true);
    });
  }

  it("revokes a grant that did not allow plan usage", async () => {
    const vendor = await fakeOpenAI({ grantedScope: "openid profile email offline_access" });
    const { authorizeUrl, pending } = await startChatGptSignIn({ hostId: HOST });
    const result = await completeChatGptSignIn({ fetch: vendor.fetch, now: Date.now }, pending, vendor.approve(authorizeUrl));
    expect(result).toMatchObject({ ok: false, problem: expect.stringMatching(/did not allow ChatGPT plan usage/) });
    expect(vendor.counts.revocations).toBe(1);
    expect(vendor.revoked.has(vendor.currentRefresh()!)).toBe(true);
  });

  it("refuses the sign-in when OpenAI's JWKS cannot be read", async () => {
    const vendor = await fakeOpenAI({ jwksDown: true });
    const { authorizeUrl, pending } = await startChatGptSignIn({ hostId: HOST });
    const result = await completeChatGptSignIn({ fetch: vendor.fetch, now: Date.now }, pending, vendor.approve(authorizeUrl));
    expect(result).toMatchObject({ ok: false, problem: expect.stringMatching(/could not be verified/) });
  });

  it("refuses a redirect that names another issuer, and takes OpenAI's", async () => {
    const vendor = await fakeOpenAI();
    const { authorizeUrl, pending } = await startChatGptSignIn({ hostId: HOST });
    const callback = new URL(vendor.approve(authorizeUrl));
    callback.searchParams.set("iss", "https://evil.example");
    expect(await completeChatGptSignIn({ fetch: vendor.fetch, now: Date.now }, pending, callback.toString())).toMatchObject({ ok: false, problem: expect.stringMatching(/another issuer/) });
    expect(vendor.counts.exchanges).toBe(0);
    callback.searchParams.set("iss", "https://auth.openai.com");
    expect(await completeChatGptSignIn({ fetch: vendor.fetch, now: Date.now }, pending, callback.toString())).toMatchObject({ ok: true });
  });

  it("refreshes with the rotated token, and names a refused refresh", async () => {
    const vendor = await fakeOpenAI();
    const { authorizeUrl, pending } = await startChatGptSignIn({ hostId: HOST });
    const signedIn = await completeChatGptSignIn({ fetch: vendor.fetch, now: Date.now }, pending, vendor.approve(authorizeUrl));
    if (!signedIn.ok) throw new Error(signedIn.problem);
    const once = await refreshChatGpt({ fetch: vendor.fetch, now: Date.now }, signedIn.credential);
    expect(once).toMatchObject({ ok: true });
    if (!once.ok) return;
    expect(once.credential.refresh).not.toBe(signedIn.credential.refresh);
    expect(once.credential.access).not.toBe(signedIn.credential.access);
    expect(once.credential).toMatchObject({ clientId: signedIn.credential.clientId, subject: signedIn.credential.subject, email: signedIn.credential.email });
    // The replaced refresh token is refused (invalid_grant): the sign-in is over.
    expect(await refreshChatGpt({ fetch: vendor.fetch, now: Date.now }, signedIn.credential)).toMatchObject({ ok: false, refused: true, code: "invalid_grant" });
    vendor.options.tokenDown = true;
    expect(await refreshChatGpt({ fetch: vendor.fetch, now: Date.now }, once.credential)).toMatchObject({ ok: false, refused: false });
  });

  it("revokes the refresh token at the discovery's revocation endpoint", async () => {
    const vendor = await fakeOpenAI();
    const { authorizeUrl, pending } = await startChatGptSignIn({ hostId: HOST });
    const signedIn = await completeChatGptSignIn({ fetch: vendor.fetch, now: Date.now }, pending, vendor.approve(authorizeUrl));
    if (!signedIn.ok) throw new Error(signedIn.problem);
    expect(await revokeChatGpt({ fetch: vendor.fetch, now: Date.now }, signedIn.credential)).toEqual({ confirmed: true });
    const revocation = vendor.requests.find((request) => request.url === FAKE_URLS.revoke)!;
    expect(Object.fromEntries(new URLSearchParams(revocation.body))).toEqual({ token: signedIn.credential.refresh, token_type_hint: "refresh_token", client_id: signedIn.credential.clientId });
    expect(await refreshChatGpt({ fetch: vendor.fetch, now: Date.now }, signedIn.credential)).toMatchObject({ ok: false, refused: true });
  });

  it("gives a failing revocation up at its deadline, its retry wait cut short", async () => {
    const vendor = await fakeOpenAI();
    const { authorizeUrl, pending } = await startChatGptSignIn({ hostId: HOST });
    const signedIn = await completeChatGptSignIn({ fetch: vendor.fetch, now: Date.now }, pending, vendor.approve(authorizeUrl));
    if (!signedIn.ok) throw new Error(signedIn.problem);
    vendor.options.revokeStatus = 503;
    const started = performance.now();
    // A 400 ms deadline: the first try, a 250 ms wait, the second try, then the 1 s wait is cut at the deadline.
    expect(await revokeChatGpt({ fetch: vendor.fetch, now: Date.now }, signedIn.credential, 400)).toEqual({ confirmed: false });
    expect(vendor.counts.revocations).toBe(2);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

