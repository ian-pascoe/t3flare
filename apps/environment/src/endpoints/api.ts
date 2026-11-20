// The Settings page's Model endpoints routes (SPI-1162), answered after panel.ts has applied its guards (Access, then for
// a change JSON, Origin, Sec-Fetch-Site and the owner's CSRF token):
//
//   GET  /api/endpoints            the entity, each endpoint with its key's mark (never the key), the presets and APIs
//   POST /api/endpoints            { op: "save", endpoint, apiKey? } or { op: "remove", id }
//   POST /api/endpoints/discover   { endpoint, apiKey? }: the endpoint's model list with pi-ai's metadata, read with the
//                                  key given, else the saved endpoint's own, but only at its saved target (API, base
//                                  URL and headers)
//   POST /api/endpoints/sign-in    a sign-in (SPI-1164): { op: "start", id, signIn, label, acknowledgedTerms: true }
//                                  gives the authorize URL; without the owner's acknowledgement of the vendor's
//                                  terms (`SignInKind.terms`, the panel's checkbox) the start is refused, 400;
//                                  { op: "complete", id, label, pasted } finishes it with the address the browser
//                                  landed on and saves the sign-in's endpoint with the models its token lists;
//                                  { op: "sign-out", id } revokes and stops the endpoint's Sessions; where the
//                                  vendor offers no revocation (Claude, SPI-1165), the answer's `revocation` says
//                                  where the owner removes the grant. A device sign-in (Copilot, SPI-1166):
//                                  `start` also gives `device` (the code the owner enters at the vendor's page),
//                                  and `complete` takes no paste: it asks the vendor once whether it was approved,
//                                  answering `waiting` until it was
//
// Every change bumps the endpoints' own revision and is audited under the entity `endpoints`, with the key's mark and the
// headers' names only.
import {
  ENDPOINT_APIS,
  ENDPOINT_ID,
  ENDPOINT_PRESETS,
  isDeviceSignIn,
  isRecord,
  isSignIn,
  type ModelEndpoint,
  RESERVED_ENDPOINT_IDS,
  sameTarget,
  SIGN_IN_KINDS,
  signInHeaders,
  SIGN_INS,
  type SignIn,
  validateEndpoint,
} from "@t3flare/models/endpoints";

import type { CredentialBroker, SignInStatus } from "../credentials/broker.ts";
import type { SealedMark } from "../credentials/sealed.ts";
import type { AuditEntry } from "../harness/store.ts";
import type { Discovery } from "./discover.ts";
import { type EndpointStore, modelsWithMetadata } from "./store.ts";

export interface EndpointsApiDeps {
  readonly store: EndpointStore;
  /** Reads an endpoint's model list (discover.ts). */
  readonly discover: (target: Pick<ModelEndpoint, "api" | "baseUrl" | "headers">, apiKey: string | undefined, signIn?: SignIn) => Promise<Discovery>;
  /** The endpoints changed: the Pi Durable picker reads them again. */
  readonly changed?: () => void;
  /** The Credential broker (SPI-1164): the sign-ins' tokens. Without it no sign-in is offered. */
  readonly signIns?: CredentialBroker;
  /** A sign-in endpoint was signed out or removed: its Sessions drop its token and stop its turns. */
  readonly signedOut?: (endpointId: string) => Promise<void>;
  /** An endpoint was removed: what is kept of it elsewhere goes too (its limit readings, SPI-1174). */
  readonly removed?: (endpointId: string) => void;
}

export type EndpointsAnswer = { readonly status: number; readonly json: unknown } | { readonly status: number; readonly text: string };

export const ENDPOINTS_PATHS = { list: "/api/endpoints", discover: "/api/endpoints/discover", signIn: "/api/endpoints/sign-in" } as const;

/** An endpoint as audited: no key, and its headers' names only. */
const audited = (endpoint: ModelEndpoint | undefined, key?: SealedMark) =>
  endpoint === undefined
    ? null
    : {
        label: endpoint.label,
        api: endpoint.api,
        baseUrl: endpoint.baseUrl,
        auth: endpoint.auth,
        headers: Object.keys(endpoint.headers),
        models: endpoint.models.map((model) => model.id),
        ...(key === undefined || !key.set ? {} : { key }),
      };

