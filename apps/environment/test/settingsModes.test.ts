// @effect-diagnostics globalDate:off
// T-modes (plan §5; ADR-0035, plan D12), M5a's part (SPI-1200): `browser`. The 2026 `input_required` shape and its
// retry; the 45 s hold answering `applied`, `declined` and `waiting`; the 2025-11-25 page elicitation on the call's
// stream, a late `decline` withdrawing; the link-in-result fallback for every client that declared no page elicitation;
// the signed `requestState` and elicitation id refused when they are not this call's. M5b's part (SPI-1201): `native`
// (the 2026 form round trip, the 2025 held stream and its cut, 2025-06-18's params) and `model` (the Pause as `pauseOf`
// reads it, `resume` and its refusals), and every fallback of D12's table.
import { CARD_TEXT_MAX, MAX_GLOBAL_MISE_BYTES } from "@t3flare/harness-registry";
import { afterEach, describe, expect, it } from "vitest";

import { addMcpServer } from "../src/harness/ops.ts";
import { isPausingServer, pauseOf } from "../src/mcp/elicitation.ts";
import { changePagePath } from "../src/harness/paths.ts";
import { CHANGE_TTL_MS } from "../src/settings/changes.ts";
import { waitingOn } from "../src/settings/openChanges.ts";
import { changesApiOf, PAUSE_LINE } from "../src/settings/server.ts";
import { signToken } from "../src/settings/tokens.ts";
import { HOLDS_PER_CALLER, HOLDS_PER_CHANGE, streamHolds } from "../src/settings/endpoint.ts";
import { ASKED, BOTH, bodyOf, endpointOf, initialize, KEY, legacy, modern, post, setAccess, structuredOf, SUB } from "./settingsEndpointFixture.ts";
import { skillMd } from "./skillRepo.fixture.ts";
import { HOST, NOW, settingsFixture, type SettingsFixture, until } from "./settingsFixture.ts";

let fixture: SettingsFixture | undefined;
const world = () => {
  fixture = settingsFixture();
  return fixture;
};
afterEach(() => fixture?.dispose());


const pageAnswer = (f: SettingsFixture, id: string, action: "approve" | "decline", subject = SUB) => changesApiOf(f.deps).answer(id, { answerer: { kind: "owner", subject }, action });

/** The one open change, and its page's URL. */
const openChange = (f: SettingsFixture) => {
  const [record] = f.deps.changes.open();
  if (record === undefined) throw new Error("no open change");
  return { record, url: `https://${HOST}${changePagePath(record.id)}` };
};

/** The JSON-RPC messages of an SSE body. */
const events = (text: string): Array<Record<string, unknown>> =>
  text
    .split("\n\n")
    .flatMap((block) => block.split("\n").filter((line) => line.startsWith("data: ")))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);

const askedCall = (options: { readonly capabilities?: unknown; readonly query?: string; readonly extra?: Record<string, unknown> } = {}) =>
  modern("tools/call", { name: "change_environment", arguments: ASKED, ...options.extra }, { ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }), ...(options.query === undefined ? {} : { query: options.query }) });

