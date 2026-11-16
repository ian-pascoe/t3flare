// @effect-diagnostics globalDate:off globalConsole:off cryptoRandomUUID:off
// The Credential broker (SPI-1164; ADR-0018 revived and refined): the Environment DO holds every Subscription's tokens
// (a Model endpoint's sign-in) and is their only refresher.
//
// - Sealed at rest: it implements pi-ai's `CredentialStore` (types only; no pi-ai in this bundle) over the sealed store
//   (credentials/sealed.ts), keyed by the endpoint's id.
// - One at a time: every write of an endpoint's sign-in runs under that endpoint's lock, after the one before it, and is
//   committed before it resolves: its credential (a refresh, a completed sign-in, a sign-out, `modify`, `delete`), its
//   waiting attempt (a start, a completion, a sign-out) and its status as they go with them. Only the vendor's network
//   calls of a start and a completion (the code exchange) run outside it; a completion then checks under the lock that its
//   attempt is still the one waiting. So a refresh runs once however many Sessions ask, a sign-out waits for a refresh in
//   flight and revokes the refresh token it left, a refused renewal's removal cannot wipe a sign-in completed meanwhile,
//   and a sign-out during a completion's exchange wins (the fresh grant is revoked, after the lock is let go). Every
//   status write is under it too, and a forgotten endpoint's status and index entry go in its sign-out's locked step.
//   A paste submitted twice shares the one completion in flight for its attempt.
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
import { type Credential, type CredentialStore, SIGN_IN_KINDS, type SignIn } from "@t3flare/models/endpoints";

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
/** The completion in flight per endpoint and attempt, per storage: a paste submitted twice shares it. */
const completing = new WeakMap<object, Map<string, Promise<SignInCompletion>>>();

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
  /**
   * The account's fields as a sign-out leaves them: its subject always forgotten, its email kept only where its kind's
   * next sign-in is hinted with it (`SignInKind.keepsEmail`: ChatGPT's); otherwise (Claude) neither is kept.
   */
  const forgotten = (endpointId: string): Pick<SignInStatus, "subject" | "email"> => {
    const { kind, email } = status(endpointId);
    return { subject: null, email: kind !== null && SIGN_IN_KINDS[kind].keepsEmail ? email : null };
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
    // The account is forgotten as at a sign-out: the next sign-in may be another account.
    setStatus(endpointId, { ...forgotten(endpointId), signedIn: false, expiresAt: null, problem, problemAt: now() });
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
      // Shown on the panel until a renewal succeeds, so it does not read "signed in, renews before" a time gone by.
      setStatus(endpointId, { problem: `${renewed.problem}: it is tried again at the next use`, problemAt: now() });
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
    await serial(endpointId, async () => {
      await sealed.put(pendingName(endpointId), JSON.stringify({ ...pending, signIn: kind }));
      setStatus(endpointId, { kind, pendingSince: pending.startedAt, problem: null, problemAt: null });
    });
    log({ endpoint: endpointId, event: "start", kind, registered: registration !== undefined });
    return { authorizeUrl };
  };

  const inFlight = (() => {
    let map = completing.get(kv);
    if (map === undefined) completing.set(kv, (map = new Map()));
    return map;
  })();

  /** The completion's locked step: keep the grant, or say why not (a grant whose attempt is over is revoked after it). */
  type Settled = { readonly answer: SignInCompletion; readonly superseded?: SignInCredential };

  const complete = async (endpointId: string, pasted: string): Promise<SignInCompletion> => {
    const text = await sealed.open(pendingName(endpointId));
    if (text === undefined) return { ok: false, problem: "No sign-in is waiting for a pasted address: start the sign-in again." };
    const key = JSON.stringify([endpointId, text]);
    const running = inFlight.get(key);
    if (running !== undefined) return running;
    const next = completeAttempt(endpointId, text, pasted).finally(() => inFlight.delete(key));
    inFlight.set(key, next);
    return next;
  };

  const completeAttempt = async (endpointId: string, text: string, pasted: string): Promise<SignInCompletion> => {
    const pending = JSON.parse(text) as PendingSignIn & { readonly signIn: SignIn };
    const vendor = vendors[pending.signIn];
    if (vendor === undefined) return { ok: false, problem: "No sign-in is waiting for a pasted address: start the sign-in again." };
    if (now() - pending.startedAt > PENDING_TTL_MS) {
      await serial(endpointId, async () => {
        if ((await sealed.open(pendingName(endpointId))) !== text) return;
        sealed.remove(pendingName(endpointId));
        setStatus(endpointId, { pendingSince: null });
      });
      return { ok: false, problem: "That sign-in lapsed (30 minutes): start it again." };
    }
    const result = await vendor.complete(pending, pasted);
    const settled = await serial(endpointId, async (): Promise<Settled> => {
      // Still the attempt waiting? A sign-out (or a new start) during the exchange took it away.
      const still = (await sealed.open(pendingName(endpointId))) === text;
      if (!result.ok) {
        log({ endpoint: endpointId, event: "complete", ok: false, spent: result.spent === true });
        if (result.spent === true && still) {
          sealed.remove(pendingName(endpointId));
          // The vendor's advice after a refused code: start again with the registration this attempt was issued.
          setStatus(endpointId, { pendingSince: null, problem: result.problem, problemAt: now(), ...(result.clientId === undefined ? {} : { clientId: result.clientId }) });
        }
        return { answer: { ok: false, problem: result.problem } };
      }
      const { credential } = result;
      if (!still) return { answer: { ok: false, problem: "This sign-in was signed out or started again while it finished, so it was not kept: start it again." }, superseded: credential };
      await write(endpointId, { ...credential, signIn: pending.signIn });
      sealed.remove(pendingName(endpointId));
      log({ endpoint: endpointId, event: "complete", ok: true, expiresAt: credential.expires });
      return {
        answer: {
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
        },
      };
    });
    if (settled.superseded !== undefined) {
      // Outside the lock: a revocation may take its 30 s.
      const { confirmed } = await vendor.revoke(settled.superseded);
      log({ endpoint: endpointId, event: "complete", ok: false, superseded: true, revoked: confirmed });
    }
    return settled.answer;
  };

  // --- sign-out --------------------------------------------------------------------------------------------------------
  const signOut = async (endpointId: string, options: SignOutOptions & { readonly forget?: boolean } = {}) => {
    // Under the lock: after a refresh in flight, so the refresh token taken here is the current one.
    const taken = await serial(endpointId, async () => {
      sealed.remove(pendingName(endpointId));
      const current = await read(endpointId);
      sealed.remove(credentialName(endpointId));
      if (options.forget === true) {
        // The endpoint is gone: its status and index entry go in this same step, so a start that comes after makes its own.
        kv.delete(signInStatusKey(endpointId));
        kv.put(
          INDEX_KEY,
          (kv.get<ReadonlyArray<string>>(INDEX_KEY) ?? []).filter((id) => id !== endpointId),
        );
      } else {
        // The account is forgotten too, so the next sign-in may be another account; a registration (its client id, and the
        // email it is hinted with) stays.
        setStatus(endpointId, { ...forgotten(endpointId), signedIn: false, expiresAt: null, pendingSince: null, problem: null, problemAt: null });
      }
      return current;
    });
    // The Sessions are stopped before the revocation, and the revocation runs whatever happened to them.
    try {
      await options.beforeRevoke?.();
    } catch (error) {
      log({ endpoint: endpointId, event: "sign-out-sessions-failed", error: String(error).slice(0, 200) });
    }
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
    forget: async (endpointId, options) => ({ revoked: (await signOut(endpointId, { ...options, forget: true })).revoked }),
    status,
    known: () => kv.get<ReadonlyArray<string>>(INDEX_KEY) ?? [],
  };
};
