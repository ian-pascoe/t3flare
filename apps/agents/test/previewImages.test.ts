// G11 (R6): a t3 tool result's MCP `image` parts reach a Durable agent as pi image content (`html_preview`'s and
// `preview_snapshot`'s screenshots), bounded: the types a model reads, at most four, at most 5 MiB of base64 each.
import { describe, expect, it } from "vitest";

import { imagesOf, MAX_IMAGE_BASE64, MAX_RESULT_IMAGES } from "../src/session/t3McpClient.ts";

describe("a t3 tool result's images", () => {
  it("keeps png, jpeg, gif and webp parts and drops the rest", () => {
    expect(
      imagesOf([
        { type: "text", text: "shot" },
        { type: "image", data: "AAA", mimeType: "image/png" },
        { type: "image", data: "BBB", mimeType: "image/svg+xml" },
        { type: "image", mimeType: "image/png" },
        { type: "image", data: "CCC", mimeType: "image/webp" },
      ]),
    ).toEqual([
      { data: "AAA", mimeType: "image/png" },
      { data: "CCC", mimeType: "image/webp" },
    ]);
  });

  it("drops an oversized image and keeps at most four", () => {
    const big = { type: "image", data: "x".repeat(MAX_IMAGE_BASE64 + 1), mimeType: "image/png" };
    expect(imagesOf([big])).toEqual([]);
    expect(imagesOf(Array.from({ length: 6 }, () => ({ type: "image", data: "A", mimeType: "image/jpeg" })))).toHaveLength(MAX_RESULT_IMAGES);
  });
});
