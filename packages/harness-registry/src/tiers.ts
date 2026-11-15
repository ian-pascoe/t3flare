// Change tiers (ADR-0035 §3, plan D5): whether a Settings change runs on its own (`free`) or waits for an answer
// (`asked`). Decided by direction: what narrows what agents have, reach, spend or run is free; what widens it, puts new
// text or code in front of them, destroys something, turns off a Guard, or touches the Settings server's own entry is
// asked. Fails closed: anything this function does not know (an unknown extension, setting, key or operation, a setting
// with no declared tier, a tool whose own hint is unknown) is asked. A change that moves nothing is `unchanged`.
//
// Pure over the stored entities, so the panel, the Settings server and the tests judge with the same function. It does
// not validate: the registry's change functions refuse what is malformed, before or after this runs.
import { applyEnvironmentChange, type EnvironmentChange, ENVIRONMENT_SETTINGS, resolveEnvironment, settingOf, type StoredEnvironment } from "./environment.ts";
import type { SettingTier } from "./fields.ts";
import { EXTENSIONS, type HarnessChange, type McpChange, mcpServersOf, resolveHarness, type StoredHarness } from "./index.ts";
import { type Exposure, ownEntry, type ToolClass } from "./mcp.ts";

export type ChangeTier = "free" | "asked";

/**
 * What a change answered on the Change page alone needs there (plan D6; `oversize` is the renderer's, not this
 * function's): a secret typed there, a sign-in started there, or skills whose SKILL.md text and files only the page
 * shows (an install or update: a card would offer Approve on text it cannot show, SPI-1199 review).
 */
export type NeedsPage = "secret" | "sign-in" | "skills";

export type TierVerdict =
  | { readonly tier: ChangeTier; readonly reasons: ReadonlyArray<string>; readonly needsPage?: NeedsPage }
  /** The change moves nothing: it has no tier, and is answered `unchanged`. */
  | { readonly tier: "unchanged"; readonly reasons: ReadonlyArray<string>; readonly needsPage?: undefined };

/** MCP changes beyond `McpChange`: a header value for an existing header-auth Direct server, and an OAuth sign-in's start. */
export type McpTierChange = McpChange | { readonly op: "header-value"; readonly server: string } | { readonly op: "sign-in"; readonly server: string };

/** The Environment skills' operations (ADR-0033), as a tier sees them. */
export type SkillsTierChange = { readonly op: "install" | "update" | "remove"; readonly name?: string } | { readonly op: "enable"; readonly name: string; readonly enabled: boolean };

export type TierInput =
  | { readonly entity: "extension"; readonly stored: StoredHarness; readonly change: HarnessChange }
  | {
      readonly entity: "mcp";
      readonly stored: StoredHarness;
      readonly change: McpTierChange;
      /** A tool's own class from its `readOnlyHint`, undefined when unknown (not listed, or no inventory). */
      readonly hintedClass?: (server: string, tool: string) => ToolClass | undefined;
    }
  | { readonly entity: "environment"; readonly stored: StoredEnvironment; readonly change: EnvironmentChange }
  | { readonly entity: "skills"; readonly change: SkillsTierChange };

/** The order Exposure widens in (plan D5): `hidden` < `codemode` < `deferred` = `direct`. */
const EXPOSURE_RANK: Readonly<Record<Exposure, number>> = { hidden: 0, codemode: 1, deferred: 2, direct: 2 };

/** An Exposure's rank; one this function does not know ranks above every other (fails closed). */
const rankOf = (exposure: unknown): number => (typeof exposure === "string" ? (ownEntry(EXPOSURE_RANK, exposure) ?? 3) : 3);

/** One part of a change: whether it is asked, and why in words. */
interface Part {
  readonly asked: boolean;
  readonly reason: string;
}

/** The verdict over the parts that move something: asked when any is (plan D5: a call that moves several things). */
const verdictOf = (parts: ReadonlyArray<Part>, needsPage?: NeedsPage): TierVerdict => {
  if (parts.length === 0) return { tier: "unchanged", reasons: [] };
  const asked = parts.filter((part) => part.asked);
  return {
    tier: asked.length > 0 ? "asked" : "free",
    reasons: (asked.length > 0 ? asked : parts).map((part) => part.reason),
    ...(needsPage === undefined ? {} : { needsPage }),
  };
};

