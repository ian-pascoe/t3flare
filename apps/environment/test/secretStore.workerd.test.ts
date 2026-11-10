// t3's ServerSecretStore over DO key-value storage (ADR-0010), with real storage.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSecretStore from "t3/src/auth/ServerSecretStore.ts";
import { expect, it } from "vitest";

import * as SecretStore from "../src/platform/secretStore.ts";

it("stores, creates once, generates once and removes secrets in DO storage", async () => {
  await runInDurableObject(env.TEST_OBJECTS.getByName("secrets"), async (_instance, state) => {
    const layer = SecretStore.layer(state.storage as never).pipe(Layer.provide(NodeCrypto.layer));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const missing = yield* secrets.get("a");
        yield* secrets.set("a", new Uint8Array([1, 2, 3]));
        yield* secrets.create("a", new Uint8Array([9]));
        const a = yield* secrets.get("a");
        const random1 = yield* secrets.getOrCreateRandom("signing", 32);
        const random2 = yield* secrets.getOrCreateRandom("signing", 32);
        yield* secrets.remove("a");
        const removed = yield* secrets.get("a");
        return { missing, a, random1, random2, removed };
      }).pipe(Effect.provide(layer)),
    );
    expect(Option.isNone(result.missing)).toBe(true);
    expect(Option.getOrThrow(result.a)).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.random1.byteLength).toBe(32);
    expect(result.random2).toEqual(result.random1);
    expect(Option.isNone(result.removed)).toBe(true);
    // Kept in key-value storage, apart from SQL.
    expect(await state.storage.get("t3flare/secret/signing")).toBeDefined();
  });
});