describe("browser on 2026-07-28: input_required with the Change page, then the retry", () => {
  it("answers the first call at once with D12's exact shape, and opens a browser-mode Open change of this sub", async () => {
    const f = world();
    const body = await bodyOf(await endpointOf(f)(askedCall()));
    const { record, url } = openChange(f);
    expect(record).toMatchObject({ mode: "browser", tier: "asked", caller: { door: "owner", key: SUB, principal: "owner", client: { name: "claude-code 2.1.322" } } });
    expect(body.result).toEqual({
      resultType: "input_required",
      inputRequests: { change: { method: "elicitation/create", params: { mode: "url", message: expect.stringContaining("Approve or decline it on the Change page."), url } } },
      requestState: expect.stringMatching(/^v1\./),
      _meta: { "io.modelcontextprotocol/serverInfo": expect.objectContaining({ name: "t3flare-settings" }) },
    });
    const message = JSON.stringify(body.result);
    expect(message).toContain("containerBudget");
    expect(message).not.toContain("expectedRevision");
  });

  const retry = (requestState: unknown, action: string | undefined, args: Record<string, unknown> = ASKED) =>
    modern("tools/call", { name: "change_environment", arguments: args, requestState, ...(action === undefined ? {} : { inputResponses: { change: { action } } }) }, { id: 2 });

  it.each([
    ["approve", { status: "applied", revision: 1 }],
    ["decline", { status: "declined" }],
  ] as const)("accept holds for the page: the page's %s answers it", async (action, expected) => {
    const f = world();
    const endpoint = endpointOf(f, { holdMs: 2000 });
    const first = await bodyOf(await endpoint(askedCall()));
    const { record } = openChange(f);
    const held = endpoint(retry(first.result?.requestState, "accept"));
    await until(() => waitingOn(record.id) > 0);
    expect((await pageAnswer(f, record.id, action)).ok).toBe(true);
    expect(await structuredOf(await held)).toMatchObject({ ...expected, changeId: record.id });
    if (action === "approve") expect(f.store.auditLog(1)[0]).toMatchObject({ via: "mcp", caller: `owner:${SUB}`, tier: "asked", mode: "browser", answeredBy: "page", change: record.id });
  });

  it("accept with no answer within the hold answers W, and the change stays open for the page", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const first = await bodyOf(await endpoint(askedCall()));
    const { record, url } = openChange(f);
    const result = (await bodyOf(await endpoint(retry(first.result?.requestState, "accept")))).result;
    expect(result).toMatchObject({ resultType: "complete", isError: false, structuredContent: { status: "waiting", changeId: record.id, url } });
    expect(JSON.stringify(result?.content)).toContain("Do not repeat this call");
    expect(f.deps.changes.get(record.id)?.state).toBe("open");
    // The page still applies it after the call ended.
    expect((await pageAnswer(f, record.id, "approve")).ok).toBe(true);
    expect(f.store.loadEnvironment().revision).toBe(1);
  });

  it.each(["decline", "cancel"])("a %s in inputResponses withdraws the Open change, and is no strike", async (action) => {
    const f = world();
    const endpoint = endpointOf(f);
    const first = await bodyOf(await endpoint(askedCall()));
    const { record } = openChange(f);
    expect(await structuredOf(await endpoint(retry(first.result?.requestState, action)))).toMatchObject({ status: "withdrawn", changeId: record.id });
    expect(f.deps.changes.get(record.id)?.state).toBe("withdrawn");
    expect(f.store.loadEnvironment().revision).toBe(0);
  });

  it("a retry without an answer asks again on the same Open change", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const first = await bodyOf(await endpoint(askedCall()));
    const again = await bodyOf(await endpoint(retry(first.result?.requestState, undefined)));
    expect(again.result?.resultType).toBe("input_required");
    expect(f.deps.changes.open()).toHaveLength(1);
    expect(JSON.stringify(again.result?.inputRequests)).toContain(openChange(f).record.id);
  });

  it("a retry of a closed change answers its outcome", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const first = await bodyOf(await endpoint(askedCall()));
    await pageAnswer(f, openChange(f).record.id, "approve");
    expect(await structuredOf(await endpoint(retry(first.result?.requestState, "accept")))).toMatchObject({ status: "applied", revision: 1 });
  });

  it("T-state: a tampered, expired, another identity's, another kind's requestState, or one for other arguments, is refused and applies nothing", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const first = await bodyOf(await endpoint(askedCall()));
    const state = first.result?.requestState as string;
    const { record } = openChange(f);
    const forged = `${state.slice(0, -4)}AAAA`;
    const [, payload] = state.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<string, unknown>;
    const expired = await signToken(KEY, { ...decoded, kind: "state", sub: SUB, exp: NOW - 1 });
    const otherSub = await signToken(KEY, { ...decoded, kind: "state", sub: "someone-else", exp: NOW + 60_000 });
    const otherKind = await signToken(KEY, { ...decoded, kind: "elicit", sub: SUB, exp: NOW + 60_000 });
    const otherKey = await signToken(new Uint8Array(32).fill(9), { ...decoded, kind: "state", sub: SUB, exp: NOW + 60_000 });
    for (const [each, args] of [
      [forged, ASKED],
      [expired, ASKED],
      [otherSub, ASKED],
      [otherKind, ASKED],
      [otherKey, ASKED],
      ["not a token", ASKED],
      [state, { expectedRevision: 0, settings: { containerBudget: 5 } }],
    ] as const) {
      const body = await bodyOf(await endpoint(retry(each, "accept", args)));
      expect(body.result).toMatchObject({ isError: true, structuredContent: { status: "refused" } });
      expect(JSON.stringify(body.result?.content)).toMatch(/requestState/);
    }
    // Nothing applied, nothing withdrawn: a forged decline withdraws nothing either.
    await endpoint(retry(forged, "decline"));
    expect(f.deps.changes.get(record.id)?.state).toBe("open");
    expect(f.store.loadEnvironment().revision).toBe(0);
    // Another identity calling with this state finds it refused too (its sub is not the state's).
    const stranger = await bodyOf(await endpoint(retry(state, "decline"), { kind: "owner", subject: "someone-else" }));
    expect(stranger.result).toMatchObject({ structuredContent: { status: "refused" } });
    expect(f.deps.changes.get(record.id)?.state).toBe("open");
  });

  it("the page refuses an answer from another Access identity than the one that asked", async () => {
    const f = world();
    await endpointOf(f)(askedCall());
    const answered = await pageAnswer(f, openChange(f).record.id, "approve", "someone-else");
    expect(answered).toMatchObject({ ok: false, status: 403 });
    expect(f.store.loadEnvironment().revision).toBe(0);
  });

  it("a repeated call finds its own Open change, not a second one; a third different change past the sub's cap is refused naming the open ones", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    await endpoint(askedCall());
    await endpoint(askedCall());
    expect(f.deps.changes.open()).toHaveLength(1);
    await endpoint(modern("tools/call", { name: "change_environment", arguments: { expectedRevision: 0, settings: { containerBudget: 5 } } }));
    const third = await structuredOf(await endpoint(modern("tools/call", { name: "change_environment", arguments: { expectedRevision: 0, settings: { containerBudget: 6 } } })));
    expect(third).toMatchObject({ status: "refused", reason: "open-owner", changeId: f.deps.changes.open()[0]!.id });
  });
});

