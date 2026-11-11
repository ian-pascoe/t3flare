// Step 3+ (P4; review findings 1, 2 and 5): the Connect service's link step with t3's real CloudLink and signing key
// against a fake relay. The link is publish-only whatever was stored before (relink after unlink included), a relay
// that hands back a tunnel is undone, the mint key is gone after the link, and the account token is kept or discarded
// by policy. Shaped after t3's own `CloudLink.lifecycle.test.ts` harness.
import { generateKeyPairSync } from "node:crypto";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as EnvironmentAuth from "t3/src/auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "t3/src/auth/ServerSecretStore.ts";
import * as CliTokenManager from "t3/src/cloud/CliTokenManager.ts";
import * as CloudLink from "t3/src/cloud/CloudLink.ts";
import * as ConnectReachability from "t3/src/cloud/ConnectReachability.ts";
import * as EnvironmentKeys from "t3/src/cloud/environmentKeys.ts";
import * as ManagedEndpointRuntime from "t3/src/cloud/ManagedEndpointRuntime.ts";
import * as ServerConfigModule from "t3/src/config.ts";
import * as ServerEnvironment from "t3/src/environment/ServerEnvironment.ts";
import * as ManagedPolicy from "t3/src/policy/ManagedPolicy.ts";
import * as AgentAwarenessRelay from "t3/src/relay/AgentAwarenessRelay.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makePublishRecorder } from "../src/connect/recorder.ts";
import * as ConnectService from "../src/connect/service.ts";

const MINT_KEY = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const ENVIRONMENT = EnvironmentId.make("env_123");
const TOKEN: CliTokenManager.PersistedToken = { accessToken: "account-access-token", refreshToken: "account-refresh", expiresAtEpochMs: Number.MAX_SAFE_INTEGER };

const decodeJwt = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as Record<string, any>;

interface Harness {
  readonly secrets: Map<string, string>;
  readonly relayCalls: Array<{ readonly method: string; readonly path: string; readonly body: any }>;
  readonly tunnels: Array<unknown>;
  token: CliTokenManager.PersistedToken | undefined;
  /** What the fake relay's link answers as `endpointRuntime`. */
  endpointRuntime: unknown;
}

const harness = (): Harness => ({ secrets: new Map(), relayCalls: [], tunnels: [], token: undefined, endpointRuntime: null });

const run = <A, E>(h: Harness, policy: ConnectService.ConnectPolicy, use: (connect: ConnectService.Connect["Service"]) => Effect.Effect<A, E>) => {
  const store: ServerSecretStore.ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.map(Option.fromNullishOr(h.secrets.get(name)), (v) => new TextEncoder().encode(v))),
    set: (name, value) => Effect.sync(() => void h.secrets.set(name, new TextDecoder().decode(value))),
    create: (name, value) => Effect.sync(() => void h.secrets.set(name, new TextDecoder().decode(value))),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void h.secrets.delete(name)),
  };
  const relay = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : null;
      h.relayCalls.push({ method: request.method, path: url.pathname, body });
      const answer =
        url.pathname === "/v1/client/environment-link-challenges"
          ? { challenge: "challenge-1", expiresAt: "2099-01-01T00:00:00.000Z" }
          : url.pathname === "/v1/client/environment-links"
            ? {
                ok: true,
                cloudUserId: "user_owner",
                environmentId: ENVIRONMENT,
                endpoint: decodeJwt(body.proof).endpoint,
                endpointRuntime: h.endpointRuntime,
                relayIssuer: "https://relay.t3.codes",
                environmentCredential: "environment-credential-1",
                cloudMintPublicKey: MINT_KEY,
              }
            : { ok: true };
      return HttpClientResponse.fromWeb(request, Response.json(answer));
    }),
  );
  const tokens = CliTokenManager.CloudCliTokenManager.of({
    get: Effect.die("unused"),
    getExisting: Effect.sync(() => Option.fromNullishOr(h.token)),
    hasCredential: Effect.sync(() => h.token !== undefined),
    store: (token) => Effect.sync(() => void (h.token = token)),
    clear: Effect.sync(() => void (h.token = undefined)),
  });
  return Effect.runPromise(
    Effect.flatMap(ConnectService.Connect, use).pipe(
      Effect.provide(ConnectService.layer(policy, makePublishRecorder({ read: () => undefined, write: () => undefined }))),
      Effect.provide(CloudLink.layer.pipe(Layer.provide(EnvironmentKeys.layer), Layer.provide(ManagedPolicy.layerTest()))),
      Effect.provideService(ConnectReachability.ConnectReachability, ConnectReachability.ConnectReachability.of({ check: Effect.die("unused"), latest: Effect.succeedNone })),
      Effect.provideService(HttpServer.HttpServer, HttpServer.HttpServer.of({ address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 443), serve: (() => Effect.void) as never })),
      Effect.provideService(ServerSecretStore.ServerSecretStore, store),
      Effect.provideService(
        AgentAwarenessRelay.AgentAwarenessRelay,
        AgentAwarenessRelay.AgentAwarenessRelay.of({ publishThread: () => Effect.void, drain: Effect.void, requestCatchUp: () => Effect.void, start: () => Effect.void }),
      ),
      Effect.provideService(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(ENVIRONMENT),
          getDescriptor: Effect.succeed({ environmentId: ENVIRONMENT, label: "t3flare" } as never),
        }),
      ),
      Effect.provideService(
        ManagedEndpointRuntime.CloudManagedEndpointRuntime,
        ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
          // As the Worker's: no cloudflared, so a tunnel never runs.
          applyConfig: (config) => Effect.sync(() => (h.tunnels.push(config), config === null ? { status: "disabled" } : { status: "unsupported", providerKind: "cloudflare_tunnel" }) as never),
          recoveryRequests: Stream.empty,
          requestRecovery: () => Effect.void,
          restartConnector: () => Effect.succeed(false),
          tunnelConnected: Stream.empty,
          inspectConnector: Effect.succeed(null),
          readinessChanged: Stream.empty,
          withLinkStateLock: (effect) => effect,
        }),
      ),
      Effect.provideService(EnvironmentAuth.EnvironmentAuth, EnvironmentAuth.EnvironmentAuth.of({} as never)),
      Effect.provideService(CliTokenManager.CloudCliTokenManager, tokens),
      Effect.provideService(HttpClient.HttpClient, relay),
      Effect.provide(ServerConfigModule.layerTest("/", { prefix: "t3flare-connect-test-" }).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))),
      Effect.scoped,
    ) as Effect.Effect<A, E>,
  );
};

