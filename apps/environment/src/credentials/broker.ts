// @effect-diagnostics globalDate:off globalConsole:off cryptoRandomUUID:off
// The Credential broker (SPI-1164; ADR-0018 revived and refined): the Environment DO holds every sign-in's tokens and is
// their only refresher. It implements pi-ai's `CredentialStore` over the sealed store (credentials/sealed.ts), keyed by
// the endpoint's id: `modify` is serialised per endpoint and commits its write before it resolves, so a refresh runs once
// however many Sessions ask, and a rotated refresh token is saved before any caller gets the new access token. A Session
// asks for an access token at use time (`access`, through `endpointCredential`) and keeps it in memory only.
//
// A sign-in's attempt (its state, nonce and PKCE verifier) is sealed too, between the start and the owner's paste, so it
// survives an isolate's restart (the spike: pi-ai's in-memory `login()` does not). What the panel shows is a status
// record with no secret: signed in or not, the account's email, the token's expiry, the attempt's start, the last problem.
//
// Only ChatGPT plan usage (credentials/chatgpt.ts) signs in today; the store is the shape the others (SPI-1165, SPI-1166)
// take. Nothing here logs a token: events name the endpoint, the outcome and an OAuth error code.
import type { Credential, CredentialStore } from "@t3flare/models/endpoints";

import type { KvStorage } from "../harness/keys.ts";
import {
  type ChatGptCredential,
  type ChatGptRegistration,
  type ChatGptVendor,
  completeChatGptSignIn,
  type PendingChatGptSignIn,
  refreshChatGpt,
  revokeChatGpt,
  startChatGptSignIn,
} from "./chatgpt.ts";
import { CredentialsKeyMissing, type SealedStore } from "./sealed.ts";

/** This Environment's agent host id for OpenAI (`ext_agent_host_id`): made once, kept for every sign-in. */
export const SIGN_IN_HOST_KEY = "t3flare:sign-ins:host-id";
/** An endpoint's sign-in status, secret-free. */
export const signInStatusKey = (endpointId: string): string => `t3flare:sign-ins:${endpointId}`;
const INDEX_KEY = "t3flare:sign-ins:index";
const credentialName = (endpointId: string): string => `endpoint/${endpointId}/oauth`;
const pendingName = (endpointId: string): string => `endpoint/${endpointId}/sign-in-pending`;

/** An access token is renewed when less than this is left (pi-ai's own margin); access tokens last an hour. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** How long a started sign-in waits for its paste. */
export const PENDING_TTL_MS = 30 * 60_000;

/** An endpoint's sign-in as the panel shows it: never a token. */
export interface SignInStatus {
  readonly signedIn: boolean;
  readonly email: string | null;
  /** The registration OpenAI issued (kept after sign-out, for the next sign-in). Not a secret. */
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

export interface CredentialBroker extends CredentialStore {
  /** A Session's access token for `endpointId` now, renewed first when it is near its expiry (once, however many ask). */
  access(endpointId: string): Promise<BrokerAccess>;
  /** Starts a sign-in: its authorize URL for the owner's browser. Rejects without a credentials key. */
  start(endpointId: string): Promise<{ readonly authorizeUrl: string }>;
  /** Completes the waiting sign-in with the owner's pasted redirect. */
  complete(endpointId: string, pasted: string): Promise<SignInCompletion>;
  /** Signs out: revokes at the vendor where it can, and forgets the tokens (the registration is kept). */
  signOut(endpointId: string): Promise<{ readonly signedOut: boolean; readonly revoked: boolean }>;
  /** Signs out and forgets everything of the endpoint's sign-in (the endpoint was removed). */
  forget(endpointId: string): Promise<{ readonly revoked: boolean }>;
  status(endpointId: string): SignInStatus;
  /** Every endpoint id with a sign-in status (signed in, waiting, or with a problem to show). */
  known(): ReadonlyArray<string>;
}

export interface BrokerDeps {
  readonly kv: KvStorage & { delete(key: string): unknown };
  readonly sealed: SealedStore;
  readonly vendor: ChatGptVendor;
  readonly now?: () => number;
}

/** The write in flight per endpoint, per storage: `modify` and `delete` queue behind it. */
const locks = new WeakMap<object, Map<string, Promise<unknown>>>();

const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ t3flare: "sign-in", ...event }));

