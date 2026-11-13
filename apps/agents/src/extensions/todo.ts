// Adapted from cloudpid@93ba45a3:packages/extensions/src/todo.ts (SPI-1055; parity row pi-todo): the `todo` extension,
// its tool, the hooks that keep the list in front of the model, and pi-todo's one prompt line. The list lives in the
// Session DO's storage (a pi-durable document, at most 200 Tasks and 20,000 characters as the model reads it); the
// Session pushes it with its state and the Environment's differ shows it as t3's own todo list (parity G5). Changing
// the list changes no file, so plan mode allows it, as t3's other providers' todo lists.
import { defineExtension, type Extension, type Harness, section } from "@earendil-works/pi-durable";

import { TODO_GUIDELINE, todoResult, todoWindow } from "./todo/projection.ts";
import { todoTool } from "./todo/tool.ts";

export const TODO_EXTENSION = "todo";

export { EMPTY_TODO_STATE, TodoDoc, type TodoState, type TodoTask } from "./todo/doc.ts";

/** The `todo` extension; `harness` commits the list's window record (see `./todo/projection.ts`). */
export const todoExtension = (harness: () => Promise<Harness>): Extension =>
  defineExtension({
    name: TODO_EXTENSION,
    tools: [todoTool()],
    hooks: [todoWindow(harness), todoResult()],
    // Fixed text, so it never moves the cache prefix.
    sections: [section("todo", (input) => (input.agent.tools.some((tool) => tool.name === "todo") ? TODO_GUIDELINE : undefined))],
  });
