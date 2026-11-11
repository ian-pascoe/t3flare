// A t3 message's attachments as a Durable agent receives them (SPI-993; t3's Pi provider does the same in
// `resolvePromptPayload`, `t3code/packages/provider-pi/src/server/adapter.ts`). The agent runs in a Session DO that
// cannot read t3's attachment store, so nothing here is a path: images go inline, readable files go into the text,
// and every other attachment is named with the reason it is not shown. The model always learns what was attached.
//
// The bound is the Session's storage: pi-durable keeps each submission and each message as one DO SQLite row, and a row
// holds at most 2 MB. A message's images inline take at most INLINE_IMAGE_BUDGET_CHARS of base64, and its text at most
// t3's own PROVIDER_SEND_TURN_MAX_INPUT_CHARS, so the two together stay under the row.
import { type ChatAttachment, isProviderSendTurnSupportedImageMimeType, PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ImageInput } from "@t3flare/session-protocol";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

/** The base64 a message's images may take inline (0.9 MB of image bytes). */
export const INLINE_IMAGE_BUDGET_CHARS = 1_200_000;

/** The largest file read to look for text (an attachment may be 50 MB; the Environment DO has 128 MB). */
export const FILE_READ_CAP_BYTES = 2_000_000;

/** How the adapter reads t3's attachment store. */
export interface AttachmentReader {
  /** The attachment's bytes, or null when t3 has no saved file for it. */
  readonly bytes: (attachment: ChatAttachment) => Effect.Effect<Uint8Array | null>;
  /** The text t3 extracted from a document attachment (a PDF), or null. */
  readonly extractedText: (attachment: ChatAttachment) => Effect.Effect<string | null>;
}

/** t3's attachment store, through its own path resolution (the Environment's state directory). */
export const attachmentReader = (host: ProviderHost.ProviderHost["Service"], fileSystem: FileSystem.FileSystem): AttachmentReader => ({
  bytes: (attachment) => {
    const path = host.resolveAttachmentPath(attachment);
    return path === null ? Effect.succeed(null) : fileSystem.readFile(path).pipe(Effect.orElseSucceed(() => null));
  },
  extractedText: (attachment) => {
    const path = host.resolveAttachmentPath(attachment);
    if (path === null || host.resolveExtractedTextPath === undefined) return Effect.succeed(null);
    return host.resolveExtractedTextPath(path).pipe(
      Effect.flatMap((extracted) =>
        extracted === undefined ? Effect.succeed(null) : fileSystem.readFileString(extracted).pipe(Effect.orElseSucceed(() => null)),
      ),
    );
  },
});

export interface TurnPrompt {
  readonly text: string;
  readonly images: ReadonlyArray<ImageInput>;
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

/** The file's text when it is UTF-8 without NUL bytes, else null. */
const asText = (bytes: Uint8Array): string | null => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
};

/** The prompt text and inline images of one message (`startTurn`'s or `steerTurn`'s). */
export const turnPrompt = Effect.fn("PiDurable.turnPrompt")(function* (
  message: { readonly text: string; readonly attachments: ReadonlyArray<ChatAttachment> },
  options: { readonly acceptsImages: boolean; readonly reader: AttachmentReader },
) {
  const notes: Array<string> = [];
  const images: Array<ImageInput> = [];
  let imageChars = 0;
  // Each file's text is cut to what is left of the input budget after the message and every attachment's note.
  let textLeft = PROVIDER_SEND_TURN_MAX_INPUT_CHARS - message.text.length - 200 * message.attachments.length;
  for (const attachment of message.attachments) {
    const label = `${attachment.type} "${attachment.name}"`;
    const inlineImage = attachment.type === "image" && isProviderSendTurnSupportedImageMimeType(attachment.mimeType);
    if (inlineImage && !options.acceptsImages) {
      notes.push(`[Attached ${label} is not shown: this model does not take images.]`);
      continue;
    }
    // Too big to send or to scan for text: named without reading it (t3's extracted text, if any, still goes in).
    const overImageBudget = inlineImage && imageChars + Math.ceil(attachment.sizeBytes / 3) * 4 > INLINE_IMAGE_BUDGET_CHARS;
    const overFileCap = !inlineImage && attachment.sizeBytes > FILE_READ_CAP_BYTES;
    const bytes = overImageBudget || overFileCap ? new Uint8Array(0) : yield* options.reader.bytes(attachment);
    if (bytes === null) {
      notes.push(`[Attached ${label} is unavailable: t3 has no saved file for it.]`);
      continue;
    }
    if (inlineImage) {
      const data = Buffer.from(bytes).toString("base64");
      if (overImageBudget || imageChars + data.length > INLINE_IMAGE_BUDGET_CHARS) {
        notes.push(
          `[Attached ${label} (${megabytes(Math.max(bytes.length, attachment.sizeBytes))}) is not shown: a message takes at most ${megabytes((INLINE_IMAGE_BUDGET_CHARS * 3) / 4)} of images inline. Ask the user for a smaller image.]`,
        );
        continue;
      }
      imageChars += data.length;
      images.push({ data, mimeType: attachment.mimeType });
      notes.push(`[Attached ${label} is shown inline.]`);
      continue;
    }
    const extracted = yield* options.reader.extractedText(attachment);
    const content = extracted ?? (overFileCap ? null : asText(bytes));
    if (content === null && overFileCap) {
      notes.push(`[Attached ${label} (${attachment.mimeType}, ${megabytes(attachment.sizeBytes)}) is too large for this agent to read.]`);
      continue;
    }
    if (content === null) {
      notes.push(`[Attached ${label} (${attachment.mimeType}) is not readable as text by this agent.]`);
      continue;
    }
    const room = Math.max(0, textLeft);
    const cut = content.length > room;
    const kept = cut ? content.slice(0, room) : content;
    textLeft -= kept.length;
    const how = cut ? ", cut to fit the prompt" : extracted === null ? "" : ", as extracted text";
    notes.push(`[Attached ${label} (${attachment.mimeType})${how}:]\n${kept}\n[End of "${attachment.name}"${cut ? ": cut" : ""}.]`);
  }
  const text = [message.text, ...notes].filter((part) => part.length > 0).join("\n\n");
  return { text, images } satisfies TurnPrompt;
});
