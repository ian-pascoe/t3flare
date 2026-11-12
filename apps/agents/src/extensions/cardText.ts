// What an approval card shows of what is approved (review M2): one rule for every card (commands, file changes, t3's
// and MCP tools). The full text up to CARD_TEXT_MAX; past it, the head, the full size, a SHA-256 prefix of the whole and
// an explicit TRUNCATED line, so nothing is approved unseen without the card saying so. Control characters (but newline
// and tab) and invisible format characters (bidi overrides, zero-width marks) are shown as `\u{…}`, so text cannot hide
// or reorder what the owner reads (SPI-992 review M6's rule for refs, kept to what is not printable).
// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";

/** Most characters of a card's text shown. */
export const CARD_TEXT_MAX = 16 * 1024;

// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\u2028\u2029]/gu;

/** `text` with control and format characters made visible. */
export const visible = (text: string): string =>
  text.replace(HIDDEN, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);

/** `text` as a card shows it: visible, and cut at `max` with the cut said and the whole fingerprinted. */
export const cardText = (text: string, max = CARD_TEXT_MAX): string => {
  const shown = visible(text);
  if (shown.length <= max) return shown;
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return `${shown.slice(0, max)}\n\n[TRUNCATED: ${shown.length - max} more characters not shown; the whole is ${text.length} characters, sha256 ${digest}…]`;
};
