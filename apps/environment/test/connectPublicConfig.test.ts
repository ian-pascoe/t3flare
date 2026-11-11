// Step 3+ (P1, review finding 7): T3 Connect's public values match what t3 ships, and t3's own config reads them.
// Run by the nightly bump (its test step), so a change upstream fails the bump instead of silently breaking the link.
import * as fs from "node:fs";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { cloudCliOAuthConfig, hasCloudPublicConfig, relayUrlConfig } from "t3/src/cloud/publicConfig.ts";

import { T3_CONNECT_PUBLIC_CONFIG } from "../src/t3/connectPublicConfig.ts";

const envExample = (): Record<string, string> => {
  const text = fs.readFileSync(path.join(import.meta.dirname, "../../../t3code/.env.example"), "utf8");
  return Object.fromEntries(
    text
      .split("\n")
      .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1]!, match[2]!.trim()]),
  );
};

describe("T3 Connect public config", () => {
  it("matches the values t3 ships in .env.example", () => {
    const env = envExample();
    expect({
      relayUrl: env.T3CODE_RELAY_URL,
      clerkPublishableKey: env.T3CODE_CLERK_PUBLISHABLE_KEY,
      clerkCliOAuthClientId: env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID,
    }).toEqual(T3_CONNECT_PUBLIC_CONFIG);
  });

  it("resolves through t3's own config with the build's defines", async () => {
    expect(hasCloudPublicConfig).toBe(true);
    expect(await Effect.runPromise(Effect.gen(function* () { return yield* relayUrlConfig; }))).toBe("https://relay.t3.codes");
    const oauth = await Effect.runPromise(Effect.gen(function* () { return yield* cloudCliOAuthConfig; }));
    expect(oauth.clientId).toBe("hzxSgY2cH10sDU2r");
    expect(oauth.deviceAuthorizationEndpoint).toBe("https://clerk.t3.codes/oauth/device_authorization");
    expect(oauth.tokenEndpoint).toBe("https://clerk.t3.codes/oauth/token");
  });
});
