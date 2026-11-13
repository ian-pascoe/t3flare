// Adapted from cloudpid@93ba45a3:packages/extensions/src/context/tools.ts and store.ts (SPI-1056): `context_notes` and
// `context_history`, with pi-context-management's parameters and limits, as plain pi-durable tools. Notes live in the
// conversation's Notes document (`./notes.ts`); History reads the stored entries (`./history.ts`), which a Handoff or a
// compaction takes out of the model's context but never out of the Session DO's storage.
//
// Changed from cloudpid's: no `lineage` scope (a Durable agent has no subagents in its Session: t3's delegated threads
// are Sessions of their own), so refs are the conversation's own; History is read in pages of stored entries, each in
// its own read, `windows`/`list` keep only a short line per entry and `search` stops once its page is full, so a long
// thread never holds its whole transcript in memory at once; the Notes' total size is bounded.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off extendsNativeError:off
import type { Context } from "@earendil-works/chord";
import { type ConversationId, defineTool, type EntryRecord, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";

import { callRange, describeEntry, entryRef, matchesFilter, PAGE_SIZE, parseRef, READ_CHARACTERS, search, type SearchItem, type SearchMatch, timestampOf } from "./history.ts";
import {
  ContextDoc,
  type ContextState,
  EMPTY_STATE,
  findNote,
  joinAppend,
  MAX_NOTE_CHARACTERS,
  MAX_NOTE_NAME,
  MAX_NOTES,
  MAX_TOTAL_NOTE_CHARACTERS,
  NOTE_NAME,
  noteRef,
} from "./notes.ts";

/** One line per tool for the system prompt, as pi-context-management's prompt guidelines. */
export const CONTEXT_GUIDELINES = {
  context_notes: "Keep named Notes with context_notes; read full Notes only when needed.",
  context_history: "Earlier History, including entries from before a Handoff, is available through context_history.",
  context_rollover: "Before Rollover, update Notes with context_notes, then call context_rollover alone with an explicit continuation Handoff.",
} as const;

/** A decision a commit refuses: it rolls the commit back and becomes the call's error. */
export class Refusal extends Error {}

/** The model reads the JSON text; scripts get the same value as an object. */
const result = (data: Record<string, unknown>) => ({ output: [{ type: "text" as const, text: JSON.stringify(data) }], structuredOutput: data as never });

/** Where the next page starts, or null after the last. */
const nextOffset = (offset: number, shown: number, total: number) => (offset + shown < total ? offset + shown : null);

const fail = (message: string): never => {
  throw new Error(message);
};

/** Conversation `conversationId`'s Notes and saved Handoff. */
export const readContext = async (api: Pick<ToolExecutionApi, "snapshot">, conversationId: ConversationId, context: Context): Promise<ContextState> =>
  (await api.snapshot(ContextDoc, conversationId, context)) ?? EMPTY_STATE;

/** Stored entries read per page (each page is one read). */
const SCAN_PAGE = 200;

/** Every stored entry of conversation `conversationId`, oldest first, including those before a Handoff, a page at a time. */
export async function* storedEntries(api: ToolExecutionApi, conversationId: ConversationId, context: Context): AsyncGenerator<EntryRecord> {
  let cursor: unknown;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page at a time keeps memory bounded
    const page = await api.commit((tx) => tx.scanEntries({ conversationId, order: "ascending" }, SCAN_PAGE, cursor as never), context);
    yield* page.items;
    cursor = page.next;
  } while (cursor !== undefined);
}

/** Entry `id`, when the conversation can see it. */
export const readEntry = (api: ToolExecutionApi, conversationId: ConversationId, id: EntryRecord["id"], context: Context) =>
  api.commit(async (tx) => (await tx.scanEntries({ conversationId, minEntryId: id, maxEntryId: id }, 1)).items[0], context);

/** The Note a reference names: one of this conversation's own. */
const noteAt = async (api: ToolExecutionApi, ref: string, context: Context) => {
  const parsed = parseRef(ref);
  if (parsed?.type !== "note") return fail("Not a Note reference; take one from context_notes list or search");
  if (parsed.conversationId !== api.conversationId) return fail("Reference is not one of this conversation's Notes");
  const note = findNote((await readContext(api, parsed.conversationId, context)).notes, parsed.name);
  return note ?? fail("Note not found");
};