describe("browser on 2025-11-25: the page elicitation on the call's stream", () => {
  const setup = async (options: { readonly holdMs?: number; readonly work?: () => () => void } = {}) => {
    const f = world();
    const endpoint = endpointOf(f, { holdMs: options.holdMs ?? 80, beatMs: 30, ...(options.work === undefined ? {} : { work: options.work }) });
    const { session } = await initialize(endpoint, "2025-11-25", BOTH);
    return { f, endpoint, session };
  };

  it("writes elicitation/create (url, message, elicitationId) and then the call's result when the page approves", async () => {
    const { f, endpoint, session } = await setup({ holdMs: 2000 });
    const response = await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session, id: 7 }));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await until(() => f.deps.changes.open().some((each) => waitingOn(each.id) > 0));
    const { record, url } = openChange(f);
    await pageAnswer(f, record.id, "approve");
    const [ask, result, ...rest] = events(await response.text());
    expect(rest).toEqual([]);
    expect(ask).toMatchObject({ jsonrpc: "2.0", method: "elicitation/create", params: { mode: "url", url, elicitationId: record.id, message: expect.stringContaining("containerBudget") } });
    expect(String(ask!.id)).toMatch(/^v1\./);
    expect(result).toMatchObject({ jsonrpc: "2.0", id: 7, result: { isError: false, structuredContent: { status: "applied", revision: 1 } } });
    expect(result!.result).not.toHaveProperty("resultType");
  });

  it("holds 45 s at most (here, briefly) and then answers W; progress every beat when the call carried a token, a comment otherwise", async () => {
    const { f, endpoint, session } = await setup();
    const withToken = await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED, _meta: { progressToken: "p1" } }, { session }));
    const messages = events(await withToken.text());
    expect(messages.filter((each) => each.method === "notifications/progress").map((each) => (each.params as { progressToken: unknown }).progressToken)).toEqual(["p1", "p1"]);
    expect(messages.at(-1)).toMatchObject({ result: { structuredContent: { status: "waiting", changeId: openChange(f).record.id } } });
    const without = await (await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session }))).text();
    expect(without).toContain(": waiting for the owner");
    expect(events(without).some((each) => each.method === "notifications/progress")).toBe(false);
  });

  it("a late decline POST withdraws the change after the call ended; accept is ignored; both 202 with no body", async () => {
    const { f, endpoint, session } = await setup();
    const [ask] = events(await (await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session }))).text());
    const { record } = openChange(f);
    const accepted = await endpoint(post({ jsonrpc: "2.0", id: ask!.id, result: { action: "accept" } }, { headers: { "mcp-session-id": session } }));
    expect(accepted.status).toBe(202);
    expect(await accepted.text()).toBe("");
    expect(f.deps.changes.get(record.id)?.state).toBe("open");
    const declined = await endpoint(post({ jsonrpc: "2.0", id: ask!.id, result: { action: "decline" } }, { headers: { "mcp-session-id": session } }));
    expect(declined.status).toBe(202);
    expect(f.deps.changes.get(record.id)).toMatchObject({ state: "withdrawn", closed: { by: "client" } });
  });

  it("T-state: a response to a question this server did not ask this identity is refused (400) and withdraws nothing", async () => {
    const { f, endpoint, session } = await setup();
    const [ask] = events(await (await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session }))).text());
    const { record } = openChange(f);
    const forged = `${String(ask!.id).slice(0, -4)}AAAA`;
    const otherKind = await signToken(KEY, { kind: "state", sub: SUB, exp: NOW + 60_000, change: record.id });
    const expired = await signToken(KEY, { kind: "elicit", sub: SUB, exp: NOW - 1, change: record.id });
    for (const id of [forged, otherKind, expired, 5, "elicit-1"]) {
      expect((await endpoint(post({ jsonrpc: "2.0", id, result: { action: "decline" } }))).status).toBe(400);
    }
    expect((await endpoint(post({ jsonrpc: "2.0", id: ask!.id, result: { action: "decline" } }), { kind: "owner", subject: "someone-else" })).status).toBe(400);
    expect(f.deps.changes.get(record.id)?.state).toBe("open");
  });

  it("a stream the client cuts leaves the change open for the page (browser)", async () => {
    let open = 0;
    const { f, endpoint, session } = await setup({
      holdMs: 2000,
      work: () => {
        open += 1;
        return () => void (open -= 1);
      },
    });
    const response = await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session }));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    // The held stream has ended (its work released) with whatever its cut does done.
    await until(() => open === 0);
    expect(openChange(f).record.state).toBe("open");
  });

  it("counts a held stream as open work until it ends", async () => {
    const f = world();
    let open = 0;
    const endpoint = endpointOf(f, {
      work: () => {
        open += 1;
        return () => void (open -= 1);
      },
    });
    const { session } = await initialize(endpoint, "2025-11-25", BOTH);
    const response = await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session }));
    expect(open).toBe(1);
    await response.text();
    await until(() => open === 0);
  });
});

describe("D12's fallbacks toward browser", () => {
  it.each([
    ["2026 with form elicitation only", () => askedCall({ capabilities: { elicitation: { form: {} } } })],
    ["2026 with no elicitation", () => askedCall({ capabilities: {} })],
  ])("%s: the link in the result (W), no question", async (_name, request) => {
    const f = world();
    const result = (await bodyOf(await endpointOf(f)(request()))).result;
    const { record, url } = openChange(f);
    expect(result).toMatchObject({ resultType: "complete", isError: false, structuredContent: { status: "waiting", changeId: record.id, url } });
    expect(JSON.stringify(result?.content)).toContain(`Waiting for the owner at ${url}. It applies when he approves it there.`);
  });

  it.each([
    ["2025-06-18 with form elicitation", "2025-06-18", BOTH],
    ["2025-11-25 with form elicitation only", "2025-11-25", { elicitation: {} }],
    ["pi 1.5.2 (2025-11-25, roots only)", "2025-11-25", { roots: {} }],
    ["2025-03-26", "2025-03-26", BOTH],
  ])("%s: the link in the result (W), no stream", async (_name, version, capabilities) => {
    const f = world();
    const endpoint = endpointOf(f);
    const { session } = await initialize(endpoint, version, capabilities);
    const response = await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session, version }));
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await structuredOf(response)).toMatchObject({ status: "waiting", url: openChange(f).url });
  });

  it("a change that needs the page is answered there like any other in browser", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const add = { expectedRevision: 0, change: { op: "add", server: "notes", url: "https://notes.example/mcp?key=secret", auth: { kind: "header", header: "X-Key" } } };
    const body = await bodyOf(await endpoint(modern("tools/call", { name: "change_mcp", arguments: add })));
    expect(body.result?.resultType).toBe("input_required");
    expect(openChange(f).record.needsPage).toBe("secret");
    // The URL the client itself sent is shown whole, so the owner approves exactly what is added (SPI-1199 review).
    expect(JSON.stringify(body)).toContain("https://notes.example/mcp?key=secret");
  });
});

// ── M5b (SPI-1201): native ─────────────────────────────────────────────────────────────────────────────────────────

const NATIVE = "?elicitation_mode=native";
const MODEL = "?elicitation_mode=model";
const FORM = { elicitation: { form: {} } };
const EMPTY = { type: "object", properties: {} };

