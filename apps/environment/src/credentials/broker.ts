// @effect-diagnostics globalDate:off globalConsole:off cryptoRandomUUID:off
// The Credential broker (SPI-1164; ADR-0018 revived and refined): the Environment DO holds every Subscription's tokens
// (a Model endpoint's sign-in) and is their only refresher.
//
// - Sealed at rest: it implements pi-ai's `CredentialStore` (types only; no pi-ai in this bundle) over the sealed store
//   (credentials/sealed.ts), keyed by the endpoint's id.
// - One at a time: every write of an endpoint's sign-in (a refresh, a completed sign-in, a sign-out, `modify`, `delete`)
//   runs under that endpoint's lock, after the one before it, and is committed before it resolves. So a refresh runs
//   once however many Sessions ask, a sign-out waits for a refresh in flight and revokes the refresh token it left, and a
//   refused renewal's removal cannot wipe a sign-in completed meanwhile.
// - Saved before use: a renewed credential, its rotated refresh token included, is saved before any caller gets its
//   access token; if it cannot be saved, no caller gets it.
// - A refused renewal (the vendor's codes that end a sign-in) signs the endpoint out, with the reason; a passing failure
//   keeps a token that is still valid.
// - Sessions ask for an access token at use time (`access`, through `endpointCredential`) and keep it in memory only.
//
// A sign-in's attempt (its state, nonce and PKCE verifier) is sealed too, between the start and the owner's paste, so it
// survives an isolate's restart (the spike: pi-ai's in-memory `login()` does not). What the panel shows is a status
// record with no secret: signed in or not, the account's email, the token's expiry, the attempt's start, the last
// problem. Each sign-in kind's vendor (signIn.ts) does the talking; nothing here logs a token.
import type { Credential, CredentialStore, SignIn } from "@t3flare/models/endpoints";

import type { KvStorage } from "../harness/keys.ts";
import { CredentialsKeyMissing, type SealedStore } from "./sealed.ts";
import type { PendingSignIn, SignInCredential, SignInRegistration, SignInVendor } from "./signIn.ts";

/** This Environment's agent host id for the vendors (OpenAI's `ext_agent_host_id`): made once, kept for every sign-in. */
export const SIGN_IN_HOST_KEY = "t3flare:sign-ins:host-id";
/** An endpoint's sign-in status, secret-free. */
export const signInStatusKey = (endpointId: string): string => `t3flare:sign-ins:${endpointId}`;
const INDEX_KEY = "t3flare:sign-ins:index";
const credentialName = (endpointId: string): string => `endpoint/${endpointId}/oauth`;
const pendingName = (endpointId: string): string => `endpoint/${endpointId}/sign-in-pending`;

/** An access token is renewed when less than this is left (pi-ai's own margin); ChatGPT's last an hour. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** How long a started sign-in waits for its paste. */
export const PENDING_TTL_MS = 30 * 60_000;

/** An endpoint's sign-in as the panel shows it: never a token. */
export interface SignInStatus {
  /** Which sign-in it is (`SIGN_IN_KINDS`), from its first start. */
  readonly kind: SignIn | null;
  readonly signedIn: boolean;
  readonly email: string | null;
  /** The registration the vendor issued (kept after sign-out, for the next sign-in). Not a secret. */
  readonly clientId: string | null;
  readonly subject: string | null;
  readonly signedInAt: number | null;
  readonly expiresAt: number | null;
  readonly refreshedAt: number | null;
  /** A sign-in started and waiting for its paste. */
  readonly pendingSince: number | null;
  /** The last thing that went wrong, as a fixed text. */
  readonly problem: string | null;
  readonly problemAt: number | null;
}

const NOT_SIGNED_IN: SignInStatus = {
  kind: null,
  signedIn: false,
  email: null,
  clientId: null,
  subject: null,
  signedInAt: null,
  expiresAt: null,
  refreshedAt: null,
  pendingSince: null,
  problem: null,
  problemAt: null,
};

export type BrokerAccess =
  | { readonly ok: true; readonly accessToken: string; readonly expiresAt: number }
  /** `signedOut`: there is no sign-in (sign in again); otherwise a passing failure (retry). */
  | { readonly ok: false; readonly signedOut: boolean; readonly problem: string };

