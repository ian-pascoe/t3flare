// The Claude subscription sign-in (SPI-1165) against a fake of Anthropic's OAuth: the authorize URL with pi-ai's client,
// redirect and scopes, PKCE and a state of its own; the code Anthropic's page shows, pasted in the forms a phone gives;
// the state checked; the exchange; refresh with rotation; and no revocation, since Anthropic offers none. Each failure is
// a fixed text that never holds a token, a code or the verifier.
import { CLAUDE_CLIENT_ID, CLAUDE_REDIRECT_URI, CLAUDE_SCOPES, CLAUDE_TOKEN_URL } from "@t3flare/models/claudeOAuth";
import { describe, expect, it, vi } from "vitest";

import { claudeSignIn, completeClaudeSignIn, refreshClaude, startClaudeSignIn } from "../src/credentials/claude.ts";
import { fakeAnthropic } from "./fixtures/fakeAnthropicAuth.ts";

const NOW = 1_000_000;
const vendorOf = (fake: ReturnType<typeof fakeAnthropic>) => ({ fetch: fake.fetch, now: () => NOW });

describe("the Claude subscription sign-in", () => {
  it("starts with Anthropic's authorize URL: pi-ai's client, redirect and scopes, PKCE, and a state that is not the verifier", async () => {
    const { authorizeUrl, pending } = await startClaudeSignIn({ now: () => NOW });
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://claude.ai/oauth/authorize");
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({ code: "true", client_id: CLAUDE_CLIENT_ID, response_type: "code", redirect_uri: CLAUDE_REDIRECT_URI, scope: CLAUDE_SCOPES, code_challenge_method: "S256" });
    expect(params.state).toBe(pending.state);
    expect(pending.state).not.toBe(pending.verifier);
    expect(authorizeUrl).not.toContain(pending.verifier);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier)));
    expect(params.code_challenge).toBe(btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    expect(pending.startedAt).toBe(NOW);
  });

  it("completes from the code Anthropic shows, pasted whole, with spaces, or as the page's address", async () => {
    for (const shape of ["code#state", "spaced", "address", "address without scheme"] as const) {
      const fake = fakeAnthropic();
      const { authorizeUrl, pending } = await startClaudeSignIn({ now: () => NOW });
      const shown = fake.approve(authorizeUrl, { uuid: "acct-42", email: "owner@example.com" });
      const [code, state] = shown.split("#");
      const address = `${CLAUDE_REDIRECT_URI}?code=${code}&state=${state}`;
      const pasted = shape === "code#state" ? shown : shape === "spaced" ? `  ${shown}\n` : shape === "address" ? address : address.replace(/^https:\/\//, "");
      const result = await completeClaudeSignIn(vendorOf(fake), pending, pasted);
      expect(result, shape).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(result.credential).toMatchObject({ type: "oauth", subject: "acct-42", email: "owner@example.com", expires: NOW + 28_800_000 });
      expect(result.credential.access).toMatch(/^sk-ant-oat01-/);
      expect(result.credential.scopes).toContain("user:inference");
      const sent = fake.requests[0]!;
      expect(sent.url).toBe(CLAUDE_TOKEN_URL);
      expect(JSON.parse(sent.body)).toEqual({ grant_type: "authorization_code", client_id: CLAUDE_CLIENT_ID, code, state, redirect_uri: CLAUDE_REDIRECT_URI, code_verifier: pending.verifier });
      // Never following a redirect (the body holds the code), and bounded.
      expect(sent).toMatchObject({ redirect: "manual", signal: true });
    }
  });

  it("checks the state: another attempt's code is refused before any exchange, and the attempt keeps waiting", async () => {
    const fake = fakeAnthropic();
    const first = await startClaudeSignIn({ now: () => NOW });
    const second = await startClaudeSignIn({ now: () => NOW });
    const shown = fake.approve(first.authorizeUrl);
    const result = await completeClaudeSignIn(vendorOf(fake), second.pending, shown);
    expect(result).toMatchObject({ ok: false, problem: expect.stringMatching(/does not belong to the sign-in in progress/) });
    expect(result).not.toHaveProperty("spent");
    expect(fake.counts.exchanges).toBe(0);
    for (const part of [shown, ...shown.split("#")]) expect(JSON.stringify(result)).not.toContain(part);
  });

  it("refuses any address but the page Anthropic shows the code on, before any exchange: the authorize link itself spends nothing", async () => {
    const fake = fakeAnthropic();
    const { authorizeUrl, pending } = await startClaudeSignIn({ now: () => NOW });
    const [code] = fake.approve(authorizeUrl).split("#");
    // The authorize link carries `code=true` and this attempt's state: pasted by mistake, it must not be exchanged.
    const pastes = [authorizeUrl, `https://evil.example/oauth/code/callback?code=${code}&state=${pending.state}`, `https://platform.claude.com/other?code=${code}&state=${pending.state}`, `code=${code}&state=${pending.state}`];
    for (const pasted of pastes) {
      const result = await completeClaudeSignIn(vendorOf(fake), pending, pasted);
      expect(result, pasted).toMatchObject({ ok: false });
      expect(result, pasted).not.toHaveProperty("spent");
      for (const secret of [code!, pending.state, pending.verifier]) expect(JSON.stringify(result), pasted).not.toContain(secret);
    }
    expect(fake.counts.exchanges).toBe(0);
  });

  it("bounds each request at 15 s by default", async () => {
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    const fake = fakeAnthropic();
    const { authorizeUrl, pending } = await startClaudeSignIn({ now: () => NOW });
    await completeClaudeSignIn(vendorOf(fake), pending, fake.approve(authorizeUrl));
    expect(timeouts).toHaveBeenCalledWith(15_000);
    timeouts.mockRestore();
  });

  it("takes a code pasted in quotes, or with a stray quote at either end, and asks again for one holding other characters, never exchanging it", async () => {
    for (const quote of [['"', '"'], ["'", "'"], ["\u201C", "\u201D"], ["`", "`"], ['"', ""], ["", "\u201D"]] as const) {
      const fake = fakeAnthropic();
      const { authorizeUrl, pending } = await startClaudeSignIn({ now: () => NOW });
      const shown = fake.approve(authorizeUrl);
      expect(await completeClaudeSignIn(vendorOf(fake), pending, ` ${quote[0]}${shown}${quote[1]} `), quote[0]).toMatchObject({ ok: true });
    }
    const fake = fakeAnthropic();
    const { authorizeUrl, pending } = await startClaudeSignIn({ now: () => NOW });
    const shown = fake.approve(authorizeUrl);
    // Each holds the right state, followed by an address's characters: not what Anthropic's page shows.
    for (const pasted of [`${shown}?x`, `${shown}&x=1`, `${shown}&x`, `${shown}#more`, `x=${shown}`, `,${shown}`, `code:${shown}`, `${shown},`]) {
      expect(await completeClaudeSignIn(vendorOf(fake), pending, pasted), pasted).toMatchObject({ ok: false, problem: expect.stringMatching(/^Copy all of the code/) });
    }
    expect(fake.counts.exchanges).toBe(0);
  });

  it("gives up on a token endpoint that does not answer, within its bound, and the attempt keeps waiting", async () => {
    const fake = fakeAnthropic({ hang: true });
    const { authorizeUrl, pending } = await startClaudeSignIn({ now: () => NOW });
    const shown = fake.approve(authorizeUrl);
    const started = performance.now();
    const result = await completeClaudeSignIn({ ...vendorOf(fake), timeoutMs: 50 }, pending, shown);
    expect(result).toMatchObject({ ok: false, problem: expect.stringMatching(/could not be reached/) });
    expect(result).not.toHaveProperty("spent");
    expect(await refreshClaude({ ...vendorOf(fake), timeoutMs: 50 }, { type: "oauth", access: "sk-ant-oat01-a", refresh: "sk-ant-ort01-r", expires: NOW })).toMatchObject({ ok: false, refused: false });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("says plainly why a sign-in failed, never echoing a code, the verifier or a token", async () => {
    const cases: Array<{ readonly name: string; readonly set: (fake: ReturnType<typeof fakeAnthropic>) => void; readonly paste?: (shown: string) => string; readonly problem: RegExp; readonly spent: boolean }> = [
      { name: "no state", set: () => undefined, paste: (shown) => shown.split("#")[0]!, problem: /Copy all of the code/, spent: false },
      { name: "empty", set: () => undefined, paste: () => "  ", problem: /Copy all of the code/, spent: false },
      { name: "refused code", set: (fake) => void (fake.options.exchangeError = "invalid_grant"), problem: /Anthropic refused the sign-in code \(invalid_grant\)/, spent: true },
      { name: "unreachable", set: (fake) => void (fake.options.tokenDown = true), problem: /could not be reached/, spent: false },
      { name: "no model use", set: (fake) => void (fake.options.grantedScope = "user:profile"), problem: /did not allow model use \(user:inference\)/, spent: true },
      { name: "unknown token form", set: (fake) => void (fake.options.plainTokens = true), problem: /not in the form/, spent: true },
    ];
    for (const entry of cases) {
      const fake = fakeAnthropic();
      entry.set(fake);
      const { authorizeUrl, pending } = await startClaudeSignIn({ now: () => NOW });
      const shown = fake.approve(authorizeUrl);
      const result = await completeClaudeSignIn(vendorOf(fake), pending, entry.paste?.(shown) ?? shown);
      expect(result, entry.name).toMatchObject({ ok: false, problem: expect.stringMatching(entry.problem) });
      expect(result.ok === false && result.spent === true, entry.name).toBe(entry.spent);
      for (const secret of [...fake.secrets(), pending.verifier, pending.state]) expect(JSON.stringify(result), entry.name).not.toContain(secret);
    }
  });

  it("refreshes with the stored refresh token and keeps the rotated one; a replaced one is refused and ends the sign-in", async () => {
    const fake = fakeAnthropic();
    const { authorizeUrl, pending } = await startClaudeSignIn({ now: () => NOW });
    const signedIn = await completeClaudeSignIn(vendorOf(fake), pending, fake.approve(authorizeUrl));
    if (!signedIn.ok) throw new Error(signedIn.problem);
    const renewed = await refreshClaude(vendorOf(fake), signedIn.credential);
    expect(renewed).toMatchObject({ ok: true });
    if (!renewed.ok) return;
    expect(JSON.parse(fake.requests.at(-1)!.body)).toEqual({ grant_type: "refresh_token", client_id: CLAUDE_CLIENT_ID, refresh_token: signedIn.credential.refresh });
    expect(renewed.credential.refresh).toBe(fake.currentRefresh());
    expect(renewed.credential.refresh).not.toBe(signedIn.credential.refresh);
    expect(renewed.credential).toMatchObject({ subject: signedIn.credential.subject, email: signedIn.credential.email, expires: NOW + 28_800_000 });
    // The replaced token, presented again: Anthropic's invalid_grant, which ends the sign-in.
    expect(await refreshClaude(vendorOf(fake), signedIn.credential)).toEqual({ ok: false, refused: true, code: "invalid_grant", problem: "Claude refused to renew the sign-in (invalid_grant)" });
    // A passing failure is not a refusal.
    fake.options.refreshStatus = 503;
    expect(await refreshClaude(vendorOf(fake), renewed.credential)).toMatchObject({ ok: false, refused: false, problem: expect.stringMatching(/HTTP 503/) });
  });

  it("ends the sign-in on a JSON refusal of the refresh (a grant removed at claude.ai), but not on passing trouble or a body that is not JSON", async () => {
    const credential = { type: "oauth" as const, access: "sk-ant-oat01-a", refresh: "sk-ant-ort01-r", expires: NOW };
    const cases: Array<{ readonly status: number; readonly body?: unknown; readonly refused: boolean; readonly code?: string }> = [
      { status: 401, body: { error: "invalid_client" }, refused: true, code: "invalid_client" },
      { status: 400, body: { error: "unauthorized_client" }, refused: true, code: "unauthorized_client" },
      // No OAuth code at all (Anthropic's API error shape, or none): still the end of the sign-in, not "retry" forever.
      { status: 401, body: { type: "error", error: { type: "authentication_error", message: "OAuth token has been revoked" } }, refused: true, code: "http_401" },
      { status: 403, body: { type: "error", error: { type: "permission_error", message: "x" } }, refused: true, code: "http_403" },
      // Not JSON (an edge's HTML page, or nothing): passing trouble, retried; the sign-in is kept.
      { status: 403, refused: false },
      { status: 401, body: "", refused: false },
      // JSON that is not an error object: a bare value, a list, another shape (an edge's problem details). Passing.
      { status: 403, body: "Forbidden", refused: false },
      { status: 403, body: null, refused: false },
      { status: 403, body: 403, refused: false },
      { status: 401, body: [{ error: "invalid_grant" }], refused: false },
      { status: 403, body: { type: "about:blank", title: "Forbidden", status: 403 }, refused: false },
      // Anthropic's passing codes, each.
      { status: 400, body: { error: "temporarily_unavailable" }, refused: false },
      { status: 400, body: { error: "server_error" }, refused: false },
      { status: 400, body: { error: "slow_down" }, refused: false },
      { status: 429, body: { error: "rate_limit_error" }, refused: false },
    ];
    for (const entry of cases) {
      const fake = fakeAnthropic({ refreshStatus: entry.status, refreshBody: entry.body });
      const result = await refreshClaude(vendorOf(fake), credential);
      expect(result, JSON.stringify(entry)).toMatchObject({ ok: false, refused: entry.refused, ...(entry.code === undefined ? {} : { code: entry.code }) });
      expect(JSON.stringify(result)).not.toContain("revoked");
    }
  });

  it("does not take a renewal whose access token is not a Claude subscription's", async () => {
    const fake = fakeAnthropic();
    const { authorizeUrl, pending } = await startClaudeSignIn({ now: () => NOW });
    const signedIn = await completeClaudeSignIn(vendorOf(fake), pending, fake.approve(authorizeUrl));
    if (!signedIn.ok) throw new Error(signedIn.problem);
    fake.options.plainTokens = true;
    expect(await refreshClaude(vendorOf(fake), signedIn.credential)).toEqual({ ok: false, refused: false, problem: "Anthropic's renewal was not a usable token set" });
  });

  it("revokes nothing: Anthropic offers no revocation, so nothing is sent and it is not confirmed", async () => {
    const fake = fakeAnthropic();
    const vendor = claudeSignIn(vendorOf(fake));
    expect(await vendor.revoke({ type: "oauth", access: "sk-ant-oat01-a", refresh: "sk-ant-ort01-r", expires: NOW })).toEqual({ confirmed: false });
    expect(fake.requests).toEqual([]);
  });
});
