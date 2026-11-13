// What the Session pushes (step 2a plan, section 2): pi-durable's committed entries and documents, slimmed into the
// session protocol's shapes. Pure functions over pi-durable's records, so they are tested without a Harness.
import type {
  ContentBlock,
  LiveSlim,
  NestedToolSlim,
  PushedEntry,
  ToolSlotSlim,
  TurnState,
  UsageSlim,
} from "@t3flare/session-protocol";
import { NESTED_ARGS_BYTES, NESTED_OUTPUT_BYTES, TOOL_LIVE_OUTPUT_BYTES, TOOL_OUTPUT_BYTES } from "@t3flare/session-protocol";

type Json = unknown;
const record = (value: Json): Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : {};
const str = (value: Json): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: Json): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
/** An id pi-durable stores as a number (or a string). */
const idText = (value: Json): string | undefined =>
  typeof value === "number" || typeof value === "string" ? String(value) : undefined;
/** `{ [key]: value }` when value is defined, else `{}` (exactOptionalPropertyTypes). */
const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

const encoder = new TextEncoder();
const cut = (text: string, bytes: number): string => {
  if (encoder.encode(text).length <= bytes) return text;
  let end = Math.min(text.length, bytes);
  while (end > 0 && encoder.encode(text.slice(0, end)).length > bytes - 32) end = Math.floor(end * 0.9);
  return `${text.slice(0, end)}\n… [cut: ${encoder.encode(text).length} bytes]`;
};

/** A message's content blocks, bounded: text of a tool result to TOOL_OUTPUT_BYTES, images without their bytes. */
export const slimContent = (content: Json, bound = Number.POSITIVE_INFINITY): ReadonlyArray<ContentBlock> => {
  if (typeof content === "string") return [{ type: "text", text: Number.isFinite(bound) ? cut(content, bound) : content }];
  if (!Array.isArray(content)) return [];
  return content.map((raw): ContentBlock => {
    const block = record(raw);
    switch (block.type) {
      case "text":
        return { type: "text", text: Number.isFinite(bound) ? cut(str(block.text) ?? "", bound) : (str(block.text) ?? "") };
      case "thinking":
        return { type: "thinking", thinking: str(block.thinking) ?? "", ...(block.redacted === true ? { redacted: true } : {}) };
      case "toolCall":
        return {
          type: "toolCall",
          id: str(block.id) ?? "",
          name: str(block.name) ?? "tool",
          arguments: record(block.arguments),
        };
      case "image":
        return { type: "image", ...(str(block.mimeType) ? { mimeType: str(block.mimeType) } : {}) };
      default:
        return { type: str(block.type) ?? "unknown" };
    }
  });
};

export const usageOf = (value: Json): UsageSlim | undefined => {
  const usage = record(value);
  if (Object.keys(usage).length === 0) return undefined;
  const cost = record(usage.cost);
  return {
    input: num(usage.input),
    output: num(usage.output),
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite),
    totalTokens: num(usage.totalTokens),
    cost: num(cost.total ?? usage.cost),
  };
};

/** One committed entry as pushed. `turn` is the turn the Session attributes it to. */
export const pushedEntry = (
  entry: { readonly id: number | string; readonly kind: string; readonly model?: ReadonlyArray<Json>; readonly byTaskId?: number | string; readonly data?: Json },
  turn: string | null,
): PushedEntry => {
  const message = record(entry.model?.[entry.model.length - 1]);
  const role = str(message.role);
  const base = {
    id: String(entry.id),
    kind: entry.kind,
    byTaskId: entry.byTaskId === undefined ? null : String(entry.byTaskId),
    turn,
    ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
    // The ports' own entries (an Advisor finding, a Guardian rejection, a Terminal's exit) carry what t3 shows in `data`.
    ...(entry.kind.startsWith("t3flare.") && entry.data !== undefined ? { details: boundedDetails(entry.data) } : {}),
  };
  if (role === "assistant") {
    const usage = usageOf(message.usage);
    return {
      ...base,
      role: "assistant",
      content: slimContent(message.content),
      ...opt("stopReason", str(message.stopReason)),
      ...(str(message.errorMessage) ? { errorMessage: cut(str(message.errorMessage)!, 2048) } : {}),
      ...(usage ? { usage } : {}),
    };
  }
  if (role === "toolResult") {
    return {
      ...base,
      role: "toolResult",
      content: slimContent(message.content, TOOL_OUTPUT_BYTES),
      ...opt("toolCallId", str(message.toolCallId)),
      ...opt("toolName", str(message.toolName)),
      isError: message.isError === true,
      ...(message.details === undefined ? {} : { details: boundedDetails(message.details) }),
    };
  }
  if (role === "user") return { ...base, role: "user", content: slimContent(message.content, 64 * 1024) };
  return { ...base, role: role === "system" ? "system" : "other", content: [] };
};

