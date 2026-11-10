// @effect-diagnostics globalDate:off globalFetch:off
// The admin guard (ADR-0010): `/_t3flare/*` sits behind a Cloudflare Access application of its own, and
// the Worker does not trust that Access ran. It verifies `Cf-Access-Jwt-Assertion` itself (after
// cloudpid's apps/server/src/access.ts) and also requires the admin token, and fails closed: a Worker
// without its Access audience, team or admin token refuses every admin request.
//
// Admitted callers: the owner (an assertion with the owner's email and no `common_name`), and the stage's
// own Access service token (an assertion whose `common_name` is that token's client id), which the
// acceptance test and the bump job use.

/** The header Access adds to every request it admits. */
export const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";

export type Refusal =
  | "not_configured"
  | "missing"
  | "malformed"
  | "unsupported_algorithm"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "expired"
  | "not_yet_valid"
  | "wrong_audience"
  | "not_admitted"
  | "bad_admin_token"
  | "error";

export type Caller = { readonly kind: "owner" } | { readonly kind: "service-token" };

export type Verdict =
  | { readonly admitted: true; readonly caller: Caller }
  | { readonly admitted: false; readonly reason: Refusal };

const refuse = (reason: Refusal): Verdict => ({ admitted: false, reason });

/** What the guard is configured with: Worker vars and secrets set by alchemy.run.ts. */
export interface GuardConfig {
  /** `<team>.cloudflareaccess.com`: the issuer, and where the signing keys are. */
  readonly teamDomain: string | undefined;
  /** The `aud` of the stage's admin Access application. */
  readonly audience: string | undefined;
  readonly ownerEmail: string | undefined;
  /** The client id of the stage's Access service token, if it has one. */
  readonly serviceTokenClientId: string | undefined;
  readonly adminToken: string | undefined;
}

/** A team signing key, as WebCrypto imports it. */
export type TeamKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export type TeamKeyLookup = (kid: string) => Promise<TeamKey | undefined>;

const KEY_ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const NOT_BEFORE_LEEWAY_SECONDS = 30;
const decoder = new TextDecoder();

const base64UrlBytes = (segment: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) return undefined;
  const padded = segment.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