describe("native on 2026-07-28: the form in input_required, answered by the retry", () => {
  const retry = (requestState: unknown, action: string | undefined, query = NATIVE) =>
    modern("tools/call", { name: "change_environment", arguments: ASKED, requestState, ...(action === undefined ? {} : { inputResponses: { change: { action } } }) }, { id: 2, query });

  it("answers the first call at once with D12's exact form, opening a native-mode Open change", async () => {
    const f = world();
    const body = await bodyOf(await endpointOf(f)(askedCall({ query: NATIVE })));
    const { record, url } = openChange(f);
    expect(record).toMatchObject({ mode: "native", tier: "asked" });
    expect(body.result).toEqual({
      resultType: "input_required",
      inputRequests: { change: { method: "elicitation/create", params: { mode: "form", message: expect.stringContaining("Accept applies it"), requestedSchema: EMPTY } } },
      requestState: expect.stringMatching(/^v1\./),
      _meta: expect.any(Object),
    });
    const message = JSON.stringify(body.result);
    expect(message).toContain("containerBudget");
    expect(message).toContain(url);
  });

  it("accept applies it, answered by client, with no hold, and audits mode native", async () => {
    const f = world();
    // A hold would outlast this test's timeout: the form's answer is the client's, so nothing waits.
    const endpoint = endpointOf(f, { holdMs: 60_000 });
    const first = await bodyOf(await endpoint(askedCall({ query: NATIVE })));
    const { record } = openChange(f);
    expect(await structuredOf(await endpoint(retry(first.result?.requestState, "accept")))).toMatchObject({ status: "applied", revision: 1, changeId: record.id });
    expect(f.deps.changes.get(record.id)).toMatchObject({ state: "applied", closed: { by: "client" } });
    expect(f.store.auditLog(1)[0]).toMatchObject({ via: "mcp", caller: `owner:${SUB}`, tier: "asked", mode: "native", answeredBy: "client", change: record.id });
  });

  it("decline closes it declined (a strike, by client); cancel withdraws it", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const first = await bodyOf(await endpoint(askedCall({ query: NATIVE })));
    const declined = openChange(f).record;
    expect(await structuredOf(await endpoint(retry(first.result?.requestState, "decline")))).toMatchObject({ status: "declined", changeId: declined.id });
    expect(f.deps.changes.get(declined.id)).toMatchObject({ state: "declined", closed: { by: "client" } });
    const other = { expectedRevision: 0, settings: { containerBudget: 6 } };
    const second = await bodyOf(await endpoint(modern("tools/call", { name: "change_environment", arguments: other }, { query: NATIVE })));
    const cancelled = openChange(f).record;
    const cancel = await endpoint(modern("tools/call", { name: "change_environment", arguments: other, requestState: second.result?.requestState, inputResponses: { change: { action: "cancel" } } }, { query: NATIVE }));
    expect(await structuredOf(cancel)).toMatchObject({ status: "withdrawn", changeId: cancelled.id });
    expect(f.store.loadEnvironment().revision).toBe(0);
  });

  it("a retry without a response asks again on the same Open change", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const first = await bodyOf(await endpoint(askedCall({ query: NATIVE })));
    const again = await bodyOf(await endpoint(retry(first.result?.requestState, undefined)));
    expect(again.result).toMatchObject({ resultType: "input_required", inputRequests: { change: { params: { mode: "form" } } } });
    expect(f.deps.changes.open()).toHaveLength(1);
  });

  it("a retry in another mode than the change's is refused and applies nothing", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const first = await bodyOf(await endpoint(askedCall({ query: NATIVE })));
    const body = await bodyOf(await endpoint(retry(first.result?.requestState, "accept", "?elicitation_mode=browser")));
    expect(body.result).toMatchObject({ isError: true, structuredContent: { status: "refused" } });
    expect(JSON.stringify(body.result?.content)).toContain("asked in the native Elicitation mode");
    expect(openChange(f).record.state).toBe("open");
    expect(f.store.loadEnvironment().revision).toBe(0);
  });

  it("the page can still answer a native change; the client's later accept finds it closed", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const first = await bodyOf(await endpoint(askedCall({ query: NATIVE })));
    expect((await pageAnswer(f, openChange(f).record.id, "decline")).ok).toBe(true);
    expect(await structuredOf(await endpoint(retry(first.result?.requestState, "accept")))).toMatchObject({ status: "declined" });
    expect(f.store.loadEnvironment().revision).toBe(0);
  });
});

