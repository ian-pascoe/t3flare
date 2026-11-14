// SPI-1175: what `stage.ts deploy` binds and sets up (scripts/lib/deployPlan.ts): the Model proxy optional on a
// throwaway stage and kept on prod, `--no-model-proxy`, the endpoint derived on a laptop and not in CI, and which
// settings dev.env is read for.
import { describe, expect, it } from "vitest";

import { deployPlan, devEnvNames } from "../scripts/lib/deployPlan.ts";

const KEY = "cms_spi1175-proxy-key-0123456789";
const REQUIRED = { T3FLARE_GITHUB_APP_ID: "1", T3FLARE_GITHUB_APP_PRIVATE_KEY: "pem", COMMISSARY_CONTAINER_API_KEY: "cms_container" };
const PROXY = { MODEL_PROXY_URL: "https://llm.example.com", MODEL_PROXY_API_KEY: KEY };
const ENDPOINT = JSON.stringify({ id: "mine", baseUrl: "https://api.example.com", apiKey: "sk-mine-0000" });
const laptop = {};
const ci = { GITHUB_ACTIONS: "true" };

describe("deployPlan", () => {
  it("binds the proxy and derives Commissary's endpoint on a laptop", () => {
    const plan = deployPlan({ stage: "p1175", args: [], read: { ...REQUIRED, ...PROXY }, env: laptop });
    expect(plan).toMatchObject({ ok: true, alchemyEnv: { ...REQUIRED, ...PROXY }, endpoint: { ok: true, source: "MODEL_PROXY_URL" }, notes: [] });
  });

  it("derives no endpoint in CI: without the secret it is a skip, and the deploy goes on", () => {
    const plan = deployPlan({ stage: "bump", args: [], read: { ...REQUIRED, ...PROXY }, env: ci });
    expect(plan).toMatchObject({ ok: true, endpoint: { ok: false, invalid: false, reason: "T3FLARE_MODEL_ENDPOINT is not set" } });
  });

  it("takes the secret in CI, and never hands it to alchemy", () => {
    const plan = deployPlan({ stage: "bump", args: [], read: { ...REQUIRED, ...PROXY, T3FLARE_MODEL_ENDPOINT: ENDPOINT }, env: ci });
    expect(plan.ok && plan.endpoint).toMatchObject({ ok: true, source: "T3FLARE_MODEL_ENDPOINT", spec: { id: "mine" } });
    expect(plan.ok && plan.alchemyEnv.T3FLARE_MODEL_ENDPOINT).toBeUndefined();
  });

  it("--no-model-proxy blanks the proxy's settings for alchemy, so a shell's own cannot be bound, and still derives the endpoint", () => {
    const plan = deployPlan({ stage: "p1175", args: ["--web", "--no-model-proxy"], read: { ...REQUIRED, ...PROXY }, env: laptop });
    expect(plan).toMatchObject({ ok: true, endpoint: { ok: true, source: "MODEL_PROXY_URL" }, notes: ["deploying without the Model proxy (--no-model-proxy)"] });
    expect(plan.ok && plan.alchemyEnv).toEqual({ ...REQUIRED, MODEL_PROXY_URL: "", MODEL_PROXY_API_KEY: "" });
  });

  it("deploys a throwaway stage without the proxy when it is not set", () => {
    const plan = deployPlan({ stage: "p1175", args: [], read: { ...REQUIRED, T3FLARE_MODEL_ENDPOINT: ENDPOINT }, env: laptop });
    expect(plan).toMatchObject({ ok: true, alchemyEnv: { MODEL_PROXY_URL: "", MODEL_PROXY_API_KEY: "" }, notes: ["deploying without the Model proxy (no MODEL_PROXY_URL)"] });
  });

  it("keeps the proxy on prod until the hard cut", () => {
    expect(deployPlan({ stage: "prod", args: [], read: { ...REQUIRED }, env: ci })).toEqual({
      ok: false,
      error: "prod keeps the Model proxy until the hard cut (SPI-1176): set MODEL_PROXY_URL and MODEL_PROXY_API_KEY",
    });
    expect(deployPlan({ stage: "prod", args: ["--no-model-proxy"], read: { ...REQUIRED, ...PROXY }, env: ci })).toEqual({
      ok: false,
      error: "prod keeps the Model proxy until the hard cut (SPI-1176): --no-model-proxy is for throwaway stages",
    });
    expect(deployPlan({ stage: "prod", args: [], read: { ...REQUIRED, ...PROXY }, env: ci })).toMatchObject({ ok: true });
  });

  it("refuses an unusable endpoint setting, a missing required setting, and a proxy URL without its key", () => {
    expect(deployPlan({ stage: "p1175", args: [], read: { ...REQUIRED, ...PROXY, T3FLARE_MODEL_ENDPOINT: "{" }, env: ci })).toEqual({ ok: false, error: "T3FLARE_MODEL_ENDPOINT is not JSON" });
    expect(deployPlan({ stage: "p1175", args: [], read: { ...PROXY }, env: laptop })).toMatchObject({ ok: false, error: expect.stringMatching(/^missing T3FLARE_GITHUB_APP_ID/) });
    expect(deployPlan({ stage: "p1175", args: [], read: { ...REQUIRED, MODEL_PROXY_URL: PROXY.MODEL_PROXY_URL }, env: laptop })).toEqual({ ok: false, error: "MODEL_PROXY_URL is set without MODEL_PROXY_API_KEY" });
  });
});

describe("devEnvNames", () => {
  it("reads the endpoint's setting from dev.env even when the environment has everything else", () => {
    expect(devEnvNames({ ...REQUIRED, ...PROXY }, ["T3FLARE_MODEL_ENDPOINT"])).toEqual(["T3FLARE_MODEL_ENDPOINT"]);
  });
  it("reads nothing when the environment has it all", () => {
    expect(devEnvNames({ ...REQUIRED, ...PROXY, T3FLARE_MODEL_ENDPOINT: ENDPOINT }, ["T3FLARE_MODEL_ENDPOINT"])).toEqual([]);
  });
  it("reads every setting when a required one is missing", () => {
    expect(devEnvNames({ ...REQUIRED }, ["T3FLARE_MODEL_ENDPOINT"])).toContain("MODEL_PROXY_URL");
    expect(devEnvNames({ ...REQUIRED }, ["T3FLARE_MODEL_ENDPOINT"])).toContain("T3FLARE_MODEL_ENDPOINT");
  });
});
