// The Settings server's tools (ADR-0035, plan §3 "The tools"): static definitions, the same for every caller and both
// doors, so the list changes only with a deploy. Input schemas are generated from the registry (extension ids, setting
// names and their limits, sizes, Exposures); server and skill names are validated at call time. Every tool's class is
// fixed: reads are `read`, writes are `write` (plan D7), and `readOnlyHint` says so.
//
// `resume` (plan D12) is not among them: it is `RESUME_TOOL`, the Owner-client endpoint's alone in `model` (M5b,
// SPI-1201), never the in-process server's.
import { ENVIRONMENT_SETTINGS, type EnvironmentFieldSchema, EXTENSIONS, type ToolClass } from "@t3flare/harness-registry";

import { CHANGE_TTL_MS, durationText } from "./changes.ts";

export interface SettingsTool {
  readonly name: string;
  readonly class: ToolClass;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** What the server covers, said the same to both doors (plan D17). */
const SETTINGS_SCOPE =
  "t3flare's own settings: the Harness settings (Pi Durable's extensions and the MCP server set), the Environment settings (Container size, idle time, budget, Variables, Global mise config) and the Environment skills. These are not t3's preferences (t3_environment_preferences_update). Read tools run.";

/** What agents are told about the server (plan D17): its instructions and its tools' descriptions, nothing else. */
export const SETTINGS_INSTRUCTIONS =
  `${SETTINGS_SCOPE} Every write names the expectedRevision it read, and the thread's mode rules it: plan mode refuses writes; outside full access a write waits for the owner's card; a change that widens what agents have or can do always waits for the owner's answer on a card or its Change page (at most ${durationText(CHANGE_TTL_MS)}, one at a time per thread). Do not repeat a declined change.`;

/**
 * The same for an Owner client (plan D11, D12): it has no thread mode, and its asked changes wait on the Change page in
 * its Elicitation mode.
 */
export const SETTINGS_OWNER_INSTRUCTIONS =
  `${SETTINGS_SCOPE} Every write names the expectedRevision it read. A change that narrows what agents have or can do applies at once; one that widens it waits for the owner's answer on its Change page (at most ${durationText(CHANGE_TTL_MS)}): open the link the result or the question gives, and do not repeat the call; read the settings to see whether it applied. Do not repeat a declined change.`;

/**
 * What an Owner client is told besides, by its Elicitation mode (plan D12): the mode the owner set for this client on the
 * Harness panel, or the URL's `?elicitation_mode=` override (so the text does not say which).
 */
export const OWNER_MODE_INSTRUCTIONS = {
  browser: "",
  native: " This client is in the native Elicitation mode: such a change is asked as a form in your client, and its Accept applies it.",
  model:
    " This client is in the model Elicitation mode: such a change answers approval-required with a requestId: show it to the user, then call resume with the requestId and their answer. A change that takes a secret, starts a sign-in or installs or updates skills waits on its Change page instead.",
} as const;

const ASKED_NOTE = "Changes that widen what agents have or can do (the Change tier `asked`) wait for the owner's answer, on his card or the Change page, before they apply; turning things down is `free`.";

const EXPOSURES = ["direct", "deferred", "codemode", "hidden"] as const;

const expectedRevision = (entity: string) => ({ type: "integer", minimum: 0, description: `The ${entity} revision you read (get_settings or a write's result); a moved one is refused with the current revision.` });

/** One setting's schema as JSON Schema. */
const fieldJson = (schema: EnvironmentFieldSchema): Record<string, unknown> => {
  switch (schema.type) {
    case "boolean":
      return { type: "boolean" };
    case "integer":
      return { type: "integer", minimum: schema.minimum, maximum: schema.maximum };
    case "enum":
      return { type: "string", enum: [...schema.values] };
    case "text":
      return { type: "string", maxLength: schema.maxLength };
    case "file":
      return { type: "string", description: `At most ${schema.maxBytes} bytes of UTF-8.` };
    case "variables":
      return { type: "object", additionalProperties: { type: "string" }, description: "The whole set of Variables, NAME: value; never a credential." };
  }
};

/** The changeable extensions (a locked one, or one with no switch and no settings, cannot be changed by anyone). */
const CHANGEABLE = EXTENSIONS.filter((entry) => entry.locked === undefined && (entry.default !== "always" || Object.keys(entry.settings).length > 0));

const extensionSettings = (): string =>
  CHANGEABLE.filter((entry) => Object.keys(entry.settings).length > 0)
    .map((entry) => `${entry.id}: ${Object.keys(entry.settings).join(", ")}`)
    .join("; ");

const settingNames = [...new Set(CHANGEABLE.flatMap((entry) => Object.keys(entry.settings)))].sort();

export const SETTINGS_TOOLS: ReadonlyArray<SettingsTool> = [
  {
    name: "get_settings",
    class: "read",
    description:
      "Reads the Harness settings (entity harness: each Pi Durable extension's switch and settings) or the Environment settings (entity environment: Container size, idle time, budget, Variables, Global mise config, with the running Containers and costs): the revision, every setting resolved, its limits and its Change tier rule.",
    inputSchema: { type: "object", required: ["entity"], properties: { entity: { type: "string", enum: ["harness", "environment"] } }, additionalProperties: false },
  },
  {
    name: "list_mcp_servers",
    class: "read",
    description: "Lists the MCP server set with the Harness revision: each server's kind, switch, Exposure and sign-in state (a secret only as set or not). Name a server to list its tools with class, hint and Exposure.",
    inputSchema: { type: "object", properties: { server: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "list_skills",
    class: "read",
    description: "Lists the Environment skills with the Environment revision. Name a skill to read its SKILL.md and its files.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "get_status",
    class: "read",
    description: "The Harness panel's Status (which revisions Sessions and Workspaces took, skills), the Settings server's access switch, and this caller's open changes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_audit",
    class: "read",
    description: "Reads the settings' audit log, newest first: 20 entries by default, at most 50; pass the answer's `before` to page.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 }, before: { type: "integer", minimum: 0 } }, additionalProperties: false },
  },
  {
    name: "test_mcp_server",
    class: "read",
    description: "Lists one MCP server's tools now, as the panel's Test does, and answers its status.",
    inputSchema: { type: "object", required: ["server"], properties: { server: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "preview_skills",
    class: "read",
    description: "Previews the skills at a GitHub source (owner/repo, a tree URL, or owner/repo/path@ref): the candidates at the resolved commit, with digests. Installs nothing.",
    inputSchema: { type: "object", required: ["source"], properties: { source: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "check_skill_updates",
    class: "read",
    description: "Checks the kept Environment skills (all, or those named) against their source: per skill, current or the commit to update to.",
    inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, additionalProperties: false },
  },
  {
    name: "change_extension",
    class: "write",
    description: `Changes one Pi Durable extension's switch or some of its settings (the Harness settings). Settings by extension: ${extensionSettings()}. Applies at each thread's next turn. ${ASKED_NOTE}`,
    inputSchema: {
      type: "object",
      required: ["expectedRevision", "extension"],
      properties: {
        expectedRevision: expectedRevision("Harness"),
        extension: { type: "string", enum: CHANGEABLE.map((entry) => entry.id) },
        enabled: { type: "boolean" },
        settings: { type: "object", propertyNames: { enum: settingNames }, description: "Some of the extension's settings, by name; get_settings lists each one's limits." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "change_mcp",
    class: "write",
    description: `Changes the MCP server set (the Harness settings): op server (enabled, exposure, toolExposure by upstream tool name with null for the server's, writes for the Settings server only), op class (a tool's class read, write, or null for its own hint), op add (a Direct server: url and auth none, header with the header's name, or oauth; a header value is typed by the owner on the Change page, never here), op remove, or op header-value (asks the owner to type a header server's value on the Change page). ${ASKED_NOTE}`,
    inputSchema: {
      type: "object",
      required: ["expectedRevision", "change"],
      properties: {
        expectedRevision: expectedRevision("Harness"),
        change: {
          type: "object",
          required: ["op", "server"],
          properties: {
            op: { type: "string", enum: ["server", "class", "add", "remove", "header-value"] },
            server: { type: "string" },
            enabled: { type: "boolean" },
            exposure: { type: "string", enum: [...EXPOSURES] },
            toolExposure: { type: "object", additionalProperties: { anyOf: [{ type: "string", enum: [...EXPOSURES] }, { type: "null" }] } },
            writes: { type: "boolean" },
            tool: { type: "string" },
            class: { anyOf: [{ type: "string", enum: ["read", "write"] }, { type: "null" }] },
            url: { type: "string" },
            auth: {
              type: "object",
              required: ["kind"],
              properties: { kind: { type: "string", enum: ["none", "header", "oauth"] }, header: { type: "string" } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "start_mcp_sign_in",
    class: "write",
    description: "Asks the owner to start an OAuth sign-in for a Direct server added with auth oauth. The sign-in happens in the owner's browser from the Change page, never through an agent.",
    inputSchema: { type: "object", required: ["expectedRevision", "server"], properties: { expectedRevision: expectedRevision("Harness"), server: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "change_environment",
    class: "write",
    description: `Changes some of the Environment settings. Applies when each Workspace's Container next starts, not in one running now. ${ASKED_NOTE}`,
    inputSchema: {
      type: "object",
      required: ["expectedRevision", "settings"],
      properties: {
        expectedRevision: expectedRevision("Environment"),
        settings: {
          type: "object",
          properties: Object.fromEntries(Object.entries(ENVIRONMENT_SETTINGS).map(([key, entry]) => [key, fieldJson(entry.schema as EnvironmentFieldSchema)])),
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "change_skills",
    class: "write",
    description: `Changes the Environment skills (their revision is the Environment settings'): op install (source, the previewed 40-hex commit, folders), update (name, commit from check_skill_updates), enable, disable or remove (name). ${ASKED_NOTE}`,
    inputSchema: {
      type: "object",
      required: ["expectedRevision", "op"],
      properties: {
        expectedRevision: expectedRevision("Environment"),
        op: { type: "string", enum: ["install", "update", "enable", "disable", "remove"] },
        source: { type: "string" },
        commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        folders: { type: "array", items: { type: "string" } },
        name: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

export const settingsToolOf = (name: string): SettingsTool | undefined => SETTINGS_TOOLS.find((tool) => tool.name === name);

/**
 * `resume` (plan D12's `model`): Executor's shape, a `requestId` and a `response` with its `action`, so that
 * `isPausingServer` is true of a tool list that includes it. A write: it applies the change it accepts.
 */
export const RESUME_TOOL: SettingsTool = {
  name: "resume",
  class: "write",
  description:
    "Answers a change that waits for approval (a write's approval-required result): requestId from that result, and response.action accept (applies it), decline (refuses it; do not ask again) or cancel (withdraws it). Call it only with the user's answer.",
  inputSchema: {
    type: "object",
    required: ["requestId", "response"],
    properties: {
      requestId: { type: "string" },
      response: { type: "object", required: ["action"], properties: { action: { enum: ["accept", "decline", "cancel"] }, content: { type: "object" } } },
    },
  },
};

/** A tool as an MCP definition: its name, description, input schema, and `readOnlyHint` from its class. */
export const toolDefinition = (tool: SettingsTool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: tool.class === "read" } });

/** The tools as MCP definitions, by name: what the MCP host lists as the server's inventory. */
export const settingsDefinitions = (): Readonly<Record<string, Readonly<Record<string, unknown>>>> => Object.fromEntries(SETTINGS_TOOLS.map((tool) => [tool.name, toolDefinition(tool)]));
