// SPI-1169: the image's OpenCode key plugin's guard (`apps/sandbox-image/image/opencode-key-plugin/relay.js`): which
// providers it treats as the relay's, the only requests the handle goes into, where it reads the handle, and its
// constants against their TypeScript sources (the plugin is plain JavaScript in the image, so they are restated there).
import { ENDPOINT_ID as TS_ENDPOINT_ID } from "@t3flare/models/endpoints";
import { endpointProviderId, modelRelayUrl } from "@t3flare/models/relay";
import { HANDLE as TS_HANDLE } from "@t3flare/workspace-client";
import { describe, expect, it } from "vitest";

import { OPENCODE_HANDLE_HOLDERS, OPENCODE_PACKAGES, opencodeConfig } from "../src/agents/acpProfiles.ts";
import { ENDPOINT_ID, ENDPOINT_PROVIDER, HANDLE, HOLDER_CMDLINE, handleFrom, PACKAGE_PATHS, PLACEHOLDER, putHandle, RELAY, relayProviders } from "../../sandbox-image/image/opencode-key-plugin/relay.js";

const handle = "a".repeat(64);
const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text" as const], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false });
/** The profile's own configuration for three endpoints, one per API. */
const config = opencodeConfig({
  kind: "relay",
  relay: {
    endpoints: [
      { id: "comm", label: "C", api: "anthropic-messages", models: [model("m")] },
      { id: "oai", label: "O", api: "openai-completions", models: [model("m")] },
      { id: "resp", label: "R", api: "openai-responses", models: [model("m")] },
    ],
    model: "comm/m",
    smallModel: "comm/m",
  },
}) as unknown as { providers: Record<string, Record<string, unknown>> };
const withProvider = (id: string, provider: Record<string, unknown>) => ({ providers: { ...config.providers, [id]: provider } });
const comm = config.providers["t3flare-endpoint-comm"]!;

describe("the key plugin's providers", () => {
  it("takes the profile's endpoint providers, each with its endpoint", () => {
    expect(relayProviders(config)).toEqual([
      { providerID: "t3flare-endpoint-comm", endpoint: "comm" },
      { providerID: "t3flare-endpoint-oai", endpoint: "oai" },
      { providerID: "t3flare-endpoint-resp", endpoint: "resp" },
    ]);
    expect(relayProviders(undefined)).toEqual([]);
    expect(relayProviders({ providers: null })).toEqual([]);
  });

  it("refuses a provider whose base URL is not the relay's URL for its endpoint", () => {
    for (const baseURL of ["https://evil.example/v1", "http://computer.internal/t3flare/model/oai/v1", "http://computer.internal/t3flare/model/comm", "http://computer.internal/t3flare/model/comm/v1/", undefined]) {
      expect(relayProviders(withProvider("t3flare-endpoint-comm", { ...comm, settings: { baseURL } })).map((entry) => entry.endpoint), String(baseURL)).toEqual(["oai", "resp"]);
    }
  });

  it("refuses a provider whose package is not one of the three, whatever its base URL", () => {
    for (const pkg of ["@opencode/ai/providers/openai", "@opencode/ai/providers/anthropic", "toString", undefined]) {
      for (const baseURL of [`${RELAY}comm`, `${RELAY}comm/v1`, `${RELAY}comm${String(undefined)}`]) {
        expect(relayProviders(withProvider("t3flare-endpoint-comm", { ...comm, package: pkg, settings: { baseURL } })).map((entry) => entry.endpoint), `${String(pkg)} ${baseURL}`).toEqual(["oai", "resp"]);
      }
    }
  });

  it("refuses a provider whose id is not an endpoint provider's, or names no endpoint id, even at its own relay URL", () => {
    const ids = ["openai", "t3flare", "t3flare-endpoint-", "t3flare-endpoint-Evil", "t3flare-endpoint-a/b", "t3flare-endpoint-../x", `${"x".repeat(ENDPOINT_PROVIDER.length)}evil`];
    for (const id of ids) {
      // The base URL the id would have if it were an endpoint provider's.
      const evil = { ...comm, settings: { baseURL: `${RELAY}${id.slice(ENDPOINT_PROVIDER.length)}/v1` } };
      expect(relayProviders(withProvider(id, evil)).map((entry) => entry.providerID), id).toEqual(["t3flare-endpoint-comm", "t3flare-endpoint-oai", "t3flare-endpoint-resp"]);
    }
  });
});

