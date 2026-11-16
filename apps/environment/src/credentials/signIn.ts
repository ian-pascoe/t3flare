// What the Credential broker (broker.ts) needs of each sign-in's vendor (SPI-1164): start an attempt, complete it with
// the owner's paste, refresh, revoke. ChatGPT plan usage is the first (chatgpt.ts `chatgptSignIn`), a Claude plan the
// second (claude.ts `claudeSignIn`, SPI-1165; its `revoke` never confirms: Anthropic offers no revocation); Copilot
// (SPI-1166) adds its own, one entry each in the broker's `vendors`, keyed as `SIGN_IN_KINDS`.

/**
 * A signed-in credential, in pi-ai's `OAuthCredential` shape (`{ type: "oauth", access, refresh, expires, …extras }`).
 * `expires` is the access token's real expiry (ms); the broker renews it before.
 */
export interface SignInCredential {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  /** The vendor's registration of this app for the account, when it has one (OpenAI's issued client id). */
  readonly clientId?: string;
  /** What the account granted, as the vendor listed it. */
  readonly scopes?: ReadonlyArray<string>;
  /** The vendor's id of the account, and its email: what the panel shows, and what a sign-out forgets. */
  readonly subject?: string | null;
  readonly email?: string | null;
  /** No refresh before this (ms), when the vendor says. */
  readonly earliestRefreshAt?: number | null;
  readonly [key: string]: unknown;
}

/** What is kept of an account after sign-out, for its next sign-in. Not a secret. */
export interface SignInRegistration {
  readonly clientId: string;
  readonly email?: string | null;
  readonly subject?: string | null;
}

/** An attempt between its start and the owner's paste, kept sealed. */
export interface PendingSignIn {
  readonly startedAt: number;
}

export type SignInResult =
  | { readonly ok: true; readonly credential: SignInCredential }
  /**
   * `spent`: the attempt is over (its code was exchanged or refused); otherwise the owner may paste again. `clientId`: a
   * registration this attempt was issued, kept for the next one.
   */
  | { readonly ok: false; readonly problem: string; readonly spent?: boolean; readonly clientId?: string };

export type RefreshResult =
  | { readonly ok: true; readonly credential: SignInCredential }
  /** `refused`: the vendor ended the sign-in (sign in again); otherwise a passing failure. `problem` is a fixed text. */
  | { readonly ok: false; readonly refused: boolean; readonly code?: string; readonly problem: string };

export interface SignInVendor {
  start(input: { readonly hostId: string; readonly registration?: SignInRegistration; readonly now: () => number }): Promise<{ readonly authorizeUrl: string; readonly pending: PendingSignIn }>;
  complete(pending: PendingSignIn, pasted: string): Promise<SignInResult>;
  refresh(credential: SignInCredential): Promise<RefreshResult>;
  revoke(credential: SignInCredential): Promise<{ readonly confirmed: boolean }>;
}
