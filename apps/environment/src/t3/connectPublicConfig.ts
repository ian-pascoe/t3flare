// T3 Connect's public values (step 3+, review finding 7): the relay, the Clerk instance and the CLI's OAuth client every
// official t3 build ships. They are public identifiers, not secrets (`t3code/.env.example`, "the same public identifiers
// baked into official release builds"), and account constants rather than per-release values. build.ts defines them
// as t3's `__T3CODE_BUILD_*` constants; `test/connectPublicConfig.test.ts` fails the bump when `.env.example` changes
// them. A change means prod's link was made against other values: sign in again (`scripts/connect.ts prod sign-in`).
export const T3_CONNECT_PUBLIC_CONFIG = {
  relayUrl: "https://relay.t3.codes",
  clerkPublishableKey: "pk_live_Y2xlcmsudDMuY29kZXMk",
  clerkCliOAuthClientId: "hzxSgY2cH10sDU2r",
} as const;

/** The defines t3's `cloud/publicConfig.ts` reads (`t3code/apps/server/vite.config.ts` sets the same names). */
export const T3_CONNECT_DEFINES = {
  __T3CODE_BUILD_RELAY_URL__: JSON.stringify(T3_CONNECT_PUBLIC_CONFIG.relayUrl),
  __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(T3_CONNECT_PUBLIC_CONFIG.clerkPublishableKey),
  __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: JSON.stringify(T3_CONNECT_PUBLIC_CONFIG.clerkCliOAuthClientId),
} as const;