/** The entity as the panel shows it: each key's mark, with whether it still opens, and each sign-in's status. */
export const endpointsOverview = async (deps: Pick<EndpointsApiDeps, "store" | "signIns">) => {
  const { revision, endpoints } = deps.store.load();
  const signIns = deps.signIns;
  return {
    revision,
    credentialsKey: deps.store.sealing,
    endpoints: await Promise.all(
      endpoints.map(async (endpoint) => ({
        ...endpoint,
        key: await deps.store.keyStatus(endpoint.id),
        ...(signIns !== undefined && isSignIn(endpoint.auth) ? { signIn: signIns.status(endpoint.id) } : {}),
      })),
    ),
    // A sign-in under way for an endpoint not saved yet (its first), shown with its paste field.
    ...(signIns === undefined
      ? {}
      : {
          signIns: Object.fromEntries(
            signIns
              .known()
              .filter((id) => !endpoints.some((endpoint) => endpoint.id === id))
              .map((id) => [id, signIns.status(id)] as const)
              .filter(([, status]) => status.pendingSince !== null || status.problem !== null),
          ) as Record<string, SignInStatus>,
        }),
    presets: ENDPOINT_PRESETS,
    apis: ENDPOINT_APIS,
  };
};

/** A change to the endpoints, `audit`ed. */
export const endpointsChange = async (deps: EndpointsApiDeps, body: Record<string, unknown>, audit: (entry: Omit<AuditEntry, "at" | "caller" | "entity">) => void): Promise<EndpointsAnswer> => {
  if (body.op === "remove") {
    const id = typeof body.id === "string" ? body.id : "";
    const removed = deps.store.remove(id);
    if (!removed.ok) return { status: 404, text: removed.error };
    // What else is kept of it (its limit readings) goes at once, before a sign-out that may fail.
    deps.removed?.(id);
    // A removed sign-in endpoint is signed out first (revoked where the vendor allows), and its Sessions stopped.
    const signedOut = isSignIn(removed.removed.auth) && deps.signIns !== undefined ? await deps.signIns.forget(id, { beforeRevoke: async () => deps.signedOut?.(id) }) : undefined;
    audit({ action: "endpoint.remove", target: id, before: audited(removed.removed), ...(signedOut === undefined ? {} : { after: { revoked: signedOut.revoked } }) });
    deps.changed?.();
    const kept = signedOut !== undefined && !signedOut.revoked && isSignIn(removed.removed.auth) ? revocationNote(removed.removed.auth) : {};
    return { status: 200, json: { ok: true, revision: removed.endpoints.revision, ...kept } };
  }
  if (body.op !== "save") return { status: 400, text: "the body is { op: \"save\", endpoint, apiKey? } or { op: \"remove\", id }" };
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") return { status: 400, text: "apiKey is a string" };
  const saved = await deps.store.save(body.endpoint, typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {});
  if (!saved.ok) return { status: 400, text: saved.error };
  audit({ action: saved.added ? "endpoint.add" : "endpoint.change", target: saved.endpoint.id, before: audited(saved.before), after: audited(saved.endpoint, saved.key) });
  deps.changed?.();
  return { status: 200, json: { ok: true, revision: saved.endpoints.revision, endpoint: saved.endpoint, key: saved.key } };
};

/** The model list of an endpoint being edited, with pi-ai's metadata: nothing is saved or audited. */
export const endpointsDiscover = async (deps: EndpointsApiDeps, body: Record<string, unknown>): Promise<EndpointsAnswer> => {
  const given = isRecord(body.endpoint) ? body.endpoint : {};
  // The list is read before the endpoint has models or a final id: validate it with a stand-in for each.
  const valid = validateEndpoint({ ...given, id: typeof given.id === "string" && given.id !== "" ? given.id : "unsaved", label: typeof given.label === "string" && given.label.trim() !== "" ? given.label : "unsaved", models: [] });
  if (!valid.ok) return { status: 400, text: valid.error };
  const typed = typeof body.apiKey === "string" && body.apiKey !== "" ? body.apiKey : undefined;
  let apiKey: string | undefined;
  let target: Pick<ModelEndpoint, "api" | "baseUrl" | "headers"> = valid.endpoint;
  // The saved sign-in whose list it is (its vendor's list may have its own shape: Copilot's).
  let signIn: SignIn | undefined;
  if (isSignIn(valid.endpoint.auth)) {
    // A sign-in's list is read with its own token, at its own target only.
    const saved = deps.store.load().endpoints.find((endpoint) => endpoint.id === valid.endpoint.id);
    if (deps.signIns === undefined || saved === undefined || !isSignIn(saved.auth)) return { status: 400, text: "sign in first: the list is read with the sign-in's token" };
    const access = await deps.signIns.access(saved.id);
    if (!access.ok) return { status: 200, json: { ok: false, error: access.problem } };
    target = signInTarget(saved.auth, access);
    signIn = saved.auth;
  } else if (valid.endpoint.auth === "api-key") {
    if (typed !== undefined) apiKey = typed;
    else {
      // The saved key goes only to the target it was saved with: the same API, base URL and headers.
      const saved = await deps.store.resolve(valid.endpoint.id);
      if (saved === undefined || saved.endpoint.auth === "none" || !sameTarget(saved.endpoint, valid.endpoint)) {
        return { status: 400, text: "type the API key: a saved key is sent only to the API, base URL and headers it was saved with" };
      }
      if (saved.apiKey === undefined) return { status: 400, text: "the saved API key cannot be read: enter it again" };
      apiKey = saved.apiKey;
    }
  }
  const found = await deps.discover(target, apiKey, signIn);
  if (!found.ok) return { status: 200, json: found };
  return { status: 200, json: { ok: true, models: modelsWithMetadata(valid.endpoint, found.models) } };
};

