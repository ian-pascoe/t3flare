// The admin guard (src/access.ts): Access assertions signed with a test key, and the admin token.
import { beforeAll, describe, expect, it } from "vitest";

import {
  type GuardConfig,
  type TeamKey,
  classifyAssertion,
  teamKeys,
  timingSafeEqual,
  verifyAdminRequest,
  verifyAdminToken,
} from "../src/access.ts";

const TEAM = "team.cloudflareaccess.com";
const AUD = "the-admin-aud";
const OWNER = "owner@example.com";
const SERVICE_CLIENT = "0123abcd.access";
const NOW = 1_800_000_000;

const config: GuardConfig = {
  teamDomain: TEAM,
  audience: AUD,
  ownerEmail: OWNER,
  serviceTokenClientId: SERVICE_CLIENT,
  adminToken: "admin-token",
};

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

let keyPair: CryptoKeyPair;
let otherPair: CryptoKeyPair;
const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

beforeAll(async () => {
  const generate = () =>
    crypto.subtle.generateKey({ ...algorithm, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
  keyPair = (await generate()) as CryptoKeyPair;
  otherPair = (await generate()) as CryptoKeyPair;
});

const sign = async (claims: Record<string, unknown>, options: { kid?: string; alg?: string; key?: CryptoKey } = {}) => {
  const header = encode({ alg: options.alg ?? "RS256", kid: options.kid ?? "k1" });
  const payload = encode(claims);
  const signature = await crypto.subtle.sign(algorithm, options.key ?? keyPair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
};

const ownerClaims = (overrides: Record<string, unknown> = {}) => ({
  iss: `https://${TEAM}`,
  aud: [AUD],
  exp: NOW + 600,
  nbf: NOW - 10,
  email: OWNER,
  ...overrides,
});

const keys = async (kid: string): Promise<TeamKey | undefined> => (kid === "k1" ? keyPair.publicKey : undefined);

describe("classifyAssertion", () => {
  it("admits the owner and the stage's service token", async () => {
    expect(await classifyAssertion(await sign(ownerClaims()), config, keys, NOW)).toEqual({ admitted: true, caller: { kind: "owner" } });
    const service = await sign(ownerClaims({ email: undefined, common_name: SERVICE_CLIENT }));
    expect(await classifyAssertion(service, config, keys, NOW)).toEqual({ admitted: true, caller: { kind: "service-token" } });
  });

  it.each([
    ["another email", ownerClaims({ email: "someone@example.com" }), "not_admitted"],
    ["another service token", ownerClaims({ email: undefined, common_name: "other.access" }), "not_admitted"],
    ["the owner's email with a common_name", ownerClaims({ common_name: "other.access" }), "not_admitted"],
    ["another audience", ownerClaims({ aud: ["someone-else"] }), "wrong_audience"],
    ["another issuer", ownerClaims({ iss: "https://evil.cloudflareaccess.com" }), "wrong_issuer"],
    ["an expired assertion", ownerClaims({ exp: NOW - 1 }), "expired"],
    ["a future assertion", ownerClaims({ nbf: NOW + 3600 }), "not_yet_valid"],
  ])("refuses %s", async (_name, claims, reason) => {
    expect(await classifyAssertion(await sign(claims), config, keys, NOW)).toEqual({ admitted: false, reason });
  });

  it("refuses unsigned, unknown-key, badly signed and malformed assertions", async () => {
    const good = await sign(ownerClaims());
    const [header, payload] = good.split(".");
    expect((await classifyAssertion(`${encode({ alg: "none", kid: "k1" })}.${payload}.`, config, keys, NOW)).admitted).toBe(false);
    expect(await classifyAssertion(await sign(ownerClaims(), { kid: "k2" }), config, keys, NOW)).toEqual({ admitted: false, reason: "unknown_key" });
    expect(await classifyAssertion(await sign(ownerClaims(), { key: otherPair.privateKey }), config, keys, NOW)).toEqual({ admitted: false, reason: "bad_signature" });
    const tampered = `${header}.${encode(ownerClaims({ email: "x@example.com" }))}.${good.split(".")[2]}`;
    expect(await classifyAssertion(tampered, config, keys, NOW)).toEqual({ admitted: false, reason: "bad_signature" });
    expect(await classifyAssertion("not-a-jwt", config, keys, NOW)).toEqual({ admitted: false, reason: "malformed" });
    expect(await classifyAssertion(undefined, config, keys, NOW)).toEqual({ admitted: false, reason: "missing" });
  });

  it("fails closed when the Worker has no audience", async () => {
    expect(await classifyAssertion(await sign(ownerClaims()), { ...config, audience: undefined }, keys, NOW)).toEqual({
      admitted: false,
      reason: "not_configured",
    });
  });
});

describe("verifyAdminRequest", () => {
  const request = (headers: Record<string, string>) => new Request("https://env.example/_t3flare/health", { headers });

  it("needs both the assertion and the admin token", async () => {
    const assertion = await sign(ownerClaims());
    expect((await verifyAdminRequest(request({ "cf-access-jwt-assertion": assertion, authorization: "Bearer admin-token" }), config, keys, NOW)).admitted).toBe(true);
    expect(await verifyAdminRequest(request({ "cf-access-jwt-assertion": assertion, authorization: "Bearer nope" }), config, keys, NOW)).toEqual({ admitted: false, reason: "bad_admin_token" });
    expect(await verifyAdminRequest(request({ authorization: "Bearer admin-token" }), config, keys, NOW)).toEqual({ admitted: false, reason: "missing" });
    expect(await verifyAdminRequest(request({ "cf-access-jwt-assertion": assertion, authorization: "Bearer admin-token" }), { ...config, adminToken: undefined }, keys, NOW)).toEqual({ admitted: false, reason: "not_configured" });
  });

  it("refuses, never throws, when the key lookup fails", async () => {
    const failing = async () => {
      throw new Error("down");
    };
    const assertion = await sign(ownerClaims());
    expect(await verifyAdminRequest(request({ "cf-access-jwt-assertion": assertion, authorization: "Bearer admin-token" }), config, failing, NOW)).toEqual({ admitted: false, reason: "error" });
  });

  it("local mode takes the admin token alone", () => {
    expect(verifyAdminToken(request({ authorization: "Bearer admin-token" }), config).admitted).toBe(true);
    expect(verifyAdminToken(request({}), config).admitted).toBe(false);
    expect(verifyAdminToken(request({ authorization: "Bearer admin-token" }), { ...config, adminToken: undefined }).admitted).toBe(false);
  });
});

describe("teamKeys", () => {
  it("reads the team's keys once, then serves them from memory", async () => {
    const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    let reads = 0;
    const lookup = teamKeys(async () => {
      reads++;
      return JSON.stringify({ keys: [{ ...jwk, kid: "k1" }, { kty: "EC", kid: "skipped" }] });
    }, () => 1000);
    expect(await lookup("k1")).toBeDefined();
    expect(await lookup("k1")).toBeDefined();
    expect(reads).toBe(1);
    // An unknown kid is looked up again only after the cooldown.
    expect(await lookup("k9")).toBeUndefined();
    expect(reads).toBe(1);
  });
});

it("timingSafeEqual compares whole strings", () => {
  expect(timingSafeEqual("abc", "abc")).toBe(true);
  expect(timingSafeEqual("abc", "abd")).toBe(false);
  expect(timingSafeEqual("abc", "abcd")).toBe(false);
});
