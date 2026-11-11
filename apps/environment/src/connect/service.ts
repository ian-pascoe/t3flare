// @effect-diagnostics globalDate:off globalDateInEffect:off globalFetch:off globalFetchInEffect:off effectFnOpportunity:off
// The Connect service (step 3+, ADR-0025): a publish-only T3 Connect link, so the owner's phone hears when a cloud run
// ends or waits. Everything is t3's own: the device-flow sign-in (`CliTokenManager.deviceAuthorizationLogin`), the
// link step (`CloudLink.reconcileDesiredLinkIfStillDesired`), the token store, and the publisher, which then publishes
// on its own whenever a thread's awareness phase changes. This service only runs those steps from the admin routes,
// once at sign-in and never at boot, and makes each link publish-only whatever was stored before (review finding 2):
//
// - every link writes `publish_only` itself and asserts the mode t3 returns; a stored tunnel config afterwards unlinks;
// - the relay's mint key is deleted after the link (review finding 1): publishing never reads it, and without it
//   t3's mint and health answers and its relay delivery proofs verify nothing;
// - on prod the account token is discarded after the link (owner decision D2; review finding 5): the relay accepts it
//   for the whole client group, so only the publish credential stays.
import * as ServerSecretStore from "t3/src/auth/ServerSecretStore.ts";
import { readCliDesiredCloudLink, readCliDesiredLinkMode, setCliDesiredCloudLink } from "t3/src/cloud/CliState.ts";
import * as CliTokenManager from "t3/src/cloud/CliTokenManager.ts";
import * as CloudLink from "t3/src/cloud/CloudLink.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_MINT_PUBLIC_KEY,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "t3/src/cloud/config.ts";
import { relayUrlConfig } from "t3/src/cloud/publicConfig.ts";
import * as ServerEnvironment from "t3/src/environment/ServerEnvironment.ts";
import * as ManagedLimits from "t3/src/policy/managedLimits.ts";
import * as AgentAwarenessRelay from "t3/src/relay/AgentAwarenessRelay.ts";
import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";

import * as Idle from "../host/idle.ts";
import { redact } from "../host/redactingConsole.ts";
import type { PublishRecorder } from "./recorder.ts";

/**
 * The origin the link names. t3 signs a link proof only for a loopback origin, and for a `manual` (publish-only) link
 * the relay records it as metadata only: the public host is never sent (plan section 4.2).
 */
export const LINK_ORIGIN = "http://127.0.0.1:443";

/** The idle hold the sign-in's poll takes while its code is valid. */
export const SIGN_IN_HOLD = Idle.CONNECT_SIGN_IN_HOLD;

/** The phases that leave a card or an alert standing on the phone until something replaces them. */
const LIVE_PHASES = new Set(["starting", "running", "waiting_for_approval", "waiting_for_input"]);

export interface ConnectPolicy {
  /** Keep the T3 Connect account token after the link (stages); prod discards it (D2). */
  readonly keepAccountToken: boolean;
}

