// SPI-1169: what the key plugin trusts on the model relay, pure. Tested in apps/environment/test/opencodeKeyPlugin.test.ts,
// which also checks these constants against their TypeScript sources (`@t3flare/models/relay`, `@t3flare/models/endpoints`,
// `@t3flare/workspace-client` and `apps/environment/src/agents/acpProfiles.ts` `OPENCODE_PACKAGES`).

/** The relay's origin and per-endpoint path prefix in the Container (`modelRelayUrl("")`). */
export const RELAY = "http://computer.internal/t3flare/model/";
/** An endpoint's OpenCode provider id prefix (`endpointProviderId("")`). */
export const ENDPOINT_PROVIDER = "t3flare-endpoint-";
/** An endpoint id (`ENDPOINT_ID`). */
export const ENDPOINT_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** A model handle (`HANDLE`). */
export const HANDLE = /^[0-9a-f]{64}$/;
/** Each provider package's path beyond the relay's per-endpoint URL (`OPENCODE_PACKAGES`). */
export const PACKAGE_PATHS = {
  "@opencode/ai/providers/anthropic-compatible": "/v1",
  "@opencode/ai/providers/openai-compatible-responses": "",
  "@opencode/ai/providers/openai-compatible": "",
};
/**
 * The API key OpenCode's endpoint providers are configured with: not a secret, and refused by the relay. The handle
 * replaces it in a request only when the request's URL is at the relay, for that provider's endpoint (`atRelay`).
 */
export const PLACEHOLDER = "t3flare-model-relay";

/**
 * The endpoint providers of a process's configuration (the profile's copy, parsed), with their endpoint ids: each
 * `t3flare-endpoint-<id>` provider whose package is one of the three and whose base URL is the relay's URL for `<id>`.
 */
export const relayProviders = (config) => {
  const providers = config?.providers;
  if (typeof providers !== "object" || providers === null) return [];
  return Object.entries(providers).flatMap(([providerID, provider]) => {
    if (!providerID.startsWith(ENDPOINT_PROVIDER)) return [];
    const endpoint = providerID.slice(ENDPOINT_PROVIDER.length);
    const path = Object.hasOwn(PACKAGE_PATHS, provider?.package) ? PACKAGE_PATHS[provider.package] : undefined;
    if (!ENDPOINT_ID.test(endpoint) || path === undefined) return [];
    return provider.settings?.baseURL === `${RELAY}${endpoint}${path}` ? [{ providerID, endpoint }] : [];
  });
};

/** Whether a request's URL (as OpenCode sends it, after every setting was applied) is at the relay, for `endpoint`. */
export const atRelay = (url, endpoint) => {
  if (!ENDPOINT_ID.test(endpoint)) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const relay = new URL(RELAY);
  return parsed.origin === relay.origin && parsed.username === "" && parsed.password === "" && parsed.pathname.startsWith(`${relay.pathname}${endpoint}/`);
};

/**
 * The handle in the key header the request's package sent (`x-api-key`, or `authorization: Bearer`), for a request at
 * the relay for `endpoint` only; any other request is left as it is (it carries the placeholder, or nothing).
 */
export const putHandle = (headers, url, endpoint, handle) => {
  if (!HANDLE.test(handle) || !atRelay(url, endpoint)) return false;
  let put = false;
  if (headers.has("x-api-key")) {
    headers.set("x-api-key", handle);
    put = true;
  }
  if (headers.has("authorization")) {
    headers.set("authorization", `Bearer ${handle}`);
    put = true;
  }
  return put;
};

/** The launch chain's process whose start environment holds the handle: `setsid --wait` of the image's launcher. */
export const HOLDER_CMDLINE = "setsid\0--wait\0/opt/t3flare/bin/opencode\0acp\0";

/**
 * The model handle from the holder's start environment (`environ`, NUL-separated), when that process is the launch
 * chain's (`cmdline`) and of this process (`T3FLARE_EXEC`, the process's marker); else the empty string.
 */
export const handleFrom = (cmdline, environ, exec) => {
  if (cmdline !== HOLDER_CMDLINE || typeof exec !== "string" || exec === "") return "";
  const entries = environ.split("\0");
  if (!entries.includes(`T3FLARE_EXEC=${exec}`)) return "";
  const entry = entries.find((line) => line.startsWith("T3FLARE_MODEL_HANDLE="));
  const handle = entry === undefined ? "" : entry.slice("T3FLARE_MODEL_HANDLE=".length);
  return HANDLE.test(handle) ? handle : "";
};
