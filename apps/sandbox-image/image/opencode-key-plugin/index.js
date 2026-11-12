// OpenCode V2 server plugin (plan §4.2 (a), changelog F6): asks the key helper once at load, with the nonce it then
// removes from the process environment, and sets the key as a request header on the `t3flare` provider only.
import { execFileSync } from "node:child_process";

const HELPER = "/opt/t3flare/bin/t3flare-model-key";

export default {
  id: "t3flare.key",
  async setup(ctx) {
    const nonce = process.env.T3FLARE_MODEL_KEY_NONCE ?? "";
    delete process.env.T3FLARE_MODEL_KEY_NONCE;
    const key = execFileSync(HELPER, ["opencode"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", T3FLARE_MODEL_KEY_NONCE: nonce },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    })
      .toString()
      .trim();
    await ctx.provider.transform((editor) => {
      editor.update("t3flare", (provider) => {
        provider.headers = { ...provider.headers, "x-api-key": key };
      });
    });
  },
};
