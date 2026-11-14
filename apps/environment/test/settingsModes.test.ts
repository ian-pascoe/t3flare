// @effect-diagnostics globalDate:off
// T-modes (plan §5; ADR-0034, plan D12), M5a's part (SPI-1200): `browser`. The 2026 `input_required` shape and its
// retry; the 45 s hold answering `applied`, `declined` and `waiting`; the 2025-11-25 page elicitation on the call's
// stream, a late `decline` withdrawing; the link-in-result fallback for every client that declared no page elicitation;
// the signed `requestState` and elicitation id refused when they are not this call's. `native` and `model` are M5b's
// (SPI-1201): until then a request for them is answered as `browser`, as every fallback of D12 moves.
import { afterEach, describe, expect, it } from "vitest";

import { changesApiOf } from "../src/settings/server.ts";
import { signToken } from "../src/settings/tokens.ts";
import { ASKED, BOTH, bodyOf, endpointOf, initialize, KEY, legacy, modern, post, structuredOf, SUB } from "./settingsEndpointFixture.ts";
import { NOW, PANEL, settingsFixture, type SettingsFixture } from "./settingsFixture.ts";

let fixture: SettingsFixture | undefined;
const world = () => {
  fixture = settingsFixture();
  return fixture;
};
afterEach(() => fixture?.dispose());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pageAnswer = (f: SettingsFixture, id: string, action: "approve" | "decline", subject = SUB) => changesApiOf(f.deps).answer(id, { answerer: { kind: "owner", subject }, action });

/** The one open change, and its page's URL. */
const openChange = (f: SettingsFixture) => {
  const [record] = f.deps.changes.open();
  if (record === undefined) throw new Error("no open change");
  return { record, url: `${PANEL}/changes/${record.id}` };
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
    await sleep(20);
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
  const setup = async (options: { readonly holdMs?: number } = {}) => {
    const f = world();
    const endpoint = endpointOf(f, { holdMs: options.holdMs ?? 80, beatMs: 30 });
    const { session } = await initialize(endpoint, "2025-11-25", BOTH);
    return { f, endpoint, session };
  };

  it("writes elicitation/create (url, message, elicitationId) and then the call's result when the page approves", async () => {
    const { f, endpoint, session } = await setup({ holdMs: 2000 });
    const response = await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session, id: 7 }));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await sleep(20);
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
    const { f, endpoint, session } = await setup({ holdMs: 2000 });
    const response = await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session }));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await sleep(20);
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
    await sleep(5);
    expect(open).toBe(0);
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

  it("absent elicitation_mode is browser", async () => {
    const f = world();
    await endpointOf(f)(askedCall());
    expect(openChange(f).record.mode).toBe("browser");
  });

  it.each(["native", "model"])("M5a: elicitation_mode=%s is answered as browser, and says so", async (mode) => {
    const f = world();
    const endpoint = endpointOf(f);
    const tools = (await bodyOf(await endpoint(modern("tools/list", {}, { query: `?elicitation_mode=${mode}` })))).result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).not.toContain("resume");
    const first = await bodyOf(await endpoint(askedCall({ query: `?elicitation_mode=${mode}`, capabilities: { elicitation: { form: {} } } })));
    expect(openChange(f).record.mode).toBe("browser");
    expect(first.result).toMatchObject({ structuredContent: { status: "waiting" } });
    expect(JSON.stringify(first.result?.content)).toContain(`answers elicitation_mode=${mode} as browser`);
    expect(first.result?.structuredContent).not.toHaveProperty("requestId");
  });

  it("a change that needs the page is answered there like any other in browser", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const add = { expectedRevision: 0, change: { op: "add", server: "notes", url: "https://notes.example/mcp?key=secret", auth: { kind: "header", header: "X-Key" } } };
    const body = await bodyOf(await endpoint(modern("tools/call", { name: "change_mcp", arguments: add })));
    expect(body.result?.resultType).toBe("input_required");
    expect(openChange(f).record.needsPage).toBe("secret");
    expect(JSON.stringify(body)).not.toContain("key=secret");
  });
});