describe("native on 2025: the form on the call's held stream", () => {
  const setup = async (version = "2025-11-25", extra: Parameters<typeof endpointOf>[1] = {}) => {
    const f = world();
    const endpoint = endpointOf(f, { beatMs: 30, ...extra });
    const { session } = await initialize(endpoint, version, BOTH);
    return { f, endpoint, session };
  };
  const call = (session: string, version = "2025-11-25", meta: Record<string, unknown> = {}) =>
    legacy("tools/call", { name: "change_environment", arguments: ASKED, ...(Object.keys(meta).length === 0 ? {} : { _meta: meta }) }, { session, version, query: NATIVE, id: 7 });
  const answer = (session: string, id: unknown, body: Record<string, unknown>, query = NATIVE) => post({ jsonrpc: "2.0", id, ...body }, { query, headers: { "mcp-session-id": session } });

  /** The first SSE message of a held response, read without waiting for the stream's end. */
  const firstMessage = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    let text = "";
    while (!text.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    return events(text)[0]!;
  };
  const rest = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += new TextDecoder().decode(value);
    }
  };

  it.each([
    ["accept", { status: "applied", revision: 1 }, "applied"],
    ["decline", { status: "declined" }, "declined"],
    ["cancel", { status: "withdrawn" }, "withdrawn"],
  ] as const)("writes elicitation/create (form, no fields) and holds; the response POST's %s answers the call", async (action, expected, state) => {
    const { f, endpoint, session } = await setup();
    const response = await endpoint(call(session));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const ask = await firstMessage(reader);
    const { record } = openChange(f);
    expect(record.mode).toBe("native");
    expect(ask).toMatchObject({ jsonrpc: "2.0", method: "elicitation/create", params: { mode: "form", requestedSchema: EMPTY, message: expect.stringContaining("containerBudget") } });
    expect(String(ask.id)).toMatch(/^v1\./);
    const posted = await endpoint(answer(session, ask.id, { result: { action, content: {} } }));
    expect(posted.status).toBe(202);
    expect(await posted.text()).toBe("");
    const [result, ...more] = events(await rest(reader));
    expect(more).toEqual([]);
    expect(result).toMatchObject({ jsonrpc: "2.0", id: 7, result: { structuredContent: { ...expected, changeId: record.id } } });
    expect(f.deps.changes.get(record.id)).toMatchObject({ state, closed: { by: "client" } });
    if (action === "accept") expect(f.store.auditLog(1)[0]).toMatchObject({ tier: "asked", mode: "native", answeredBy: "client", change: record.id });
  });

  it("2025-06-18 has no mode in the question's params", async () => {
    const { session, endpoint } = await setup("2025-06-18");
    const reader = (await endpoint(call(session, "2025-06-18"))).body!.getReader();
    const ask = await firstMessage(reader);
    expect(ask.params).toEqual({ message: expect.any(String), requestedSchema: EMPTY });
    await reader.cancel();
  });

  it("sends progress each beat when the call carried a token, an SSE comment otherwise", async () => {
    const { session, endpoint } = await setup("2025-11-25", { formWaitMs: 100 });
    const withToken = events(await (await endpoint(call(session, "2025-11-25", { progressToken: "p9" }))).text());
    expect(withToken.filter((each) => each.method === "notifications/progress").length).toBeGreaterThanOrEqual(2);
    expect(withToken.filter((each) => each.method === "notifications/progress").every((each) => (each.params as { progressToken: unknown }).progressToken === "p9")).toBe(true);
    const without = await (await endpoint(call(session))).text();
    expect(without).toContain(": waiting for the form's answer");
  });

  it("a stream the client cuts withdraws the change (by stop, no strike), and a later accept applies nothing", async () => {
    const { f, endpoint, session } = await setup();
    const reader = (await endpoint(call(session))).body!.getReader();
    const ask = await firstMessage(reader);
    const { record } = openChange(f);
    await reader.cancel();
    await until(() => f.deps.changes.get(record.id)?.state !== "open");
    expect(f.deps.changes.get(record.id)).toMatchObject({ state: "withdrawn", closed: { by: "stop", cut: true } });
    // One log line for the close, which says the stream was cut.
    const lines = f.logs.filter((line) => line.change === record.id && line.outcome === "withdrawn");
    expect(lines).toEqual([expect.objectContaining({ t3flare: "settings-refused", answeredBy: "stop", cut: true })]);
    expect(f.logs.some((line) => line.t3flare === "settings-stream-cut")).toBe(false);
    expect((await endpoint(answer(session, ask.id, { result: { action: "accept" } }))).status).toBe(202);
    expect(f.store.loadEnvironment().revision).toBe(0);
    expect(f.deps.changes.get(record.id)?.state).toBe("withdrawn");
  });

  // C2 (SPI-1201 review): an answer with no live stream to deliver its result applies nothing.
  it("an accept POSTed when no stream holds the question (the Environment reset) withdraws the change by stop and applies nothing", async () => {
    const { f, endpoint, session } = await setup();
    const reader = (await endpoint(call(session))).body!.getReader();
    const ask = await firstMessage(reader);
    const { record } = openChange(f);
    // Another isolate: the same storage, none of this one's streams.
    f.reset();
    const fresh = endpointOf(f, { beatMs: 30, holds: streamHolds() });
    const posted = await fresh(answer(session, ask.id, { result: { action: "accept", content: {} } }));
    expect(posted.status).toBe(202);
    expect(f.deps.changes.get(record.id)).toMatchObject({ state: "withdrawn", closed: { by: "stop" } });
    expect(f.store.loadEnvironment().revision).toBe(0);
    expect(f.logs).toContainEqual(expect.objectContaining({ t3flare: "settings-refused", reason: "no-live-stream", change: record.id }));
    await reader.cancel();
  });

  // C3 (SPI-1201 review): streams on one change are counted; the last cut withdraws it, and the caps bound them.
  it("two streams on one change: cutting one leaves the other's question standing, and its accept applies", async () => {
    const holds = streamHolds();
    const { f, endpoint, session } = await setup("2025-11-25", { holds });
    const first = (await endpoint(call(session))).body!.getReader();
    await firstMessage(first);
    const second = (await endpoint(call(session))).body!.getReader();
    const ask = await firstMessage(second);
    const { record } = openChange(f);
    expect(f.deps.changes.open()).toHaveLength(1);
    expect(holds.byChange.get(record.id)).toBe(2);
    await first.cancel();
    await until(() => holds.byChange.get(record.id) === 1);
    expect(f.deps.changes.get(record.id)?.state).toBe("open");
    expect((await endpoint(answer(session, ask.id, { result: { action: "accept", content: {} } }))).status).toBe(202);
    const [result] = events(await rest(second));
    expect(result).toMatchObject({ result: { structuredContent: { status: "applied", revision: 1, changeId: record.id } } });
  });

  it("the last of two cut streams withdraws the change", async () => {
    const { f, endpoint, session } = await setup();
    const readers = [(await endpoint(call(session))).body!.getReader(), (await endpoint(call(session))).body!.getReader()];
    for (const reader of readers) await firstMessage(reader);
    const { record } = openChange(f);
    await readers[0]!.cancel();
    await readers[1]!.cancel();
    await until(() => f.deps.changes.get(record.id)?.state !== "open");
    expect(f.deps.changes.get(record.id)).toMatchObject({ state: "withdrawn", closed: { by: "stop", cut: true } });
  });

  it(`at most ${HOLDS_PER_CHANGE} streams per change; past it, W saying why`, async () => {
    let open = 0;
    const { f, endpoint, session } = await setup("2025-11-25", {
      work: () => {
        open += 1;
        return () => void (open -= 1);
      },
    });
    const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
    for (let index = 0; index < HOLDS_PER_CHANGE; index++) {
      const reader = (await endpoint(call(session))).body!.getReader();
      await firstMessage(reader);
      readers.push(reader);
    }
    const third = await endpoint(call(session));
    expect(third.headers.get("content-type")).toBe("application/json");
    const body = await bodyOf(third);
    expect(body.result).toMatchObject({ structuredContent: { status: "waiting", changeId: openChange(f).record.id } });
    expect(JSON.stringify(body.result?.content)).toContain(`${HOLDS_PER_CHANGE} calls already wait on this change's question`);
    expect(open).toBe(HOLDS_PER_CHANGE);
    for (const reader of readers) await reader.cancel();
    await until(() => open === 0);
  });

  it(`at most ${HOLDS_PER_CALLER} streams per caller; past it, W saying why`, async () => {
    // Two open changes of two streams each stay under it today (OPEN_PER_OWNER): it is the backstop, so the caller's
    // other streams are stood in for.
    const holds = streamHolds();
    holds.byCaller.set(SUB, HOLDS_PER_CALLER);
    const { endpoint, session } = await setup("2025-11-25", { holds });
    const past = await bodyOf(await endpoint(call(session)));
    expect(past.result).toMatchObject({ structuredContent: { status: "waiting" } });
    expect(JSON.stringify(past.result?.content)).toContain(`${HOLDS_PER_CALLER} of your calls already wait on a question`);
  });

  it("holds no longer than the change lives: unanswered, it expires and the call says so", async () => {
    const { f, endpoint, session } = await setup("2025-11-25", { formWaitMs: 60 });
    const messages = events(await (await endpoint(call(session))).text());
    expect(messages.at(-1)).toMatchObject({ result: { isError: true, structuredContent: { status: "expired" } } });
    expect(f.deps.changes.open()).toHaveLength(0);
  });

  it("a JSON-RPC error in place of the answer withdraws it; a response sent in another mode is refused", async () => {
    const { f, endpoint, session } = await setup();
    const reader = (await endpoint(call(session))).body!.getReader();
    const ask = await firstMessage(reader);
    const { record } = openChange(f);
    expect((await endpoint(answer(session, ask.id, { result: { action: "accept" } }, "?elicitation_mode=browser"))).status).toBe(400);
    expect(f.deps.changes.get(record.id)?.state).toBe("open");
    expect((await endpoint(answer(session, ask.id, { error: { code: -1, message: "no UI" } }))).status).toBe(202);
    expect(f.deps.changes.get(record.id)?.state).toBe("withdrawn");
    await rest(reader);
    expect(f.store.loadEnvironment().revision).toBe(0);
  });

  it("another identity's response to the question is refused (400) and answers nothing", async () => {
    const { f, endpoint, session } = await setup();
    const reader = (await endpoint(call(session))).body!.getReader();
    const ask = await firstMessage(reader);
    expect((await endpoint(answer(session, ask.id, { result: { action: "accept" } }), { kind: "owner", subject: "someone-else" })).status).toBe(400);
    expect(openChange(f).record.state).toBe("open");
    await reader.cancel();
  });

  it("counts the held stream as open work until it ends", async () => {
    const f = world();
    let open = 0;
    const endpoint = endpointOf(f, {
      formWaitMs: 40,
      work: () => {
        open += 1;
        return () => void (open -= 1);
      },
    });
    const { session } = await initialize(endpoint, "2025-11-25", BOTH);
    const response = await endpoint(call(session));
    expect(open).toBe(1);
    await response.text();
    await until(() => open === 0);
  });
});