export type SignInCompletion = { readonly ok: true; readonly status: SignInStatus } | { readonly ok: false; readonly problem: string };

export interface SignOutOptions {
  /** Runs after the tokens are gone here and before the vendor is asked to revoke them (the Sessions stopped). */
  readonly beforeRevoke?: () => Promise<void>;
}

export interface CredentialBroker extends CredentialStore {
  /** A Session's access token for `endpointId` now, renewed first when it is near its expiry (once, however many ask). */
  access(endpointId: string): Promise<BrokerAccess>;
  /** Starts a `kind` sign-in for `endpointId`: its authorize URL for the owner's browser. Rejects without a credentials key. */
  start(endpointId: string, kind: SignIn): Promise<{ readonly authorizeUrl: string }>;
  /** Completes the waiting sign-in with the owner's pasted redirect. */
  complete(endpointId: string, pasted: string): Promise<SignInCompletion>;
  /**
   * Signs out: after any refresh in flight, the tokens are removed here, `beforeRevoke` runs, then the vendor revokes the
   * refresh token that was current (`revoked` only when it confirmed). The registration is kept.
   */
  signOut(endpointId: string, options?: SignOutOptions): Promise<{ readonly signedOut: boolean; readonly revoked: boolean }>;
  /** Signs out and forgets everything of the endpoint's sign-in (the endpoint was removed). */
  forget(endpointId: string, options?: SignOutOptions): Promise<{ readonly revoked: boolean }>;
  status(endpointId: string): SignInStatus;
  /** Every endpoint id with a sign-in status (signed in, waiting, or with a problem to show). */
  known(): ReadonlyArray<string>;
}

export interface BrokerDeps {
  readonly kv: KvStorage & { delete(key: string): unknown };
  readonly sealed: SealedStore;
  /** Each sign-in kind's vendor. */
  readonly vendors: Readonly<Partial<Record<SignIn, SignInVendor>>>;
  readonly now?: () => number;
}

/** The write in flight per endpoint, per storage: every write of a sign-in queues behind it. */
const locks = new WeakMap<object, Map<string, Promise<unknown>>>();

const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ t3flare: "sign-in", ...event }));

const isSignedIn = (credential: Credential | undefined): credential is SignInCredential & Credential & { readonly signIn: SignIn } =>
  credential?.type === "oauth" && typeof credential.access === "string" && typeof credential.refresh === "string" && typeof credential.signIn === "string";

