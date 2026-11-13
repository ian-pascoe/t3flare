// @effect-diagnostics globalDate:off globalConsole:off globalTimers:off
// The MCP host (ADR-0028; cloudpid's McpHost, plan §3.0): the Environment DO's part that holds the MCP server set's
// inventory, each server's protocol state and its credentials, and makes every MCP list and call through the MCP
// Worker's engine (`MCP_ENGINE`), the one place the SDK runs. No credential leaves the Environment Worker except inside
// the engine call that uses it; the engine scrubs it (`redact`) from whatever comes back.
//
// - Inventory: each server's tools, listed at most every 10 minutes, on the panel's test, or after a failure; a failed
//   list keeps the last one, marked stale. Capped per server (review M12).
// - Classes: the owner's choice in the settings, else the tool's own `readOnlyHint` (`classOf`), as t3 does (owner,
//   2026-11-12, back to stock: no definition-hash pins).
// - Calls: the Session or the relay has already decided (`decideCall`); the host checks the server is enabled and offered
//   to the caller, finds the tool's definition, and calls. A failed or timed-out write is never retried.
import {
  classOf,
  type Exposure,
  MAX_SCHEMA_BYTES,
  MAX_TOOLS_PER_SERVER,
  type McpServerSetting,
  mcpServersOf,
  type StoredHarness,
  type ToolClass,
  toolNamesOf,
} from "@t3flare/harness-registry";
import type {
  McpEngineDiscoverResult,
  McpEngineHooks,
  McpEnginePriorEncoded,
  McpEngineRequestEncoded,
  McpEngineRequestResult,
  McpEngineTargetEncoded,
} from "@cloudpid/mcp/types";

import { MCP_ELICITATION_WAIT_MS } from "@cloudpid/mcp/types";
import type { McpAsker, McpQuestionAnswer } from "@t3flare/session-protocol";

import type { KvStorage } from "../harness/store.ts";
import { type ElicitAnswer, type ElicitResultOrCancel, isPausingServer, pauseOf, planPause, planQuestion, type QuestionContext, type QuestionPlan } from "./elicitation.ts";

/** How long a server's question waits for the owner: cloudpid's Legacy wait, and the CLI card's (`CLI_ASK_MS`). */
export const QUESTION_WAIT_MS = MCP_ELICITATION_WAIT_MS;

/** The MCP Worker's `McpEngine`, as the Environment binds it. */
export interface McpEngineBinding {
  discover(target: McpEngineTargetEncoded, prior: McpEnginePriorEncoded, hooks: McpEngineHooks): Promise<typeof McpEngineDiscoverResult.Encoded>;
  request(target: McpEngineTargetEncoded, prior: McpEnginePriorEncoded, request: McpEngineRequestEncoded, hooks: McpEngineHooks): Promise<typeof McpEngineRequestResult.Encoded>;
}

/** Where Commissary's MCP endpoint is and the key it takes (decision 1: the Workers' proxy key, for now). */
export interface CommissaryConfig {
  readonly url: string | undefined;
  readonly key: string | undefined;
  /** `?toolkits=` narrowing, when set. */
  readonly toolkits?: string;
}

export const INVENTORY_TTL_MS = 10 * 60_000;
/** A call's own bound: Commissary's upstream timeout is 240 s; ours is a little more. */
export const CALL_TIMEOUT_MS = 270_000;
const MAX_RESULT_BYTES = 1024 * 1024;

/** One tool as the host lists it, with its class resolved. */
export interface InventoryTool {
  readonly name: string;
  readonly upstream: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly hash: string;
  readonly class: ToolClass;
  /** What the tool's own hint says, shown beside an owner's override. */
  readonly hinted: ToolClass;
  readonly exposure: Exposure;
}

export interface Inventory {
  readonly server: string;
  readonly listedAt: number;
  readonly status: "ok" | "failed" | "never";
  readonly error?: string;
  /** The definitions as the server gave them, by upstream name (what a call sends back as `tool`). */
  readonly definitions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly refused: ReadonlyArray<{ readonly tool: string; readonly reason: string }>;
  readonly instructions?: string;
}

/** What a Session (or the relay) is given: the servers it may use, with their tools; no secret, no URL. */
export interface McpView {
  readonly version: string;
  readonly servers: ReadonlyArray<{
    readonly name: string;
    readonly kind: McpServerSetting["kind"];
    readonly state: "available" | "stale" | "unavailable";
    readonly listedAt: number | null;
    readonly exposure: Exposure;
    readonly tools: ReadonlyArray<InventoryTool>;
  }>;
}

