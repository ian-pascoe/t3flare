// A fake of GitHub's device flow and Copilot token endpoint (SPI-1166), as pi-ai 1.5.0's Copilot sign-in uses them and
// GitHub documents the device flow (docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
// #device-flow): the device code (`device_code`, `user_code` as `XXXX-XXXX`, `verification_uri`, `expires_in` 900,
// `interval` 5), the poll answered 200 with `authorization_pending` / `slow_down` (with its new `interval`) /
// `expired_token` / `access_denied` until the owner approves at the device page; then the GitHub token, exchanged for a
// Copilot token (`token` holding `proxy-ep=…`, `expires_at` in epoch seconds) with the bearer and the editor headers.
// GitHub's API errors are `{ message, documentation_url }`. No revocation (this client has no secret). It records every
// request, so a test can check what was sent and that no token leaks elsewhere.
import { COPILOT_CLIENT_ID, COPILOT_HEADERS, COPILOT_TOKEN_URL, DEVICE_GRANT_TYPE, GITHUB_ACCESS_TOKEN_URL, GITHUB_DEVICE_CODE_URL } from "@t3flare/models/copilotOAuth";

export interface FakeCopilotOptions {
  /** The device code request answers this status. */
  startStatus?: number;
  /** The poll answers `slow_down` once, with this new interval (seconds; none: without one). */
  slowDown?: { readonly interval?: number } | undefined;
  /** The owner declined at GitHub. */
  denied?: boolean;
  /** The device code lapsed at GitHub. */
  expired?: boolean;
  /** Copilot token requests answer this status, with this JSON body (none: an HTML page) and these headers. */
  copilotStatus?: number | undefined;
  copilotBody?: unknown;
  copilotHeaders?: Record<string, string>;
  /** The Copilot token's `proxy-ep` host (none: no `proxy-ep` field). */
  proxyHost?: string | null;
  /** How long each Copilot token lasts (s; GitHub's: about 30 minutes). */
  copilotLife?: number;
  /** Held open until released, and signalled on arrival. */
  copilotGate?: Promise<void> | undefined;
  onCopilot?: (() => void) | undefined;
  /** Polls are held open until released, and signalled on arrival. */
  pollGate?: Promise<void> | undefined;
  onPoll?: (() => void) | undefined;
  /** The device code answer's fields, replaced (a test of what the Environment refuses). */
  deviceAnswer?: Record<string, unknown>;
  /** Every request fails at the network. */
  down?: boolean;
}

export interface FakeCopilot {
  readonly fetch: typeof fetch;
  readonly options: FakeCopilotOptions;
  /** The owner enters `userCode` at GitHub's device page and approves. */
  approve(userCode: string): void;
  readonly requests: Array<{ readonly url: string; readonly method: string; readonly headers: Record<string, string>; readonly body: string; readonly redirect: RequestRedirect | undefined; readonly signal: boolean }>;
  /** Every token it issued (GitHub's and Copilot's), for leak scans. */
  readonly issued: Array<string>;
  readonly githubTokens: Array<string>;
  readonly copilotTokens: Array<string>;
  /** Everything secret it made: tokens and device codes. */
  secrets(): ReadonlyArray<string>;
  readonly counts: { deviceCodes: number; polls: number; copilotTokens: number; other: number };
  /** The clock it answers by (ms), for `expires_at`. */
  now: () => number;
}