const NOTES_ACTIONS = ["list", "read", "write", "append", "delete", "search", "copy"] as const;

interface NotesArgs {
  readonly action: (typeof NOTES_ACTIONS)[number];
  readonly ref?: string;
  readonly name?: string;
  readonly content?: string;
  readonly query?: string;
  readonly offset?: number;
  readonly limit?: number;
}

const notesTool = async (args: NotesArgs, api: ToolExecutionApi, context: Context) => {
  const self = api.conversationId;
  const offset = args.offset ?? 0;
  const pageSize = Math.min(args.limit ?? PAGE_SIZE, PAGE_SIZE);
  switch (args.action) {
    case "list": {
      const { notes } = await readContext(api, self, context);
      const page = notes.slice(offset, offset + pageSize);
      return result({
        notes: page.map((note) => ({ name: note.name, updated_at: new Date(note.updatedAt).toISOString(), ref: noteRef(self, note.name), characters: note.content.length })),
        total: notes.length,
        next_offset: nextOffset(offset, page.length, notes.length),
      });
    }
    case "search": {
      if (args.query === undefined) return fail("A non-empty literal query is required");
      const notes = (await readContext(api, self, context)).notes.filter((note) => args.name === undefined || note.name === args.name);
      return result(search(notes.map((note): SearchItem => ({ ref: noteRef(self, note.name), content: note.content, name: note.name })), args.query, offset, pageSize));
    }
    case "read": {
      const note =
        args.ref !== undefined
          ? await noteAt(api, args.ref, context)
          : args.name !== undefined
            ? findNote((await readContext(api, self, context)).notes, args.name)
            : fail("A Note name or ref is required");
      if (note === undefined) return fail("Note not found");
      const content = note.content.slice(offset, offset + (args.limit ?? MAX_NOTE_CHARACTERS));
      return result({
        name: note.name,
        ref: noteRef(self, note.name),
        content,
        offset,
        total_characters: note.content.length,
        next_offset: nextOffset(offset, content.length, note.content.length),
      });
    }
    case "write":
    case "append":
    case "delete":
    case "copy": {
      const action = args.action;
      if (action === "copy" && args.ref === undefined) return fail("copy needs the ref of a Note from context_notes list or search");
      const source = action === "copy" && args.ref !== undefined ? await noteAt(api, args.ref, context) : undefined;
      const name = args.name ?? source?.name;
      if (name === undefined) return fail("A Note name is required");
      if ((action === "write" || action === "append") && args.content === undefined) return fail("Note content is required");
      const now = api.now();
      try {
        await api.commit(async (tx) => {
          const state = await tx.doc(ContextDoc, self);
          const index = state.notes.findIndex((note) => note.name === name);
          const existing = state.notes[index];
          if (action === "delete") {
            if (existing === undefined) throw new Refusal("Note not found");
            state.notes.splice(index, 1);
            return;
          }
          if (action === "copy" && existing !== undefined) {
            throw new Refusal(`A Note named ${JSON.stringify(name)} already exists; pass name to copy under another name`);
          }
          if (existing === undefined && state.notes.length >= MAX_NOTES) throw new Refusal("Note limit reached; delete an obsolete Note first");
          const content = action === "append" ? joinAppend(existing?.content ?? "", args.content ?? "") : (source?.content ?? args.content ?? "");
          if (content.length > MAX_NOTE_CHARACTERS) throw new Refusal(`Note exceeds ${MAX_NOTE_CHARACTERS} characters`);
          const others = state.notes.reduce((sum, note) => sum + (note === existing ? 0 : note.content.length), 0);
          if (others + content.length > MAX_TOTAL_NOTE_CHARACTERS) {
            throw new Refusal(`Notes would exceed ${MAX_TOTAL_NOTE_CHARACTERS} characters in all; shorten or delete obsolete Notes first`);
          }
          if (existing === undefined) state.notes.push({ name, content, updatedAt: now });
          else {
            existing.content = content;
            existing.updatedAt = now;
          }
        }, context);
      } catch (error) {
        if (error instanceof Refusal) return fail(error.message);
        throw error;
      }
      return result({ action, name, saved: true });
    }
  }
};

