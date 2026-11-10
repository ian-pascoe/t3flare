// @effect-diagnostics effectFnOpportunity:off
// t3's server secrets (signing keys it creates at runtime) in DO key-value storage, apart
// from SQL (ADR-0010). Same service as t3's file-backed `ServerSecretStore`.
import type { DurableObjectStorage } from "@cloudflare/workers-types/index.ts";
import * as ServerSecretStore from "t3/src/auth/ServerSecretStore.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const key = (name: string) => `t3flare/secret/${name}`;

export const layer = (storage: DurableObjectStorage) =>
  Layer.effect(
    ServerSecretStore.ServerSecretStore,
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      const read = (name: string) =>
        Effect.tryPromise({
          try: () => storage.get<ArrayBuffer | Uint8Array>(key(name)),
          catch: (cause) => new ServerSecretStore.SecretStoreReadError({ resource: name, cause }),
        }).pipe(
          Effect.map((value) =>
            value === undefined ? Option.none<Uint8Array>() : Option.some(new Uint8Array(value as ArrayBuffer)),
          ),
        );
      const write = (name: string, value: Uint8Array) =>
        Effect.tryPromise({
          try: () => storage.put(key(name), Uint8Array.from(value)),
          catch: (cause) => new ServerSecretStore.SecretStorePersistError({ resource: name, cause }),
        });
      const create = (name: string, value: Uint8Array) =>
        Effect.flatMap(read(name), (existing) =>
          Option.isSome(existing) ? Effect.void : write(name, value),
        );
      return ServerSecretStore.ServerSecretStore.of({
        get: read,
        set: write,
        create,
        // Requests to one DO are serialized at each await by its input gate, so a read and
        // the write after it cannot interleave with another creator.
        getOrCreateRandom: (name, bytes) =>
          Effect.gen(function* () {
            const existing = yield* read(name);
            if (Option.isSome(existing)) return existing.value;
            const value = yield* random.randomBytes(bytes);
            yield* write(name, value);
            return value;
          }),
        remove: (name) =>
          Effect.tryPromise({
            try: () => storage.delete(key(name)),
            catch: (cause) => new ServerSecretStore.SecretStoreRemoveError({ resource: name, cause }),
          }).pipe(Effect.asVoid),
      });
    }),
  );
