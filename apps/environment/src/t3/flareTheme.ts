// t3flare's own theme in T3 Code: the Settings page's look (harness/pageStyle.ts) as an Environment theme, which t3
// publishes (`EnvironmentThemeService`) to each client whose primary Environment is the Cloud Environment, such as the
// web app a Deployment serves, with no change to t3's web app (ADR-0001: a Layer). The file
// `<stateDir>/themes/t3flare.json` is written at each boot, so a deploy ships palette changes and an owner's edit to it
// does not last (Duplicate it in the picker to keep a variant). It is made the Environment's default theme once, and
// only while no Environment default was ever set (`defaultThemeSetAt`; a theme picked in a client's picker is that
// client's own and does not count): each client then switches to it once (t3's `useDefaultTheme`), existing ones too,
// and every later choice, the owner's or a client's, wins.
//
// Both appearances are defined, so the theme keeps each client's light, dark or system mode, as the Settings page
// follows `prefers-color-scheme`. Every one of t3's colour roles is given, none derived: dark is the page's true black
// with flare orange (pageBrand.ts's FLARE_FROM, FLARE_TO for focus), light its zinc with the deeper orange, dark ink
// on the orange in both. Theme colours are opaque, so the page's translucent tokens become near greys: a border, for
// one, sits between the page's 9% white on black (#171717) and on a card (#272727).
import type { EnvironmentThemeFile } from "@t3tools/contracts";
import type { ThemeColorRole } from "@t3tools/shared/themePalettes";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "t3/src/config.ts";
import * as EnvironmentTheme from "t3/src/environmentTheme.ts";
import * as ServerSettings from "t3/src/serverSettings.ts";

import { environmentServices } from "../agents/bindings.ts";

export const FLARE_THEME_ID = "t3flare";

type Palette = Readonly<Record<ThemeColorRole, string>>;

const INK = "#18181b";

export const FLARE_DARK: Palette = {
  canvas: "#000000",
  chrome: "#000000",
  toolbar: "#000000",
  toolbarForeground: "#f5f5f5",
  toolbarBorder: "#1f1f1f",
  toolbarControl: "#121212",
  toolbarControlForeground: "#f5f5f5",
  toolbarControlHover: "#1a1a1a",
  surface: "#121212",
  surfaceRaised: "#121212",
  surfaceOverlay: "#161616",
  text: "#f5f5f5",
  textMuted: "#a3a3a3",
  border: "#1f1f1f",
  input: "#242424",
  focus: "#ffb547",
  accent: "#ff7a1a",
  accentForeground: INK,
  secondary: "#121212",
  secondaryForeground: "#f5f5f5",
  muted: "#0a0a0a",
  mutedForeground: "#a3a3a3",
  placeholder: "#858585",
  secondaryLabel: "#a3a3a3",
  iconMuted: "#a3a3a3",
  error: "#ef4444",
  errorForeground: "#f87171",
  errorSurface: "#220a0a",
  warning: "#f59e0b",
  warningForeground: "#fbbf24",
  warningSurface: "#221602",
  update: "#ff7a1a",
  updateForeground: "#ffb547",
  updateSurface: "#2e1605",
  accentSurface: "#141414",
  accentSurfaceForeground: "#f5f5f5",
  messageSurface: "#141414",
  messageForeground: "#f5f5f5",
  messageAction: "#ff7a1a",
  messageActionForeground: INK,
  messageActionHover: "#e66e17",
  codeBackground: "#121212",
  codeForeground: "#f5f5f5",
  searchMatchBackground: "#6b3a12",
  searchMatchForeground: "#f5f5f5",
  searchMatchActiveBackground: "#ffb547",
  searchMatchActiveForeground: INK,
  sidebar: "#0b0b0b",
  sidebarForeground: "#f5f5f5",
  sidebarMutedForeground: "#a3a3a3",
  sidebarControlSurface: "#121212",
  sidebarRowHover: "#151515",
  sidebarRowActive: "#1c1c1c",
  sidebarRowSelected: "#171717",
  sidebarBorder: "#171717",
  terminalBackground: "#000000",
  terminalForeground: "#f5f5f5",
  terminalCursor: "#ff7a1a",
  terminalSelection: "#472207",
  terminalScrollbar: "#242424",
  terminalScrollbarHover: "#3a3a3a",
};

