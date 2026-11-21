// The Server version stamp (in-app updates plan D1, D16; ADR-0041): the pin's tag on the Deployment's t3 track without its
// `v`, else the manifest's version; served in t3's server manifest by build.ts and checked against the descriptor and the
// web client by acceptance.
import { describe, expect, it } from "vitest";

import { serverVersionOf, stampedManifest } from "../serverVersion.ts";
import { versionAgreement, webScripts } from "../scripts/lib/versionAgreement.ts";

describe("the Server version stamp", () => {
  it("is the exact tag without its v", () => {
    expect(serverVersionOf(["v0.1.11-nightly.20261117.4825"], "nightly", "0.1.10")).toEqual({ version: "0.1.11-nightly.20261117.4825", exact: true, tag: "v0.1.11-nightly.20261117.4825" });
    expect(serverVersionOf(["v0.2.0"], "stable", "0.1.10")).toEqual({ version: "0.2.0", exact: true, tag: "v0.2.0" });
  });

  it("names a commit with a tag on each track by the Deployment's track, never by git's pick", () => {
    const both = ["v0.1.11", "v0.1.11-nightly.20261120.4979"];
    expect(serverVersionOf(both, "stable", "0.1.10")).toMatchObject({ version: "0.1.11", tag: "v0.1.11" });
    expect(serverVersionOf([...both].reverse(), "stable", "0.1.10")).toMatchObject({ version: "0.1.11", tag: "v0.1.11" });
    expect(serverVersionOf(both, "nightly", "0.1.10")).toMatchObject({ version: "0.1.11-nightly.20261120.4979", tag: "v0.1.11-nightly.20261120.4979" });
  });

  it("names a pin on the other track by its own tag (a Deployment that switched tracks, before the new track passes it)", () => {
    expect(serverVersionOf(["v0.1.12-nightly.20261120.4994"], "stable", "0.1.10")).toEqual({ version: "0.1.12-nightly.20261120.4994", exact: true, tag: "v0.1.12-nightly.20261120.4994" });
  });

  it("falls back to the manifest's version off a release tag", () => {
    expect(serverVersionOf([], "stable", "0.1.10")).toEqual({ version: "0.1.10", exact: false, tag: null });
    expect(serverVersionOf(["nightly-latest", "v0.1.10-preview.20261112.4593"], "stable", "0.1.10")).toEqual({ version: "0.1.10", exact: false, tag: null });
  });

  it("stamps only the version into t3's server manifest", () => {
    const stamped = JSON.parse(stampedManifest(JSON.stringify({ name: "t3", version: "0.1.10", bin: { t3: "x" } }), "0.1.11-nightly.20261117.4825"));
    expect(stamped).toEqual({ name: "t3", version: "0.1.11-nightly.20261117.4825", bin: { t3: "x" } });
  });
});

describe("the version agreement acceptance check", () => {
  const version = "0.1.11-nightly.20261117.4825";
  const html = `<script type="module" crossorigin src="/assets/index-abc.js"></script><link rel="modulepreload" crossorigin href="/assets/vendor-def.js"><script src="https://cdn.example/x.js"></script>`;

  it("reads the same-origin scripts index.html names", () => {
    expect(webScripts(html)).toEqual(["/assets/index-abc.js", "/assets/vendor-def.js"]);
  });

  it("passes when the tag, the descriptor and the web client agree", () => {
    expect(versionAgreement({ tag: `v${version}`, serverVersion: version, scripts: [`const a=${JSON.stringify(version)};`] }).ok).toBe(true);
    // As the minifier writes it.
    expect(versionAgreement({ tag: `v${version}`, serverVersion: version, scripts: [`let t=\`${version}\`;`] }).ok).toBe(true);
  });

  it("names each disagreement", () => {
    const result = versionAgreement({ tag: `v${version}`, serverVersion: "0.1.10", scripts: ['const a="0.1.10";'] });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([`t3's descriptor reports serverVersion 0.1.10, the pin is v${version}`, `no web client script carries APP_VERSION ${version}`]);
  });
});