export const fakeGitHubCopilot = (options: FakeCopilotOptions = {}, now: () => number = Date.now): FakeCopilot => {
  const devices = new Map<string, { readonly userCode: string; approved: boolean; used: boolean }>();
  const githubTokens: Array<string> = [];
  const copilotTokens: Array<string> = [];
  const issued: Array<string> = [];
  const requests: FakeCopilot["requests"] = [];
  const counts = { deviceCodes: 0, polls: 0, copilotTokens: 0, other: 0 };
  let serial = 0;
  const next = (prefix: string) => `${prefix}${(serial += 1)}${crypto.randomUUID().replace(/-/g, "")}`;
  const fake: FakeCopilot = {
    options,
    requests,
    issued,
    githubTokens,
    copilotTokens,
    counts,
    now,
    secrets: () => [...issued, ...devices.keys()],
    approve: (userCode) => {
      const device = [...devices.values()].find((entry) => entry.userCode === userCode);
      if (device === undefined) throw new Error(`no device code shows ${userCode}`);
      device.approved = true;
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      requests.push({ url, method, headers, body, redirect: init?.redirect, signal: init?.signal instanceof AbortSignal });
      if (options.down === true) throw new TypeError("fetch failed");
      const form = new URLSearchParams(body);
      if (url === GITHUB_DEVICE_CODE_URL && method === "POST") {
        counts.deviceCodes += 1;
        if (options.startStatus !== undefined) return new Response("<html>trouble</html>", { status: options.startStatus });
        if (form.get("client_id") !== COPILOT_CLIENT_ID || form.get("scope") !== "read:user") return Response.json({ error: "incorrect_client_credentials" });
        const deviceCode = next("dc_");
        const userCode = `${String(serial).padStart(4, "0").slice(-4)}-${crypto.randomUUID().slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, "Q")}`;
        devices.set(deviceCode, { userCode, approved: false, used: false });
        return Response.json({ device_code: deviceCode, user_code: userCode, verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5, ...options.deviceAnswer });
      }
      if (url === GITHUB_ACCESS_TOKEN_URL && method === "POST") {
        counts.polls += 1;
        options.onPoll?.();
        await options.pollGate;
        if (form.get("client_id") !== COPILOT_CLIENT_ID || form.get("grant_type") !== DEVICE_GRANT_TYPE) return Response.json({ error: "unsupported_grant_type" });
        const device = devices.get(form.get("device_code") ?? "");
        if (device === undefined || device.used) return Response.json({ error: "incorrect_device_code" });
        if (options.expired === true) return Response.json({ error: "expired_token", error_description: "This 'device_code' has expired." });
        if (options.denied === true) return Response.json({ error: "access_denied" });
        if (options.slowDown !== undefined) {
          const slow = options.slowDown;
          options.slowDown = undefined;
          return Response.json({ error: "slow_down", ...(slow.interval === undefined ? {} : { interval: slow.interval }) });
        }
        if (!device.approved) return Response.json({ error: "authorization_pending", error_description: "The authorization request is still pending." });
        device.used = true;
        const token = next("ghu_");
        githubTokens.push(token);
        issued.push(token);
        return Response.json({ access_token: token, token_type: "bearer", scope: "" });
      }
      if (url === COPILOT_TOKEN_URL && method === "GET") {
        counts.copilotTokens += 1;
        options.onCopilot?.();
        await options.copilotGate;
        if (options.copilotStatus !== undefined) {
          const extra = options.copilotHeaders ?? {};
          if (options.copilotBody === undefined) return new Response("<html>edge trouble</html>", { status: options.copilotStatus, headers: { "content-type": "text/html", ...extra } });
          return Response.json(options.copilotBody, { status: options.copilotStatus, headers: extra });
        }
        const bearer = headers.authorization?.replace(/^Bearer /, "");
        if (bearer === undefined || !githubTokens.includes(bearer)) return Response.json({ message: "Bad credentials", documentation_url: "https://docs.github.com/rest" }, { status: 401 });
        for (const [name, value] of Object.entries(COPILOT_HEADERS)) if (headers[name.toLowerCase()] !== value) return Response.json({ message: `missing ${name}` }, { status: 400 });
        const life = options.copilotLife ?? 1_800;
        const expiresAt = Math.floor(now() / 1000) + life;
        const proxy = options.proxyHost === undefined ? "proxy.individual.githubcopilot.com" : options.proxyHost;
        const token = `tid=${next("t")};exp=${expiresAt};sku=copilot_pro;${proxy === null ? "" : `proxy-ep=${proxy};`}8kp=1:${next("sig")}`;
        copilotTokens.push(token);
        issued.push(token);
        return Response.json({ token, expires_at: expiresAt, refresh_in: life - 300, endpoints: { api: "https://api.individual.githubcopilot.com" } });
      }
      counts.other += 1;
      return Response.json({ message: "Not Found" }, { status: 404 });
    }) as typeof fetch,
  };
  return fake;
};