describe("the key plugin's requests", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);

  it("puts the handle in the key header of a request at the relay for the provider's endpoint", () => {
    const anthropic = headers({ "x-api-key": PLACEHOLDER });
    expect(putHandle(anthropic, "http://computer.internal/t3flare/model/comm/v1/messages", "comm", handle)).toBe(true);
    expect(anthropic.get("x-api-key")).toBe(handle);
    const openai = headers({ authorization: `Bearer ${PLACEHOLDER}` });
    expect(putHandle(openai, "http://computer.internal/t3flare/model/oai/chat/completions", "oai", handle)).toBe(true);
    expect(openai.get("authorization")).toBe(`Bearer ${handle}`);
  });

  it("leaves every other request with the placeholder: another host, another endpoint, a path that leaves the endpoint", () => {
    for (const url of [
      "http://evil.example/t3flare/model/comm/v1/messages",
      "https://computer.internal/t3flare/model/comm/v1/messages",
      "http://computer.internal:8080/t3flare/model/comm/v1/messages",
      "http://user:pw@computer.internal/t3flare/model/comm/v1/messages",
      "http://computer.internal/t3flare/model/comm2/v1/messages",
      "http://computer.internal/t3flare/model/oai/chat/completions",
      "http://computer.internal/t3flare/model/comm/../oai/chat/completions",
      "http://computer.internal/evil/t3flare/model/comm/v1/messages",
      "http://computer.internal/t3flare/model/comm",
      "not a url",
    ]) {
      const sent = headers({ "x-api-key": PLACEHOLDER });
      expect(putHandle(sent, url, "comm", handle), url).toBe(false);
      expect(sent.get("x-api-key"), url).toBe(PLACEHOLDER);
    }
    // Not a handle, or a bad endpoint id: nothing.
    expect(putHandle(headers({ "x-api-key": PLACEHOLDER }), "http://computer.internal/t3flare/model/comm/v1/messages", "comm", "nope")).toBe(false);
    expect(putHandle(headers({ "x-api-key": PLACEHOLDER }), "http://computer.internal/t3flare/model/comm/v1/messages", "../comm", handle)).toBe(false);
  });
});

describe("where the key plugin reads the handle", () => {
  const environ = (entries: ReadonlyArray<string>) => `${entries.join("\0")}\0`;

  it("from the launch chain's setsid of this process only", () => {
    expect(handleFrom(HOLDER_CMDLINE, environ(["T3FLARE_EXEC=proc-1", `T3FLARE_MODEL_HANDLE=${handle}`]), "proc-1")).toBe(handle);
    // Another process's setsid, another command, no marker, no handle or a malformed one.
    expect(handleFrom(HOLDER_CMDLINE, environ(["T3FLARE_EXEC=proc-2", `T3FLARE_MODEL_HANDLE=${handle}`]), "proc-1")).toBe("");
    expect(handleFrom("setsid\0--wait\0/opt/t3flare/bin/claude-agent-acp\0", environ(["T3FLARE_EXEC=proc-1", `T3FLARE_MODEL_HANDLE=${handle}`]), "proc-1")).toBe("");
    expect(handleFrom(HOLDER_CMDLINE, environ(["T3FLARE_EXEC=proc-1", `T3FLARE_MODEL_HANDLE=${handle}`]), undefined)).toBe("");
    expect(handleFrom(HOLDER_CMDLINE, environ(["T3FLARE_EXEC=proc-1"]), "proc-1")).toBe("");
    expect(handleFrom(HOLDER_CMDLINE, environ(["T3FLARE_EXEC=proc-1", "T3FLARE_MODEL_HANDLE=short"]), "proc-1")).toBe("");
  });

  it("is the holder the stage script and test:docker expect", () => {
    expect(OPENCODE_HANDLE_HOLDERS).toEqual([HOLDER_CMDLINE.split("\0").filter((word) => word !== "").join(" ")]);
  });
});

describe("the key plugin's constants against their TypeScript sources", () => {
  it("has the relay's URL, the provider prefix, the endpoint id and handle patterns, and the packages' paths", () => {
    expect(RELAY).toBe(modelRelayUrl(""));
    expect(ENDPOINT_PROVIDER).toBe(endpointProviderId(""));
    expect(ENDPOINT_ID.source).toBe(TS_ENDPOINT_ID.source);
    expect(HANDLE.source).toBe(TS_HANDLE.source);
    expect(PACKAGE_PATHS).toEqual(Object.fromEntries(Object.values(OPENCODE_PACKAGES).map((wiring) => [wiring!.package, wiring!.path])));
  });
});
