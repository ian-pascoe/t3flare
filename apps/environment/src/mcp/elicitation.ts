// An MCP server's questions as t3 cards (SPI-1079, ADR-0028's elicitation refinement; cloudpid ADR-0041's rules as
// ported). Pure: the MCP host makes a card of each question a server asks during an agent's call, and of each pause an
// Executor-style server returns, and turns the owner's answer back into what the server gets. The caller (the Session or
// the CLI relay) only shows the card.
//
// - A form with no fields, an Executor `approval-required` and a page (URL mode) are t3's own `mcp-elicitation` approval
//   cards, as t3's Codex adapter shows an approval-shaped elicitation; a form with fields is a `user_input` card, one
//   question per field, as t3's ACP adapter builds one (`parseElicitationForm`), plus a last Send / Decline question.
// - Declined unseen (the server is told `decline`, the card never raised): a form whose field asks for a credential (the
//   spec forbids it, and t3 keeps a `user_input` answer in its event log), and a page that is not on HTTPS, is on a local
//   or private host, or is on t3flare's own host.
// - Refused (Legacy: a JSON-RPC error; Modern: the call ends): a malformed or over-bound form, a malformed page, a
//   Sampling request (not offered).
// - Nothing here keeps an answer; logs name fields, never values.
// @effect-diagnostics cryptoRandomUUID:off
import { checkElicitationUrl } from "@cloudpid/mcp/elicitation-url";
import {
  MCP_INVALID_PARAMS,
  type McpInputAnswer,
  type McpInputRequest,
  type NormalizedForm,
  normalizeElicitationForm,
  plainLine,
  plainMessage,
  validateElicitation,
} from "@cloudpid/mcp/types";
import { cardText } from "@t3flare/harness-registry";
import { MCP_QUESTION_MARKER, type McpCardQuestion, type McpQuestionAnswer, type McpQuestionCard } from "@t3flare/session-protocol";
import * as Result from "effect/Result";

/** The form card's last question: send the answers, or decline the form. */
export const SEND_QUESTION = "t3flare_send";
const SEND = "send";
const DECLINE = "decline";

/** What a question is about: the server, and the agent's call it came from. */
export interface QuestionContext {
  readonly server: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Whether a host (lowercase, ASCII) is t3flare's own. */
  readonly isOwnHost: (host: string) => boolean;
}

/** The answer a server gets, as the engine's `onInput` returns it. */
export type ElicitAnswer = typeof McpInputAnswer.Encoded;

/** The spec's `ElicitResult`, with a note when the owner's answer could not be sent as given. */
export interface ElicitResultOrCancel {
  readonly result: { readonly action: "accept" | "decline" | "cancel"; readonly content?: Record<string, string | number | boolean | Array<string>> };
  readonly note?: string;
}

/** What to do with a question: show `card` and turn its answer back with `answerOf`, or answer at once (`now`). */
export type QuestionPlan =
  | { readonly kind: "card"; readonly card: McpQuestionCard; readonly answerOf: (answer: McpQuestionAnswer) => ElicitResultOrCancel }
  | { readonly kind: "now"; readonly answer: ElicitAnswer; readonly why: string };

export const newCardId = (): string => `${MCP_QUESTION_MARKER}-${crypto.randomUUID()}`;

const decline = (why: string): QuestionPlan => ({ kind: "now", answer: { kind: "answered", result: { action: "decline" } }, why });
const refuse = (why: string): QuestionPlan => ({ kind: "now", answer: { kind: "refused", message: why, code: MCP_INVALID_PARAMS }, why });

const callLine = (context: QuestionContext): string => cardText(`The agent's call: ${context.server}: ${context.tool}\n${JSON.stringify(context.args, null, 2)}`, 8 * 1024);

const approvalOptions = (accept: string): NonNullable<McpQuestionCard["options"]> => [
  { decision: "accept", label: accept },
  { decision: "decline", label: "Decline" },
  { decision: "cancel", label: "Cancel" },
];

/** A decision as the server gets it: only an accept accepts. */
export const actionOf = (decision: McpQuestionAnswer["decision"]): "accept" | "decline" | "cancel" =>
  decision === "accept" || decision === "acceptForSession" ? "accept" : decision === "decline" ? "decline" : "cancel";

/** An answer as t3 hands it (a string, a list, or `{ answers }`), unwrapped. */
const unwrap = (value: unknown): unknown => (typeof value === "object" && value !== null && !Array.isArray(value) && "answers" in value ? unwrap((value as { answers: unknown }).answers) : value);

const single = (value: unknown): unknown => {
  const plain = unwrap(value);
  return Array.isArray(plain) ? plain[0] : plain;
};

type ElicitationForm = NormalizedForm["form"];
type Field = ElicitationForm["fields"][number];

const optionsOf = (options: ReadonlyArray<{ readonly value: string; readonly title: string }>) =>
  options.map((option) => {
    const label = plainLine(option.title, 200) || option.value;
    return { label, description: label, value: option.value };
  });

