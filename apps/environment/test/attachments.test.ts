// What a Durable agent receives of a message's attachments (SPI-993): images inline within the Session's per-message
// budget, readable files as text, and a note for everything else, so the model always knows what was attached.
import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { INLINE_IMAGE_BUDGET_CHARS, type AttachmentReader, turnPrompt } from "../src/provider/attachments.ts";

const image = (id: string, mimeType = "image/png"): ChatAttachment =>
  ({ type: "image", id, name: `${id}.png`, mimeType, sizeBytes: 3 }) as ChatAttachment;
const file = (id: string, name: string, mimeType: string, extra: object = {}): ChatAttachment =>
  ({ type: "file", id, name, mimeType, sizeBytes: 10, ...extra }) as ChatAttachment;

const reader = (files: Record<string, Uint8Array>, extracted: Record<string, string> = {}): AttachmentReader => ({
  bytes: (attachment) => Effect.succeed(files[attachment.id] ?? null),
  extractedText: (attachment) => Effect.succeed(extracted[attachment.id] ?? null),
});
const utf8 = (text: string) => new TextEncoder().encode(text);
const prompt = (text: string, attachments: ReadonlyArray<ChatAttachment>, files: AttachmentReader, acceptsImages = true) =>
  Effect.runPromise(turnPrompt({ text, attachments }, { acceptsImages, reader: files }));

describe("a message's attachments, as a Durable agent receives them", () => {
  it("sends an image inline and names it in the text", async () => {
    const result = await prompt("What is this?", [image("shot")], reader({ shot: new Uint8Array([1, 2, 3]) }));
    expect(result.images).toEqual([{ data: "AQID", mimeType: "image/png" }]);
    expect(result.text).toBe('What is this?\n\n[Attached image "shot.png" is shown inline.]');
  });

  it("names, but does not send, an image past the per-message budget", async () => {
    const big = new Uint8Array((INLINE_IMAGE_BUDGET_CHARS * 3) / 4);
    const result = await prompt("", [image("small"), image("big")], reader({ small: new Uint8Array([1, 2, 3]), big }));
    expect(result.images).toEqual([{ data: "AQID", mimeType: "image/png" }]);
    expect(result.text).toContain('[Attached image "small.png" is shown inline.]');
    expect(result.text).toContain('[Attached image "big.png" (0.9 MB) is not shown: a message takes at most 0.9 MB of images inline.');
  });

  it("sends no image to a model without image input", async () => {
    const result = await prompt("hi", [image("shot")], reader({ shot: new Uint8Array([1, 2, 3]) }), false);
    expect(result.images).toEqual([]);
    expect(result.text).toBe('hi\n\n[Attached image "shot.png" is not shown: this model does not take images.]');
  });

  it("inlines a text file and pasted text, and names a binary or missing one", async () => {
    const result = await prompt(
      "Review",
      [
        file("notes", "notes.md", "text/markdown"),
        file("paste", "Pasted text.txt", "text/plain", { source: { _tag: "pasted-text" } }),
        file("blob", "data.bin", "application/octet-stream"),
        file("gone", "gone.txt", "text/plain"),
      ],
      reader({ notes: utf8("# Notes\nhello"), paste: utf8("long paste"), blob: new Uint8Array([0, 159, 146, 150]) }),
    );
    expect(result.images).toEqual([]);
    expect(result.text).toBe(
      [
        "Review",
        '[Attached file "notes.md" (text/markdown):]\n# Notes\nhello\n[End of "notes.md".]',
        '[Attached file "Pasted text.txt" (text/plain):]\nlong paste\n[End of "Pasted text.txt".]',
        '[Attached file "data.bin" (application/octet-stream) is not readable as text by this agent.]',
        '[Attached file "gone.txt" is unavailable: t3 has no saved file for it.]',
      ].join("\n\n"),
    );
  });

  it("uses the text t3 extracted from a document", async () => {
    const result = await prompt("", [file("doc", "spec.pdf", "application/pdf")], reader({ doc: utf8("%PDF-\u0000") }, { doc: "The spec." }));
    expect(result.text).toBe('[Attached file "spec.pdf" (application/pdf), as extracted text:]\nThe spec.\n[End of "spec.pdf".]');
  });

  it("cuts file text to the input budget and says so", async () => {
    const result = await prompt("x", [file("huge", "huge.txt", "text/plain")], reader({ huge: utf8("a".repeat(200_000)) }));
    expect(result.text.length).toBeLessThanOrEqual(120_000);
    expect(result.text).toContain('[Attached file "huge.txt" (text/plain), cut to fit the prompt:]');
    expect(result.text.endsWith('[End of "huge.txt": cut.]')).toBe(true);
  });

  it("treats an image type providers do not take inline as a file", async () => {
    const result = await prompt("", [image("vector", "image/svg+xml")], reader({ vector: utf8("<svg/>") }));
    expect(result.images).toEqual([]);
    expect(result.text).toContain('[Attached image "vector.png" (image/svg+xml):]\n<svg/>');
  });
});
