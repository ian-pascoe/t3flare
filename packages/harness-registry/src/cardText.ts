// What an approval card shows of what is approved (review M2): one rule for every card (commands, file changes, t3's
// and MCP tools). The full text up to CARD_TEXT_MAX; past it, the head, the full size, a SHA-256 prefix of the whole and
// an explicit TRUNCATED line, so nothing is approved unseen without the card saying so. Control characters (but newline
// and tab) and invisible format characters (bidi overrides, zero-width marks) are shown as `\u{…}`, so text cannot hide
// or reorder what the owner reads (SPI-992 review M6's rule for refs, kept to what is not printable).
import { createHash } from "node:crypto";

/** Most characters of a card's text shown. */
export const CARD_TEXT_MAX = 16 * 1024;

// Every character that hides or reorders text: controls, format characters (bidi overrides and isolates, zero-width
// marks, the soft hyphen, the BOM) and the line and paragraph separators. The card set keeps newline and tab; the
// label set does not. U+2060 to U+206F is named whole (format characters and the unassigned code points among them).
// Both are built from one class body: the characters every card hides, without newline (U+000A) and tab (U+0009).
const HIDDEN_CLASS = String.raw`\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\u2028\u2029\u2060-\u206f`;
const HIDDEN = new RegExp(`[${HIDDEN_CLASS}]`, "gu");
// The same, with newline and tab.
const HIDDEN_OR_BREAK = new RegExp(`[${HIDDEN_CLASS}\\u0009\\u000a]`, "gu");

/** `text` with control and format characters made visible. */
export const visible = (text: string): string =>
  text.replace(HIDDEN, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);

/** `text` on one line with every hidden character dropped: for an untrusted label shown inline (a client's own name). */
export const withoutHidden = (text: string): string => text.replace(HIDDEN_OR_BREAK, "");

/** `text` as a card shows it: visible, and cut at `max` with the cut said and the whole fingerprinted. */
export const cardText = (text: string, max = CARD_TEXT_MAX): string => {
  const shown = visible(text);
  if (shown.length <= max) return shown;
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return `${shown.slice(0, max)}\n\n[TRUNCATED: ${shown.length - max} more characters not shown; the whole is ${text.length} characters, sha256 ${digest}…]`;
};