/** One field as t3's `user_input` question (`parseElicitationForm`'s shapes). */
const questionOf = (field: Field, index: number, message: string): McpCardQuestion => {
  const header = plainLine(field.title ?? field.name, 60) || `Question ${index + 1}`;
  const text = plainLine(field.description ?? "", 500) || plainLine(field.title ?? "", 500) || plainLine(message, 500) || field.name;
  const base = { id: field.name, header, question: field.required ? text : `${text} (optional)`, required: field.required };
  switch (field.kind) {
    case "boolean":
      return { ...base, options: [{ label: "Yes", description: "Yes", value: "true" }, { label: "No", description: "No", value: "false" }], allowCustomAnswer: false };
    case "choice":
      return { ...base, options: optionsOf(field.options), allowCustomAnswer: false };
    case "multi_choice":
      return { ...base, options: optionsOf(field.options), multiSelect: true, allowCustomAnswer: false };
    default:
      return { ...base, options: [] };
  }
};

/** The owner's answer to one field, typed as the field takes it (the core's validator checks it after). */
const valueOf = (field: Field, raw: unknown): unknown => {
  if (raw === undefined || raw === null) return undefined;
  switch (field.kind) {
    case "boolean": {
      const value = single(raw);
      return value === true || value === "true" ? true : value === false || value === "false" ? false : value;
    }
    case "number":
    case "integer": {
      const value = single(raw);
      return typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : value;
    }
    case "multi_choice": {
      const value = unwrap(raw);
      return Array.isArray(value) ? value : value === "" ? [] : [value];
    }
    default:
      return single(raw);
  }
};

/** A form's card: its questions, the Send / Decline question, and the answers turned into the form's content. */
const formPlan = (form: ElicitationForm, title: string, prompt: string, server: string): QuestionPlan => {
  if (form.fields.some((field) => field.name === SEND_QUESTION)) return refuse(`a field is named ${SEND_QUESTION}, which t3flare's card uses`);
  const send: McpCardQuestion = {
    id: SEND_QUESTION,
    header: "Send",
    question: `Send these answers to ${plainLine(server, 60)}?`,
    options: [
      { label: "Send", description: "Send the answers above", value: SEND },
      { label: "Decline", description: "Send nothing; the server is told you declined", value: DECLINE },
    ],
    allowCustomAnswer: false,
    required: true,
  };
  // A `user_input` card has no prompt of its own: what the server says, and the agent's call, lead its first question.
  const asked = form.fields.map((field, index) => questionOf(field, index, ""));
  const questions = asked.map((question, index) => (index === 0 ? { ...question, question: `${prompt}\n\n${question.question}` } : question));
  const card: McpQuestionCard = { id: newCardId(), kind: "form", server, title, prompt, questions: [...questions, send] };
  return {
    kind: "card",
    card,
    answerOf: (answer) => {
      if (answer.answers === undefined) return { result: { action: actionOf(answer.decision) === "accept" ? "cancel" : actionOf(answer.decision) } };
      const answers = answer.answers;
      if (single(answers[SEND_QUESTION]) !== SEND) return { result: { action: "decline" } };
      const entered: Record<string, unknown> = {};
      for (const field of form.fields) {
        const value = valueOf(field, Object.hasOwn(answers, field.name) ? answers[field.name] : undefined);
        if (value !== undefined && value !== "") entered[field.name] = value;
      }
      const checked = validateElicitation(form, entered as never);
      if (Result.isFailure(checked)) {
        const problems = Object.entries(checked.failure).map(([name, problem]) => `${name === "" ? "the answer" : name} ${problem}`);
        return { result: { action: "cancel" }, note: `the answer did not fit the form (${problems.join("; ").slice(0, 300)})` };
      }
      return { result: { action: "accept", content: checked.success as never } };
    },
  };
};

/** A form (an elicitation's, or an Executor `input-required`'s): declined unseen when it asks for a credential. */
const formOrApproval = (requested: unknown, title: string, prompt: string, server: string, accept: string): QuestionPlan => {
  const normalized = normalizeElicitationForm(requested as never);
  if (Result.isFailure(normalized)) return refuse(`the form is malformed: ${normalized.failure}`);
  const { form, notes, credential } = normalized.success;
  if (credential !== undefined) return decline(`the form asks for a credential ('${plainLine(credential, 60)}'), so t3flare declined it unseen`);
  const noted = notes.length === 0 ? prompt : `${prompt}\n\n(t3flare: ${notes.join("; ")})`;
  if (form.fields.length === 0) {
    const card: McpQuestionCard = { id: newCardId(), kind: "approval", server, title, prompt: noted, options: approvalOptions(accept) };
    return { kind: "card", card, answerOf: (answer) => ({ result: { action: actionOf(answer.decision) } }) };
  }
  return formPlan(form, title, noted, server);
};

