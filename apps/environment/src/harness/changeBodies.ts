// The Settings API's change bodies, decoded rather than trusted: the shapes of `@t3flare/harness-registry`'s `McpChange`
// and `HarnessChange` (which has no Effect dependency, so the Schemas live here). The registry still judges the values
// (a known server, extension and setting); these only promise the types it reads them as.
import type { HarnessChange, McpChange } from "@t3flare/harness-registry";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const Exposure = Schema.Literals(["direct", "deferred", "codemode", "hidden"]);

const ServerAuth = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("header"), header: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("oauth") }),
]);

/** `McpChange` as a body may carry it. */
export const McpChangeBody = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("server"),
    server: Schema.String,
    enabled: Schema.optionalKey(Schema.Boolean),
    exposure: Schema.optionalKey(Exposure),
    // `toolExposure: null` is refused on purpose: no client sends it (the panel sends an object), and it changes nothing.
    toolExposure: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Exposure))),
    writes: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ op: Schema.Literal("class"), server: Schema.String, tool: Schema.String, class: Schema.NullOr(Schema.Literals(["read", "write"])) }),
  Schema.Struct({ op: Schema.Literal("add"), server: Schema.String, url: Schema.String, auth: ServerAuth }),
  Schema.Struct({ op: Schema.Literal("remove"), server: Schema.String }),
]);

/** `HarnessChange` as a body may carry it. */
export const HarnessChangeBody = Schema.Struct({
  extension: Schema.String,
  enabled: Schema.optionalKey(Schema.Boolean),
  // `settings: null` is refused on purpose: no client sends it (the panel omits an empty one), and it changes nothing.
  settings: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

/** Whether `A` and `B` are the same type, both ways (`readonly`, optional and `null` included). */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const sameType = <_ extends true>() => undefined;
// A field added to the registry's type, or to a Schema, fails here rather than being dropped by the decode.
sameType<Equals<typeof McpChangeBody.Type, McpChange>>();
sameType<Equals<typeof HarnessChangeBody.Type, HarnessChange>>();

/** The decoded change, or the decoder's account of what is wrong with it. */
export type Decoded<T> = { readonly ok: true; readonly change: T } | { readonly ok: false; readonly error: string };

const decoder =
  <T>(schema: Schema.Decoder<T>) =>
  (body: unknown): Decoded<T> => {
    const result = Schema.decodeUnknownResult(schema)(body);
    return Result.isSuccess(result) ? { ok: true, change: result.success } : { ok: false, error: result.failure.message };
  };

export const decodeMcpChange: (body: unknown) => Decoded<McpChange> = decoder(McpChangeBody);
export const decodeHarnessChange: (body: unknown) => Decoded<HarnessChange> = decoder(HarnessChangeBody);