export class ConnectError extends Schema.TaggedError<ConnectError>()("ConnectError", {
  reason: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

export interface SignInPrompt {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string | null;
  readonly expiresInSeconds: number;
}

export type SignInFlow =
  | { readonly state: "idle" }
  | { readonly state: "pending"; readonly startedAt: string; readonly expiresAt: string | null }
  | { readonly state: "linked"; readonly at: string; readonly accountTokenKept: boolean }
  | { readonly state: "failed"; readonly at: string; readonly error: string };

export interface LinkOutcome {
  readonly mode: "publish_only";
  readonly accountTokenKept: boolean;
  readonly mintKeyRemoved: true;
}

export interface UnlinkOutcome {
  /** The relay's answer to `DELETE /v1/client/environment-links/<id>`, or why it was not called. */
  readonly relay: { readonly status: number } | { readonly skipped: string };
  readonly local: boolean;
  readonly accountTokenCleared: boolean;
}

/** A failure as the status route shows it: t3's error tag and message, credentials redacted, never a cause chain. */
export const describeFailure = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  const tag = typeof error === "object" && error !== null && "_tag" in error ? String((error as { _tag: unknown })._tag) : "Error";
  const rejection = typeof error === "object" && error !== null && "rejection" in error ? `:${String((error as { rejection: unknown }).rejection)}` : "";
  const message = error instanceof Error ? error.message : String(error);
  return redact(`${tag}${rejection}: ${message}`).slice(0, 300);
};

export class Connect extends Context.Service<
  Connect,
  {
    /** Starts t3's device flow (or answers the one pending) and returns the code for the owner to approve. */
    readonly signIn: Effect.Effect<SignInPrompt, ConnectError>;
    /** R1 fallback: a token from `t3 connect login --headless`, imported once and linked with. */
    readonly importToken: (token: CliTokenManager.PersistedToken) => Effect.Effect<LinkOutcome, ConnectError>;
    /** Runs the link step again with the stored account token. */
    readonly relink: Effect.Effect<LinkOutcome, ConnectError>;
    /** Removes the link on the relay (with the account token, if held) and here; keeps the token. */
    readonly unlink: Effect.Effect<UnlinkOutcome, ConnectError>;
    /** Unlinks, then removes the account token. */
    readonly signOut: Effect.Effect<UnlinkOutcome, ConnectError>;
    /**
     * A stage's fault (M2): removes the link on the relay only, as removing the environment in the T3 apps does, so
     * the next publish meets the relay's refusal while the credential is still stored here.
     */
    readonly relayUnlinkOnly: Effect.Effect<UnlinkOutcome["relay"]>;
    /**
     * After a boot (review finding 4): republishes each thread the recorder last saw published live (starting, running
     * or waiting). t3's publisher starts with an empty map and its catch-up skips threads whose state is now null, so
     * a run a restart cancelled under a waiting approval would otherwise keep "Approval needed" on the phone; this
     * makes t3 publish the thread's current state, a tombstone included. Answers the threads it republished.
     */
    readonly republishLastLive: Effect.Effect<ReadonlyArray<string>>;
    /** t3's own publish switch. */
    readonly setPublishing: (on: boolean) => Effect.Effect<void, ConnectError>;
    readonly status: (options: { readonly relay: boolean }) => Effect.Effect<Record<string, unknown>>;
  }
>()("@t3flare/environment/connect/service/Connect") {}

export const make = (policy: ConnectPolicy, recorder: PublishRecorder) =>
  Effect.gen(function* () {
    const cloudLink = yield* CloudLink.CloudLink;
    const tokens = yield* CliTokenManager.CloudCliTokenManager;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const scope = yield* Effect.scope;
    const httpClient = yield* HttpClient.HttpClient;
    const awareness = yield* AgentAwarenessRelay.AgentAwarenessRelay;
    const lock = yield* Semaphore.make(1);
    const withSecrets = Effect.provideService(ServerSecretStore.ServerSecretStore, secrets);

    let flow: SignInFlow = { state: "idle" };
    let pending: { readonly prompt: Deferred.Deferred<SignInPrompt, ConnectError>; readonly until: number } | undefined;

    const fail = (reason: string, detail?: string) => new ConnectError({ reason, ...(detail === undefined ? {} : { detail }) });
    const has = (name: string) => secrets.get(name).pipe(Effect.map(Option.isSome), Effect.orElseSucceed(() => false));
    const text = (name: string) =>
      secrets.get(name).pipe(
        Effect.map((value) => (Option.isSome(value) ? new TextDecoder().decode(value.value) : null)),
        Effect.orElseSucceed(() => null),
      );
    const relayUrl = Effect.gen(function* () {
      return (yield* text(RELAY_URL_SECRET)) ?? (yield* relayUrlConfig.pipe(Effect.orElseSucceed(() => null)));
    });

    /** t3's link step, made publish-only whatever was stored (review finding 2). Holds the lock. */
    const linkNow = Effect.gen(function* () {
      yield* setCliDesiredCloudLink(true, "publish_only").pipe(withSecrets, Effect.mapError((e) => fail("store-desired-link", e.message)));
      // As `t3 connect link --publish-only`: publishing on, unless the owner turned it off before a relink.
      if (!(yield* has(PUBLISH_AGENT_ACTIVITY_SECRET))) {
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true")).pipe(Effect.mapError((e) => fail("store-publish-flag", e.message)));
      }
      const result = yield* Effect.exit(cloudLink.reconcileDesiredLinkIfStillDesired(LINK_ORIGIN));
      const tunnel = yield* has(CLOUD_ENDPOINT_RUNTIME_CONFIG);
      const mode = Exit.isSuccess(result) ? result.value : undefined;
      if (tunnel || (Exit.isSuccess(result) && mode !== "publish_only")) {
        // Never a managed tunnel (ADR-0010): undo the link here; the relay keeps a link the owner removes in the app.
        yield* cloudLink.unlink().pipe(Effect.ignore);
        return yield* fail("not-publish-only", tunnel ? "the relay returned a managed tunnel" : `t3 linked in mode ${String(mode)}`);
      }
      if (Exit.isFailure(result)) return yield* fail("link-failed", describeFailure(result.cause));
      yield* secrets.remove(CLOUD_MINT_PUBLIC_KEY).pipe(Effect.mapError((e) => fail("remove-mint-key", e.message)));
      if (!policy.keepAccountToken) yield* tokens.clear.pipe(Effect.mapError((e) => fail("discard-account-token", e.message)));
      return { mode: "publish_only", accountTokenKept: policy.keepAccountToken, mintKeyRemoved: true } satisfies LinkOutcome;
    });
    const link = lock.withPermits(1)(linkNow);

    const linkWith = (token: CliTokenManager.PersistedToken) =>
      lock.withPermits(1)(tokens.store(token).pipe(Effect.mapError((e) => fail("store-account-token", e.message)), Effect.andThen(linkNow)));

    const signIn = Effect.gen(function* () {
      if (pending !== undefined && Date.now() < pending.until) return yield* Deferred.await(pending.prompt);
      const prompt = yield* Deferred.make<SignInPrompt, ConnectError>();
      const startedAt = Date.now();
      // Until the code arrives, a short hold; then until it expires (plan section 2.1).
      pending = { prompt, until: startedAt + 30_000 };
      Idle.hold(SIGN_IN_HOLD, startedAt + 30_000);
      flow = { state: "pending", startedAt: new Date(startedAt).toISOString(), expiresAt: null };
      const run = CliTokenManager.deviceAuthorizationLogin((shown) =>
        Effect.sync(() => {
          const until = Date.now() + Duration.toMillis(shown.expiresIn);
          pending = { prompt, until };
          Idle.hold(SIGN_IN_HOLD, until + 5_000);
          flow = { state: "pending", startedAt: new Date(startedAt).toISOString(), expiresAt: new Date(until).toISOString() };
        }).pipe(
          Effect.andThen(
            Deferred.succeed(prompt, {
              userCode: shown.userCode,
              verificationUri: shown.verificationUri,
              verificationUriComplete: shown.verificationUriComplete ?? null,
              expiresInSeconds: Math.round(Duration.toSeconds(shown.expiresIn)),
            }),
          ),
        ),
      ).pipe(
        Effect.flatMap(({ token }) => linkWith(token)),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            Idle.release(SIGN_IN_HOLD);
            pending = undefined;
            const at = new Date().toISOString();
            flow = Exit.isSuccess(exit)
              ? { state: "linked", at, accountTokenKept: exit.value.accountTokenKept }
              : { state: "failed", at, error: describeFailure(exit.cause) };
            if (Exit.isFailure(exit)) yield* Deferred.fail(prompt, fail("sign-in-failed", describeFailure(exit.cause)));
            yield* Effect.logInfo("t3flare: T3 Connect sign-in ended", { state: flow.state });
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      yield* Effect.forkIn(Effect.ignore(run), scope);
      return yield* Deferred.await(prompt).pipe(
        Effect.timeoutOrElse({
          duration: "20 seconds",
          orElse: () => Effect.fail(fail("no-device-code", "T3 Connect's sign-in did not answer in 20 s")),
        }),
      );
    });

    const deleteRelayLink = Effect.gen(function* () {
      const token = yield* tokens.getExisting.pipe(Effect.option, Effect.map(Option.flatten));
      if (Option.isNone(token)) return { skipped: "no account token held (remove the environment in the T3 apps)" } as const;
      const url = yield* relayUrl;
      if (url === null) return { skipped: "no relay URL" } as const;
      const environmentId = yield* environment.getEnvironmentId;
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`${url}/v1/client/environment-links/${encodeURIComponent(environmentId)}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${token.value.accessToken}` },
            signal: AbortSignal.timeout(10_000),
          }),
        catch: () => fail("relay-unreachable"),
      }).pipe(Effect.option);
      return Option.isSome(response) ? ({ status: response.value.status } as const) : ({ skipped: "the relay did not answer" } as const);
    });

    const unlinkNow = (clearToken: boolean) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const relay = yield* deleteRelayLink;
          yield* cloudLink.unlink().pipe(Effect.mapError((e) => fail("unlink", e.message)));
          if (clearToken) yield* tokens.clear.pipe(Effect.mapError((e) => fail("clear-account-token", e.message)));
          if (clearToken) flow = { state: "idle" };
          return { relay, local: true, accountTokenCleared: clearToken } satisfies UnlinkOutcome;
        }),
      );

    /** The relay's view, with the account token (stages): environments and devices, reduced to what proves the link. */
    const relayView = Effect.gen(function* () {
      const token = yield* tokens.getExisting.pipe(Effect.option, Effect.map(Option.flatten));
      const url = yield* relayUrl;
      if (Option.isNone(token) || url === null) return { skipped: "no account token held" };
      const get = (path: string) =>
        Effect.tryPromise({
          try: async () => {
            const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token.value.accessToken}` }, signal: AbortSignal.timeout(10_000) });
            return { status: response.status, body: response.ok ? ((await response.json()) as Record<string, unknown>) : null };
          },
          catch: () => fail("relay-unreachable"),
        }).pipe(Effect.orElseSucceed(() => ({ status: 0, body: null })));
      const [environments, devices] = yield* Effect.all([get("/v1/environments"), get("/v2/client/devices")], { concurrency: 2 });
      const list = (body: Record<string, unknown> | null, key: string) => (Array.isArray(body?.[key]) ? (body[key] as Array<Record<string, any>>) : []);
      return {
        environments: {
          status: environments.status,
          items: list(environments.body, "environments").map((e) => ({
            environmentId: e.environmentId,
            label: e.label,
            providerKind: e.endpoint?.providerKind ?? null,
            linkedAt: e.linkedAt,
          })),
        },
        devices: {
          status: devices.status,
          items: list(devices.body, "devices").map((d) => ({ platform: d.platform, appVersion: d.appVersion, notifications: d.notifications })),
        },
      };
    });

    const status = ({ relay }: { readonly relay: boolean }) =>
      Effect.gen(function* () {
        const token = yield* tokens.getExisting.pipe(Effect.exit);
        return {
          flow,
          link: yield* cloudLink.linkState().pipe(Effect.orElseSucceed(() => null)),
          desired: {
            marked: yield* readCliDesiredCloudLink.pipe(withSecrets, Effect.orElseSucceed(() => false)),
            mode: yield* readCliDesiredLinkMode.pipe(withSecrets, Effect.orElseSucceed(() => null)),
          },
          secretsHeld: {
            environmentCredential: yield* has(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
            mintKey: yield* has(CLOUD_MINT_PUBLIC_KEY),
            tunnelConfig: yield* has(CLOUD_ENDPOINT_RUNTIME_CONFIG),
          },
          accountToken: Exit.isSuccess(token)
            ? Option.match(token.value, {
                onNone: () => ({ held: false }),
                onSome: (value) => ({ held: true, expiresAt: new Date(value.expiresAtEpochMs).toISOString(), identity: value.identity ?? null }),
              })
            : { held: true, error: describeFailure(token.cause) },
          policy,
          publishes: { ...recorder.summary(), recent: recorder.entries().slice(-30) },
          ...(relay ? { relay: yield* relayView } : {}),
        };
      });

    return Connect.of({
      signIn,
      importToken: linkWith,
      relink: link,
      unlink: unlinkNow(false),
      signOut: unlinkNow(true),
      relayUnlinkOnly: lock.withPermits(1)(deleteRelayLink),
      republishLastLive: Effect.gen(function* () {
        const live = [...recorder.lastPublishedPhases()].filter(([, phase]) => phase !== null && LIVE_PHASES.has(phase)).map(([threadId]) => threadId);
        yield* Effect.forEach(live, (threadId) => awareness.publishThread(threadId as ThreadId).pipe(Effect.ignore), { discard: true });
        return live;
      }),
      setPublishing: (on) => cloudLink.updatePreferences({ publishAgentActivity: on }).pipe(Effect.asVoid, Effect.mapError((e) => fail("preferences", e.message))),
      status,
    });
  });

export const layer = (policy: ConnectPolicy, recorder: PublishRecorder) => Layer.effect(Connect, make(policy, recorder));

/**
 * The `CloudLink` t3's HTTP routes get (review finding 1): the four calls only the relay or a client-driven link make
 * fail, as t3's own policy variant refuses them (`CloudLink.ts`, `allowsConnect`). Link state, preferences, unlink and
 * the reachability answer stay t3's. The Connect service keeps the real one.
 */
export const layerRefusingCloudLink = Layer.effect(
  CloudLink.CloudLink,
  Effect.map(CloudLink.CloudLink, (real) => {
    const refused = Effect.fn("t3flare.CloudLink.refused")(function* () {
      return yield* new ManagedLimits.ManagedPolicyRefusedError({
        organization: "t3flare",
        action: "T3 Connect's relay routes",
        detail: "this Environment links outward only, from its admin routes (ADR-0010, ADR-0025)",
      });
    });
    return CloudLink.CloudLink.of({
      ...real,
      linkProof: refused,
      applyRelayConfig: refused,
      answerHealthRequest: refused,
      mintCredential: refused,
    });
  }),
);