export const credentialBroker = (deps: BrokerDeps): CredentialBroker => {
  const { kv, sealed, vendors } = deps;
  const now = deps.now ?? Date.now;
  const queue = (() => {
    let map = locks.get(kv);
    if (map === undefined) locks.set(kv, (map = new Map()));
    return map;
  })();
  /** Runs `task` under `endpointId`'s lock: after every earlier write of its sign-in here, and before any later one. */
  const serial = <T>(endpointId: string, task: () => Promise<T>): Promise<T> => {
    const next = (queue.get(endpointId) ?? Promise.resolve()).then(task);
    queue.set(
      endpointId,
      next.catch(() => undefined),
    );
    return next;
  };

  // --- Status (no secret) ---------------------------------------------------------------------------------------------
  const status = (endpointId: string): SignInStatus => ({ ...NOT_SIGNED_IN, ...kv.get<SignInStatus>(signInStatusKey(endpointId)) });
  const setStatus = (endpointId: string, patch: Partial<SignInStatus>): SignInStatus => {
    const next = { ...status(endpointId), ...patch };
    kv.put(signInStatusKey(endpointId), next);
    const index = new Set(kv.get<ReadonlyArray<string>>(INDEX_KEY) ?? []);
    if (!index.has(endpointId)) kv.put(INDEX_KEY, [...index, endpointId]);
    return next;
  };
  const notSignedIn = (endpointId: string): BrokerAccess => ({ ok: false, signedOut: true, problem: status(endpointId).problem ?? "it is not signed in" });

  // --- The sealed credential (callers hold the lock to write) ---------------------------------------------------------
  const read = async (endpointId: string): Promise<Credential | undefined> => {
    const text = await sealed.open(credentialName(endpointId));
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as Credential;
    } catch {
      return undefined;
    }
  };
  const write = async (endpointId: string, credential: Credential): Promise<void> => {
    await sealed.put(credentialName(endpointId), JSON.stringify(credential));
  };
  const modify: CredentialStore["modify"] = (endpointId, fn) =>
    serial(endpointId, async () => {
      const current = await read(endpointId);
      const next = await fn(current);
      if (next === undefined) return current;
      await write(endpointId, next);
      return next;
    });
  const hostId = (): string => {
    const kept = kv.get<string>(SIGN_IN_HOST_KEY);
    if (kept !== undefined) return kept;
    const made = `urn:uuid:${crypto.randomUUID()}`;
    kv.put(SIGN_IN_HOST_KEY, made);
    return made;
  };
  const fresh = (credential: SignInCredential): boolean => now() + REFRESH_MARGIN_MS < credential.expires;
  const granted = (credential: SignInCredential): BrokerAccess => ({ ok: true, accessToken: credential.access, expiresAt: credential.expires });

  // --- access: a token now, renewed under the lock when near its expiry ------------------------------------------------
  /** The vendor refused the renewal: the sign-in is over here (called under the lock). */
  const refusedRenewal = (endpointId: string, refusal: { readonly code?: string; readonly problem: string }): BrokerAccess => {
    sealed.remove(credentialName(endpointId));
    const problem = `${refusal.problem}: it is signed out`;
    setStatus(endpointId, { signedIn: false, expiresAt: null, problem, problemAt: now() });
    log({ endpoint: endpointId, event: "refresh", ok: false, refused: true, code: refusal.code ?? null });
    return { ok: false, signedOut: true, problem };
  };
  /** Renews `endpointId`'s token if it still needs it (called under the lock, so once for every caller waiting). */
  const renew = async (endpointId: string): Promise<BrokerAccess> => {
    const current = await read(endpointId);
    // Gone (signed out, or refused for a caller ahead of this one), or renewed by a caller ahead of this one.
    if (!isSignedIn(current)) return notSignedIn(endpointId);
    if (fresh(current)) return granted(current);
    const keep = (problem: string): BrokerAccess => (current.expires > now() ? granted(current) : { ok: false, signedOut: false, problem });
    if (typeof current.earliestRefreshAt === "number" && current.earliestRefreshAt > now()) return keep("its sign-in cannot be renewed yet");
    const vendor = vendors[current.signIn];
    if (vendor === undefined) return keep("this Environment cannot renew this sign-in");
    const renewed = await vendor.refresh(current);
    if (!renewed.ok) {
      if (renewed.refused) return refusedRenewal(endpointId, renewed);
      log({ endpoint: endpointId, event: "refresh", ok: false, refused: false, code: renewed.code ?? null, kept: current.expires > now() });
      return keep(renewed.problem);
    }
    try {
      // Saved before anyone gets the new access token: its rotated refresh token is the only one that works now.
      await write(endpointId, { ...renewed.credential, signIn: current.signIn });
    } catch {
      log({ endpoint: endpointId, event: "refresh", ok: false, saved: false });
      setStatus(endpointId, { problem: "the renewed sign-in could not be saved: retry, or sign in again", problemAt: now() });
      return { ok: false, signedOut: false, problem: "the renewed sign-in could not be saved" };
    }
    setStatus(endpointId, { expiresAt: renewed.credential.expires, refreshedAt: now(), problem: null, problemAt: null });
    log({ endpoint: endpointId, event: "refresh", ok: true, expiresAt: renewed.credential.expires });
    return granted(renewed.credential);
  };
  const access = async (endpointId: string): Promise<BrokerAccess> => {
    const stored = await read(endpointId);
    if (!isSignedIn(stored)) return notSignedIn(endpointId);
    return fresh(stored) ? granted(stored) : serial(endpointId, () => renew(endpointId));
  };

  // --- start and complete ----------------------------------------------------------------------------------------------
  const start = async (endpointId: string, kind: SignIn) => {
    if (!sealed.available) throw new CredentialsKeyMissing();
    const vendor = vendors[kind];
    if (vendor === undefined) throw new Error(`this Environment offers no ${kind} sign-in`);
    const saved = status(endpointId);
    const registration: SignInRegistration | undefined = saved.clientId === null || saved.kind !== kind ? undefined : { clientId: saved.clientId, email: saved.email, subject: saved.subject };
    const { authorizeUrl, pending } = await vendor.start({ hostId: hostId(), now, ...(registration === undefined ? {} : { registration }) });
    await sealed.put(pendingName(endpointId), JSON.stringify({ ...pending, signIn: kind }));
    setStatus(endpointId, { kind, pendingSince: pending.startedAt, problem: null, problemAt: null });
    log({ endpoint: endpointId, event: "start", kind, registered: registration !== undefined });
    return { authorizeUrl };
  };

  const complete = async (endpointId: string, pasted: string): Promise<SignInCompletion> => {
    const text = await sealed.open(pendingName(endpointId));
    const pending = text === undefined ? undefined : (JSON.parse(text) as PendingSignIn & { readonly signIn: SignIn });
    const vendor = pending === undefined ? undefined : vendors[pending.signIn];
    if (pending === undefined || vendor === undefined) return { ok: false, problem: "No sign-in is waiting for a pasted address: start the sign-in again." };
    if (now() - pending.startedAt > PENDING_TTL_MS) {
      sealed.remove(pendingName(endpointId));
      setStatus(endpointId, { pendingSince: null });
      return { ok: false, problem: "That sign-in lapsed (30 minutes): start it again." };
    }
    const result = await vendor.complete(pending, pasted);
    if (!result.ok) {
      log({ endpoint: endpointId, event: "complete", ok: false, spent: result.spent === true });
      if (result.spent === true) {
        sealed.remove(pendingName(endpointId));
        // The vendor's advice after a refused code: start again with the registration this attempt was issued.
        setStatus(endpointId, { pendingSince: null, problem: result.problem, problemAt: now(), ...(result.clientId === undefined ? {} : { clientId: result.clientId }) });
      }
      return { ok: false, problem: result.problem };
    }
    const { credential } = result;
    await serial(endpointId, () => write(endpointId, { ...credential, signIn: pending.signIn }));
    sealed.remove(pendingName(endpointId));
    log({ endpoint: endpointId, event: "complete", ok: true, expiresAt: credential.expires });
    return {
      ok: true,
      status: setStatus(endpointId, {
        signedIn: true,
        email: credential.email ?? null,
        clientId: credential.clientId ?? null,
        subject: credential.subject ?? null,
        signedInAt: now(),
        expiresAt: credential.expires,
        refreshedAt: null,
        pendingSince: null,
        problem: null,
        problemAt: null,
      }),
    };
  };

  // --- sign-out --------------------------------------------------------------------------------------------------------
  const signOut = async (endpointId: string, options: SignOutOptions = {}) => {
    // Under the lock: after a refresh in flight, so the refresh token taken here is the current one.
    const taken = await serial(endpointId, async () => {
      sealed.remove(pendingName(endpointId));
      const current = await read(endpointId);
      sealed.remove(credentialName(endpointId));
      setStatus(endpointId, { signedIn: false, expiresAt: null, pendingSince: null, problem: null, problemAt: null });
      return current;
    });
    await options.beforeRevoke?.();
    const vendor = isSignedIn(taken) ? vendors[taken.signIn] : undefined;
    const revoked = isSignedIn(taken) && vendor !== undefined ? (await vendor.revoke(taken)).confirmed : false;
    log({ endpoint: endpointId, event: "sign-out", hadToken: taken !== undefined, revoked });
    return { signedOut: taken !== undefined, revoked };
  };

  return {
    read: (endpointId) => read(endpointId),
    list: async () => {
      const ids = kv.get<ReadonlyArray<string>>(INDEX_KEY) ?? [];
      return ids.filter((id) => sealed.mark(credentialName(id)).set).map((providerId) => ({ providerId, type: "oauth" as const }));
    },
    modify,
    delete: (endpointId) => serial(endpointId, async () => sealed.remove(credentialName(endpointId))),
    access,
    start,
    complete,
    signOut,
    forget: async (endpointId, options) => {
      const { revoked } = await signOut(endpointId, options);
      kv.delete(signInStatusKey(endpointId));
      kv.put(
        INDEX_KEY,
        (kv.get<ReadonlyArray<string>>(INDEX_KEY) ?? []).filter((id) => id !== endpointId),
      );
      return { revoked };
    },
    status,
    known: () => kv.get<ReadonlyArray<string>>(INDEX_KEY) ?? [],
  };
};