export type McpCallAnswer =
  | { readonly kind: "result"; readonly isError: boolean; readonly text: string }
  | { readonly kind: "unavailable"; readonly message: string; readonly mayHaveRun: boolean };

const inventoryKey = (server: string) => `t3flare:mcp:inventory:${server}`;
const priorKey = (server: string) => `t3flare:mcp:prior:${server}`;

const canonical = (value: unknown): string =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value as object)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
          .join(",")}}`;

/** A tool definition's hash: what the server says the tool is (name, description, schemas, annotations). */
export const definitionHash = async (definition: Readonly<Record<string, unknown>>): Promise<string> => {
  const { name, title, description, inputSchema, outputSchema, annotations } = definition;
  const bytes = new TextEncoder().encode(canonical({ name, title, description, inputSchema, outputSchema, annotations }));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
};

const overrideOf = (value: unknown): ToolClass | undefined => (value === "read" || value === "write" ? value : undefined);

const errorText = (error: unknown): string => {
  const record = (error ?? {}) as { _tag?: unknown; message?: unknown; status?: unknown };
  const tag = typeof record._tag === "string" ? record._tag : "Error";
  const message = typeof record.message === "string" ? record.message : JSON.stringify(error).slice(0, 300);
  return `${tag}: ${message}`.slice(0, 600);
};

export interface McpHostDeps {
  readonly kv: KvStorage & { delete?(key: string): unknown };
  readonly engine: McpEngineBinding | undefined;
  readonly commissary: CommissaryConfig;
  readonly settings: () => StoredHarness;
  /** A direct server's header value, from the secret store (part 4). */
  readonly secret?: (server: string, field: string) => Promise<string | undefined>;
  /** An OAuth server's access token (review M4): refreshed when stale; undefined when the owner must sign in. */
  readonly oauthToken?: (server: string, stale: boolean) => Promise<string | undefined>;
  readonly now?: () => number;
  /** Keeps background work alive past the request (`ctx.waitUntil`). */
  readonly background?: (work: Promise<unknown>) => void;
  /** The t3 host as deployed: a page question that sends the owner there is declined (SPI-1079). */
  readonly ownHost?: () => string | undefined;
}

export class McpHost {
  readonly #deps: McpHostDeps;
  readonly #refreshing = new Map<string, Promise<Inventory>>();

  constructor(deps: McpHostDeps) {
    this.#deps = deps;
  }

  #now() {
    return this.#deps.now?.() ?? Date.now();
  }

  servers(): Readonly<Record<string, McpServerSetting>> {
    return mcpServersOf(this.#deps.settings());
  }

  /** The engine's target for `server`, its credential resolved; undefined when it cannot be reached. */
  async #target(name: string, server: McpServerSetting): Promise<McpEngineTargetEncoded | string> {
    if (server.kind === "commissary") {
      const { url, key, toolkits } = this.#deps.commissary;
      if (url === undefined || url === "") return "Commissary's MCP endpoint is not configured (MODEL_PROXY_URL)";
      if (key === undefined || key === "") return "the Commissary tools key (MODEL_PROXY_API_KEY) is not set";
      const endpoint = new URL(url);
      if (toolkits !== undefined && toolkits !== "") endpoint.searchParams.set("toolkits", toolkits);
      return { kind: "http", conn: name, name, url: endpoint.toString(), headers: { authorization: `Bearer ${key}` }, redact: [key], timeoutMs: CALL_TIMEOUT_MS };
    }
    if (server.url === undefined) return `${name} has no URL`;
    const headers: Record<string, string> = {};
    const redact: Array<string> = [];
    if (server.auth?.kind === "header") {
      const value = await this.#deps.secret?.(name, "header");
      if (value === undefined) return `${name}'s ${server.auth.header} header is not set`;
      headers[server.auth.header] = value;
      redact.push(value);
    }
    return { kind: "http", conn: name, name, url: server.url, headers, redact, timeoutMs: CALL_TIMEOUT_MS };
  }

  /** The engine's `auth` hook for an OAuth server: asked for a token, and again with `stale` after a 401. */
  #authHooks(name: string, server: McpServerSetting): McpEngineHooks {
    const token = this.#deps.oauthToken;
    if (server.auth?.kind !== "oauth" || token === undefined) return {};
    return { auth: (stale: boolean) => token(name, stale) };
  }

  #prior(name: string): McpEnginePriorEncoded {
    return this.#deps.kv.get<McpEnginePriorEncoded>(priorKey(name)) ?? {};
  }

  #keepState(name: string, state: { readonly era?: unknown; readonly session?: unknown } | undefined) {
    if (state === undefined) return;
    const prior: Record<string, unknown> = { ...this.#prior(name) };
    for (const key of ["era", "session"] as const) {
      if (state[key] === null) delete prior[key];
      else if (state[key] !== undefined) prior[key] = state[key];
    }
    this.#deps.kv.put(priorKey(name), prior);
  }

  inventory(name: string): Inventory {
    return this.#deps.kv.get<Inventory>(inventoryKey(name)) ?? { server: name, listedAt: 0, status: "never", definitions: {}, refused: [] };
  }

  /** Lists `name`'s tools now (one list in flight per server). */
  list(name: string): Promise<Inventory> {
    const running = this.#refreshing.get(name);
    if (running !== undefined) return running;
    const work = this.#list(name).finally(() => this.#refreshing.delete(name));
    this.#refreshing.set(name, work);
    return work;
  }

  async #list(name: string): Promise<Inventory> {
    const server = this.servers()[name];
    const before = this.inventory(name);
    const failed = (error: string): Inventory => {
      const next: Inventory = { ...before, status: "failed", error, listedAt: before.listedAt };
      this.#deps.kv.put(inventoryKey(name), { ...next, failedAt: this.#now() });
      console.warn(JSON.stringify({ t3flare: "mcp-list-failed", server: name, error: error.slice(0, 300) }));
      return next;
    };
    if (server === undefined) return failed("no such server");
    if (this.#deps.engine === undefined) return failed("the MCP engine is not bound");
    const target = await this.#target(name, server);
    if (typeof target === "string") return failed(target);
    let result: typeof McpEngineDiscoverResult.Encoded;
    try {
      result = await this.#deps.engine.discover(target, this.#prior(name), this.#authHooks(name, server));
    } catch (error) {
      return failed(`the MCP engine failed: ${String(error).slice(0, 300)}`);
    }
    this.#keepState(name, result.state as never);
    if (result.kind !== "discovered") return failed(errorText(result.error));
    const definitions: Record<string, Readonly<Record<string, unknown>>> = {};
    const refused: Array<{ tool: string; reason: string }> = (result.problems ?? []).map((problem) => ({ tool: problem.tool, reason: problem.problem }));
    let bytes = 0;
    for (const tool of result.tools) {
      const size = JSON.stringify(tool).length;
      if (Object.keys(definitions).length >= MAX_TOOLS_PER_SERVER || bytes + size > MAX_SCHEMA_BYTES) {
        refused.push({ tool: tool.name, reason: "past the server's cap (200 tools, 256 KiB of schemas)" });
        continue;
      }
      bytes += size;
      definitions[tool.name] = tool as Readonly<Record<string, unknown>>;
    }
    const next: Inventory = {
      server: name,
      listedAt: this.#now(),
      status: "ok",
      definitions,
      refused,
      ...(typeof result.instructions === "string" ? { instructions: result.instructions.slice(0, 4000) } : {}),
    };
    this.#deps.kv.put(inventoryKey(name), next);
    console.log(JSON.stringify({ t3flare: "mcp-listed", server: name, tools: Object.keys(definitions).length, refused: refused.length }));
    return next;
  }

  /** `name`'s tools with names, classes and exposure resolved. */
  async tools(name: string, server: McpServerSetting, inventory: Inventory): Promise<{ readonly tools: ReadonlyArray<InventoryTool>; readonly refused: Inventory["refused"] }> {
    const named = toolNamesOf(name, Object.keys(inventory.definitions));
    const tools: Array<InventoryTool> = [];
    for (const [upstream, toolName] of Object.entries(named.names)) {
      const definition = inventory.definitions[upstream]!;
      const annotations = definition.annotations as { readonly readOnlyHint?: unknown } | undefined;
      tools.push({
        name: toolName,
        upstream,
        description: (typeof definition.description === "string" ? definition.description : typeof definition.title === "string" ? definition.title : upstream).slice(0, 4000),
        inputSchema: (definition.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        hash: await definitionHash(definition),
        // Only "read" or "write" is an override (settings stored before the back-to-stock cut held hash pins: ignored).
        class: classOf(annotations === undefined ? {} : { annotations }, overrideOf(server.classes?.[upstream])),
        hinted: classOf(annotations === undefined ? {} : { annotations }, undefined),
        exposure: server.toolExposure?.[upstream] ?? server.exposure,
      });
    }
    return { tools, refused: [...inventory.refused, ...named.refused] };
  }

  /**
   * What a caller may use: the enabled servers, linked threads included (owner, 2026-11-12, back to stock), from the
   * kept inventories; an inventory older than INVENTORY_TTL_MS is listed again in the background.
   */
  async view(): Promise<McpView> {
    const servers: Array<McpView["servers"][number]> = [];
    for (const [name, server] of Object.entries(this.servers()).sort(([a], [b]) => a.localeCompare(b))) {
      if (!server.enabled) continue;
      const inventory = this.inventory(name);
      if (this.#now() - inventory.listedAt > INVENTORY_TTL_MS) {
        const refresh = this.list(name).catch(() => undefined);
        this.#deps.background?.(refresh);
      }
      const { tools } = await this.tools(name, server, inventory);
      const pausing = isPausingServer(inventory.definitions);
      servers.push({
        name,
        kind: server.kind,
        state: inventory.status === "ok" ? "available" : inventory.listedAt > 0 ? "stale" : "unavailable",
        listedAt: inventory.listedAt > 0 ? inventory.listedAt : null,
        exposure: server.exposure,
        // SPI-1079: a pausing server's `resume` is t3flare's to call (with the owner's answer), so no agent is offered it.
        tools: tools.filter((tool) => tool.exposure !== "hidden" && !(pausing && tool.upstream === RESUME_TOOL)),
      });
    }
    const version = await definitionHash({ name: "view", inputSchema: servers.map((server) => [server.name, server.tools.map((tool) => [tool.name, tool.hash, tool.class, tool.exposure])]) });
    return { version, servers };
  }

  /**
   * Calls `tool` (the upstream name) of `name` with `args`, for a caller already judged. With an `asker` (an agent's call,
   * SPI-1079) the call declares elicitation and every question the server asks, and every pause of a pausing server
   * (Executor's model mode), becomes a card the caller shows; only the owner's answer goes back.
   */
  async call(input: {
    readonly server: string;
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    /** The class the caller judged the call by: a read whose class is write now is refused, to be asked again. */
    readonly judged?: ToolClass;
    readonly signal?: AbortSignal;
    /** The caller's cards for the server's questions (SPI-1079); without one, every question is cancelled. */
    readonly asker?: McpAsker;
  }): Promise<McpCallAnswer> {
    const server = this.servers()[input.server];
    if (server === undefined || !server.enabled) return { kind: "unavailable", message: `The owner removed or disabled the MCP server ${input.server}; its tools are gone from the next turn.`, mayHaveRun: false };
    const inventory = this.inventory(input.server);
    const definition = inventory.definitions[input.tool];
    if (definition === undefined) return { kind: "unavailable", message: `${input.server} has no tool ${input.tool} (any more).`, mayHaveRun: false };
    if (server.toolExposure?.[input.tool] === "hidden") return { kind: "unavailable", message: `${input.tool} is hidden by the owner.`, mayHaveRun: false };
    const pausing = isPausingServer(inventory.definitions);
    // SPI-1079: a pausing server's `resume` is t3flare's to call, with the owner's answer, never the agent's.
    if (pausing && input.tool === RESUME_TOOL) return { kind: "unavailable", message: RESUME_REFUSAL(input.server), mayHaveRun: false };
    if (input.judged !== "write") {
      // A class change applies to the next call (plan §6.2): a read the owner (or a new hint) made write asks.
      const now = (await this.tools(input.server, server, inventory)).tools.find((tool) => tool.upstream === input.tool);
      if (now?.class !== "read") return { kind: "unavailable", message: `${input.tool} is now a write tool; call it again and it asks the owner.`, mayHaveRun: false };
    }
    if (this.#deps.engine === undefined) return { kind: "unavailable", message: "The MCP engine is not bound.", mayHaveRun: false };
    const target = await this.#target(input.server, server);
    if (typeof target === "string") return { kind: "unavailable", message: target, mayHaveRun: false };
    const context: QuestionContext = { server: input.server, tool: input.tool, args: input.args, isOwnHost: (host) => host === this.#deps.ownHost?.()?.toLowerCase() };
    const first = await this.#request(input.server, server, target, definition, input.args, input.signal, input.asker, context);
    if (first.kind === "unavailable" || !pausing) return first.kind === "unavailable" ? first : { kind: "result", ...resultText(first.value) };
    return this.#answerPauses(input.server, server, target, first.value, input.signal, input.asker, context);
  }

  /** One `tools/call` through the engine, its questions answered from the caller's cards: the result's value, or why not. */
  async #request(
    name: string,
    server: McpServerSetting,
    target: McpEngineTargetEncoded,
    definition: Readonly<Record<string, unknown>>,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    asker: McpAsker | undefined,
    context: QuestionContext,
  ): Promise<{ readonly kind: "value"; readonly value: unknown } | Extract<McpCallAnswer, { kind: "unavailable" }>> {
    const engine = this.#deps.engine!;
    const aborted = new Promise<void>((resolve) => {
      if (signal === undefined) return;
      if (signal.aborted) resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const cards = new Map<string, string>();
    const questionHooks: McpEngineHooks =
      asker === undefined
        ? {}
        : {
            onInput: async (request) => {
              const plan = planQuestion(request, context);
              const answer = await this.#answer(plan, asker, context, "question");
              if (plan.kind === "card") cards.set(request.key, plan.card.id);
              return answer.kind === "now" ? answer.answer : { kind: "answered", result: answer.result };
            },
            onInputEnded: async (key) => {
              const id = cards.get(key);
              if (id !== undefined) await asker.withdraw(id);
            },
          };
    let result: typeof McpEngineRequestResult.Encoded;
    try {
      result = await engine.request(
        target,
        this.#prior(name),
        {
          op: "tools/call",
          tool: definition as never,
          arguments: args as never,
          ctx: { origin: "agent", ...(asker === undefined ? {} : { answers: { elicitation: true, inputWaitMs: QUESTION_WAIT_MS } }) },
        },
        { ...this.#authHooks(name, server), ...(signal === undefined ? {} : { untilAborted: () => aborted }), ...questionHooks },
      );
    } catch (error) {
      return { kind: "unavailable", message: `The MCP call failed; it may have run: ${String(error).slice(0, 300)}`, mayHaveRun: true };
    }
    this.#keepState(name, result.state as never);
    if (result.kind === "failed") {
      const tag = (result.error as { _tag?: string })._tag;
      const unauthorized = tag === "SignInRequired" || /\b40[13]\b/.test(errorText(result.error));
      const message =
        unauthorized && server.kind === "commissary"
          ? `Commissary refused the tools key (MODEL_PROXY_API_KEY): ${errorText(result.error)}`
          : `The MCP call failed (${errorText(result.error)}). It may have run upstream; do not repeat a change without checking.`;
      if (tag === "NotFound") this.#deps.background?.(this.list(name).catch(() => undefined));
      return { kind: "unavailable", message, mayHaveRun: true };
    }
    if (result.kind !== "complete") return { kind: "unavailable", message: `The MCP server answered ${result.kind}, which t3flare does not take yet.`, mayHaveRun: true };
    const value = result.result.kind === "inline" ? result.result.value : await readStream(result.result.body as ReadableStream<Uint8Array>);
    return { kind: "value", value };
  }

  /**
   * A plan's answer: at once (declined unseen, or refused), or the owner's on the caller's card, which closes after
   * QUESTION_WAIT_MS unanswered. Logged with the fields answered, never a value.
   */
  async #answer(plan: QuestionPlan, asker: McpAsker, context: QuestionContext, what: "question" | "pause"): Promise<Answered> {
    const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ t3flare: "mcp-question", what, server: context.server, tool: context.tool, ...event }));
    if (plan.kind === "now") {
      log({ outcome: "answered-unseen", why: plan.why });
      return { kind: "now", answer: plan.answer };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<McpQuestionAnswer>((resolve) => {
      timer = setTimeout(() => resolve({ decision: "cancel", reason: "no answer in time" }), QUESTION_WAIT_MS);
    });
    let answer: McpQuestionAnswer;
    try {
      answer = await Promise.race([asker.ask(plan.card), timedOut]);
    } catch (error) {
      answer = { decision: "cancel", reason: `the card could not be shown: ${String(error).slice(0, 200)}` };
    } finally {
      clearTimeout(timer);
    }
    if (answer.reason === "no answer in time") await Promise.resolve(asker.withdraw(plan.card.id)).catch(() => undefined);
    const sent = plan.answerOf(answer);
    log({ card: plan.card.kind, outcome: sent.result.action, fields: Object.keys(sent.result.content ?? {}), ...(answer.reason === undefined ? {} : { reason: answer.reason }), ...(sent.note === undefined ? {} : { note: sent.note }) });
    return { kind: "card", ...sent };
  }

  /**
   * A pausing server's result (Executor's model mode, SPI-1079): each pause becomes a card and t3flare calls `resume`
   * with the owner's answer, at most MAX_PAUSES times; the agent gets the last result, never a `requestId`. An approval
   * is resumed with `accept` only when the owner accepted; a decline is sent as `decline`, an unanswered card as `cancel`.
   */
  async #answerPauses(
    name: string,
    server: McpServerSetting,
    target: McpEngineTargetEncoded,
    value: unknown,
    signal: AbortSignal | undefined,
    asker: McpAsker | undefined,
    context: QuestionContext,
  ): Promise<McpCallAnswer> {
    const resume = this.inventory(name).definitions[RESUME_TOOL]!;
    let current = value;
    for (let round = 0; ; round++) {
      const pause = pauseOf(current);
      if (pause === undefined) return { kind: "result", ...redactedResult(current) };
      if (asker === undefined) return { kind: "result", isError: true, text: `${name} paused this call for the owner's ${pause.status === "approval-required" ? "approval" : "input"}, which this caller cannot ask for. It did not run.` };
      if (round === MAX_PAUSES) return { kind: "unavailable", message: `${name} paused this call more than ${MAX_PAUSES} times; t3flare stopped answering. Some of its steps may have run.`, mayHaveRun: true };
      const answer = await this.#answer(planPause(pause, context), asker, context, "pause");
      // Declined unseen or refused (a credential form, a malformed one): the server is told `decline`.
      const response = answer.kind === "card" ? answer.result : answer.answer.kind === "answered" ? answer.answer.result : { action: "decline" };
      const next = await this.#request(name, server, target, resume, { requestId: pause.requestId, response }, signal, asker, context);
      if (next.kind === "unavailable") return { ...next, message: `Resuming ${name}'s paused call failed: ${next.message}` };
      current = next.value;
    }
  }
}

