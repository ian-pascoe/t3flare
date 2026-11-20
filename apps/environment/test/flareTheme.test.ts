// The t3flare theme: a complete, valid Environment theme in both appearances, published at each boot through t3's own
// EnvironmentThemeService, and made the default theme once, only while the owner has set none.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { EnvironmentThemeFile, environmentThemeFileHasColors } from "@t3tools/contracts";
import { THEME_COLOR_ROLES } from "@t3tools/shared/themePalettes";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerConfig from "t3/src/config.ts";
import * as EnvironmentTheme from "t3/src/environmentTheme.ts";
import * as ServerSettings from "t3/src/serverSettings.ts";
import { afterEach, describe, expect, it } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { FLARE_DARK, FLARE_LIGHT, FLARE_THEME, FLARE_THEME_ID, FLARE_THEME_JSON, layerFlareTheme } from "../src/t3/flareTheme.ts";

/** WCAG 2 contrast ratio of two opaque hex colours. */
const contrast = (a: string, b: string) => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe("the t3flare theme's palette", () => {
  it("is a valid Environment theme file with colours", () => {
    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(EnvironmentThemeFile))(FLARE_THEME_JSON);
    expect(decoded).toEqual(FLARE_THEME);
    expect(environmentThemeFileHasColors(decoded)).toBe(true);
  });

  it.each([
    ["dark", FLARE_DARK],
    ["light", FLARE_LIGHT],
  ])("gives every colour role in %s, as opaque hex", (_appearance, palette) => {
    expect(Object.keys(palette).toSorted()).toEqual([...THEME_COLOR_ROLES].toSorted());
    for (const colour of Object.values(palette)) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each([
    ["dark", FLARE_DARK],
    ["light", FLARE_LIGHT],
  ])("keeps text and ink on the orange readable in %s", (_appearance, palette) => {
    expect(contrast(palette.text, palette.canvas)).toBeGreaterThanOrEqual(7);
    expect(contrast(palette.text, palette.surface)).toBeGreaterThanOrEqual(7);
    expect(contrast(palette.textMuted, palette.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.accentForeground, palette.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.messageActionForeground, palette.messageAction)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.codeForeground, palette.codeBackground)).toBeGreaterThanOrEqual(7);
    expect(contrast(palette.terminalForeground, palette.terminalBackground)).toBeGreaterThanOrEqual(7);
  });
});

const tempDirs: Array<string> = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const bindMarks = () => {
  const marks = new Map<string, number>();
  bindEnvironmentServices({ marks: { has: (key: string) => marks.has(key), set: (key: string) => void marks.set(key, 1) } } as unknown as EnvironmentServices);
  return marks;
};

/** One boot of the seed over t3's theme service, in `baseDir`: the settings, the published themes and the file after it. */
const boot = (baseDir: string, settings: Partial<Parameters<typeof ServerSettings.layerTest>[0]> = {}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const themes = yield* EnvironmentTheme.EnvironmentThemeService;
      const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
      const read = yield* themes.read();
      const current = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      return {
        defaultTheme: current.defaultTheme,
        published: read.themes.map((theme) => theme.id),
        file: NodeFS.readFileSync(NodePath.join(environmentThemesDir, `${FLARE_THEME_ID}.json`), "utf8"),
        themesDir: environmentThemesDir,
      };
    }).pipe(
      Effect.provide(
        layerFlareTheme.pipe(
          Layer.provideMerge(EnvironmentTheme.layer),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(ServerSettings.layerTest(settings)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
  );

const tempBase = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3flare-theme-"));
  tempDirs.push(dir);
  return dir;
};

describe("the t3flare theme's seed", () => {
  it("publishes the theme and makes it the default at the first boot", async () => {
    const marks = bindMarks();
    const after = await boot(tempBase());
    expect(after.published).toContain(FLARE_THEME_ID);
    expect(after.defaultTheme).toBe(FLARE_THEME_ID);
    expect(after.file).toBe(FLARE_THEME_JSON);
    expect(marks.size).toBe(1);
  });

  it("leaves a theme the owner chose, and does not choose again once seeded", async () => {
    bindMarks();
    const chosen = await boot(tempBase(), { defaultTheme: "grove", defaultThemeSetAt: "2026-11-01T00:00:00.000Z" });
    expect(chosen.defaultTheme).toBe("grove");
    expect(chosen.published).toContain(FLARE_THEME_ID);
    // The stock theme, chosen after the seed: an empty theme with no set time reads as unset, but the mark holds.
    const later = await boot(tempBase());
    expect(later.defaultTheme).toBe("");
    expect(later.published).toContain(FLARE_THEME_ID);
  });

  it("restores the shipped file at each boot", async () => {
    bindMarks();
    const base = tempBase();
    const first = await boot(base);
    NodeFS.writeFileSync(NodePath.join(first.themesDir, `${FLARE_THEME_ID}.json`), JSON.stringify({ name: "edited", appearance: "light", canvas: "#ffffff", accent: "#000000" }));
    const second = await boot(base);
    expect(second.file).toBe(FLARE_THEME_JSON);
  });
});