const HISTORY_ACTIONS = ["windows", "list", "read", "search"] as const;

interface HistoryArgs {
  readonly action: (typeof HISTORY_ACTIONS)[number];
  readonly ref?: string;
  readonly window?: string;
  readonly type?: string;
  readonly role?: string;
  readonly query?: string;
  readonly offset?: number;
  readonly limit?: number;
}

/** What `windows` and `list` keep of an entry: never the entry itself. */
interface EntryLine {
  readonly id: EntryRecord["id"];
  readonly head: boolean;
  readonly kind: string;
  readonly role: string | undefined;
  readonly preview: string;
  readonly timestamp: string;
}

const historyTool = async (args: HistoryArgs, api: ToolExecutionApi, context: Context) => {
  const self = api.conversationId;
  const offset = args.offset ?? 0;
  const pageSize = Math.min(args.limit ?? PAGE_SIZE, PAGE_SIZE);

  if (args.action === "read") {
    if (args.ref === undefined) return fail("An entry reference is required");
    const parsed = parseRef(args.ref);
    if (parsed?.type !== "entry") return fail("Not an entry reference; take one from context_history list or search");
    if (parsed.conversationId !== self) return fail("Reference is not in this conversation");
    const entry = await readEntry(api, self, parsed.entryId, context);
    if (entry === undefined) return fail("Entry not found in this conversation");
    const recorded = JSON.stringify(entry);
    const content = recorded.slice(offset, offset + (args.limit ?? READ_CHARACTERS));
    return result({
      ref: args.ref,
      resolved_in_session: String(self),
      format: "recorded-entry-json",
      content,
      offset,
      total_characters: recorded.length,
      next_offset: nextOffset(offset, content.length, recorded.length),
    });
  }

  // The window `args.window` names, by the entry that starts it (a Context Window starts the transcript or at a head marker).
  let startId: EntryRecord["id"] | undefined;
  if (args.window !== undefined) {
    const parsed = parseRef(args.window);
    if (parsed?.type !== "entry" || parsed.conversationId !== self) return fail("No such Context Window in this conversation");
    startId = parsed.entryId;
  }
  const noWindow = () => fail("No such Context Window in this conversation");

  if (args.action === "windows" || args.action === "list") {
    const lines: Array<EntryLine> = [];
    for await (const entry of storedEntries(api, self, context)) {
      lines.push({
        id: entry.id,
        head: lines.length === 0 || entry.head !== undefined,
        kind: entry.kind,
        role: entry.model?.[0]?.role,
        preview: args.action === "list" ? describeEntry(entry) : "",
        timestamp: args.action === "list" ? timestampOf(entry) : "",
      });
    }
    const starts = lines.flatMap((line, index) => (line.head ? [index] : []));
    const windows = starts.map((start, index) => ({ start, end: starts[index + 1] ?? lines.length }));
    if (args.action === "windows") {
      const page = windows.slice(offset, offset + pageSize);
      return result({
        windows: page.map((window) => ({ ref: entryRef(self, lines[window.start]!.id), items: window.end - window.start })),
        total: windows.length,
        next_offset: nextOffset(offset, page.length, windows.length),
      });
    }
    let scoped = lines;
    if (startId !== undefined) {
      const window = windows.find((each) => lines[each.start]?.id === startId) ?? noWindow();
      scoped = lines.slice(window.start, window.end);
    }
    const listed = scoped.filter((line) => (args.type === undefined || line.kind === args.type) && (args.role === undefined || line.role === args.role));
    const page = listed.slice(offset, offset + pageSize);
    return result({
      items: page.map((line) => ({ ref: entryRef(self, line.id), type: line.kind, timestamp: line.timestamp, preview: line.preview })),
      total: listed.length,
      next_offset: nextOffset(offset, page.length, listed.length),
    });
  }

  if (args.query === undefined) return fail("A non-empty literal query is required");
  // Searched as entries are read: one page of matches is kept, and the scan stops once it is full.
  const matches: Array<SearchMatch> = [];
  let skipped = 0;
  let seen = 0;
  let inWindow = startId === undefined;
  for await (const entry of storedEntries(api, self, context)) {
    const head = seen === 0 || entry.head !== undefined;
    seen++;
    if (startId !== undefined) {
      if (inWindow && head) break;
      if (entry.id === startId) {
        if (!head) return noWindow();
        inWindow = true;
      }
    }
    if (!inWindow || !matchesFilter(entry, args.type, args.role)) continue;
    const content = JSON.stringify(entry);
    // A direct search call does not match its own tool-call block.
    const skip = entry.model?.[0]?.role === "assistant" ? callRange(entry, content, api.callId) : undefined;
    for (const match of search([{ ref: entryRef(self, entry.id), content, recorded: true, skip }], args.query, 0, Number.MAX_SAFE_INTEGER).matches) {
      if (skipped < offset) skipped++;
      else if (matches.length < pageSize) matches.push(match);
      else return result({ matches, next_offset: offset + matches.length });
    }
  }
  if (!inWindow) return noWindow();
  return result({ matches, next_offset: null });
};

