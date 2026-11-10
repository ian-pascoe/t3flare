// The test Worker for the `workerd` project (vitest.config.ts): one plain Durable Object whose storage the
// tests drive with `runInDurableObject`.
import { DurableObject } from "cloudflare:workers";

export class TestObject extends DurableObject {}

export default {
  fetch: () => new Response("t3flare test worker"),
};
