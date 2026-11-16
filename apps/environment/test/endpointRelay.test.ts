// The model relay's target (SPI-1167): what the Environment answers a Workspace DO for an endpoint, from the store's
// `resolve`: the endpoint's base URL, its own headers and its key in the header its API takes, or why not.
import { relayTargetOf } from "@t3flare/models/relay";
import { describe, expect, it } from "vitest";

import { sealedStore } from "../src/credentials/sealed.ts";
import type { BrokerAccess } from "../src/credentials/broker.ts";
import { endpointStore } from "../src/endpoints/store.ts";

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

/** A stand-in Credential broker: each `access` answers the next of `answers` (the last one again once they run out). */
const broker = (answers: ReadonlyArray<BrokerAccess>) => {
  const asked: Array<string> = [];
  return {
    asked,
    access: (endpointId: string): Promise<BrokerAccess> => {
      asked.push(endpointId);
      return Promise.resolve(answers[Math.min(asked.length - 1, answers.length - 1)]!);
    },
  };
};

const setup = (credentialsKey: string | undefined = "c".repeat(64), signIns?: ReturnType<typeof broker>) => {
  const kv = memory();
  return { kv, store: endpointStore(kv, sealedStore(kv, credentialsKey, () => 5_000), signIns) };
};

const target = async (store: ReturnType<typeof setup>["store"], id: string) => relayTargetOf(await store.resolve(id), id);