export const FLARE_LIGHT: Palette = {
  canvas: "#fcfcfc",
  chrome: "#fcfcfc",
  toolbar: "#fcfcfc",
  toolbarForeground: INK,
  toolbarBorder: "#e4e4e7",
  toolbarControl: "#ffffff",
  toolbarControlForeground: INK,
  toolbarControlHover: "#f4f4f5",
  surface: "#ffffff",
  surfaceRaised: "#fcfcfc",
  surfaceOverlay: "#ffffff",
  text: INK,
  textMuted: "#71717a",
  border: "#e4e4e7",
  input: "#d4d4d8",
  focus: "#ea580c",
  accent: "#ea580c",
  accentForeground: INK,
  secondary: "#f4f4f5",
  secondaryForeground: INK,
  muted: "#f4f4f5",
  mutedForeground: "#71717a",
  placeholder: "#8d8d95",
  secondaryLabel: "#71717a",
  iconMuted: "#71717a",
  error: "#ef4444",
  errorForeground: "#b91c1c",
  errorSurface: "#fef0f0",
  warning: "#f59e0b",
  warningForeground: "#b45309",
  warningSurface: "#fef5e7",
  update: "#ea580c",
  updateForeground: "#c2410c",
  updateSurface: "#fdeee7",
  accentSurface: "#f4f4f5",
  accentSurfaceForeground: INK,
  messageSurface: "#f4f4f5",
  messageForeground: INK,
  messageAction: "#ea580c",
  messageActionForeground: INK,
  messageActionHover: "#ec6924",
  codeBackground: "#ffffff",
  codeForeground: INK,
  searchMatchBackground: "#ffd9b8",
  searchMatchForeground: "#21180a",
  searchMatchActiveBackground: "#ffb547",
  searchMatchActiveForeground: "#21180a",
  sidebar: "#fafafa",
  sidebarForeground: INK,
  sidebarMutedForeground: "#71717a",
  sidebarControlSurface: "#f4f4f5",
  sidebarRowHover: "#f4f4f5",
  sidebarRowActive: "#ffffff",
  sidebarRowSelected: "#ffffff",
  sidebarBorder: "#e4e4e7",
  terminalBackground: "#fcfcfc",
  terminalForeground: INK,
  terminalCursor: "#ea580c",
  terminalSelection: "#f9d0bb",
  terminalScrollbar: "#d4d4d8",
  terminalScrollbarHover: "#a1a1aa",
};

export const FLARE_THEME: EnvironmentThemeFile = {
  version: 1,
  name: "t3flare",
  appearance: "dark",
  colors: FLARE_DARK,
  variants: { light: FLARE_LIGHT },
};

/** The file as written: compared with what is there, so an unchanged theme is not rewritten. */
export const FLARE_THEME_JSON = `${JSON.stringify(FLARE_THEME, null, 2)}\n`;

/** Marks, in the Environment DO's storage, that the theme has been made the default (once). */
const FLARE_THEME_SEEDED = "t3flare:seeded/default-theme";

/**
 * Publishes the t3flare theme at each boot, and makes it the default theme once per Environment, while no Environment
 * default was ever set (`defaultThemeSetAt`). Above `EnvironmentTheme.layer` in the composition, which provides the service it publishes through.
 */
export const layerFlareTheme = Layer.effectDiscard(
  Effect.gen(function* () {
    const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const themes = yield* EnvironmentTheme.EnvironmentThemeService;
    const path = `${environmentThemesDir}/${FLARE_THEME_ID}.json`;
    const current = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => null));
    if (current !== FLARE_THEME_JSON) {
      yield* fs.makeDirectory(environmentThemesDir, { recursive: true });
      yield* fs.writeFileString(path, FLARE_THEME_JSON);
    }
    // The State directory has no file watch (platform/fileSystem.ts): a read refreshes t3's published set, and
    // publishes a change to the clients already connected.
    yield* themes.read();

    const marks = environmentServices().marks;
    if (marks.has(FLARE_THEME_SEEDED)) return;
    const settings = yield* ServerSettings.ServerSettingsService;
    // A set time means the owner (or an agent at their asking) chose a theme, the stock one included: theirs stands.
    if ((yield* settings.getSettings).defaultThemeSetAt === "") {
      yield* themes.apply({ themeId: FLARE_THEME_ID });
      yield* Effect.logInfo("t3flare: the t3flare theme is the default theme");
    }
    marks.set(FLARE_THEME_SEEDED);
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("t3flare: the t3flare theme was not published", cause))),
);
