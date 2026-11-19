// Deployment settings (scripts/lib/deploymentSettings.ts): no defaults, every value checked for its shape, and one
// message that names the setting and where it goes.
import { describe, expect, it } from "vitest";

import {
  DEPLOYMENT_SETTINGS,
  type DeploymentSettingName,
  malformedSettingMessage,
  missingSettingMessage,
  optionalSetting,
  requiredSetting,
  requiredSettings,
  requireSetting,
} from "../scripts/lib/deploymentSettings.ts";

const WHERE = "Deployment settings are listed in docs/deploy.md: put them in ~/.config/t3flare/dev.env, or in the Deployment repository's variables for CI.";

describe("the messages", () => {
  it("names a missing setting, exactly", () => {
    expect(missingSettingMessage("T3FLARE_OWNER_EMAIL")).toBe(
      "t3flare: T3FLARE_OWNER_EMAIL is not set. Deployment settings are listed in docs/deploy.md: put them in ~/.config/t3flare/dev.env, or in the Deployment repository's variables for CI.",
    );
  });

  it("names a malformed setting and its shape, never its value", () => {
    expect(malformedSettingMessage("T3FLARE_OWNER_EMAIL")).toBe(`t3flare: T3FLARE_OWNER_EMAIL is not an email address. ${WHERE}`);
    const result = requiredSetting({ T3FLARE_OWNER_EMAIL: "owner-at-example" }, "T3FLARE_OWNER_EMAIL");
    expect(result).toEqual({ ok: false, error: malformedSettingMessage("T3FLARE_OWNER_EMAIL") });
    expect(JSON.stringify(result)).not.toContain("owner-at-example");
  });
});

describe("the shapes", () => {
  const cases: ReadonlyArray<readonly [DeploymentSettingName, ReadonlyArray<string>, ReadonlyArray<string>]> = [
    ["T3FLARE_OWNER_EMAIL", ["owner@example.com", "a.b+c@mail.example.org"], ["owner", "owner@", "@example.com", "owner@example", "own er@example.com"]],
    ["T3FLARE_ACCESS_TEAM_DOMAIN", ["my-team.cloudflareaccess.com"], ["my-team", "https://my-team.cloudflareaccess.com", "my-team.cloudflareaccess.com.evil.dev", "-team.cloudflareaccess.com", "a.b.cloudflareaccess.com"]],
    ["T3FLARE_WORKERS_DEV_SUBDOMAIN", ["my-account", "abc123"], ["my-account.workers.dev", "-x", "x-", "a_b", "a".repeat(64)]],
    ["T3FLARE_FIXTURE_REPO", ["someone/t3flare-fixture", "org-1/repo.name_2"], ["t3flare-fixture", "someone/", "/repo", "a/b/c", "https://github.com/a/b"]],
    ["GITHUB_REPOSITORY", ["someone/t3flare"], ["someone"]],
    ["T3FLARE_UPDATE_REPO", ["spiritledsoftware/t3flare"], ["spiritledsoftware"]],
    ["T3FLARE_DOMAIN", ["t3.example.com", "example.dev"], ["example", "https://t3.example.com", "t3.example.com/", "t3..example.com", "t3_x.example.com"]],
    ["T3FLARE_STANDIN_ZONE", ["example.dev"], ["example"]],
    ["T3FLARE_DOMAIN_ZONE_ID", ["0123456789abcdef0123456789abcdef"], ["0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef", "0123456789abcdef0123456789abcdeg"]],
  ];

  it("covers every setting", () => {
    expect(new Set(cases.map(([name]) => name))).toEqual(new Set(Object.keys(DEPLOYMENT_SETTINGS)));
  });

  for (const [name, good, bad] of cases) {
    it(`${name}: accepts ${good.join(", ")}; refuses the rest`, () => {
      for (const value of good) expect(requiredSetting({ [name]: value }, name)).toEqual({ ok: true, value });
      for (const value of bad) expect(requiredSetting({ [name]: value }, name)).toEqual({ ok: false, error: malformedSettingMessage(name) });
    });
  }
});

describe("reading", () => {
  it("has no default: unset and empty are missing", () => {
    expect(requiredSetting({}, "T3FLARE_WORKERS_DEV_SUBDOMAIN")).toEqual({ ok: false, error: missingSettingMessage("T3FLARE_WORKERS_DEV_SUBDOMAIN") });
    expect(requiredSetting({ T3FLARE_WORKERS_DEV_SUBDOMAIN: "" }, "T3FLARE_WORKERS_DEV_SUBDOMAIN")).toEqual({ ok: false, error: missingSettingMessage("T3FLARE_WORKERS_DEV_SUBDOMAIN") });
  });

  it("an optional setting may be unset, but not malformed", () => {
    expect(optionalSetting({}, "T3FLARE_UPDATE_REPO")).toEqual({ ok: true, value: undefined });
    expect(optionalSetting({ T3FLARE_UPDATE_REPO: "" }, "T3FLARE_UPDATE_REPO")).toEqual({ ok: true, value: undefined });
    expect(optionalSetting({ T3FLARE_UPDATE_REPO: "a/b" }, "T3FLARE_UPDATE_REPO")).toEqual({ ok: true, value: "a/b" });
    expect(optionalSetting({ T3FLARE_UPDATE_REPO: "a" }, "T3FLARE_UPDATE_REPO")).toEqual({ ok: false, error: malformedSettingMessage("T3FLARE_UPDATE_REPO") });
  });

  it("reads several at once, reporting every problem, one per line", () => {
    const names = ["T3FLARE_ACCESS_TEAM_DOMAIN", "T3FLARE_OWNER_EMAIL", "T3FLARE_WORKERS_DEV_SUBDOMAIN"] as const;
    expect(requiredSettings({ T3FLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", T3FLARE_OWNER_EMAIL: "o@example.com", T3FLARE_WORKERS_DEV_SUBDOMAIN: "acct" }, names)).toEqual({
      ok: true,
      value: { T3FLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", T3FLARE_OWNER_EMAIL: "o@example.com", T3FLARE_WORKERS_DEV_SUBDOMAIN: "acct" },
    });
    expect(requiredSettings({ T3FLARE_OWNER_EMAIL: "nope" }, names)).toEqual({
      ok: false,
      error: [missingSettingMessage("T3FLARE_ACCESS_TEAM_DOMAIN"), malformedSettingMessage("T3FLARE_OWNER_EMAIL"), missingSettingMessage("T3FLARE_WORKERS_DEV_SUBDOMAIN")].join("\n"),
    });
  });

  it("requireSetting throws the message", () => {
    expect(() => requireSetting({}, "T3FLARE_FIXTURE_REPO")).toThrow(missingSettingMessage("T3FLARE_FIXTURE_REPO"));
    expect(requireSetting({ T3FLARE_FIXTURE_REPO: "a/b" }, "T3FLARE_FIXTURE_REPO")).toBe("a/b");
  });
});