/** One setting's move from `before` to `after` under its tier rule. */
const settingPart = (name: string, tier: SettingTier | undefined, before: unknown, after: unknown): Part => {
  const shown = `${name}: ${JSON.stringify(before)} to ${JSON.stringify(after)}`;
  if (tier === "free") return { asked: false, reason: `${shown} (free in either direction)` };
  if (tier === "down-free") {
    const down = (typeof after === "boolean" && after === false) || (typeof after === "number" && typeof before === "number" && after < before);
    return down ? { asked: false, reason: `${shown} (turned down)` } : { asked: true, reason: `${shown} (turned up)` };
  }
  return { asked: true, reason: `${shown} (every change to it is asked)` };
};

const extensionTier = (stored: StoredHarness, change: HarnessChange): TierVerdict => {
  const entry = EXTENSIONS.find((each) => each.id === change.extension);
  if (entry === undefined) return { tier: "asked", reasons: [`${change.extension}: not an extension this registry knows`] };
  const current = resolveHarness(stored).extensions[entry.id]!;
  const parts: Array<Part> = [];
  // Only `false` narrows; anything else that is not `true` would resolve to the default, so it is asked (fails closed).
  if (change.enabled !== undefined && typeof change.enabled !== "boolean") parts.push({ asked: true, reason: `${entry.id}: a switch that is not true or false` });
  else if (change.enabled !== undefined && change.enabled !== current.enabled) {
    if (change.enabled) parts.push({ asked: true, reason: `${entry.id}: turned on` });
    else if (entry.guard === true) parts.push({ asked: true, reason: `${entry.id}: a Guard turned off` });
    else parts.push({ asked: false, reason: `${entry.id}: turned off` });
  }
  for (const [key, value] of Object.entries(change.settings ?? {})) {
    const setting = ownEntry(entry.settings, key);
    if (setting === undefined) {
      parts.push({ asked: true, reason: `${entry.id}.${key}: not a setting this registry knows` });
      continue;
    }
    const before = current.settings[key];
    if (before === value) continue;
    // A Guard's settings are asked whatever their own rule (plan D5).
    parts.push(settingPart(`${entry.id}.${key}`, entry.guard === true ? undefined : setting.tier, before, value));
  }
  return verdictOf(parts);
};