const NAME = str({ minLength: 1, maxLength: MAX_NOTE_NAME, pattern: NOTE_NAME.source });
const REF = str({ maxLength: 300 });
const QUERY = str({ minLength: 1, maxLength: 256 });

export const contextNotesTool = (): ToolRegistration =>
  defineTool({
    name: "context_notes",
    description: `Conversation Markdown Notes, kept across Handoffs and compactions in this thread's Session. Actions list/read/write/append/delete/search/copy. Names are labels, not paths. read takes a name or a ref from list/search; copy saves the Note a ref names under another name. read returns the whole Note unless offset/limit select a character range; lists return at most 20 Notes. Append starts the new text on a new line unless the Note is empty or already ends with one. Search is case-sensitive literal text. At most ${MAX_NOTES} Notes of ${MAX_NOTE_CHARACTERS} characters, ${MAX_TOTAL_NOTE_CHARACTERS} in all.`,
    parameters: obj({
      action: oneOf(NOTES_ACTIONS),
      ref: opt(REF),
      name: opt(NAME),
      content: opt(str({ maxLength: MAX_NOTE_CHARACTERS })),
      query: opt(QUERY),
      offset: opt(int({ minimum: 0 })),
      limit: opt(int({ minimum: 1, maximum: MAX_NOTE_CHARACTERS })),
    }),
    executionMode: "sequential",
    replay: "safe",
    execute: (args, api, context) => notesTool(args as NotesArgs, api, context),
  });

export const contextHistoryTool = (): ToolRegistration =>
  defineTool({
    name: "context_history",
    description:
      "Read-only stored History of this conversation, including entries from before a Handoff or compaction. windows/list/search are paginated (max 20); read returns exact stored entry JSON, at most 2000 characters per call from a zero-based offset. Search is case-sensitive literal text, with JSON string escaping handled for you; returned offsets address the entry JSON. Optional window limits list/search to one Context Window. Optional type (entry kind, e.g. pi.user) and role (message role, e.g. user) filter list/search; by default every entry is included, and list previews describe each entry's text, tool call, or kind. Search previews are decoded readable text; a direct search call does not match its own tool-call block.",
    parameters: obj({
      action: oneOf(HISTORY_ACTIONS),
      ref: opt(REF),
      window: opt(REF),
      type: opt(str({ maxLength: 64, description: 'list/search: only entries of this kind, e.g. "pi.user", "pi.assistant", "pi.tool-result", "pi.reset", "pi.compaction"' })),
      role: opt(str({ maxLength: 64, description: 'list/search: only entries whose message has this role, e.g. "user", "assistant", "toolResult"' })),
      query: opt(QUERY),
      offset: opt(int({ minimum: 0 })),
      limit: opt(int({ minimum: 1, maximum: READ_CHARACTERS })),
    }),
    executionMode: "sequential",
    replay: "safe",
    execute: (args, api, context) => historyTool(args as HistoryArgs, api, context),
  });
