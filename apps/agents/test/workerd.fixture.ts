// The workerd test Worker: the agents Worker's Durable Objects that need no Container or Worker Loader, and a probe of
// computer's VFS tables.
import { Workspace } from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";

import { ContainerBudget } from "../src/budget.ts";
import { SKILLS_MOUNT, type SkillSet } from "@t3flare/skills";

import { repoFileSizes } from "../src/workspace/changeLog.ts";
import { mountWithFallback, skillSetMount, skillSetStore } from "../src/workspace/skillSet.ts";

export { ContainerBudget };

/** A ContainerBudget on a clock that only `advance` moves, so lease timing never depends on how loaded the machine is. */
export class FakeClockContainerBudget extends ContainerBudget {
  #clock = 1_000_000;
  protected override readonly now = () => this.#clock;

  advance(ms: number): void {
    this.#clock += ms;
  }
}

/** The fake-clock budget as a deploy runs it: no `T3FLARE_MAX_CONTAINERS`, so the budget carried with a request judges it. */
export class SettingContainerBudget extends FakeClockContainerBudget {
  protected override readonly maxOverride = () => undefined;
}

export default { fetch: () => new Response("t3flare agents test worker") };

/** A computer Workspace with no backends, over this object's SQLite: the VFS tables as the Workspace DO has them. */
export class VfsProbe extends DurableObject {
  readonly #workspace = new Workspace({ storage: this.ctx.storage, backends: [] });

  async write(path: string, bytes: number): Promise<void> {
    await this.#workspace.ready();
    await this.#workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await this.#workspace.fs.writeFile(path, new Uint8Array(bytes).fill(7));
  }

  async remove(path: string): Promise<void> {
    await this.#workspace.ready();
    await this.#workspace.fs.rm(path);
  }

  async symlink(target: string, path: string): Promise<void> {
    await this.#workspace.ready();
    await this.#workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await this.#workspace.fs.symlink(target, path);
  }

  async sizes(dir: string): Promise<{ largest: number; worktreeBytes: number }> {
    await this.#workspace.ready();
    return repoFileSizes(this.ctx.storage.sql, dir);
  }
}

/**
 * The Workspace DO's Environment skill set (SPI-1148) over a real computer Workspace: the store, the read-only mount and
 * the take with its fallback. A set holding `boom/SKILL.md` fails its copy, as a write computer cannot make would.
 */
export class SkillSetProbe extends DurableObject {
  /** Every copy of a set with files fails: the held set's too, so the mount falls back to the empty set. */
  #failAll = false;

  failAll(on: boolean): void {
    this.#failAll = on;
  }

  readonly #store = skillSetStore({ kv: this.ctx.storage.kv, transactionSync: (closure) => this.ctx.storage.transactionSync(closure) });
  readonly #mount = skillSetMount(this.#store);
  readonly #workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [],
    mounts: {
      [SKILLS_MOUNT]: {
        ...this.#mount,
        materialize: (api) => {
          const files = this.#store.files();
          const fails = files["boom/SKILL.md"] !== undefined || (this.#failAll && Object.keys(files).length > 0);
          return fails ? Promise.reject(new Error("boom")) : this.#mount.materialize(api);
        },
      },
    },
  });

  async take(set: SkillSet): Promise<{ readonly error?: string; readonly hash: string }> {
    await this.#workspace.ready();
    const answer = await this.ctx.blockConcurrencyWhile(() => mountWithFallback(this.#store, () => this.#workspace.remount(), set, () => undefined));
    return { ...answer, hash: this.#store.hash() };
  }

  async listing() {
    return this.#store.listing();
  }

  async read(path: string): Promise<string | null> {
    await this.#workspace.ready();
    return this.#workspace.fs.readFile(path, "utf8").catch(() => null);
  }

  async write(path: string): Promise<string> {
    await this.#workspace.ready();
    return this.#workspace.fs.writeFile(path, "x").then(
      () => "written",
      (error: unknown) => String(error),
    );
  }

  async find(): Promise<ReadonlyArray<string>> {
    await this.#workspace.ready();
    return (await this.#workspace.fs.find(SKILLS_MOUNT).catch(() => [])).map((entry) => entry.path).sort();
  }
}

/**
 * A Session's Model endpoints (SPI-1162) over a real Durable Object's storage: it takes one endpoint, makes one request
 * through its provider (a fetch stub answers as Anthropic's Messages API), and reports what the stub was sent and every
 * value the object stored, so a test can check the key was used and never kept.
 */
export class EndpointsProbe extends DurableObject {
  /** `signIn` (SPI-1164): a ChatGPT sign-in endpoint, its access token as the broker gives it, on OpenAI's Responses API. */
  async run(input: { readonly key: string; readonly signIn?: boolean }): Promise<{ readonly sentKey: string | null; readonly reply: string; readonly stored: string }> {
    const { createModels } = await import("@earendil-works/pi-ai");
    const { SessionEndpoints } = await import("../src/session/endpoints.ts");
    let sentKey: string | null = null;
    const sse = [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ready" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    const item = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ready", annotations: [] }] };
    const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
    const responses = [
      { type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress", model: "gpt-6.1-sol", output: [], usage } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "ready" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_1", object: "response", status: "completed", model: "gpt-6.1-sol", output: [item], usage } },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    const fetcher = (async (url: unknown, init?: RequestInit) => {
      const request = url instanceof Request ? url : new Request(String(url), init);
      sentKey = input.signIn === true ? (request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null) : request.headers.get("x-api-key");
      return new Response(input.signIn === true ? responses : sse, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const models = createModels();
    const endpoints = new SessionEndpoints({
      usage: { session: () => "s", record: () => undefined },
      kv: this.ctx.storage.kv,
      models,
      source: () => ({
        modelEndpoints: async () => ({
          revision: 1,
          endpoints: [
            input.signIn === true
              ? {
                  id: "probe",
                  label: "Probe",
                  api: "openai-responses",
                  baseUrl: "https://api.openai.com/v1",
                  auth: "chatgpt",
                  headers: {},
                  models: [{ id: "claude-haiku-5-5", name: "GPT-6.1 Sol", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false }],
                }
              : {
                  id: "probe",
                  label: "Probe",
                  api: "anthropic-messages",
                  baseUrl: "https://endpoint.example",
                  auth: "api-key",
                  headers: {},
                  models: [{ id: "claude-haiku-5-5", name: "Claude Haiku 5.5", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: true }],
                },
          ],
        }),
        endpointCredential: async () => ({ apiKey: input.key, ...(input.signIn === true ? { expiresAt: 4_000_000_000_000 } : {}) }),
      }),
      fetch: fetcher,
      readMs: 5_000,
    });
    await endpoints.take();
    const model = models.getModel("probe", "claude-haiku-5-5");
    if (model === undefined) throw new Error("no model");
    const message = await models.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    const reply = message.content.map((block) => (block.type === "text" ? block.text : "")).join("") || String(message.errorMessage);
    const kv = JSON.stringify([...this.ctx.storage.kv.list()]);
    const tables = this.ctx.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
      .toArray()
      .map((row) => JSON.stringify(this.ctx.storage.sql.exec(`SELECT * FROM "${row.name}"`).toArray()));
    return { sentKey, reply, stored: `${kv}\n${tables.join("\n")}` };
  }
}
