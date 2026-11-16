// SPI-1172: error text is redacted before it reaches t3 or a log. One case per shape: vendor keys (Anthropic's, OpenAI's
// project and legacy keys, a masked echo, Google's), bearer tokens, JWT-shaped values, key headers and query parameters,
// and a value the caller knows (an endpoint's own key, whatever its shape).
import { REDACTED, redactSecrets } from "@t3flare/models/redact";
import { describe, expect, it } from "vitest";

// Made-up values of each shape: none is a real credential.
const ANTHROPIC_KEY = "sk-ant-api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVbNm-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AAAA";
const ANTHROPIC_OAUTH = "sk-ant-oat01-Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVbNmAbCdEfGh";
const OPENAI_PROJECT_KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKl";
const OPENAI_LEGACY_KEY = "sk-AbCdEfGhIjKlMnOpQrSt" + "T3BlbkFJ" + "AbCdEfGhIjKlMnOpQrSt";
const GOOGLE_KEY = "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q";
const JWT =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzEyMyIsImV4cCI6MTc5OTk5OTk5OX0.c2lnbmF0dXJlLW5vdC1yZWFsLWJ1dC1sb25nLWVub3VnaA";
const OPAQUE_TOKEN = "ac.1.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

describe("redactSecrets", () => {
  it("an Anthropic API key and a Claude Code OAuth token", () => {
    const out = redactSecrets(`invalid x-api-key: ${ANTHROPIC_KEY}; token ${ANTHROPIC_OAUTH} was revoked`);
    expect(out).not.toContain("sk-ant-api03-Zx9");
    expect(out).not.toContain("Qw8Er7Ty6Ui5");
    expect(out).toContain(REDACTED);
  });

  it("OpenAI project and legacy keys, and OpenAI's own masked echo of one", () => {
    const out = redactSecrets(
      JSON.stringify({ error: { message: `Incorrect API key provided: ${OPENAI_PROJECT_KEY}. Also ${OPENAI_LEGACY_KEY}. Masked: sk-proj-********************************************AbCd.` } }),
    );
    expect(out).not.toContain("AbCdEfGhIjKlMnOp");
    expect(out).not.toContain("sk-proj-****");
    // The JSON stays JSON: a CLI reading the body still parses it.
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("a Google API key, in the text and as a query parameter", () => {
    const out = redactSecrets(`API key not valid: ${GOOGLE_KEY} (https://generativelanguage.googleapis.com/v1beta/models?key=short-but-secret)`);
    expect(out).not.toContain(GOOGLE_KEY);
    expect(out).not.toContain("short-but-secret");
  });

  it("a bearer token, any shape", () => {
    const out = redactSecrets(`401: Authorization: Bearer ${OPAQUE_TOKEN} was refused; also "authorization":"Bearer abcdefgh12345678"`);
    expect(out).not.toContain(OPAQUE_TOKEN);
    expect(out).not.toContain("abcdefgh12345678");
  });

  it("a JWT-shaped value on its own", () => {
    const out = redactSecrets(`{"detail":"token ${JWT} is expired"}`);
    expect(out).not.toContain(JWT.split(".")[1]);
    expect(out).not.toContain("eyJhbGciOiJSUzI1NiIs");
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("a key header or parameter whatever the value's shape", () => {
    const out = redactSecrets(`x-api-key: plainvalue123456 api-key=other-value-987 "api_key":"third-value-555" access_token=fourth-value-222`);
    for (const value of ["plainvalue123456", "other-value-987", "third-value-555", "fourth-value-222"]) expect(out).not.toContain(value);
  });

  it("a value the caller knows, whatever its shape (an endpoint's own key)", () => {
    const own = "my-gateway-key.4f7d";
    expect(redactSecrets(`gateway says ${own} is over its budget`, [own])).not.toContain(own);
    // A short known value is not hunted for: it would cut ordinary words.
    expect(redactSecrets("the key abc failed", ["abc"])).toBe("the key abc failed");
  });

  it("xAI and Groq keys, and a basic credential", () => {
    const out = redactSecrets("xai-AbCdEfGhIjKlMnOpQrStUvWx0123 gsk_AbCdEfGhIjKlMnOpQrStUvWx0123 Authorization: Basic dXNlcjpwYXNzd29yZA==");
    for (const value of ["AbCdEfGhIjKlMnOpQrStUvWx0123", "dXNlcjpwYXNzd29yZA=="]) expect(out).not.toContain(value);
  });

  it("keeps JSON valid: a key's null stays null, escapes inside a string stay escapes", () => {
    const body = JSON.stringify({ error: { api_key: null, access_token: 12, message: `bad key ${OPENAI_PROJECT_KEY}` }, url: "https://x.example/v1?key=abcdefgh123&b=1" });
    const out = redactSecrets(body);
    const parsed = JSON.parse(out) as { error: { api_key: unknown; access_token: unknown; message: string }; url: string };
    expect(parsed.error.api_key).toBeNull();
    expect(parsed.error.access_token).toBe(12);
    expect(parsed.error.message).not.toContain("AbCdEfGh");
    expect(parsed.url).toBe("https://x.example/v1?key=[redacted]&b=1");
    // A body inside a string (pi-ai's text in a JSON log record): its escapes survive.
    const nested = JSON.stringify({ log: JSON.stringify({ "x-api-key": "plain-secret-value", detail: `"${OPENAI_PROJECT_KEY}"`, link: "https://a.example/?key=zzzzzzzzzz" }) });
    const outer = JSON.parse(redactSecrets(nested)) as { log: string };
    const inner = JSON.parse(outer.log) as Record<string, string>;
    expect(inner["x-api-key"]).toBe(REDACTED);
    expect(inner.detail).toBe(`"${REDACTED}"`);
    expect(inner.link).toBe(`https://a.example/?key=${REDACTED}`);
  });

  it("property: redacting any JSON gives JSON that parses and holds none of the secrets planted in it", () => {
    const secrets = [ANTHROPIC_KEY, OPENAI_PROJECT_KEY, GOOGLE_KEY, JWT, OPAQUE_TOKEN, "xai-AbCdEfGhIjKlMnOpQrStUvWx0123"];
    let seed = 1172;
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const pick = <T>(items: ReadonlyArray<T>): T => items[Math.floor(random() * items.length)]!;
    const names = ["api_key", "x-api-key", "access_token", "message", "type", "code", "param", "detail", "authorization"];
    const text = (): string => {
      const parts = ["bad", "key", pick(secrets), `Bearer ${pick(secrets)}`, `api_key=${pick(secrets)}`, `?key=${pick(secrets)}`, '"', "\\", "\n", "{", "}", ":", ",", "null"];
      return Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(parts)).join(pick([" ", "", "\"", ":"]));
    };
    const value = (depth: number): unknown => {
      const kind = Math.floor(random() * (depth > 3 ? 4 : 6));
      if (kind === 0) return null;
      if (kind === 1) return Math.floor(random() * 1000);
      if (kind === 2) return random() < 0.5;
      if (kind === 3) return random() < 0.3 ? JSON.stringify(value(depth + 1)) : text();
      if (kind === 4) return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(random() * 5) }, () => [pick(names), value(depth + 1)]));
    };
    for (let round = 0; round < 500; round++) {
      const original = JSON.stringify(value(0));
      const out = redactSecrets(original);
      expect(() => JSON.parse(out), original).not.toThrow();
      for (const secret of secrets) expect(out, original).not.toContain(secret);
    }
  });

  it("leaves ordinary error text alone", () => {
    const text = '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}';
    expect(redactSecrets(text)).toBe(text);
    expect(redactSecrets("insufficient_quota: You exceeded your current quota, please check your plan and billing details.")).toBe(
      "insufficient_quota: You exceeded your current quota, please check your plan and billing details.",
    );
  });
});
