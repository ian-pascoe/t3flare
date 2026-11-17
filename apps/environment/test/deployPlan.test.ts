// SPI-1175: what `stage.ts deploy` binds and sets up (scripts/lib/deployPlan.ts), and which settings dev.env is read for.
// Since the hard cut (SPI-1176) no model setting is bound: no MODEL_PROXY_* or COMMISSARY_* reaches alchemy, and the
// stage's Model endpoint comes from T3FLARE_MODEL_ENDPOINT alone, on a laptop as in CI.
import { describe, expect, it } from "vitest";

import { allDeploySettings, deployPlan, devEnvNames } from "../scripts/lib/deployPlan.ts";

const REQUIRED = { T3FLARE_GITHUB_APP_ID: "1", T3FLARE_GITHUB_APP_PRIVATE_KEY: "pem" };
/** The retired settings, as a dev.env or a shell may still hold them. */
const RETIRED = { MODEL_PROXY_URL: "https://llm.example.com", MODEL_PROXY_API_KEY: "cms_spi1176-proxy-key-0123456789", COMMISSARY_CONTAINER_API_KEY: "cms_container" };
const ENDPOINT = JSON.stringify({ id: "mine", baseUrl: "https://api.example.com", apiKey: "sk-mine-0000" });
const laptop = {};
const ci = { GITHUB_ACTIONS: "true" };

describe("deployPlan", () => {
  it("binds only the deploy-wide settings, and derives no endpoint from the retired proxy settings, on a laptop or in CI", () => {
    for (const env of [laptop, ci]) {
      const plan = deployPlan({ stage: "p1176", args: [], read: { ...REQUIRED }, env });
      expect(plan).toEqual({ ok: true, alchemyEnv: REQUIRED, endpoint: { ok: false, invalid: false, reason: "T3FLARE_MODEL_ENDPOINT is not set" }, notes: [] });
    }
  });

  it("takes the endpoint's setting, and never hands it to alchemy", () => {
    const plan = deployPlan({ stage: "bump", args: [], read: { ...REQUIRED, T3FLARE_MODEL_ENDPOINT: ENDPOINT }, env: ci });
    expect(plan.ok && plan.endpoint).toMatchObject({ ok: true, source: "T3FLARE_MODEL_ENDPOINT", spec: { id: "mine" } });
    expect(plan.ok && plan.alchemyEnv).toEqual(REQUIRED);
  });

  it("deploys prod without any model setting (SPI-1176)", () => {
    expect(deployPlan({ stage: "prod", args: [], read: { ...REQUIRED, T3FLARE_MODEL_ENDPOINT: ENDPOINT }, env: ci })).toMatchObject({ ok: true, alchemyEnv: REQUIRED });
  });

  it("refuses --no-model-proxy, which no longer means anything", () => {
    expect(deployPlan({ stage: "p1176", args: ["--web", "--no-model-proxy"], read: { ...REQUIRED }, env: laptop })).toEqual({
      ok: false,
      error: "--no-model-proxy is gone: there is no Model proxy since the hard cut (SPI-1176); deploy without it",
    });
  });

  it("refuses a custom domain on any stage but prod (prod's host, Access application and rate limit); empty is unset", () => {
    const domain = { T3FLARE_DOMAIN: "t3.example.dev" };
    expect(deployPlan({ stage: "p1176", args: [], read: { ...REQUIRED }, env: { ...laptop, ...domain } })).toEqual({
      ok: false,
      error: "T3FLARE_DOMAIN is set (to t3.example.dev) for the stage p1176: only prod has a custom domain; unset it (was dev.env sourced into the shell?)",
    });
    expect(deployPlan({ stage: "bump", args: [], read: { ...REQUIRED }, env: { ...ci, ...domain } })).toMatchObject({ ok: false });
    // deploy-prod.yml's `bump` run passes the `bump` environment's unset variable as "".
    expect(deployPlan({ stage: "bump", args: [], read: { ...REQUIRED }, env: { ...ci, T3FLARE_DOMAIN: "" } })).toMatchObject({ ok: true });
    expect(deployPlan({ stage: "prod", args: [], read: { ...REQUIRED }, env: { ...ci, ...domain } })).toMatchObject({ ok: true });
  });

  it("refuses an unusable endpoint setting and a missing required setting", () => {
    expect(deployPlan({ stage: "p1176", args: [], read: { ...REQUIRED, T3FLARE_MODEL_ENDPOINT: "{" }, env: ci })).toEqual({ ok: false, error: "T3FLARE_MODEL_ENDPOINT is not JSON" });
    expect(deployPlan({ stage: "p1176", args: [], read: {}, env: laptop })).toMatchObject({ ok: false, error: expect.stringMatching(/^missing T3FLARE_GITHUB_APP_ID/) });
  });
});

describe("devEnvNames", () => {
  it("reads the endpoint's setting from dev.env even when the environment has everything else", () => {
    expect(devEnvNames({ ...REQUIRED }, ["T3FLARE_MODEL_ENDPOINT"])).toEqual(["T3FLARE_MODEL_ENDPOINT"]);
  });
  it("reads nothing when the environment has it all", () => {
    expect(devEnvNames({ ...REQUIRED, T3FLARE_MODEL_ENDPOINT: ENDPOINT }, ["T3FLARE_MODEL_ENDPOINT"])).toEqual([]);
  });
  it("reads every setting when a required one is missing, and never a retired one", () => {
    expect(devEnvNames({}, ["T3FLARE_MODEL_ENDPOINT"])).toEqual(allDeploySettings(["T3FLARE_MODEL_ENDPOINT"]));
    expect(allDeploySettings()).toEqual(["T3FLARE_GITHUB_APP_ID", "T3FLARE_GITHUB_APP_PRIVATE_KEY"]);
    expect(devEnvNames({ ...REQUIRED, ...RETIRED }, [])).toEqual([]);
  });
});