// ── M5b (SPI-1201): model ──────────────────────────────────────────────────────────────────────────────────────────

describe("model: Executor's Pause, and resume", () => {
  const resume = (requestId: unknown, action: string, query = MODEL) => modern("tools/call", { name: "resume", arguments: { requestId, response: { action } } }, { query, id: 3 });

  it("answers the write with the Pause's exact shape at once, which pauseOf reads as a pause", async () => {
    const f = world();
    const body = await bodyOf(await endpointOf(f)(askedCall({ query: MODEL })));
    const { record, url } = openChange(f);
    expect(record.mode).toBe("model");
    const message = (body.result!.structuredContent as { elicitation: { message: string } }).elicitation.message;
    expect(body.result).toEqual({
      resultType: "complete",
      content: [{ type: "text", text: `${message}\n\n${PAUSE_LINE}` }],
      structuredContent: {
        status: "approval-required",
        requestId: record.id,
        elicitation: { mode: "form", message, requestedSchema: EMPTY },
        expiresAt: new Date(NOW + CHANGE_TTL_MS).toISOString(),
      },
      isError: false,
      _meta: expect.any(Object),
    });
    expect(message).toContain("containerBudget");
    expect(message).toContain(url);
    expect(pauseOf(body.result)).toMatchObject({ status: "approval-required", requestId: record.id, message, requestedSchema: EMPTY });
  });

  it("is the same Pause on every version, with no elicitation declared and no stream", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const { session } = await initialize(endpoint, "2025-03-26", {});
    const response = await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session, version: "2025-03-26", query: MODEL }));
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(pauseOf((await bodyOf(response)).result)).toMatchObject({ requestId: openChange(f).record.id });
  });

  it("lists resume in model alone, and isPausingServer is true of that list", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const listed = async (query: string) => (await bodyOf(await endpoint(modern("tools/list", {}, { query })))).result?.tools as Array<{ name: string; inputSchema: Record<string, unknown> }>;
    const model = await listed(MODEL);
    expect(model.map((tool) => tool.name)).toContain("resume");
    expect(isPausingServer(Object.fromEntries(model.map((tool) => [tool.name, tool])))).toBe(true);
    for (const query of ["", NATIVE, "?elicitation_mode=browser"]) expect((await listed(query)).map((tool) => tool.name)).not.toContain("resume");
    // Unlisted is unknown: resume outside model is no tool at all.
    const outside = await bodyOf(await endpoint(resume("chg_x", "accept", NATIVE)));
    expect(outside.error).toMatchObject({ code: -32602 });
  });

  it.each([
    ["accept", { status: "applied", revision: 1 }, "applied", "agent"],
    ["decline", { status: "declined" }, "declined", "agent"],
    ["cancel", { status: "withdrawn" }, "withdrawn", "agent"],
  ] as const)("resume with %s answers it, closed by agent", async (action, expected, state, by) => {
    const f = world();
    const endpoint = endpointOf(f);
    await endpoint(askedCall({ query: MODEL }));
    const { record } = openChange(f);
    expect(await structuredOf(await endpoint(resume(record.id, action)))).toMatchObject({ ...expected, changeId: record.id });
    expect(f.deps.changes.get(record.id)).toMatchObject({ state, closed: { by } });
    if (action === "accept") {
      expect(f.store.auditLog(1)[0]).toMatchObject({ via: "mcp", caller: `owner:${SUB}`, tier: "asked", mode: "model", answeredBy: "agent", change: record.id });
      expect(f.store.loadEnvironment().revision).toBe(1);
    } else expect(f.store.loadEnvironment().revision).toBe(0);
  });

  it("refuses another identity's, another mode's, an expired and an unknown id, applying nothing", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    await endpoint(askedCall({ query: MODEL }));
    const model = openChange(f).record;
    // Another sub: as unknown as a made-up id.
    const stranger = await bodyOf(await endpoint(resume(model.id, "accept"), { kind: "owner", subject: "someone-else" }));
    expect(stranger.result).toMatchObject({ isError: true, structuredContent: { status: "refused" } });
    expect(JSON.stringify(stranger.result?.content)).toContain("call the original tool again");
    expect(f.deps.changes.get(model.id)?.state).toBe("open");
    // Another mode's: a browser change of this sub.
    await endpoint(modern("tools/call", { name: "change_environment", arguments: { expectedRevision: 0, settings: { containerBudget: 6 } } }));
    const browser = f.deps.changes.open().find((record) => record.mode === "browser")!;
    const other = await bodyOf(await endpoint(resume(browser.id, "accept")));
    expect(other.result).toMatchObject({ isError: true, structuredContent: { status: "refused", changeId: browser.id } });
    expect(JSON.stringify(other.result?.content)).toContain("asked in the browser Elicitation mode");
    expect(f.deps.changes.get(browser.id)?.state).toBe("open");
    // Unknown and malformed ids.
    for (const id of ["chg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "not-an-id", 5]) {
      expect((await bodyOf(await endpoint(resume(id, "accept")))).result).toMatchObject({ isError: true, structuredContent: { status: "refused" } });
    }
    // Expired.
    f.advance(CHANGE_TTL_MS + 1);
    const expired = await bodyOf(await endpoint(resume(model.id, "accept")));
    expect(expired.result).toMatchObject({ isError: true, structuredContent: { status: "expired" } });
    expect(JSON.stringify(expired.result?.content)).toContain("call change_environment again");
    expect(f.store.loadEnvironment().revision).toBe(0);
  });

  it("a repeated call answers the same Pause; past the sub's cap the refusal names the requestId to resume", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const first = await structuredOf(await endpoint(askedCall({ query: MODEL })));
    const again = await structuredOf(await endpoint(askedCall({ query: MODEL })));
    expect(again?.requestId).toBe(first?.requestId);
    await endpoint(modern("tools/call", { name: "change_environment", arguments: { expectedRevision: 0, settings: { containerBudget: 5 } } }, { query: MODEL }));
    const third = await bodyOf(await endpoint(modern("tools/call", { name: "change_environment", arguments: { expectedRevision: 0, settings: { containerBudget: 6 } } }, { query: MODEL })));
    const refused = third.result?.structuredContent as Record<string, unknown>;
    expect(refused).toMatchObject({ status: "refused", reason: "open-owner", requestId: refused.changeId });
    expect(f.deps.changes.open().map((record) => record.id)).toContain(refused.requestId);
    expect(JSON.stringify(third.result?.content)).toContain("call resume");
  });

  it("the access switch: read-only lists no resume and refuses it; off refuses it naming the panel", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    await endpoint(askedCall({ query: MODEL }));
    const { record } = openChange(f);
    setAccess(f, { writes: false });
    const tools = (await bodyOf(await endpoint(modern("tools/list", {}, { query: MODEL })))).result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).not.toContain("resume");
    expect(await structuredOf(await endpoint(resume(record.id, "accept")))).toMatchObject({ status: "refused" });
    setAccess(f, { enabled: false });
    const off = await bodyOf(await endpoint(resume(record.id, "accept")));
    expect(JSON.stringify(off.result?.content)).toContain("Settings page");
    expect(f.store.loadEnvironment().revision).toBe(0);
  });

  it("the page can still answer a model change; resume then reports it closed", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    await endpoint(askedCall({ query: MODEL }));
    const { record } = openChange(f);
    expect((await pageAnswer(f, record.id, "approve")).ok).toBe(true);
    expect((await bodyOf(await endpoint(resume(record.id, "decline")))).result).toMatchObject({ isError: true, structuredContent: { status: "applied", revision: 1 } });
  });
});

