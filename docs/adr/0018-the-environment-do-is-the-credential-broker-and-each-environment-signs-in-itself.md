# The Environment DO is the Credential broker, and each Environment signs in itself

Subscription logins carry rotating refresh tokens, which need a single writer. The Environment DO holds every Subscription credential and is the only process that refreshes; callers (intercept handlers, Session DOs) get access tokens only, cached until near expiry. t3 already ships this for ChatGPT (`CodexChatGptAuth.ts`, single-writer refresh in its secret store), so we extend it with a small broker service for other providers rather than adding a Credentials DO.

Each Environment signs in itself: a rotating credential is never copied from the laptop to the cloud, because two refreshers invalidate each other.

## Considered Options

- **A lease where one runner holds the real `auth.json`**: serializes work and puts a rotating token on Container disk. Kept only as the fallback for Codex if managed mode fails in the cloud.