const endpoint = (extra: Record<string, unknown>) => ({ id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key", models: ["gpt-5-mini"], ...extra });

describe("the model relay's target", () => {
  it("is the endpoint's base URL and headers, with its key as a bearer for the OpenAI APIs", async () => {
    const { store } = setup();
    await store.save(endpoint({ headers: { "X-Org": "acme" } }), { apiKey: "sk-relay-1" });
    expect(await target(store, "openai")).toEqual({
      ok: true,
      api: "openai-responses",
      auth: "api-key",
      baseUrl: "https://api.openai.com/v1",
      headers: { "X-Org": "acme", authorization: "Bearer sk-relay-1" },
      key: "sk-relay-1",
    });
  });

  it("puts the key in the header each API takes", async () => {
    const { store } = setup();
    await store.save(endpoint({ id: "claude", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", models: ["claude-haiku-5-5"] }), { apiKey: "sk-ant-1" });
    await store.save(endpoint({ id: "gemini", api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: ["gemini-3-flash"] }), { apiKey: "g-key-1" });
    expect(await target(store, "claude")).toMatchObject({ ok: true, headers: { "x-api-key": "sk-ant-1" }, key: "sk-ant-1" });
    expect(await target(store, "gemini")).toMatchObject({ ok: true, headers: { "x-goog-api-key": "g-key-1" }, key: "g-key-1" });
  });

  it("adds no credential for an endpoint with no auth", async () => {
    const { store } = setup();
    await store.save(endpoint({ id: "local", auth: "none", baseUrl: "https://models.example.com/v1" }), {});
    expect(await target(store, "local")).toEqual({ ok: true, api: "openai-responses", auth: "none", baseUrl: "https://models.example.com/v1", headers: {}, key: null });
  });

  describe("of a sign-in (SPI-1171)", () => {
    const chatgpt = { id: "chatgpt", label: "ChatGPT", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "chatgpt", models: ["gpt-5-mini"] };
    const claude = { id: "claude", label: "Claude", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: "claude", models: ["claude-haiku-5-5"] };
    const copilot = { id: "copilot", label: "GitHub Copilot", api: "openai-responses", baseUrl: "https://api.individual.githubcopilot.com", auth: "copilot", models: ["gpt-6.1-sol"] };

    it("is the sign-in's API and base URL with the broker's access token as a bearer, asked for at every request", async () => {
      const signIns = broker([
        { ok: true, accessToken: "oai-access-1", expiresAt: 1 },
        // Renewed by the broker between two requests (a mid-thread refresh): the next target carries the new token.
        { ok: true, accessToken: "oai-access-2", expiresAt: 2 },
      ]);
      const { store } = setup(undefined, signIns);
      await store.save(chatgpt, {});
      expect(await target(store, "chatgpt")).toEqual({ ok: true, api: "openai-responses", auth: "chatgpt", baseUrl: "https://api.openai.com/v1", headers: { authorization: "Bearer oai-access-1" }, key: "oai-access-1" });
      expect(await target(store, "chatgpt")).toMatchObject({ ok: true, headers: { authorization: "Bearer oai-access-2" }, key: "oai-access-2" });
      expect(signIns.asked).toEqual(["chatgpt", "chatgpt"]);
    });

    it("sends a Claude sign-in's token as a bearer, never as Anthropic's API key header", async () => {
      const { store } = setup(undefined, broker([{ ok: true, accessToken: "sk-ant-oat01-relay", expiresAt: 1 }]));
      await store.save(claude, {});
      const answer = await target(store, "claude");
      expect(answer).toEqual({ ok: true, api: "anthropic-messages", auth: "claude", baseUrl: "https://api.anthropic.com", headers: { authorization: "Bearer sk-ant-oat01-relay" }, key: "sk-ant-oat01-relay" });
    });

    it("takes a Copilot token's base URL and editor headers only where its kind allows that host", async () => {
      const editor = { "Editor-Version": "vscode/1.107.0" };
      const { store } = setup(undefined, broker([
        { ok: true, accessToken: "tid=copilot-1", expiresAt: 1, baseUrl: "https://api.business.githubcopilot.com", headers: editor },
        { ok: true, accessToken: "tid=copilot-2", expiresAt: 1, baseUrl: "https://evil.example", headers: editor },
      ]));
      await store.save(copilot, {});
      expect(await target(store, "copilot")).toEqual({
        ok: true,
        api: "openai-responses",
        auth: "copilot",
        baseUrl: "https://api.business.githubcopilot.com",
        headers: { ...editor, authorization: "Bearer tid=copilot-1" },
        key: "tid=copilot-1",
      });
      // A host outside githubcopilot.com: the endpoint's stand-in, without the credential's headers (the Session's rule).
      expect(await target(store, "copilot")).toMatchObject({ ok: true, baseUrl: "https://api.individual.githubcopilot.com", headers: { authorization: "Bearer tid=copilot-2" } });
    });

    it("refuses a signed-out sign-in (401) naming it, and a passing failure (503) with when to try again", async () => {
      const { store } = setup(undefined, broker([
        { ok: false, signedOut: true, problem: "OpenAI refused the renewal (invalid_grant): it is signed out" },
        { ok: false, signedOut: false, problem: "its sign-in cannot be renewed yet", retryAt: 90_000 },
      ]));
      await store.save(chatgpt, {});
      expect(await target(store, "chatgpt")).toEqual({
        ok: false,
        status: 401,
        message: expect.stringMatching(/chatgpt.*sign/i),
        signIn: { api: "openai-responses", kind: "chatgpt", signedOut: true, problem: "OpenAI refused the renewal (invalid_grant): it is signed out" },
      });
      expect(await target(store, "chatgpt")).toMatchObject({ ok: false, status: 503, signIn: { kind: "chatgpt", signedOut: false, retryAt: 90_000 } });
    });

    it("refuses a sign-in in an Environment with no Credential broker as signed out", async () => {
      const { store } = setup();
      await store.save(claude, {});
      expect(await target(store, "claude")).toMatchObject({ ok: false, status: 401, signIn: { kind: "claude", signedOut: true } });
    });
  });

  it("refuses an endpoint that is gone (404) or whose key no longer opens (503), naming no key", async () => {
    const { kv, store } = setup();
    expect(await target(store, "openai")).toMatchObject({ ok: false, status: 404 });
    await store.save(endpoint({}), { apiKey: "sk-relay-2" });
    // Another credentials key over the same storage: the sealed key is there but does not open.
    const other = endpointStore(kv, sealedStore(kv, "d".repeat(64), () => 6_000));
    const refused = await target(other, "openai");
    expect(refused).toMatchObject({ ok: false, status: 503 });
    expect(JSON.stringify(refused)).toContain("enter it again");
    expect(JSON.stringify(refused)).not.toContain("sk-relay-2");
    store.remove("openai");
    expect(await target(store, "openai")).toMatchObject({ ok: false, status: 404 });
  });
});
