// Adapted from cloudpid@93ba45a3:packages/extensions/src/todo/tool.ts (SPI-1055): the `todo` tool, pi-todo's parameters,
// atomic batches and structured output, over the conversation's Todo document, as a plain pi-durable tool (cloudpid's
// is an Effect tool). A call reads and changes the list in one commit, so it sees the list as the last call left it and
// a failure changes nothing. Every result's text ends with the whole list, so the model's context shows the current
// list wherever the last call is, and the projection only has to fill in when no call is.
// @effect-diagnostics asyncFunction:off
import { defineTool, type ToolRegistration, type ToolTaskInput } from "@earendil-works/pi-durable";
import { arr, int, nullable, obj, oneOf, opt, str } from "@earendil-works/pi-schema";

import { MAX_CHANGED_BY, TODO_STATUSES, TodoDoc, type TodoState } from "./doc.ts";
import { applyTodo, formatTasks, MAX_DESCRIPTION_CHARACTERS, MAX_TITLE_CHARACTERS, TODO_ACTIONS, type TodoInput, type TodoList, type TodoOutcome } from "./list.ts";

/** The key of a result's `details` that names the revision of the list its text shows, for the projection. */
export const SHOWN_REV = "todoRev";

const taskId = (description?: string) => int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, ...(description === undefined ? {} : { description }) });
const status = (description: string) => oneOf(TODO_STATUSES, { description });
const title = (description: string) => str({ maxLength: MAX_TITLE_CHARACTERS, description });
const descriptionField = (description: string) => str({ maxLength: MAX_DESCRIPTION_CHARACTERS, description });

/** Models often send `null` for a field they leave out, as pi-todo's `acceptNullForOptionalArguments` expects. */
const PARAMETERS = obj({
  action: oneOf(TODO_ACTIONS),
  id: opt(nullable(taskId("Task ID for update or remove; not allowed with updates"))),
  title: opt(nullable(title(`Task title (at most ${MAX_TITLE_CHARACTERS} characters) for add or update; not allowed with tasks or updates`))),
  description: opt(
    nullable(
      descriptionField(`Optional Task description (at most ${MAX_DESCRIPTION_CHARACTERS} characters); null removes it during update; not allowed with tasks or updates`),
    ),
  ),
  tasks: opt(
    nullable(
      arr(obj({ title: title("Task title"), description: opt(nullable(descriptionField("Optional Task description"))) }), {
        minItems: 1,
        description: "Tasks to add in one call, all or none, with sequential IDs; use instead of title and description",
      }),
    ),
  ),
  updates: opt(
    nullable(
      arr(
        obj({
          id: taskId("Task ID"),
          status: opt(nullable(status("New Task status"))),
          title: opt(nullable(title("New Task title"))),
          description: opt(nullable(descriptionField("New Task description; null removes it"))),
        }),
        { minItems: 1, description: "Task changes to apply in one call, all or none, one per Task ID; use instead of id, title, description, and status" },
      ),
    ),
  ),
  status: opt(nullable(status("Task status; for add, applies to every new Task; not allowed with updates"))),
});

const TASK_SCHEMA = {
  type: "object",
  properties: { id: { type: "integer" }, title: { type: "string" }, description: { type: "string" }, status: { type: "string", enum: [...TODO_STATUSES] } },
  required: ["id", "title", "status"],
};

/** Flat, as pi-todo's: `action` (and whether the request carried `tasks` or `updates`) says which field is present. */
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...TODO_ACTIONS], description: "The operation that ran" },
    tasks: {
      type: "array",
      items: TASK_SCHEMA,
      description: "list: every Task in ID order; add with tasks: the Tasks created, in ID order; update with updates: the Tasks changed, in request order",
    },
    task: TASK_SCHEMA,
    id: { type: "integer", description: "remove: ID of the removed Task" },
    cleared: { type: "integer", minimum: 0, description: "clear: number of Tasks removed" },
  },
  required: ["action"],
};

interface Args {
  readonly action: TodoInput["action"];
  readonly id?: number | null;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly tasks?: ReadonlyArray<{ readonly title: string; readonly description?: string | null }> | null;
  readonly updates?: ReadonlyArray<{ readonly id: number; readonly status?: TodoState["tasks"][number]["status"] | null; readonly title?: string | null; readonly description?: string | null }> | null;
  readonly status?: TodoState["tasks"][number]["status"] | null;
}

/** The call's input with each `null` the model sent for a field it left out taken as absent; `null` stays where it means "remove". */
const inputOf = (args: Args): TodoInput => ({
  action: args.action,
  id: args.id ?? undefined,
  title: args.title ?? undefined,
  description: args.description,
  tasks: args.tasks?.map((task) => ({ title: task.title, description: task.description ?? undefined })),
  updates: args.updates?.map((update) => ({ id: update.id, title: update.title ?? undefined, description: update.description, status: update.status ?? undefined })),
  status: args.status ?? undefined,
});

/** The document's list, as the actions take it: a copy, so a draft is never kept by what they return. */
const listOf = (state: TodoState): TodoList => ({ nextId: state.nextId, tasks: state.tasks.map((task) => ({ ...task })) });

/** The text of a result: what the call did, then the whole list. */
const textOf = (outcome: Extract<TodoOutcome, { ok: true }>, list: string): string => (outcome.output.action === "list" ? list : `${outcome.message}\n${list}`);

export const TODO_DESCRIPTION =
  "Manage this conversation's Todo List: flat Tasks with a title, an optional description, and a status (pending, active, completed). Actions list, add, update, remove, clear. add takes a title, or tasks to add several; update takes an id and fields, or updates to change several; both batches are all or nothing. Every result shows the whole list. The owner sees the list in the thread.";

export const todoTool = (): ToolRegistration =>
  defineTool({
    name: "todo",
    description: TODO_DESCRIPTION,
    parameters: PARAMETERS,
    structuredOutputSchema: OUTPUT_SCHEMA,
    executionMode: "sequential",
    replay: "safe",
    async execute(args, api, context) {
      const input = inputOf(args as Args);
      // Whether this is a nested call, and of which call.
      const task = await api.getTask(api.taskId, context);
      // SAFETY: a tool call's task is a `pi.tool` task, whose input is a `ToolTaskInput`.
      const caller = task?.input as ToolTaskInput | undefined;
      // A failure leaves the document as it was: only a successful change writes.
      const applied = await api.commit(async (tx) => {
        const state = await tx.doc(TodoDoc, api.conversationId);
        const list = listOf(state);
        const outcome = applyTodo(list, input);
        // An action that changes nothing (`list`, `clear` of an empty list) hands back the list it was given.
        if (outcome.ok && outcome.list !== list) {
          state.nextId = outcome.list.nextId;
          state.tasks = outcome.list.tasks.map((each) => ({ ...each }));
          state.rev += 1;
          // A nested call (a script's) leaves no result in the context: remember whose, so that its result shows the list.
          if (caller?.kind === "nested") state.changedBy = [...state.changedBy, caller.parentCallId].slice(-MAX_CHANGED_BY);
        }
        return { outcome, rev: state.rev, text: formatTasks(state.tasks) };
      }, context);
      if (!applied.outcome.ok) throw new Error(applied.outcome.message);
      return {
        output: [{ type: "text" as const, text: textOf(applied.outcome, applied.text) }],
        structuredOutput: applied.outcome.output as never,
        details: { [SHOWN_REV]: applied.rev },
      };
    },
  });