/**
 * A sign-in's model list target: its own API and base URL (the one its token names, when it does: Copilot's), its token
 * in the headers its vendor takes it in, with the headers the broker gives beside it.
 */
const signInTarget = (kind: SignIn, access: { readonly accessToken: string; readonly baseUrl?: string; readonly headers?: Readonly<Record<string, string>> }): Pick<ModelEndpoint, "api" | "baseUrl" | "headers"> => ({
  api: SIGN_IN_KINDS[kind].api,
  baseUrl: access.baseUrl ?? SIGN_IN_KINDS[kind].baseUrl,
  headers: { ...access.headers, ...signInHeaders(kind, access.accessToken) },
});

/** What a sign-out tells the owner beside `revoked`: where to remove a grant its vendor cannot revoke (none otherwise). */
const revocationNote = (kind: SignIn | null | undefined): { readonly revocation?: string } => {
  const text = kind === null || kind === undefined ? null : SIGN_IN_KINDS[kind].revocation;
  return text === null ? {} : { revocation: text };
};

/** A label for a sign-in's endpoint: the given one, else the sign-in's title. */
const signInLabel = (value: unknown, kind: SignIn): string => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 60) : SIGN_IN_KINDS[kind].title);

const isSignInKind = (value: unknown): value is SignIn => typeof value === "string" && (SIGN_INS as ReadonlyArray<string>).includes(value);

/** Signs `id` out (after its tokens are gone here, its Sessions stopped; then revoked at the vendor where it can). */
const signOutOf = (deps: EndpointsApiDeps, signIns: CredentialBroker, id: string) => signIns.signOut(id, { beforeRevoke: async () => deps.signedOut?.(id) });

/**
 * A sign-in's completion: the pasted redirect exchanged, then its endpoint saved with the models its token lists (a
 * re-sign-in keeps the owner's); a grant whose endpoint cannot be saved is revoked. Answered as JSON either way, so the
 * panel shows why beside the paste field.
 */
const completeSignIn = async (
  deps: EndpointsApiDeps,
  signIns: CredentialBroker,
  id: string,
  saved: ModelEndpoint | undefined,
  body: Record<string, unknown>,
  audit: (entry: Omit<AuditEntry, "at" | "caller" | "entity">) => void,
): Promise<EndpointsAnswer> => {
  // A device sign-in takes no paste: its completion asks the vendor whether the owner approved.
  const started = signIns.status(id).kind;
  const device = started !== null && isDeviceSignIn(started);
  const pasted = device && body.pasted === undefined ? "" : body.pasted;
  if (typeof pasted !== "string" || pasted.length > 8192) return { status: 400, text: "pasted is the address your browser landed on" };
  const result = await signIns.complete(id, pasted);
  const kind = signIns.status(id).kind;
  // Not approved yet: asked again after the vendor's interval; nothing to audit until it ends.
  if (!result.ok && result.waiting === true) return { status: 200, json: { ok: false, waiting: true, error: result.problem } };
  if (!result.ok || kind === null) {
    audit({ action: "endpoint.sign-in", target: id, after: { ok: false } });
    return { status: 200, json: { ok: false, error: result.ok ? "the sign-in's kind is not known: start it again" : result.problem } };
  }
  const target = SIGN_IN_KINDS[kind];
  let models: ReadonlyArray<{ readonly id: string; readonly name?: string }> = saved?.models ?? [];
  let modelsProblem: string | undefined;
  if (saved === undefined) {
    const access = await signIns.access(id);
    const found = access.ok ? await deps.discover(signInTarget(kind, access), undefined, kind) : { ok: false as const, error: access.problem };
    if (found.ok) models = found.models;
    else modelsProblem = found.error;
  }
  const stored = await deps.store.save(
    { id, label: saved?.label ?? signInLabel(body.label, kind), api: target.api, baseUrl: target.baseUrl, auth: kind, headers: {}, models: models.map((model) => ({ id: model.id, ...(model.name === undefined ? {} : { name: model.name }) })) },
    {},
  );
  if (!stored.ok) {
    // No endpoint holds the fresh grant: it is revoked, not left behind.
    const { revoked } = await signOutOf(deps, signIns, id);
    audit({ action: "endpoint.sign-in", target: id, after: { ok: false, saved: false, revoked } });
    const dropped = target.revocation === null ? "dropped (its revocation was not confirmed)" : `dropped here. ${target.revocation}`;
    return { status: 200, json: { ok: false, error: `Signed in, but the endpoint could not be saved (${stored.error}), so the sign-in was ${revoked ? "revoked" : dropped}.` } };
  }
  audit({ action: "endpoint.sign-in", target: id, before: audited(stored.before), after: { ok: true, ...audited(stored.endpoint) } });
  deps.changed?.();
  return { status: 200, json: { ok: true, email: result.status.email, models: stored.endpoint.models.length, ...(modelsProblem === undefined ? {} : { modelsProblem }) } };
};

