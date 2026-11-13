// Adapted from ian-pascoe/pi-extensions@a5e15d1:packages/pi-utils/src/evidence.ts and pi-advisor/src/advisor-evidence.ts
// (SPI-1059): Review Evidence, what the observed model saw: each message's role, text, reasoning text, tool calls with
// arguments, and tool results' text with their error status, each call and its result sharing a short Tool-Call
// Reference; tool results capped at `maxToolResultChars` (4,000) around a marker. Changed: projected from the Session's
// stored entries (pi-durable's History), not Pi's session messages; images are left out; the Context Seed keeps the
// original request and the newest turns within a character budget (no token calibration), never splitting a turn.
// @effect-diagnostics asyncFunction:off
import type { EntryRecord } from "@earendil-works/pi-durable";

/** pi-advisor's `maxToolResultChars` default. */
export const TOOL_RESULT_CHARS = 4_000;
/** The Context Seed's budget in characters (pi-advisor's `auto` seed, at most 50k tokens, at about 3 characters a token). */
export const SEED_CHARACTERS = 150_000;

export type EvidenceBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | { readonly type: "toolCall"; readonly ref: string; readonly name: string; readonly arguments: unknown };

export type EvidenceMessage =
  | { readonly role: "user"; readonly origin: string; readonly content: string }
  | { readonly role: "assistant"; readonly content: ReadonlyArray<EvidenceBlock>; readonly stopReason?: string; readonly errorMessage?: string }
  | { readonly role: "toolResult"; readonly ref: string; readonly toolName: string; readonly isError: boolean; readonly content: string };

/** A Tool-Call Reference: short, derived from the call id alone (FNV-1a in place of pi-utils' SHA-256 prefix). */
export const toolCallRef = (id: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
};

/** pi-utils' `capText`: the head and tail of a long tool result around a marker. */
export const capText = (text: string, limit = TOOL_RESULT_CHARS): string => {
  if (text.length <= limit) return text;
  const head = Math.ceil(limit / 2);
  const tail = text.length - (limit - head);
  const capped = `${text.slice(0, head)}\n[… ${tail - head} characters omitted from this tool result; the agent's full result is in its History]\n${text.slice(tail)}`;
  return capped.length >= text.length ? text : capped;
};

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.flatMap((block: { type?: string; text?: string }) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n")
      : "";

/** Who a user-role entry is from: the user (t3), the Advisor's own findings, or another extension's note. */
const originOf = (kind: string): string => (kind === "pi.user" ? "user" : kind === "t3flare.advice" ? "advisorFinding" : kind === "pi.compaction" ? "compactionSummary" : "extension");

/** One stored entry as Review Evidence; undefined for what the observed model did not see as a message. */
export const projectEntry = (entry: EntryRecord): EvidenceMessage | undefined => {
  const message = entry.model?.[entry.model.length - 1] as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string; toolCallId?: string; toolName?: string; isError?: boolean } | undefined;
  switch (message?.role) {
    case "user": {
      const content = textOf(message.content);
      return content === "" ? undefined : { role: "user", origin: originOf(entry.kind), content };
    }
    case "assistant": {
      const content = (Array.isArray(message.content) ? message.content : []).flatMap((block: { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }): Array<EvidenceBlock> => {
        if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
        if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() !== "") return [{ type: "thinking", thinking: block.thinking }];
        if (block.type === "toolCall" && typeof block.id === "string") return [{ type: "toolCall", ref: toolCallRef(block.id), name: block.name ?? "tool", arguments: block.arguments }];
        return [];
      });
      const abnormal = message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length";
      return { role: "assistant", content, ...(abnormal ? { stopReason: message.stopReason, ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }) } : {}) };
    }
    case "toolResult":
      return { role: "toolResult", ref: toolCallRef(message.toolCallId ?? ""), toolName: message.toolName ?? "tool", isError: message.isError === true, content: capText(textOf(message.content)) };
    default:
      return undefined;
  }
};

export const evidenceRefs = (messages: ReadonlyArray<EvidenceMessage>): ReadonlyArray<string> =>
  messages.flatMap((message) => (message.role === "toolResult" ? [message.ref] : message.role === "assistant" ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.ref] : [])) : []));

const size = (message: EvidenceMessage) => JSON.stringify(message).length + 1;

/**
 * A Context Seed (advisor-evidence.ts `selectContextSeed`): the original request (the first user message, or the
 * compaction summary and the first user message after it) and the newest turn always; then the newest turns that fit
 * `budget`, a turn being a message with the tool results that follow it. Says which positions it kept.
 */
export const selectContextSeed = (messages: ReadonlyArray<EvidenceMessage>, budget = SEED_CHARACTERS): { readonly messages: ReadonlyArray<EvidenceMessage>; readonly note: string } => {
  const starts = messages.flatMap((message, index) => (index === 0 || message.role !== "toolResult" ? [index] : []));
  const units = starts.map((start, index) => ({ start, end: starts[index + 1] ?? messages.length }));
  const unitAt = (position: number) => units.findLastIndex((unit) => unit.start <= position);
  const summary = messages.findIndex((message) => message.role === "user" && message.origin === "compactionSummary");
  const request = messages.findIndex((message, index) => index > summary && message.role === "user" && message.origin === "user");
  const chosen = new Set([summary, request].filter((index) => index >= 0).map(unitAt));
  if (units.length > 0) chosen.add(units.length - 1);
  let remaining = budget - [...chosen].reduce((sum, unit) => sum + messages.slice(units[unit]!.start, units[unit]!.end).reduce((total, message) => total + size(message), 0), 0);
  for (let unit = units.length - 1; unit >= 0; unit--) {
    if (chosen.has(unit)) continue;
    const cost = messages.slice(units[unit]!.start, units[unit]!.end).reduce((total, message) => total + size(message), 0);
    if (cost > remaining) break;
    chosen.add(unit);
    remaining -= cost;
  }
  const kept = [...chosen].sort((a, b) => a - b).flatMap((unit) => Array.from({ length: units[unit]!.end - units[unit]!.start }, (_, offset) => units[unit]!.start + offset));
  const omitted = messages.length - kept.length;
  return {
    messages: kept.map((index) => messages[index]!),
    note: omitted === 0 ? "" : ` To fit its budget, it keeps ${kept.length} of the ${messages.length} observed messages and omits the other ${omitted} (older turns); the agent's History holds them.`,
  };
};