const jsonSegment = (segment: string): Record<string, unknown> | undefined => {
  const bytes = base64UrlBytes(segment);
  if (bytes === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** Constant-time comparison of two strings (their UTF-8 bytes). */
export const timingSafeEqual = (left: string, right: string): boolean => {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.byteLength ^ b.byteLength;
  for (let i = 0; i < Math.max(a.byteLength, b.byteLength); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

/** Verifies an Access assertion: signature, issuer, lifetime, audience, then who it is. Never trusts claims first. */
export const classifyAssertion = async (
  assertion: string | null | undefined,
  config: GuardConfig,
  keys: TeamKeyLookup,
  nowSeconds: number,
): Promise<Verdict> => {
  if (!config.teamDomain || !config.audience || !config.ownerEmail) return refuse("not_configured");
  if (!assertion) return refuse("missing");
  const parts = assertion.split(".");
  if (parts.length !== 3) return refuse("malformed");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = jsonSegment(encodedHeader);
  if (header === undefined) return refuse("malformed");
  // Access signs with RS256; `none` and HMAC are never verified.
  if (header.alg !== "RS256") return refuse("unsupported_algorithm");
  if (typeof header.kid !== "string") return refuse("unknown_key");
  const signature = base64UrlBytes(encodedSignature);
  if (signature === undefined) return refuse("malformed");
  const key = await keys(header.kid);
  if (key === undefined) return refuse("unknown_key");
  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  if (!(await crypto.subtle.verify(KEY_ALGORITHM, key, signature, signed))) return refuse("bad_signature");

  const claims = jsonSegment(encodedPayload);
  if (claims === undefined) return refuse("malformed");
  if (claims.iss !== `https://${config.teamDomain}`) return refuse("wrong_issuer");
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return refuse("expired");
  if (typeof claims.nbf === "number" && claims.nbf > nowSeconds + NOT_BEFORE_LEEWAY_SECONDS) return refuse("not_yet_valid");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.audience)) return refuse("wrong_audience");

  if (claims.common_name !== undefined) {
    // A service token's assertion: only the stage's own token is admitted.
    return config.serviceTokenClientId && claims.common_name === config.serviceTokenClientId
      ? { admitted: true, caller: { kind: "service-token" } }
      : refuse("not_admitted");
  }
  return typeof claims.email === "string" && claims.email.toLowerCase() === config.ownerEmail.toLowerCase()
    ? { admitted: true, caller: { kind: "owner" } }
    : refuse("not_admitted");
};

/** How long the team's keys are kept; Access rotates them about every six weeks. */
const KEYS_MAX_AGE_MS = 60 * 60 * 1000;
const UNKNOWN_KEY_COOLDOWN_MS = 60 * 1000;
const FAILED_READ_COOLDOWN_MS = 5 * 1000;

const importTeamKeys = async (body: string): Promise<Map<string, TeamKey>> => {
  const parsed = JSON.parse(body) as { keys?: Array<Record<string, unknown>> };
  const keys = new Map<string, TeamKey>();
  for (const jwk of parsed.keys ?? []) {
    if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    try {
      keys.set(
        jwk.kid,
        await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, KEY_ALGORITHM, false, ["verify"]),
      );
    } catch {
      // A key that cannot be imported finds nothing; the others still do.
    }
  }
  return keys;
};

/**
 * A key lookup over the team's `/cdn-cgi/access/certs`, kept for an hour per isolate. Keys that cannot be
 * read find nothing, so the guard refuses. Each lookup reads for itself: workerd forbids awaiting another
 * request's I/O.
 */
export const teamKeys = (load: () => Promise<string>, clock: () => number = Date.now): TeamKeyLookup => {
  let kept = new Map<string, TeamKey>();
  let keptAt: number | undefined;
  let attemptedAt: number | undefined;
  const fresh = () => keptAt !== undefined && clock() - keptAt < KEYS_MAX_AGE_MS;
  return async (kid) => {
    const key = fresh() ? kept.get(kid) : undefined;
    if (key !== undefined) return key;
    const cooldown = fresh() ? UNKNOWN_KEY_COOLDOWN_MS : FAILED_READ_COOLDOWN_MS;
    if (attemptedAt !== undefined && clock() - attemptedAt < cooldown) return undefined;
    try {
      kept = await importTeamKeys(await load());
      keptAt = clock();
    } catch {
      // Nothing newer was read.
    } finally {
      attemptedAt = clock();
    }
    return fresh() ? kept.get(kid) : undefined;
  };
};

export const loadTeamKeysFrom = (teamDomain: string) => async () => {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`The Access team's keys answered ${response.status}`);
  return response.text();
};

const bearer = (request: Request) => {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
};

/** The admin token alone: local workerd only, where no Access stands in front (worker.ts, local mode). */
export const verifyAdminToken = (request: Request, config: GuardConfig): Verdict =>
  config.adminToken && timingSafeEqual(bearer(request), config.adminToken)
    ? { admitted: true, caller: { kind: "owner" } }
    : refuse(config.adminToken ? "bad_admin_token" : "not_configured");

/** The whole admin check: the Access assertion, then the admin token. Never throws. */
export const verifyAdminRequest = async (
  request: Request,
  config: GuardConfig,
  keys: TeamKeyLookup,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<Verdict> => {
  try {
    if (!config.adminToken) return refuse("not_configured");
    const verdict = await classifyAssertion(request.headers.get(ACCESS_ASSERTION_HEADER), config, keys, nowSeconds);
    if (!verdict.admitted) return verdict;
    return timingSafeEqual(bearer(request), config.adminToken) ? verdict : refuse("bad_admin_token");
  } catch {
    return refuse("error");
  }
};