/**
 * A sign-in's steps (SPI-1164), for any kind of `SIGN_IN_KINDS`: start, complete with the pasted redirect, sign out.
 * Each audited, none with a token.
 */
export const endpointsSignIn = async (deps: EndpointsApiDeps, body: Record<string, unknown>, audit: (entry: Omit<AuditEntry, "at" | "caller" | "entity">) => void): Promise<EndpointsAnswer> => {
  const signIns = deps.signIns;
  if (signIns === undefined) return { status: 404, text: "this Environment offers no sign-in" };
  const id = typeof body.id === "string" ? body.id : "";
  if (!ENDPOINT_ID.test(id) || RESERVED_ENDPOINT_IDS.includes(id)) return { status: 400, text: "id is 1–32 of a–z, 0–9 and -, not a reserved one" };
  const saved = deps.store.load().endpoints.find((endpoint) => endpoint.id === id);
  if (saved !== undefined && !isSignIn(saved.auth)) return { status: 400, text: `there is already an endpoint with an API key (or none) under the id ${id}: pick another id` };
  if (body.op === "start") {
    if (!isSignInKind(body.signIn)) return { status: 400, text: `signIn is one of ${SIGN_INS.join(", ")}` };
    if (saved !== undefined && saved.auth !== body.signIn) return { status: 400, text: `the endpoint ${id} is another sign-in: pick another id` };
    // The owner's acknowledgement that complying with the vendor's terms is theirs: the panel's checkbox, required here
    // too, so no start skips it.
    if (body.acknowledgedTerms !== true) {
      const { title, terms } = SIGN_IN_KINDS[body.signIn];
      return {
        status: 400,
        text: `acknowledge ${terms.vendor}'s terms first: complying with them when you sign in with ${title} is your responsibility (${terms.docs}). Tick the acknowledgement in the Settings page, or send acknowledgedTerms: true`,
      };
    }
    try {
      const { authorizeUrl, device } = await signIns.start(id, body.signIn);
      audit({ action: "endpoint.sign-in.start", target: id, after: { signIn: body.signIn, acknowledgedTerms: true } });
      return { status: 200, json: { ok: true, authorizeUrl, ...(device === undefined ? {} : { device }) } };
    } catch (error) {
      return { status: 400, text: error instanceof Error ? error.message : "the sign-in could not start" };
    }
  }
  if (body.op === "complete") return completeSignIn(deps, signIns, id, saved, body, audit);
  if (body.op === "sign-out") {
    const kind = saved !== undefined && isSignIn(saved.auth) ? saved.auth : signIns.status(id).kind;
    const { signedOut, revoked } = await signOutOf(deps, signIns, id);
    audit({ action: "endpoint.sign-out", target: id, after: { signedOut, revoked } });
    return { status: 200, json: { ok: true, signedOut, revoked, ...(revoked ? {} : revocationNote(kind)) } };
  }
  return { status: 400, text: 'the body is { op: "start", id, signIn, label, acknowledgedTerms: true }, { op: "complete", id, label, pasted } or { op: "sign-out", id }' };
};
