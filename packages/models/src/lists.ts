// A model list as an endpoint serves it (SPI-1162's discovery): Anthropic's paged `/v1/models` or the OpenAI-shaped
// `/models`, both `{ data: [{ id, … }] }`. Every field but the id is optional.
//
// Commissary lists a model that is not Claude under an alias in Anthropic's shape, `claude-fable-5-dd-` and its real id
// spelled backwards (`claude-fable-5-dd-eerf-maeb` is `beam-free`): an endpoint at Commissary reads it back to the real
// id (`realIdOf`), which both of its id forms answer to.

/** One model of a list, in either shape. */
export interface ListedModel {
  readonly id: string;
  readonly displayName?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

const CLOAK_PREFIX = "claude-fable-5-dd-";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

/** A page of a list in either shape, or undefined when the body is not one. */
export const parseList = (
  body: unknown,
): { readonly models: ReadonlyArray<ListedModel>; readonly lastId: string | undefined } | undefined => {
  if (!isRecord(body) || !Array.isArray(body.data)) return undefined;
  const models: Array<ListedModel> = [];
  for (const entry of body.data as ReadonlyArray<unknown>) {
    if (!isRecord(entry)) continue;
    const id = text(entry.id);
    if (id === undefined) continue;
    const displayName = text(entry.display_name);
    const contextWindow = count(entry.max_input_tokens);
    const maxTokens = count(entry.max_tokens);
    models.push({
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
  }
  return { models, lastId: body.has_more === true ? text(body.last_id) : undefined };
};

/** The real id behind Commissary's alias for a non-Claude model (the id itself when it is not one). */
export const realIdOf = (id: string): string => (id.startsWith(CLOAK_PREFIX) ? Array.from(id.slice(CLOAK_PREFIX.length)).reverse().join("") : id);