/** The plan for a question a server asked during an agent's call (the engine's `onInput`). */
export const planQuestion = (request: typeof McpInputRequest.Encoded, context: QuestionContext): QuestionPlan => {
  if (request.kind !== "elicitation") return refuse("t3flare answers no Sampling request");
  const params = request.params as { message?: unknown; mode?: unknown; requestedSchema?: unknown; url?: unknown };
  const message = typeof params.message === "string" ? plainMessage(params.message) : "";
  const server = plainLine(context.server, 60);
  if (params.mode === "url") {
    if (typeof params.url !== "string") return refuse("a page question without a URL");
    const page = checkElicitationUrl(params.url, context.isOwnHost);
    if (Result.isFailure(page)) {
      const reason = page.failure.reason.replace("cloudpid's", "t3flare's");
      return page.failure.kind === "declined" ? decline(`the page was declined unseen: ${reason}`) : refuse(reason);
    }
    const { url, host, domain, warning } = page.success;
    const warn = warning === undefined ? "" : `\nWarning: the host is ${warning === "idn" ? "internationalized" : "a mix of scripts"}; check it is the one you expect.`;
    const prompt = cardText(`${server} asks you to open a page.\n\n${message}\n\nPage: ${url}\nSite: ${domain} (host ${host})${warn}\n\nOpen it in your browser and finish there, then choose "Opened it". Decline sends nothing.\n\n${callLine(context)}`);
    const card: McpQuestionCard = { id: newCardId(), kind: "approval", server: context.server, title: cardText(`${server}: open ${domain}?`, 200), prompt, options: approvalOptions("Opened it") };
    return { kind: "card", card, answerOf: (answer) => ({ result: { action: actionOf(answer.decision) } }) };
  }
  if (params.mode !== undefined && params.mode !== "form") return refuse(`an elicitation of mode ${plainLine(JSON.stringify(params.mode), 30)}`);
  const prompt = cardText(`${server} asks:\n\n${message}\n\n${callLine(context)}`);
  return formOrApproval(params.requestedSchema ?? { type: "object", properties: {} }, cardText(`${server} asks`, 200), prompt, context.server, "Approve");
};

// ---------------------------------------------------------------------------------------------------------------------
// Executor-style pauses ("Through your agent", Executor's `model` mode): a `call` or `execute` result that is a pause,
// and a `resume` that takes the answer. t3flare answers it from the owner's card and calls `resume` itself.

/** A pause, as Executor's model mode returns it in `structuredContent`. */
export interface Pause {
  readonly status: "approval-required" | "input-required";
  readonly requestId: string;
  readonly message: string;
  readonly requestedSchema: unknown;
  /** Executor's own description of what waits (its `elicitation._meta`), shown whole. */
  readonly meta: unknown;
  readonly expiresAt?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a server's tools include a `resume` that takes the answer (Executor's model mode; browser mode's takes only `requestId`). */
export const isPausingServer = (definitions: Readonly<Record<string, Readonly<Record<string, unknown>>>>): boolean => {
  const schema = definitions["resume"]?.inputSchema;
  const properties = isRecord(schema) ? schema.properties : undefined;
  return isRecord(properties) && "requestId" in properties && "response" in properties;
};

/** The pause a tool result is, or undefined. */
export const pauseOf = (result: unknown): Pause | undefined => {
  const content = isRecord(result) ? result.structuredContent : undefined;
  if (!isRecord(content)) return undefined;
  const { status, requestId, elicitation, expiresAt } = content;
  if ((status !== "approval-required" && status !== "input-required") || typeof requestId !== "string" || requestId === "") return undefined;
  const form = isRecord(elicitation) ? elicitation : {};
  return {
    status,
    requestId,
    message: typeof form.message === "string" ? form.message : "",
    requestedSchema: form.requestedSchema ?? { type: "object", properties: {} },
    meta: form._meta,
    ...(typeof expiresAt === "string" ? { expiresAt } : {}),
  };
};

/** The card for a pause: Executor's own text of what waits (its message and `_meta`), and the agent's call. */
export const planPause = (pause: Pause, context: QuestionContext): QuestionPlan => {
  const server = plainLine(context.server, 60);
  const meta = pause.meta === undefined ? "" : `\n\nWhat ${server} says waits (its own details):\n${JSON.stringify(pause.meta, null, 2)}`;
  const expires = pause.expiresAt === undefined ? "" : `\nExpires ${pause.expiresAt}.`;
  const what = pause.status === "approval-required" ? "approval" : "input";
  const prompt = cardText(`${server} asks for your ${what}:\n\n${plainMessage(pause.message)}${meta}${expires}\n\n${callLine(context)}`);
  const title = cardText(pause.status === "approval-required" ? `${server}: approve?` : `${server} asks`, 200);
  if (pause.status === "approval-required") {
    // Executor refuses an approval that carries field values: an approval is a bare accept, whatever its schema says.
    const card: McpQuestionCard = { id: newCardId(), kind: "approval", server: context.server, title, prompt, options: approvalOptions("Approve") };
    return { kind: "card", card, answerOf: (answer) => ({ result: { action: actionOf(answer.decision) } }) };
  }
  return formOrApproval(pause.requestedSchema, title, prompt, context.server, "Continue");
};
