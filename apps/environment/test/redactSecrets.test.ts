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

  it("leaves ordinary error text alone", () => {
    const text = '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}';
    expect(redactSecrets(text)).toBe(text);
    expect(redactSecrets("insufficient_quota: You exceeded your current quota, please check your plan and billing details.")).toBe(
      "insufficient_quota: You exceeded your current quota, please check your plan and billing details.",
    );
  });
});
