// The model-routed body's scan (SPI-1168, `routedBody.ts`): the one top-level `model` as JSON reads it, found in the
// body's bytes; the slug's model id written in place; the cap and the nesting limit.
import { describe, expect, it } from "vitest";

import { MAX_NESTING, MAX_ROUTED_BODY_BYTES, readCapped, routeBody, topLevelModel } from "../src/workspace/routedBody.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);
const streamOf = (...chunks: ReadonlyArray<string>) =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(bytes(chunk));
      controller.close();
    },
  });

describe("the model-routed body's scan", () => {
  it("reads a key as JSON does: an escaped `model` is the model, and an escaped quote in a key is skipped", () => {
    expect(topLevelModel(bytes('{"mod\\u0065l":"comm/a"}'))?.value).toBe("comm/a");
    expect(topLevelModel(bytes('{"a\\"model":"x","model":"comm/b"}'))?.value).toBe("comm/b");
    expect(topLevelModel(bytes('{"mod\\u0065l":"comm/a","model":"comm/b"}'))).toBeUndefined();
  });

  it("refuses a byte-order mark, and nesting past the limit; takes nesting up to it", () => {
    expect(topLevelModel(bytes('\ufeff{"model":"comm/a"}'))).toBeUndefined();
    // The top-level object is one level of MAX_NESTING.
    const at = (depth: number) => `{"a":${"[".repeat(depth - 1)}${"]".repeat(depth - 1)},"model":"comm/a"}`;
    expect(topLevelModel(bytes(at(MAX_NESTING)))?.value).toBe("comm/a");
    expect(topLevelModel(bytes(at(MAX_NESTING + 1)))).toBeUndefined();
  });

  it("writes the model's own id over the slug in the same buffer, every other byte kept (multi-byte text too)", () => {
    const body = bytes('{"system":"é ✓","model":"comm2/claude-sonnet-5-5","n":9007199254740993}');
    const routed = routeBody(body);
    expect(routed?.endpointId).toBe("comm2");
    expect(text(routed!.body)).toBe('{"system":"é ✓","model":"claude-sonnet-5-5","n":9007199254740993}');
    expect(routed!.body.buffer).toBe(body.buffer);
  });

  it("names no endpoint for a model without a slug, or with an id that is not an endpoint's", () => {
    for (const body of ['{"model":"claude"}', '{"model":"_/m"}', '{"model":"A/m"}', '{"model":"comm/"}']) expect(routeBody(bytes(body)), body).toBeUndefined();
  });

  it("reads a body into one buffer, refusing a declared length or a stream over the cap", async () => {
    expect(text(((await readCapped(streamOf('{"model":', '"comm/a"}'), undefined)) as { bytes: Uint8Array }).bytes)).toBe('{"model":"comm/a"}');
    expect(text(((await readCapped(streamOf("ab", "cd"), 2)) as { bytes: Uint8Array }).bytes)).toBe("abcd");
    expect(await readCapped(streamOf("x"), MAX_ROUTED_BODY_BYTES + 1)).toEqual({ tooLarge: true });
    expect(await readCapped(streamOf("x".repeat(MAX_ROUTED_BODY_BYTES), "y"), undefined)).toEqual({ tooLarge: true });
  });
});
