// An endpoint's model list in either shape (`@t3flare/models/lists`, read by discovery): the shapes and Commissary's
// alias read-back, kept from the retired proxy catalog's tests (SPI-1176). The lists are cut from Commissary's real
// answers of 2026-11-11.
import { parseList, realIdOf } from "@t3flare/models/lists";
import { describe, expect, it } from "vitest";

/** OpenAI's shape: real ids, nothing else. */
const PLAIN = {
  object: "list",
  data: [
    { id: "beam-free", object: "model", owned_by: "opencode" },
    { id: "claude-haiku-5-5", object: "model", owned_by: "opencode" },
  ],
};

/** Anthropic's shape, with names and limits, a model that is not Claude under Commissary's alias. */
const ANTHROPIC = {
  data: [
    { id: "claude-fable-5-dd-eerf-maeb", type: "model", display_name: "Beam Free", max_input_tokens: 1048576, max_tokens: 131072 },
    { id: "claude-haiku-5-5", type: "model", display_name: "Claude Haiku 5.5", max_input_tokens: 1000000, max_tokens: 128000 },
  ],
  has_more: false,
  first_id: "claude-fable-5-dd-eerf-maeb",
  last_id: "claude-haiku-5-5",
};

describe("reading a model list", () => {
  it("reads both shapes, every field but the id optional", () => {
    expect(parseList(PLAIN)?.models.map((model) => model.id)).toEqual(["beam-free", "claude-haiku-5-5"]);
    expect(parseList(ANTHROPIC)?.models[0]).toEqual({ id: "claude-fable-5-dd-eerf-maeb", displayName: "Beam Free", contextWindow: 1048576, maxTokens: 131072 });
    expect(parseList({ data: [{ id: "x", display_name: null, max_tokens: 0 }, { nope: 1 }, "x"] })?.models).toEqual([{ id: "x" }]);
    expect(parseList({ data: [], has_more: true, last_id: "z" })?.lastId).toBe("z");
    expect(parseList({ data: [], has_more: false, last_id: "z" })?.lastId).toBeUndefined();
    expect(parseList({ models: [] })).toBeUndefined();
    expect(parseList("nope")).toBeUndefined();
  });

  it("reads Commissary's alias back to the real id", () => {
    expect(realIdOf("claude-fable-5-dd-eerf-maeb")).toBe("beam-free");
    expect(realIdOf("claude-fable-5-dd-hsalf-1.4v-keespeed")).toBe("deepseek-v4.1-flash");
    expect(realIdOf("claude-fable-5-2")).toBe("claude-fable-5-2");
  });
});
