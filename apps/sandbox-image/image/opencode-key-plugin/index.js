// OpenCode V2 server plugin (plan §4.2 (a), changelog F6): sets the key OpenCode's providers send, from what the
// process was started with, after removing it from the process environment so OpenCode's shells, MCP servers and other
// children do not inherit it. Two modes, by what the Workspace DO gave the process:
// - SPI-1169, the model relay: the process's model handle (T3FLARE_MODEL_HANDLE) is the API key of each Model endpoint
//   provider (`t3flare-endpoint-<id>`) of this process's system configuration (the profile's copy in its home) whose
//   base URL is the relay's URL for that endpoint; each provider package sends it in its own API's key header. No helper
//   is asked: a handle does not rotate while the process lives (SPI-1045's re-ask is not needed).
// - Otherwise the Model proxy: asks the key helper once with the nonce and sets the key on the `t3flare` provider only.
// The providers are patched by id: OpenCode adds the configured ones after a plugin's transform runs, so the patch
// names them (from the configuration file), and it applies when they are added.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const HELPER = "/opt/t3flare/bin/t3flare-model-key";
const RELAY = "http://computer.internal/t3flare/model/";
const ENDPOINT_PROVIDER = "t3flare-endpoint-";
const ENDPOINT_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** The path each provider package's base URL takes beyond the relay's per-endpoint URL (`acpProfiles.ts` `OPENCODE_PACKAGES`). */
const PACKAGE_PATHS = {
  "@opencode/ai/providers/anthropic-compatible": "/v1",
  "@opencode/ai/providers/openai-compatible-responses": "",
  "@opencode/ai/providers/openai-compatible": "",
};

// Read once, when OpenCode imports the plugin (a module runs once per process; `setup` may run for each location), and
// deleted from the environment at once.
const NONCE = process.env.T3FLARE_MODEL_KEY_NONCE ?? "";
const HANDLE = process.env.T3FLARE_MODEL_HANDLE ?? "";
delete process.env.T3FLARE_MODEL_KEY_NONCE;
delete process.env.T3FLARE_MODEL_HANDLE;
let proxyKey;

/** The endpoint providers of this process's configuration that are at the relay: the only ones given the handle. */
const relayProviders = () => {
  let providers = {};
  try {
    providers = JSON.parse(readFileSync(`/var/lib/t3flare/cli/${process.env.T3FLARE_EXEC}/opencode.json`, "utf8")).providers ?? {};
  } catch {
    return [];
  }
  return Object.entries(providers).flatMap(([id, provider]) => {
    if (!id.startsWith(ENDPOINT_PROVIDER)) return [];
    const endpoint = id.slice(ENDPOINT_PROVIDER.length);
    const path = PACKAGE_PATHS[provider?.package];
    return ENDPOINT_ID.test(endpoint) && path !== undefined && provider?.settings?.baseURL === `${RELAY}${endpoint}${path}` ? [id] : [];
  });
};

export default {
  id: "t3flare.key",
  async setup(ctx) {
    if (HANDLE !== "") {
      const ids = relayProviders();
      await ctx.provider.transform((editor) => {
        for (const id of ids) {
          editor.update(id, (provider) => {
            provider.settings = { ...provider.settings, apiKey: HANDLE };
          });
        }
      });
      return;
    }
    proxyKey ??= execFileSync(HELPER, ["opencode"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", T3FLARE_MODEL_KEY_NONCE: NONCE },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    })
      .toString()
      .trim();
    const key = proxyKey;
    await ctx.provider.transform((editor) => {
      editor.update("t3flare", (provider) => {
        provider.headers = { ...provider.headers, "x-api-key": key };
      });
    });
  },
};
