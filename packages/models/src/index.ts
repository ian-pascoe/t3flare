// What the Durable agents' pickers share across both Workers: the thinking levels and their default. The models
// themselves are the owner's Model endpoints' (`./endpoints`, ADR-0034); there is no static list (SPI-1176).

/** Thinking levels pi offers a reasoning model (t3's Pi picker shows the same; xhigh and max need a per-model opt-in). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const DEFAULT_THINKING: ThinkingLevel = "medium";
