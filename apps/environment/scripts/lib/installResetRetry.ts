// @effect-diagnostics globalFetch:off
// Loaded with `node --import` by `stage.ts run`: every stage script's fetch retries a reset connection (resetRetry.ts).
import { withResetRetry } from "./resetRetry.ts";

globalThis.fetch = withResetRetry(globalThis.fetch);
