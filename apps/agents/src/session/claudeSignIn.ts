// A Claude sign-in's request shape on the model relay (SPI-1171). A Session's pi-ai gives a Claude subscription's token
// Claude Code's shape itself (`isOAuthToken`); a CLI on the relay sends an API key's shape with its model handle, so the
// relay adds what pi-ai would (`@t3flare/models/claudeOAuth`, pinned to pi-ai's wire by claudeSignInShape.test.ts):
// - Claude Code's betas first, then the CLI's own (`anthropic-beta`), and pi-ai's Claude Code identity headers;
// - the identity as the system's first block, unless a block already opens with it (Claude Code's own requests carry
//   it among their blocks, and pass as they are: SPI-1161 Q4). Anthropic refuses a subscription token's request without it
//   (a disguised 429, SPI-1161 Q4).
// The bearer is the Environment's (`credentialHeaderFor`). Tool names stay the CLI's: pi-ai's Claude Code casing would
// have to be mapped back in the answer's stream, which the relay passes through unchanged.
import { CLAUDE_CODE_IDENTITY, CLAUDE_OAUTH_BETAS, CLAUDE_OAUTH_HEADERS } from "@t3flare/models/claudeOAuth";
import { isRecord } from "@t3flare/models/endpoints";

/** The headers a Claude sign-in's request takes on the relay: Claude Code's betas before the CLI's, and pi-ai's headers. */
export const claudeRelayHeaders = (_body: unknown, incoming: Headers): Record<string, string> => {
  const own = (incoming.get("anthropic-beta") ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter((beta) => beta !== "");
  return { ...CLAUDE_OAUTH_HEADERS, "anthropic-beta": [...new Set([...CLAUDE_OAUTH_BETAS, ...own])].join(",") };
};

const opensWithIdentity = (text: unknown): boolean => typeof text === "string" && text.startsWith(CLAUDE_CODE_IDENTITY);

/** A Messages body with Claude Code's identity as its system's first block, unless a block already opens with it. */
export const claudeRelayPayload = (body: unknown): unknown => {
  if (!isRecord(body)) return body;
  const identity = { type: "text", text: CLAUDE_CODE_IDENTITY };
  const { system } = body;
  if (system === undefined || system === null || system === "") return { ...body, system: [identity] };
  if (typeof system === "string") return opensWithIdentity(system) ? body : { ...body, system: [identity, { type: "text", text: system }] };
  if (!Array.isArray(system)) return body;
  if (system.some((block: unknown) => isRecord(block) && opensWithIdentity(block.text))) return body;
  return { ...body, system: [identity, ...system] };
};
