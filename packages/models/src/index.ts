// The Durable agents' static model list (ADR-0012): config in pi's `models.json` shape, what runs before the proxy's own list
// has been read (`./catalog`), and the defaults. The proxy's base URL and key are Worker settings, never named here. Shared by the agents Worker (the Session's
// pi-ai models) and the environment Worker (the provider's snapshot and text generation), so neither imports the other.
import modelsJson from "./models.json" with { type: "json" };

/** One model as pi's `models.json` lists it. */
export interface ModelEntry {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: ReadonlyArray<"text" | "image">;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/** A model as t3 names it: `<provider>/<id>`, the slug a model selection carries. */
export interface CatalogModel extends ModelEntry {
  readonly provider: string;
  /** Who makes it (`Anthropic`, `Google`, …), by its id; `OTHER_VENDOR` when that is not known. The picker's label and group. */
  readonly vendor: string;
  readonly api: string;
  readonly slug: string;
}

/** Thinking levels pi offers a reasoning model (t3's Pi picker shows the same; xhigh and max need a per-model opt-in). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const DEFAULT_MODEL_SLUG = "anthropic/claude-sonnet-5-5";
export const DEFAULT_THINKING: ThinkingLevel = "medium";
/** The model text generation and the acceptance test use: small and cheap. */
export const SMALL_MODEL_SLUG = "anthropic/claude-haiku-5-5";

/**
 * Who makes each model, by its real id's family. The proxy's own `owned_by` names the route it serves a model through
 * (`opencode`, `antigravity`), never the vendor, so it is not read at all.
 */
const VENDORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude-/, "Anthropic"],
  [/^(?:gpt-|o\d)/, "OpenAI"],
  [/^(?:gemini|gemma)-/, "Google"],
  [/^deepseek-/, "DeepSeek"],
  [/^grok-/, "xAI"],
  [/^kimi-/, "Moonshot AI"],
  [/^glm-/, "Z.ai"],
  [/^qwen/, "Alibaba"],
  [/^minimax-/, "MiniMax"],
  [/^mimo-/, "Xiaomi"],
  [/^longcat-/, "Meituan"],
  [/^nemotron-/, "NVIDIA"],
  [/^step-/, "StepFun"],
  [/^(?:mistral|codestral|devstral|magistral|ministral)-/, "Mistral"],
  [/^llama-/, "Meta"],
];

/** The label of a model whose vendor is not known. */
export const OTHER_VENDOR = "Other";

/** A model's vendor by its real id (`claude-haiku-5-5` is Anthropic's), or undefined when its family is not known. */
export const vendorOf = (id: string): string | undefined => VENDORS.find(([family]) => family.test(id))?.[1];

export const CATALOG: ReadonlyArray<CatalogModel> = Object.entries(modelsJson.providers).flatMap(([provider, block]) =>
  block.models.map((model) => ({
    ...(model as ModelEntry),
    provider,
    vendor: vendorOf(model.id) ?? OTHER_VENDOR,
    api: block.api,
    slug: `${provider}/${model.id}`,
  })),
);