const isChatGpt = (credential: Credential | undefined): credential is ChatGptCredential & Credential =>
  credential?.type === "oauth" && typeof credential.clientId === "string" && typeof credential.access === "string" && typeof credential.refresh === "string";

export const credentialBroker = (deps: BrokerDeps): CredentialBroker => {
  const { kv, sealed, vendor } = deps;
  const now = deps.now ?? Date.now;
  const queue = (() => {
    let map = locks.get(kv);
    if (map === undefined) locks.set(kv, (map = new Map()));
    return map;
  })();
  /** Runs `task` after every earlier write of `endpointId` here, and before any later one. */
  const serial = <T>(endpointId: string, task: () => Promise<T>): Promise<T> => {
    const next = (queue.get(endpointId) ?? Promise.resolve()).then(task);
    queue.set(
      endpointId,
      next.catch(() => undefined),
    );
    return next;
  };
  const status = (endpointId: string): SignInStatus => ({ ...NOT_SIGNED_IN, ...kv.get<SignInStatus>(signInStatusKey(endpointId)) });
  const setStatus = (endpointId: string, patch: Partial<SignInStatus>): SignInStatus => {
    const next = { ...status(endpointId), ...patch };
    kv.put(signInStatusKey(endpointId), next);
    const index = new Set(kv.get<ReadonlyArray<string>>(INDEX_KEY) ?? []);
    if (!index.has(endpointId)) kv.put(INDEX_KEY, [...index, endpointId]);
    return next;
  };
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
      // Committed before `modify` resolves: a rotated refresh token is saved before anyone uses what came with it.
      await write(endpointId, next);
      return next;
    });
  const remove = (endpointId: string) =>
    serial(endpointId, async () => {
      sealed.remove(credentialName(endpointId));
    });
  const hostId = (): string => {
    const kept = kv.get<string>(SIGN_IN_HOST_KEY);
    if (kept !== undefined) return kept;
    const made = `urn:uuid:${crypto.randomUUID()}`;
    kv.put(SIGN_IN_HOST_KEY, made);
    return made;
  };
  const fresh = (credential: ChatGptCredential): boolean => now() + REFRESH_MARGIN_MS < credential.expires;

  const access = async (endpointId: string): Promise<BrokerAccess> => {
    const stored = await read(endpointId);
    if (!isChatGpt(stored)) return { ok: false, signedOut: true, problem: status(endpointId).problem ?? "it is not signed in" };
    if (fresh(stored)) return { ok: true, accessToken: stored.access, expiresAt: stored.expires };
    let refusal: { readonly refused: boolean; readonly code?: string; readonly problem: string } | undefined;
    let current: Credential | undefined;
    try {
      current = await modify(endpointId, async (seen) => {
        // Checked again under the lock: a caller ahead of this one may have renewed it already.
        if (!isChatGpt(seen) || fresh(seen)) return undefined;
        if (seen.earliestRefreshAt !== null && seen.earliestRefreshAt > now()) return undefined;
        const renewed = await refreshChatGpt(vendor, seen);
        if (renewed.ok) return renewed.credential;
        refusal = renewed;
        return undefined;
      });
    } catch {
      // The renewed credential could not be saved: its tokens go to no one (the stored refresh token may be spent).
      log({ endpoint: endpointId, event: "refresh", ok: false, saved: false });
      setStatus(endpointId, { problem: "the renewed ChatGPT sign-in could not be saved: retry, or sign in again", problemAt: now() });
      return { ok: false, signedOut: false, problem: "the renewed ChatGPT sign-in could not be saved: retry the turn, or sign in again" };
    }
    if (refusal?.refused === true) {
      log({ endpoint: endpointId, event: "refresh", ok: false, refused: true, code: refusal.code ?? null });
      await remove(endpointId);
      const problem = `${refusal.problem}: it is signed out`;
      setStatus(endpointId, { signedIn: false, expiresAt: null, problem, problemAt: now() });
      return { ok: false, signedOut: true, problem };
    }
    if (!isChatGpt(current)) return { ok: false, signedOut: true, problem: status(endpointId).problem ?? "it is not signed in" };
    if (refusal === undefined && current.access !== stored.access) {
      log({ endpoint: endpointId, event: "refresh", ok: true, expiresAt: current.expires });
      setStatus(endpointId, { expiresAt: current.expires, refreshedAt: now(), problem: null, problemAt: null });
    }
    if (current.expires > now()) {
      if (refusal !== undefined) log({ endpoint: endpointId, event: "refresh", ok: false, refused: false, code: refusal.code ?? null, kept: true });
      return { ok: true, accessToken: current.access, expiresAt: current.expires };
    }
    log({ endpoint: endpointId, event: "refresh", ok: false, refused: false, code: refusal?.code ?? null });
    return { ok: false, signedOut: false, problem: `${refusal?.problem ?? "its ChatGPT sign-in could not be renewed yet"}: retry the turn` };
  };

  const start = async (endpointId: string) => {
    if (!sealed.available) throw new CredentialsKeyMissing();
    const saved = status(endpointId);
    const registration: ChatGptRegistration | undefined = saved.clientId === null ? undefined : { clientId: saved.clientId, email: saved.email, subject: saved.subject };
    const { authorizeUrl, pending } = await startChatGptSignIn({ hostId: hostId(), now, ...(registration === undefined ? {} : { registration }), ...(vendor.urls === undefined ? {} : { urls: vendor.urls }) });
    await sealed.put(pendingName(endpointId), JSON.stringify(pending));
    setStatus(endpointId, { pendingSince: pending.startedAt, problem: null, problemAt: null });
    log({ endpoint: endpointId, event: "start", registered: registration !== undefined });
    return { authorizeUrl };
  };

  const complete = async (endpointId: string, pasted: string): Promise<SignInCompletion> => {
    const text = await sealed.open(pendingName(endpointId));
    const pending = text === undefined ? undefined : (JSON.parse(text) as PendingChatGptSignIn);
    if (pending === undefined) return { ok: false, problem: "No sign-in is waiting for a pasted address: start the sign-in again." };
    if (now() - pending.startedAt > PENDING_TTL_MS) {
      sealed.remove(pendingName(endpointId));
      setStatus(endpointId, { pendingSince: null });
      return { ok: false, problem: "That sign-in lapsed (30 minutes): start it again." };
    }
    const result = await completeChatGptSignIn(vendor, pending, pasted);
    if (!result.ok) {
      log({ endpoint: endpointId, event: "complete", ok: false, spent: result.spent === true });
      if (result.spent === true) {
        sealed.remove(pendingName(endpointId));
        // OpenAI: after a refused code, start again with the client id this attempt was issued.
        setStatus(endpointId, { pendingSince: null, problem: result.problem, problemAt: now(), ...(result.clientId === undefined ? {} : { clientId: result.clientId }) });
      }
      return { ok: false, problem: result.problem };
    }
    const { credential } = result;
    await modify(endpointId, async () => credential);
    sealed.remove(pendingName(endpointId));
    log({ endpoint: endpointId, event: "complete", ok: true, expiresAt: credential.expires });
    return {
      ok: true,
      status: setStatus(endpointId, {
        signedIn: true,
        email: credential.email,
        clientId: credential.clientId,
        subject: credential.subject,
        signedInAt: now(),
        expiresAt: credential.expires,
        refreshedAt: null,
        pendingSince: null,
        problem: null,
        problemAt: null,
      }),
    };
  };

  const signOut = async (endpointId: string) => {
    sealed.remove(pendingName(endpointId));
    const stored = await read(endpointId);
    const revoked = isChatGpt(stored) ? (await revokeChatGpt(vendor, stored)).confirmed : false;
    await remove(endpointId);
    setStatus(endpointId, { signedIn: false, expiresAt: null, pendingSince: null, problem: null, problemAt: null });
    log({ endpoint: endpointId, event: "sign-out", hadToken: stored !== undefined, revoked });
    return { signedOut: stored !== undefined, revoked };
  };

  return {
    read: (endpointId) => read(endpointId),
    list: async () => {
      const ids = kv.get<ReadonlyArray<string>>(INDEX_KEY) ?? [];
      return ids.filter((id) => sealed.mark(credentialName(id)).set).map((providerId) => ({ providerId, type: "oauth" as const }));
    },
    modify,
    delete: (endpointId) => remove(endpointId),
    access,
    start,
    complete,
    signOut,
    forget: async (endpointId) => {
      const { revoked } = await signOut(endpointId);
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
