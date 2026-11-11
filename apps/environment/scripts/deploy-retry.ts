/**
 * Whether a failed first `alchemy deploy` is the brand-new-stage failure that a two-pass deploy fixes: a Worker's
 * Durable Object binding to a class in the other Worker, which does not exist yet. Cloudflare's API rejects that
 * with "Cannot create binding for class '<name>' because it is not currently configured to implement Durable
 * Objects" (same-script) or "Cannot create binding for class in script '<name>' that does not exist" (cross-script),
 * both with `[code: 10061]` (https://github.com/cloudflare/workers-sdk/issues/10034). alchemy
 * (2.0.0-beta.85) has no text of its own for it; it surfaces the API's message, so match on that.
 * Any other failure must not retry: the first pass deploys without the bindings, which unbinds a live stage.
 */
export const isDurableObjectClassNotFound = (output: string): boolean => /Cannot create binding for class|\bcode"?:? ?10061\b/i.test(output);