/** A question's answer: at once, or from the owner's card. */
type Answered = { readonly kind: "now"; readonly answer: ElicitAnswer } | ({ readonly kind: "card" } & ElicitResultOrCancel);

/** The tool a pausing server resumes a paused call with (Executor's). */
const RESUME_TOOL = "resume";
const RESUME_REFUSAL = (server: string) =>
  `t3flare answers ${server}'s approval and input requests itself, from the owner's card, and resumes the paused call; resume is not yours to call. If the call is still needed, call the original tool again.`;
/** Most pauses of one call t3flare answers. */
const MAX_PAUSES = 16;

/** A result as text, without a pause's `requestId` (an expired or busy outcome still carries one). */
const redactedResult = (value: unknown): { readonly isError: boolean; readonly text: string } => {
  const content = (value as { structuredContent?: unknown } | null)?.structuredContent as { requestId?: unknown; message?: unknown } | undefined;
  if (content === undefined || content === null || typeof content.requestId !== "string") return resultText(value);
  return { isError: (value as { isError?: unknown }).isError === true, text: typeof content.message === "string" ? content.message.replaceAll(content.requestId, "[request]") : "The server is still answering an earlier request for this call; try the call again." };
};

const readStream = async (body: ReadableStream<Uint8Array>): Promise<unknown> => {
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESULT_BYTES) {
      await reader.cancel();
      return { isError: true, content: [{ type: "text", text: `The tool's result was larger than ${MAX_RESULT_BYTES} bytes.` }] };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all));
};

/** A `CallToolResult` as text for the model: its text blocks, else its structured content, else its JSON. */
export const resultText = (value: unknown): { readonly isError: boolean; readonly text: string } => {
  const result = (value ?? {}) as { isError?: unknown; content?: unknown; structuredContent?: unknown };
  const blocks = Array.isArray(result.content) ? (result.content as Array<{ type?: unknown; text?: unknown }>) : [];
  const texts = blocks.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : typeof block.type === "string" ? [`[${block.type} content]`] : []));
  const text = texts.length > 0 ? texts.join("\n") : result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : JSON.stringify(value);
  return { isError: result.isError === true, text: text.slice(0, MAX_RESULT_BYTES) };
};
