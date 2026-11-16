// OpenCode V2 server plugin (plan §4.2 (a), changelog F6): the key OpenCode's providers send. Two modes:
// - SPI-1169, the model relay: each Model endpoint provider of the process's own configuration (`relay.js`
//   `relayProviders`) gets a placeholder API key, which the relay refuses; the process's model handle replaces it in a
//   request (OpenCode's `http.request` hook, after every setting was applied) only when the request's URL is at the
//   relay for that provider's endpoint (`putHandle`). So a repository's model-level `baseURL` or `package`, a model or
//   variant it adds, never sends the handle anywhere else. The handle is read from the start environment of the launch
//   chain's `setsid` (`handleFrom`): the launcher starts OpenCode without it, so OpenCode's own environment never holds
//   it and a repository's `{env:T3FLARE_MODEL_HANDLE}` finds nothing. No helper is asked: a handle does not rotate
//   while the process lives (SPI-1045's re-ask is not needed). No handle found: no key, failing closed.
// - Otherwise the Model proxy: asks the key helper once with the nonce and sets the key on the `t3flare` provider only.
// The nonce leaves this process's environment at import, before OpenCode starts anything from it. Providers are patched
// by id: OpenCode adds the configured ones after a plugin's transform runs, so the ids come from the configuration file.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { handleFrom, PLACEHOLDER, putHandle, relayProviders } from "./relay.js";

const HELPER = "/opt/t3flare/bin/t3flare-model-key";

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/** The handle from the nearest ancestor that is the launch chain's `setsid` (`opencode serve` ← `opencode acp` ← setsid). */
const ancestorHandle = () => {
  let pid = process.ppid;
  for (let depth = 0; depth < 4 && pid > 0; depth++) {
    const handle = handleFrom(read(`/proc/${pid}/cmdline`), read(`/proc/${pid}/environ`), process.env.T3FLARE_EXEC);
    if (handle !== "") return handle;
    const stat = read(`/proc/${pid}/stat`);
    pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  }
  return "";
};

// Once per process, at import.
const NONCE = process.env.T3FLARE_MODEL_KEY_NONCE ?? "";
delete process.env.T3FLARE_MODEL_KEY_NONCE;
delete process.env.T3FLARE_MODEL_HANDLE;
const PROVIDERS = (() => {
  try {
    return relayProviders(JSON.parse(read(`/var/lib/t3flare/cli/${process.env.T3FLARE_EXEC}/opencode.json`)));
  } catch {
    return [];
  }
})();
const HANDLE = PROVIDERS.length === 0 ? "" : ancestorHandle();
let proxyKey;

export default {
  id: "t3flare.key",
  async setup(ctx) {
    if (PROVIDERS.length > 0) {
      if (HANDLE === "") return;
      await ctx.provider.transform((editor) => {
        for (const { providerID } of PROVIDERS) {
          editor.update(providerID, (provider) => {
            provider.settings = { ...provider.settings, apiKey: PLACEHOLDER };
          });
        }
      });
      for (const { providerID, endpoint } of PROVIDERS) {
        await ctx.session.hook("http.request", (input) => void putHandle(input.request.headers, input.request.url, endpoint, HANDLE), { providerID });
      }
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
