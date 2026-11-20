// Fonts load once, here; every scene and element imports this module so a standalone composition has them too.
import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";

loadGeist("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] });
loadGeistMono("normal", { weights: ["400", "500"], subsets: ["latin"] });

// For plain (non-interactive) markup. Interactive elements write their values inline so Studio can edit them.
export const SANS = "Geist, ui-sans-serif, system-ui, sans-serif";
export const MONO = "'Geist Mono', ui-monospace, monospace";
export const FLARE_GRADIENT = "linear-gradient(90deg, #FF7A1A 0%, #FFB547 100%)";
export const TEXT = "#f5f5f5";
export const MUTED = "#a3a3a3";
export const BORDER = "rgba(255, 255, 255, 0.08)";