const STAGE = { keepAccountToken: true };
const PROD = { keepAccountToken: false };

describe("the publish-only link step against a fake relay", () => {
  afterEach(() => vi.restoreAllMocks());

  it("links publish-only: a manual proof for a loopback origin, no tunnel asked for, mint key dropped, credential kept", async () => {
    const h = harness();
    const outcome = await run(h, STAGE, (connect) => connect.importToken(TOKEN));
    expect(outcome).toEqual({ mode: "publish_only", accountTokenKept: true, mintKeyRemoved: true });

    const [challenge, link] = h.relayCalls;
    expect(challenge).toMatchObject({ method: "POST", path: "/v1/client/environment-link-challenges", body: { managedTunnelsEnabled: false } });
    expect(link).toMatchObject({ method: "POST", path: "/v1/client/environment-links", body: { managedTunnelsEnabled: false } });
    const proof = decodeJwt(link!.body.proof);
    expect(proof.scopes).toEqual(["agent_activity_notifications"]);
    expect(proof.endpoint).toEqual({ httpBaseUrl: "http://127.0.0.1:443", wsBaseUrl: "ws://127.0.0.1:443", providerKind: "manual" });
    expect(proof.origin).toEqual({ localHttpHost: "127.0.0.1", localHttpPort: 443 });
    expect(proof.challenge).toBe("challenge-1");

    expect(h.secrets.get("cloud-relay-environment-credential")).toBe("environment-credential-1");
    expect(h.secrets.get("cloud-cli-desired-link")).toBe("publish_only");
    expect(h.secrets.get("cloud-publish-agent-activity")).toBe("true");
    expect(h.secrets.has("cloud-mint-ed25519-public-key")).toBe(false);
    expect(h.secrets.has("cloud-endpoint-runtime-config")).toBe(false);
    expect(h.token).toEqual(TOKEN);
  });

  it("discards the account token after the link on prod (D2)", async () => {
    const h = harness();
    const outcome = await run(h, PROD, (connect) => connect.importToken(TOKEN));
    expect(outcome.accountTokenKept).toBe(false);
    expect(h.token).toBeUndefined();
    expect(h.secrets.get("cloud-relay-environment-credential")).toBe("environment-credential-1");
  });

  it("relinks publish-only after an unlink removed the desired-link mark (review finding 2)", async () => {
    const h = harness();
    const fetches: Array<string> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetches.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      return Response.json({ ok: true });
    });
    await run(h, STAGE, (connect) => connect.importToken(TOKEN));
    const unlinked = await run(h, STAGE, (connect) => connect.unlink);
    expect(unlinked).toEqual({ relay: { status: 200 }, local: true, accountTokenCleared: false });
    expect(fetches).toEqual([`DELETE /v1/client/environment-links/${ENVIRONMENT}`]);
    expect(h.secrets.has("cloud-cli-desired-link")).toBe(false);
    expect(h.secrets.has("cloud-relay-environment-credential")).toBe(false);

    h.relayCalls.length = 0;
    const relinked = await run(h, STAGE, (connect) => connect.relink);
    expect(relinked.mode).toBe("publish_only");
    expect(h.relayCalls.map((call) => call.body?.managedTunnelsEnabled)).toEqual([false, false]);
    expect(decodeJwt(h.relayCalls[1]!.body.proof).endpoint.providerKind).toBe("manual");
    expect(h.secrets.get("cloud-cli-desired-link")).toBe("publish_only");
  });

  it("undoes a link the relay answered with a tunnel, and keeps no tunnel config", async () => {
    const h = harness();
    h.endpointRuntime = { providerKind: "cloudflare_tunnel", connectorToken: "tunnel-token", tunnelId: "t1" };
    const failure = await run(h, STAGE, (connect) => Effect.flip(connect.importToken(TOKEN)));
    expect(failure).toMatchObject({ reason: "not-publish-only" });
    expect(h.secrets.has("cloud-endpoint-runtime-config")).toBe(false);
    expect(h.secrets.has("cloud-relay-environment-credential")).toBe(false);
    expect(h.secrets.has("cloud-cli-desired-link")).toBe(false);
  });

  it("signs out: the relay's link, ours and the token go", async () => {
    const h = harness();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
    await run(h, STAGE, (connect) => connect.importToken(TOKEN));
    const out = await run(h, STAGE, (connect) => connect.signOut);
    expect(out).toMatchObject({ relay: { status: 200 }, accountTokenCleared: true });
    expect(h.token).toBeUndefined();
    expect([...h.secrets.keys()].filter((name) => name.startsWith("cloud-relay") || name.startsWith("cloud-cli"))).toEqual([]);
  });
});