const mcpTier = (stored: StoredHarness, change: McpTierChange, hintedClass: (server: string, tool: string) => ToolClass | undefined): TierVerdict => {
  const server = change.server;
  const servers = mcpServersOf(stored);
  const current = ownEntry(servers, server);
  // The Settings server is known by its kind (plan D2); `mcpServersOf` lets no other entry take its name.
  const isSettingsServer = current?.kind === "settings";
  if (change.op === "add") return verdictOf([{ asked: true, reason: `${server}: a new server` }], change.auth.kind === "header" ? "secret" : undefined);
  if (change.op === "remove") return verdictOf([{ asked: true, reason: `${server}: removed, with its secrets` }]);
  if (change.op === "header-value") return verdictOf([{ asked: true, reason: `${server}: its header value set` }], "secret");
  if (change.op === "sign-in") return verdictOf([{ asked: true, reason: `${server}: an OAuth sign-in started` }], "sign-in");
  // Every change to the Settings server's own entry is asked, narrowing included (plan D5).
  const mark = (part: Part): Part => (isSettingsServer ? { asked: true, reason: `${part.reason} (the Settings server's own entry)` } : part);
  if (current === undefined) return { tier: "asked", reasons: [`${server}: not a server in the set`] };
  if (change.op === "class") {
    const before = ownEntry(current.classes, change.tool);
    const after = change.class ?? undefined;
    if (before === after) return { tier: "unchanged", reasons: [] };
    const name = `${server}/${change.tool}`;
    if (change.class === "write") return verdictOf([mark({ asked: false, reason: `${name}: marked write` })]);
    if (change.class === "read") return verdictOf([mark({ asked: true, reason: `${name}: marked read` })]);
    if (change.class !== null) return verdictOf([mark({ asked: true, reason: `${name}: a class this registry does not know` })]);
    const hint = hintedClass(server, change.tool);
    if (hint === undefined) return verdictOf([mark({ asked: true, reason: `${name}: back to its own hint, which is unknown` })]);
    if (hint === "read" && before === "write") return verdictOf([mark({ asked: true, reason: `${name}: back to its own hint, read` })]);
    return verdictOf([mark({ asked: false, reason: `${name}: back to its own hint, ${hint}` })]);
  }
  const parts: Array<Part> = [];
  if (change.enabled !== undefined && typeof change.enabled !== "boolean") parts.push({ asked: true, reason: `${server}: a switch that is not true or false` });
  else if (change.enabled !== undefined && change.enabled !== current.enabled) {
    parts.push(mark(change.enabled ? { asked: true, reason: `${server}: turned on` } : { asked: false, reason: `${server}: turned off` }));
  }
  // The Settings server's writes switch (plan D2): only its own entry has one, so every move of it is asked.
  if (change.writes !== undefined && !isSettingsServer) parts.push({ asked: true, reason: `${server}: has no writes switch` });
  else if (change.writes !== undefined && change.writes !== (current.writes ?? true)) {
    parts.push(mark(change.writes ? { asked: true, reason: `${server}: write tools turned on` } : { asked: false, reason: `${server}: write tools turned off` }));
  }
  const exposureAfter = change.exposure ?? current.exposure;
  if (change.exposure !== undefined && change.exposure !== current.exposure) {
    const up = rankOf(change.exposure) > rankOf(current.exposure);
    parts.push(mark({ asked: up, reason: `${server}: Exposure ${current.exposure} to ${change.exposure}` }));
  }
  // Each tool named, against its effective Exposure before and after (its own, else the server's).
  for (const [tool, exposure] of Object.entries(change.toolExposure ?? {})) {
    const toolOwn = ownEntry(current.toolExposure, tool);
    const before = toolOwn ?? current.exposure;
    const after = exposure ?? exposureAfter;
    if (before === after && (exposure ?? undefined) === toolOwn) continue;
    if (before === after) {
      // Its own Exposure set or cleared to what it already was: nothing an agent sees moves.
      parts.push(mark({ asked: false, reason: `${server}/${tool}: Exposure stays ${after}` }));
      continue;
    }
    parts.push(mark({ asked: rankOf(after) > rankOf(before), reason: `${server}/${tool}: Exposure ${before} to ${after}` }));
  }
  return verdictOf(parts);
};

const environmentTier = (stored: StoredEnvironment, change: EnvironmentChange): TierVerdict => {
  for (const key of Object.keys(change.settings)) if (ownEntry(ENVIRONMENT_SETTINGS as Readonly<Record<string, unknown>>, key) === undefined) return { tier: "asked", reasons: [`${key}: not a setting this registry knows`] };
  const applied = applyEnvironmentChange(stored, change);
  // Malformed: the change function refuses it; until then it is asked.
  if (!applied.ok) return { tier: "asked", reasons: [applied.error] };
  const before: Readonly<Record<string, unknown>> = resolveEnvironment(stored);
  const after: Readonly<Record<string, unknown>> = resolveEnvironment(applied.environment);
  return verdictOf(applied.changed.map((key) => settingPart(key, settingOf(key).tier, before[key], after[key])));
};

const skillsTier = (change: SkillsTierChange): TierVerdict => {
  const name = change.name === undefined ? "skills" : change.name;
  switch (change.op) {
    case "install":
      return verdictOf([{ asked: true, reason: `${name}: installed` }], "skills");
    case "update":
      return verdictOf([{ asked: true, reason: `${name}: updated` }], "skills");
    case "remove":
      return verdictOf([{ asked: true, reason: `${name}: removed` }]);
    case "enable":
      return verdictOf([change.enabled ? { asked: true, reason: `${name}: enabled` } : { asked: false, reason: `${name}: disabled` }]);
    default:
      return { tier: "asked", reasons: ["an operation this registry does not know"] };
  }
};

/** The Change tier of one Settings change against the stored entity it changes (plan D5). */
export const tierOf = (input: TierInput): TierVerdict => {
  switch (input.entity) {
    case "extension":
      return extensionTier(input.stored, input.change);
    case "mcp":
      return mcpTier(input.stored, input.change, input.hintedClass ?? (() => undefined));
    case "environment":
      return environmentTier(input.stored, input.change);
    case "skills":
      return skillsTier(input.change);
    default:
      return { tier: "asked", reasons: ["an entity this registry does not know"] };
  }
};
