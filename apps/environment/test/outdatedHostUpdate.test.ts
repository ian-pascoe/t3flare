// A stock client blocked from the Cloud Environment by an orchestration-protocol mismatch (in-app updates plan D16; t3
// `client-runtime/src/connection/outdatedHostUpdate.ts`): with the descriptor t3flare advertises on prod, the client does
// not tell the owner to update by hand; it opens its bare socket and calls the unary server Update (no progress stream:
// `serverSelfUpdateProgress` is stripped), and takes t3flare's `respawn` answer with its update id.
//
// What this does not cover (docs/upstream-fragility.md, U7): the pin's own `/ws` refuses a socket without the
// `orchestrationProtocol` query with 426, and the bare socket carries none; and the client waits only 4 minutes for a
// compatible descriptor, while an Update takes 5–18.
import { EnvironmentId, ExecutionEnvironmentDescriptor, ORCHESTRATION_PROTOCOL_VERSION, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Socket from "effect/socket/Socket";
import { describe, expect, it } from "vitest";

import type { ConnectionCatalogEntry } from "../../../t3code/packages/client-runtime/src/connection/catalog.ts";
import { orchestrationProtocolCompatibilityError } from "../../../t3code/packages/client-runtime/src/connection/compatibility.ts";
import { PrimaryConnectionTarget } from "../../../t3code/packages/client-runtime/src/connection/model.ts";
import { updateOutdatedHost } from "../../../t3code/packages/client-runtime/src/connection/outdatedHostUpdate.ts";
import * as EnvironmentRegistry from "../../../t3code/packages/client-runtime/src/connection/registry.ts";
import * as ConnectionResolver from "../../../t3code/packages/client-runtime/src/connection/resolver.ts";
import * as RelayEnvironmentDiscovery from "../../../t3code/packages/client-runtime/src/relay/discovery.ts";
import { cloudCapabilities } from "../src/t3/capabilities.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-cloud"),
  label: "t3flare",
  httpBaseUrl: "https://t3.example.test",
  wsBaseUrl: "wss://t3.example.test",
});

const CURRENT = "0.1.11-nightly.20261117.4825";
const NEXT = "0.1.12-nightly.20261201.5000";

/** The descriptor prod advertises: t3's own capabilities through t3flare's classification, with the server Update. */
const cloudDescriptor = (protocol: number, serverVersion: string): ExecutionEnvironmentDescriptor => ({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  platform: { os: "linux", arch: "x64" },
  serverVersion,
  orchestrationProtocolVersion: protocol,
  capabilities: cloudCapabilities({ repositoryIdentity: true, serverSelfUpdateProgress: true } as ExecutionEnvironmentDescriptor["capabilities"], { serverSelfUpdate: "respawn" }),
});

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeDescriptor = Schema.encodeSync(Schema.fromJsonString(ExecutionEnvironmentDescriptor));

type Listener = (event: { readonly type: string; readonly data?: unknown; readonly code?: number }) => void;

/** The Environment's `/ws` as the update reaches it: answers the unary server Update as t3flare's ServerSelfUpdate does. */
class CloudSocket {
  static readonly OPEN = 1;
  readyState = 0;
  readonly tags: Array<string> = [];
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly url: string;
  readonly #onUpdate: () => void;

  constructor(url: string, onUpdate: () => void) {
    this.url = url;
    this.#onUpdate = onUpdate;
    queueMicrotask(() => {
      this.readyState = CloudSocket.OPEN;
      this.#emit({ type: "open" });
    });
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.#listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    const message = decodeJson(data) as { _tag?: string; id?: string; tag?: string };
    if (message._tag !== "Request" || message.tag === undefined) return;
    this.tags.push(message.tag);
    if (message.tag !== WS_METHODS.serverUpdateServer) return;
    this.#onUpdate();
    queueMicrotask(() =>
      this.#emit({
        type: "message",
        data: encodeJson({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value: { targetVersion: NEXT, method: "respawn", updateId: "update-1" } } }),
      }),
    );
  }

  close() {
    this.readyState = 3;
    this.#emit({ type: "close", code: 1006 });
  }

  #emit(event: { readonly type: string; readonly data?: unknown; readonly code?: number }) {
    for (const listener of this.#listeners.get(event.type) ?? []) listener(event);
  }
}

describe("a client blocked by a protocol mismatch", () => {
  it("still calls the Cloud Environment's server Update, and takes its respawn answer", async () => {
    // A client one protocol ahead of the pin: the normal session refuses the host and asks for a server update.
    const blockedDescriptor = cloudDescriptor(ORCHESTRATION_PROTOCOL_VERSION - 1, CURRENT);
    const blocked = orchestrationProtocolCompatibilityError(blockedDescriptor);
    expect(blocked).toMatchObject({ serverUpdateRequired: true });

    const sockets: Array<CloudSocket> = [];
    let served = blockedDescriptor;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
          new Map([[TARGET.environmentId, { target: TARGET, profile: Option.none(), enabled: false, unsupportedReason: blocked?.message ?? "", serverUpdateRequired: true }]]),
        );
        const registry = EnvironmentRegistry.EnvironmentRegistry.of({
          entries,
          setCompatibility: () => Effect.void,
          setEnabled: () => Effect.void,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const resolver = ConnectionResolver.ConnectionResolver.of({
          prepare: () => Effect.die(new Error("The update must bypass the protocol gate.")),
          prepareForUpdate: () =>
            Effect.sync(() => ({
              descriptor: served,
              prepared: { environmentId: TARGET.environmentId, label: TARGET.label, httpBaseUrl: TARGET.httpBaseUrl, socketUrl: "wss://t3.example.test/ws?wsTicket=ticket", httpAuthorization: null, target: TARGET },
            })),
        });
        const discovery = RelayEnvironmentDiscovery.RelayEnvironmentDiscovery.of({
          state: yield* SubscriptionRef.make(RelayEnvironmentDiscovery.EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE),
          refresh: Effect.void,
        });
        return yield* updateOutdatedHost(TARGET.environmentId, { targetVersion: NEXT }, () => Effect.void).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry),
              Layer.succeed(ConnectionResolver.ConnectionResolver, resolver),
              Layer.succeed(RelayEnvironmentDiscovery.RelayEnvironmentDiscovery, discovery),
              Layer.succeed(HttpClient.HttpClient, HttpClient.make((request) => Effect.sync(() => HttpClientResponse.fromWeb(request, new Response(encodeDescriptor(served)))))),
              Layer.succeed(Socket.WebSocketConstructor, (url) => {
                // The landed bump restarts the Environment on the client's version and protocol.
                const socket = new CloudSocket(url, () => (served = cloudDescriptor(ORCHESTRATION_PROTOCOL_VERSION, NEXT)));
                sockets.push(socket);
                return socket as unknown as globalThis.WebSocket;
              }),
            ),
          ),
        );
      }),
    );

    expect(sockets[0]?.tags).toEqual([WS_METHODS.serverUpdateServer]);
    // The pin's /ws gate (fragility U7) answers this socket 426: the client sends no protocol on it.
    expect(sockets[0]?.url).not.toContain("orchestrationProtocol");
    expect(result).toMatchObject({ targetVersion: NEXT, method: "respawn", updateId: "update-1" });
  });
});