/** A tool's `details` (edit's patch, bash's exit code) when small; else none. */
const boundedDetails = (details: Json): Json => {
  const text = JSON.stringify(details) ?? "";
  return encoder.encode(text).length <= 64 * 1024 ? details : undefined;
};

/** A nested call's arguments, whole when small, else each string field cut (so a command still shows its start). */
const nestedArgs = (raw: unknown): Readonly<Record<string, unknown>> => {
  const args = record(raw);
  if (encoder.encode(JSON.stringify(args) ?? "").length <= NESTED_ARGS_BYTES) return args;
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === "string" ? cut(value, NESTED_ARGS_BYTES / 2) : "…"]));
};

/** pi.live, slimmed: no tool output, nested tools with cut arguments and an output tail, the partial's blocks only. */
export const liveOf = (doc: Json, turnOfTask: (taskId: string) => string | null): LiveSlim => {
  const live = record(doc);
  const run = record(live.run);
  const generation = record(live.generation);
  const message = record(generation.message);
  const failure = record(live.runFailure);
  const tools: Array<ToolSlotSlim> = (Array.isArray(live.tools) ? live.tools : []).map((raw) => {
    const slot = record(raw);
    const status = str(slot.status);
    // SPI-996: a running call's output streams to t3; once done, its result carries it.
    const output = status === "running" ? str(slot.output) : undefined;
    return {
      callId: str(slot.callId) ?? "",
      name: str(slot.name) ?? "tool",
      status: status === "running" || status === "done" ? status : "pending",
      ...(output === undefined || output === "" ? {} : { output: output.slice(-TOOL_LIVE_OUTPUT_BYTES) }),
    };
  });
  const nestedTools: Array<NestedToolSlim> = (Array.isArray(live.nestedTools) ? live.nestedTools : []).flatMap((raw) => {
    const slot = record(raw);
    const callId = str(slot.callId);
    const parentCallId = str(slot.parentCallId);
    if (callId === undefined || parentCallId === undefined) return [];
    const status = str(slot.status);
    const summary = record(slot.summary);
    const output = str(slot.output);
    return [
      {
        callId,
        parentCallId,
        name: str(slot.name) ?? "tool",
        args: nestedArgs(slot.arguments),
        status: status === "running" || status === "done" ? status : "pending",
        ...(summary.isError === true ? { isError: true } : {}),
        ...(output === undefined || output === "" ? {} : { output: output.slice(-NESTED_OUTPUT_BYTES) }),
      },
    ];
  });
  const runTask = idText(run.taskId);
  return {
    run: runTask === undefined ? null : { taskId: runTask, turn: turnOfTask(runTask) },
    generation:
      runTask === undefined || Object.keys(message).length === 0
        ? null
        : { taskId: runTask, attempt: num(generation.attempt), content: slimContent(message.content) },
    tools,
    ...(nestedTools.length === 0 ? {} : { nestedTools }),
    runFailure:
      failure.reason === undefined
        ? null
        : {
            reason: str(failure.reason) ?? "unknown",
            taskId: idText(failure.taskId) ?? "",
            ...(str(failure.detail) ? { detail: cut(str(failure.detail)!, 2048) } : {}),
          },
  };
};

/** The turn an entry belongs to: the latest turn whose input was placed at or before it. */
export const turnOfEntry = (entryId: number, turns: Readonly<Record<string, TurnState>>): string | null => {
  let best: { readonly turn: string; readonly at: number } | null = null;
  for (const [turn, state] of Object.entries(turns)) {
    if (state.inputEntry === undefined) continue;
    const at = Number(state.inputEntry);
    if (at <= entryId && (best === null || at > best.at)) best = { turn, at };
  }
  return best?.turn ?? null;
};
