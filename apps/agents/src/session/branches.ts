// G6 (SPI-997 fork, SPI-987 rollback): the Session's conversation moved back to an earlier point, or seeded from another
// Session's. pi-durable keeps entries immutable, so neither rewrites history: a rollback forks the conversation at the
// entry before the first dropped turn (`Conversation.fork`: the fork sees its parent's entries up to there, and its
// documents, code mode's `store` among them, as they were then), and a fork across threads, whose Sessions are separate
// Durable Objects, copies the source's model context into a new conversation of the target. Either way the Session then
// runs the new conversation (`SessionDO`'s conversation pointer); the old one stays in storage as history.
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, EntryId, Harness } from "@earendil-works/pi-durable";
import type { ForkSourcePage, TurnState } from "@t3flare/session-protocol";

/** The most a page of a fork's messages carries over DO RPC (its limit is 32 MiB). */
export const FORK_PAGE_BYTES = 4 * 1024 * 1024;
/** The most one seeded entry holds, well under a Durable Object SQLite row's 2 MB. */
export const SEED_ENTRY_BYTES = 512 * 1024;
/** The kind of the entries a fork is seeded with: model context, no turn of the thread's own. */
export const FORK_ENTRY_KIND = "t3flare.fork";

const ownerless = { ownership: { kind: "ownerless" } } as const;
const sizeOf = (value: unknown): number => (JSON.stringify(value) ?? "").length;

/** A conversation as a thread starts one: `from`'s model, thinking level and cwd, no entries, no documents. */
export const freshConversation = async (harness: Harness, from: Conversation, context: Context): Promise<Conversation> => {
  const agent = await from.agent(context);
  return harness.createConversation(
    {
      ...ownerless,
      agent: { ...(agent.model === undefined ? {} : { model: agent.model }), thinkingLevel: agent.thinkingLevel, ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }) },
    },
    context,
  );
};

/**
 * What a rollback drops: the named turns the Session knows, and every turn placed at or after the first of them (the
 * conversation loses those entries too). `boundary` is that first turn's input entry, or undefined when no named turn
 * was ever placed (nothing of the conversation changes).
 */
export const rollbackPlan = (
  turns: Readonly<Record<string, TurnState>>,
  dropTurns: ReadonlyArray<string>,
): { readonly boundary: number | undefined; readonly drop: ReadonlySet<string> } => {
  const named = dropTurns.filter((id) => turns[id] !== undefined);
  const placed = named.flatMap((id) => (turns[id]!.inputEntry === undefined ? [] : [Number(turns[id]!.inputEntry)]));
  const boundary = placed.length === 0 ? undefined : Math.min(...placed);
  const drop = new Set(named);
  if (boundary !== undefined) {
    for (const [id, turn] of Object.entries(turns)) if (turn.inputEntry !== undefined && Number(turn.inputEntry) >= boundary) drop.add(id);
  }
  return { boundary, drop };
};

/** `current` as it was just before entry `boundary`: a fork at the entry before it, or a fresh conversation when none is. */
export const rewind = async (harness: Harness, current: Conversation, boundary: number, context: Context): Promise<Conversation> => {
  const before = (await current.entries({ maxEntryId: (boundary - 1) as EntryId, order: "descending" }, 1, undefined, context)).items[0];
  return before === undefined ? freshConversation(harness, current, context) : current.fork(before.id, ownerless, context);
};

/**
 * The entry a fork from `providerTurnId` ends at: the last of `current`'s entries before the next turn's input, or its
 * newest. Throws for a turn this Session never placed (t3 then hands the fork its portable context).
 */
export const forkPoint = async (
  current: Conversation,
  turns: Readonly<Record<string, TurnState>>,
  providerTurnId: string,
  context: Context,
): Promise<EntryId> => {
  const input = turns[providerTurnId]?.inputEntry;
  if (input === undefined) throw new Error(`t3flare: turn ${providerTurnId} is not in this Session's conversation`);
  const later = Object.values(turns).flatMap((turn) => (turn.inputEntry !== undefined && Number(turn.inputEntry) > Number(input) ? [Number(turn.inputEntry)] : []));
  const next = later.length === 0 ? undefined : Math.min(...later);
  const last = (await current.entries({ ...(next === undefined ? {} : { maxEntryId: (next - 1) as EntryId }), order: "descending" }, 1, undefined, context)).items[0];
  if (last === undefined) throw new Error(`t3flare: turn ${providerTurnId} has no entries`);
  return last.id;
};

/** A page of the model context `current` had at entry `at`, from message `offset`, about `bytes` long (one at least). */
export const forkPage = async (current: Conversation, at: EntryId, offset: number, bytes: number, context: Context): Promise<ForkSourcePage> => {
  const { messages } = await current.context(context, { at });
  const page: Array<unknown> = [];
  let size = 0;
  let index = offset;
  while (index < messages.length) {
    const next = sizeOf(messages[index]);
    if (page.length > 0 && size + next > bytes) break;
    page.push(messages[index]);
    size += next;
    index += 1;
  }
  return { at: String(at), messages: page, next: index < messages.length ? index : null };
};

/** Writes `messages` into `target` as model context, in entries of about SEED_ENTRY_BYTES (one message at least). */
export const seed = async (target: Conversation, messages: ReadonlyArray<unknown>, data: { readonly source: string; readonly at: string }, context: Context): Promise<void> => {
  let batch: Array<unknown> = [];
  let size = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    // SAFETY: the messages are pi-ai messages, as the source's `Conversation.context()` gave them.
    const submission = await target.submit({ type: "write", entry: { kind: FORK_ENTRY_KIND, model: batch as never, data } }, context);
    await submission.wait(context);
    batch = [];
    size = 0;
  };
  for (const message of messages) {
    const next = sizeOf(message);
    if (batch.length > 0 && size + next > SEED_ENTRY_BYTES) await flush();
    batch.push(message);
    size += next;
  }
  await flush();
};
