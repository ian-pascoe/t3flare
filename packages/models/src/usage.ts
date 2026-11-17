// Usage records (SPI-1173): t3flare's own count of the tokens its agents spend on Model endpoints, which feeds t3's Usage
// page. Three places make them, and the Environment DO keeps them (`recordUsage`):
//
// - a Session, for each assistant message a Durable agent's model call answers on an endpoint (turns, compaction, the
//   extensions' own calls): pi-ai's usage and cost;
// - text generation (titles, commit and PR text) on an endpoint's model: pi-ai's usage and cost;
// - the model relay, for each CLI request (Codex, Claude Code, OpenCode, pi): the usage its answer reports, read as it
//   streams past.
//
// A record holds counts, names and a time: never a key, a handle, a prompt or any of the answer's text. Pure.
import { ENDPOINT_ID } from "./endpoints.ts";

/**
 * Who spent the tokens: the Durable agent, text generation, or a CLI agent by t3's driver name for it. The Environment
 * counts each under one of t3's usage providers (`durable`, `text-generation` and `pi` under t3's Pi).
 */
export const USAGE_AGENTS = ["durable", "text-generation", "codex", "claude", "opencode", "pi"] as const;
export type UsageAgent = (typeof USAGE_AGENTS)[number];

export const isUsageAgent = (value: unknown): value is UsageAgent => typeof value === "string" && (USAGE_AGENTS as ReadonlyArray<string>).includes(value);

/** Token counts as pi-ai splits them: `input` is the uncached input; `reasoning` is part of `output`. */
export interface UsageTokens {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly reasoning: number;
}

/** One model answer's usage, as it is sent to the Environment. */
export interface UsageEntry extends UsageTokens {
  readonly agent: UsageAgent;
  readonly endpointId: string;
  /**
   * The model as the caller knew it: the endpoint's model id (a Session's, a routed CLI request's) or, for a request the
   * relay sent by path, the model the answer names. The Environment maps an answer's dated name to the listed model.
   */
  readonly modelId: string;
  /** When the request was made (epoch ms). */
  readonly at: number;
  /** The conversation it belongs to, opaque (a Session's id, a CLI process's key); "" for none. */
  readonly session: string;
  /**
   * What it cost in dollars, when the caller knew (pi-ai's, from the endpoint's model prices or the provider's report);
   * null when it did not, or the model has no price: the Environment prices it from the endpoint's model, else t3's rate
   * table does.
   */
  readonly costUsd: number | null;
}

/** The most entries one `recordUsage` call carries. */
export const MAX_USAGE_ENTRIES = 64;
/** The longest model id or session id kept. */
export const MAX_USAGE_NAME = 200;

/** A token count: a positive finite number, whole; anything else counts 0. */
export const tokenCount = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER) : 0);

/** The counts of anything shaped like `UsageTokens` (pi-ai's `Usage` is), each through `tokenCount`; reasoning at most the output. */
export const tokensOf = (source: { readonly [K in keyof UsageTokens]?: unknown }): UsageTokens => {
  const output = tokenCount(source.output);
  return { input: tokenCount(source.input), cacheRead: tokenCount(source.cacheRead), cacheWrite: tokenCount(source.cacheWrite), output, reasoning: Math.min(tokenCount(source.reasoning), output) };
};

/** A cost in dollars when it is a positive finite number; null otherwise (unknown, or a model with no price). */
export const positiveCost = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

/** Whether an entry counts any token: one with none is not kept. */
export const hasTokens = (tokens: UsageTokens): boolean => tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output > 0;

/**
 * An entry as the Environment accepts it from the agents Worker, or undefined: a known agent, an endpoint id, a bounded
 * model id with no control character, a time, counts (anything else counts 0), a cost that is a positive finite number or
 * null, and at least one token.
 */
export const usageEntryOf = (value: unknown): UsageEntry | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  const { agent, endpointId, modelId, at, session, costUsd } = entry;
  if (!isUsageAgent(agent) || typeof endpointId !== "string" || !ENDPOINT_ID.test(endpointId)) return undefined;
  // oxlint-disable-next-line no-control-regex -- control characters are what this refuses
  const name = (text: unknown): text is string => typeof text === "string" && text.length <= MAX_USAGE_NAME && !/[\u0000-\u001f\u007f]/.test(text);
  if (!name(modelId) || modelId.trim() === "" || !name(session)) return undefined;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return undefined;
  const tokens = tokensOf(entry);
  if (!hasTokens(tokens)) return undefined;
  return { agent, endpointId, modelId: modelId.trim(), at: Math.trunc(at), session, ...tokens, costUsd: positiveCost(costUsd) };
};

/** What a pi-ai assistant message carries that a record reads (pi-ai's `AssistantMessage`, structurally). */
export interface PiAnswer {
  readonly model: string;
  readonly timestamp?: number;
  readonly usage?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly reasoning?: number;
    readonly cost?: { readonly total?: number };
  };
}

/**
 * The record of a pi-ai answer on an endpoint (a Session's, text generation's), or undefined when it counts no token (a
 * request that failed before any usage). pi-ai's cost is kept when it is positive: zero means the model has no price.
 */
export const usageOfPiAnswer = (answer: PiAnswer, call: { readonly agent: UsageAgent; readonly endpointId: string; readonly session: string; readonly now: number }): UsageEntry | undefined => {
  const usage = answer.usage;
  if (usage === undefined) return undefined;
  const tokens = tokensOf(usage);
  if (!hasTokens(tokens)) return undefined;
  return {
    agent: call.agent,
    endpointId: call.endpointId,
    modelId: answer.model,
    at: typeof answer.timestamp === "number" && answer.timestamp > 0 ? answer.timestamp : call.now,
    session: call.session,
    ...tokens,
    costUsd: positiveCost(usage.cost?.total),
  };
};
