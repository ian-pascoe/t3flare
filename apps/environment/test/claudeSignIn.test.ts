// The Claude subscription sign-in (SPI-1165) against a fake of Anthropic's OAuth: the authorize URL with pi-ai's client,
// redirect and scopes, PKCE and a state of its own; the code Anthropic's page shows, pasted in the forms a phone gives;
// the state checked; the exchange; refresh with rotation; and no revocation, since Anthropic offers none. Each failure is
// a fixed text that never holds a token, a code or the verifier.
import { CLAUDE_CLIENT_ID, CLAUDE_REDIRECT_URI, CLAUDE_SCOPES, CLAUDE_TOKEN_URL } from "@t3flare/models/claudeOAuth";
import { describe, expect, it } from "vitest";

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
    for (const shape of ["code#state", "spaced", "address"] as const) {
      const fake = fakeAnthropic();
      const { authorizeUrl, pending } = await startClaudeSignIn({ now: () => NOW });
      const shown = fake.approve(authorizeUrl, { uuid: "acct-42", email: "owner@example.com" });
      const [code, state] = shown.split("#");
      const pasted = shape === "code#state" ? shown : shape === "spaced" ? `  ${shown}\n` : `${CLAUDE_REDIRECT_URI}?code=${code}&state=${state}`;
      const result = await completeClaudeSignIn(vendorOf(fake), pending, pasted);
      expect(result, shape).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(result.credential).toMatchObject({ type: "oauth", subject: "acct-42", email: "owner@example.com", expires: NOW + 28_800_000 });
      expect(result.credential.access).toMatch(/^sk-ant-oat01-/);
      expect(result.credential.scopes).toContain("user:inference");
      const sent = fake.requests[0]!;
      expect(sent.url).toBe(CLAUDE_TOKEN_URL);
      expect(JSON.parse(sent.body)).toEqual({ grant_type: "authorization_code", client_id: CLAUDE_CLIENT_ID, code, state, redirect_uri: CLAUDE_REDIRECT_URI, code_verifier: pending.verifier });
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

  it("revokes nothing: Anthropic offers no revocation, so nothing is sent and it is not confirmed", async () => {
    const fake = fakeAnthropic();
    const vendor = claudeSignIn(vendorOf(fake));
    expect(await vendor.revoke({ type: "oauth", access: "sk-ant-oat01-a", refresh: "sk-ant-ort01-r", expires: NOW })).toEqual({ confirmed: false });
    expect(fake.requests).toEqual([]);
  });
});
