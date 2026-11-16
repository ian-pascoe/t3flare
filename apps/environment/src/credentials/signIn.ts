// What the Credential broker (broker.ts) needs of each sign-in's vendor (SPI-1164): start an attempt, complete it with
// the owner's paste, refresh, revoke. ChatGPT plan usage is the first (chatgpt.ts `chatgptSignIn`), a Claude plan the
// second (claude.ts `claudeSignIn`, SPI-1165; its `revoke` never confirms: Anthropic offers no revocation), a GitHub
// Copilot plan the third (copilot.ts `copilotSignIn`, SPI-1166: a device sign-in, whose `complete` polls the vendor once
// and may leave the attempt waiting, and whose requests go where its token says, `use`), one entry each in the broker's
// `vendors`, keyed as `SIGN_IN_KINDS`.

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
  | {
      readonly ok: false;
      readonly problem: string;
      readonly spent?: boolean;
      readonly clientId?: string;
      /**
       * A device sign-in not approved yet (or not asked again yet): the attempt as it waits on (its next poll's time, a
       * slowed interval), sealed in place of the one given while it is still the attempt waiting.
       */
      readonly waiting?: PendingSignIn;
    };

export type RefreshResult =
  | { readonly ok: true; readonly credential: SignInCredential }
  /** `refused`: the vendor ended the sign-in (sign in again); otherwise a passing failure. `problem` is a fixed text. */
  | { readonly ok: false; readonly refused: boolean; readonly code?: string; readonly problem: string };

/** A device sign-in's code for the owner to enter at the vendor's page (`authorizeUrl`). Not a secret: the page shows it. */
export interface DeviceCode {
  readonly userCode: string;
  /** When the code lapses (ms). */
  readonly expiresAt: number;
  /** How often the panel asks whether it was approved (the vendor's poll interval). */
  readonly intervalSeconds: number;
}

/** Where a request with the credential goes and what it takes beside the token, when the credential decides (Copilot). */
export interface SignInUse {
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface SignInVendor {
  start(input: { readonly hostId: string; readonly registration?: SignInRegistration; readonly now: () => number }): Promise<{
    readonly authorizeUrl: string;
    readonly pending: PendingSignIn;
    readonly device?: DeviceCode;
  }>;
  /** With the owner's paste; a device sign-in takes none and polls the vendor instead. */
  complete(pending: PendingSignIn, pasted: string): Promise<SignInResult>;
  refresh(credential: SignInCredential): Promise<RefreshResult>;
  revoke(credential: SignInCredential): Promise<{ readonly confirmed: boolean }>;
  /** Where the credential's requests go and the headers they take, when the vendor's token decides (Copilot's). */
  use?(credential: SignInCredential): SignInUse;
}