// ── M5b (SPI-1201): D12's fallbacks for native and model ───────────────────────────────────────────────────────────

describe("D12's fallbacks for native and model", () => {
  it("native with no form elicitation declared is browser for that request: the URL elicitation when declared, else W saying why", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const withUrl = await bodyOf(await endpoint(askedCall({ query: NATIVE, capabilities: { elicitation: { url: {} } } })));
    expect(openChange(f).record.mode).toBe("browser");
    expect(withUrl.result).toMatchObject({ resultType: "input_required", inputRequests: { change: { params: { mode: "url" } } } });
    const g = world();
    const none = await bodyOf(await endpointOf(g)(askedCall({ query: NATIVE, capabilities: {} })));
    expect(openChange(g).record.mode).toBe("browser");
    expect(none.result).toMatchObject({ structuredContent: { status: "waiting", url: openChange(g).url } });
    expect(JSON.stringify(none.result?.content)).toContain("declared no form elicitation");
  });

  it.each([
    ["2025-03-26", "2025-03-26", BOTH],
    ["pi 1.5.2 (2025-11-25, roots only)", "2025-11-25", { roots: {} }],
    ["2025-11-25 with URL elicitation only", "2025-11-25", { elicitation: { url: {} } }],
  ])("native on %s: browser", async (_name, version, capabilities) => {
    const f = world();
    const endpoint = endpointOf(f, { holdMs: 40 });
    const { session } = await initialize(endpoint, version, capabilities);
    const response = await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session, version, query: NATIVE }));
    expect(openChange(f).record.mode).toBe("browser");
    const text = await response.text();
    expect(text).not.toContain('"mode":"form"');
    expect(text).toContain('"status":"waiting"');
  });

  const header = { expectedRevision: 0, change: { op: "add", server: "notes", url: "https://notes.example/mcp", auth: { kind: "header", header: "X-Key" } } };

  it("a change that needs the page, in native: the page elicitation (no form), the change browser-mode", async () => {
    const f = world();
    const body = await bodyOf(await endpointOf(f)(modern("tools/call", { name: "change_mcp", arguments: header }, { query: NATIVE })));
    expect(openChange(f).record).toMatchObject({ mode: "browser", needsPage: "secret" });
    expect(body.result).toMatchObject({ resultType: "input_required", inputRequests: { change: { params: { mode: "url", url: openChange(f).url } } } });
  });

  it("a change that needs the page, in native with form only: the link, saying why", async () => {
    const f = world();
    const body = await bodyOf(await endpointOf(f)(modern("tools/call", { name: "change_mcp", arguments: header }, { query: NATIVE, capabilities: FORM })));
    expect(body.result).toMatchObject({ structuredContent: { status: "waiting", url: openChange(f).url } });
    expect(JSON.stringify(body.result?.content)).toContain("takes a secret");
  });

  // A2 (SPI-1201 review): every other kind of change that needs the page, in each mode, as the header add above.
  const pageOnly: ReadonlyArray<readonly [string, "skills" | "sign-in" | "oversize", (f: SettingsFixture) => Promise<readonly [string, Record<string, unknown>]>]> = [
    [
      "a skill install",
      "skills",
      async (f) => {
        const commit = f.github.push("o/r", { "skills/a/SKILL.md": skillMd("a", "Do a.") });
        return ["change_skills", { expectedRevision: 0, op: "install", source: "o/r", commit, folders: ["skills/a"] }] as const;
      },
    ],
    [
      "a sign-in",
      "sign-in",
      async (f) => {
        await addMcpServer(f.deps.ops, { server: "oauthy", url: "https://oauthy.example/mcp", auth: { kind: "oauth" } }, { actor: { caller: "owner:o" } });
        return ["start_mcp_sign_in", { expectedRevision: 1, server: "oauthy" }] as const;
      },
    ],
    [
      "text too long to show",
      "oversize",
      async () => ["change_environment", { expectedRevision: 0, settings: { globalMiseConfig: `[tools]\n${"# a comment line of the config, long enough\n".repeat(Math.floor((MAX_GLOBAL_MISE_BYTES - 64) / 44))}` } }] as const,
    ],
  ];

  it.each(pageOnly)("%s, in native: the page elicitation, never a form; the client's accept applies nothing", async (_what, needsPage, setup) => {
    const f = world();
    const endpoint = endpointOf(f, { holdMs: 30 });
    const [tool, args] = await setup(f);
    const body = await bodyOf(await endpoint(modern("tools/call", { name: tool, arguments: args }, { query: NATIVE })));
    const { record, url } = openChange(f);
    expect(record).toMatchObject({ mode: "browser", needsPage });
    expect(body.result).toMatchObject({ resultType: "input_required", inputRequests: { change: { params: { mode: "url", url } } } });
    const revisions = [f.store.load().revision, f.store.loadEnvironment().revision];
    const retry = await bodyOf(await endpoint(modern("tools/call", { name: tool, arguments: args, requestState: body.result?.requestState, inputResponses: { change: { action: "accept" } } }, { query: NATIVE, id: 2 })));
    expect(retry.result).toMatchObject({ structuredContent: { status: "waiting", url } });
    expect([f.store.load().revision, f.store.loadEnvironment().revision]).toEqual(revisions);
    expect(f.deps.changes.get(record.id)?.state).toBe("open");
  });

  it.each(pageOnly)("%s, in model: the link with the reason, never a Pause; resume cannot approve it", async (_what, needsPage, setup) => {
    const f = world();
    const endpoint = endpointOf(f);
    const [tool, args] = await setup(f);
    const body = await bodyOf(await endpoint(modern("tools/call", { name: tool, arguments: args }, { query: MODEL })));
    const { record, url } = openChange(f);
    expect(record).toMatchObject({ mode: "browser", needsPage });
    expect(body.result).toMatchObject({ resultType: "complete", structuredContent: { status: "waiting", url } });
    expect(pauseOf(body.result)).toBeUndefined();
    expect(JSON.stringify(body.result?.content)).toContain("in every Elicitation mode");
    expect(await structuredOf(await endpoint(modern("tools/call", { name: "resume", arguments: { requestId: record.id, response: { action: "accept" } } }, { query: MODEL, id: 3 })))).toMatchObject({ status: "refused" });
    expect(f.deps.changes.get(record.id)?.state).toBe("open");
  });

  // C5 (SPI-1201 review): `oversize` is judged on the message the client is actually sent in its mode (the change, who
  // asked, how to answer and the page's link), so no question ever carries a cut message.
  it.each([
    ["native", NATIVE, (result: Record<string, unknown> | undefined) => (result as { inputRequests?: { change?: { params?: { message?: string } } } } | undefined)?.inputRequests?.change?.params?.message],
    ["model", MODEL, (result: Record<string, unknown> | undefined) => (result?.structuredContent as { elicitation?: { message?: string } } | undefined)?.elicitation?.message],
  ] as const)("%s: at the boundary, the longest change asked in the mode is sent whole, and one character more is answered on the page", async (_mode, query, messageOf) => {
    const ask = async (n: number) => {
      const f = settingsFixture();
      try {
        const body = await bodyOf(await endpointOf(f)(modern("tools/call", { name: "change_environment", arguments: { expectedRevision: 0, settings: { globalMiseConfig: `# ${"x".repeat(n)}\n` } } }, { query })));
        return { record: f.deps.changes.open()[0]!, result: body.result };
      } finally {
        f.dispose();
      }
    };
    let low = 0;
    let high = MAX_GLOBAL_MISE_BYTES - 8;
    expect((await ask(high)).record.needsPage).toBe("oversize");
    expect((await ask(low)).record.needsPage).toBeUndefined();
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if ((await ask(middle)).record.needsPage === "oversize") high = middle;
      else low = middle;
    }
    const fits = await ask(low);
    expect(fits.record.mode).toBe(query === NATIVE ? "native" : "model");
    const message = messageOf(fits.result);
    expect(message).toBeDefined();
    expect(message).not.toContain("[TRUNCATED");
    expect(message!.length).toBeLessThanOrEqual(CARD_TEXT_MAX);
    const over = await ask(high);
    expect(over.record).toMatchObject({ mode: "browser", needsPage: "oversize" });
    expect(pauseOf(over.result)).toBeUndefined();
  });

  it("a change that needs the page, in model: the link, never a Pause nor a question", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const body = await bodyOf(await endpoint(modern("tools/call", { name: "change_mcp", arguments: header }, { query: MODEL })));
    const { record, url } = openChange(f);
    expect(record).toMatchObject({ mode: "browser", needsPage: "secret" });
    expect(body.result).toMatchObject({ resultType: "complete", structuredContent: { status: "waiting", url } });
    expect(pauseOf(body.result)).toBeUndefined();
    // resume cannot approve it: it is not a model-mode change.
    expect(await structuredOf(await endpoint(modern("tools/call", { name: "resume", arguments: { requestId: record.id, response: { action: "accept" } } }, { query: MODEL })))).toMatchObject({ status: "refused" });
    // A repeat finds the same change, not a second one.
    await endpoint(modern("tools/call", { name: "change_mcp", arguments: header }, { query: MODEL }));
    expect(f.deps.changes.open()).toHaveLength(1);
  });
});
