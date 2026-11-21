// An MCP server's form as the owner sees it: the `ElicitationForm` made of the server's `requestedSchema`, so no reader
// takes raw JSON Schema. The normalizer that makes one and the validator that checks an answer against it are in
// `elicitation.ts`.
import * as Schema from "effect/Schema";

/** The kinds of field a form has: a string by its format, a number or an integer, a boolean, one choice or several. */
export const ELICITATION_FIELD_KINDS = [
  "text",
  "email",
  "url",
  "date",
  "date_time",
  "number",
  "integer",
  "boolean",
  "choice",
  "multi_choice",
] as const;

export type ElicitationFieldKind = (typeof ELICITATION_FIELD_KINDS)[number];

/** One option of a choice: the value sent, and the title shown. */
export const ElicitationOption = Schema.Struct({
  value: Schema.String,
  title: Schema.String,
});

export type ElicitationOption = typeof ElicitationOption.Type;

/** What every field has: its name (the key of its value), its title and description as plain text, and whether it is required. */
const Common = {
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  required: Schema.Boolean,
};

/** A field of a form, by kind. Text is plain: the Session has stripped control and bidi-override characters. */
export const ElicitationField = Schema.Union([
  Schema.Struct({
    ...Common,
    kind: Schema.Literals(["text", "email", "url", "date", "date_time"]),
    default: Schema.optionalKey(Schema.String),
    minLength: Schema.optionalKey(Schema.Int),
    maxLength: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literals(["number", "integer"]),
    default: Schema.optionalKey(Schema.Finite),
    min: Schema.optionalKey(Schema.Finite),
    max: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("boolean"),
    default: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("choice"),
    options: Schema.Array(ElicitationOption),
    default: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("multi_choice"),
    options: Schema.Array(ElicitationOption),
    default: Schema.Array(Schema.String).pipe(Schema.optionalKey),
    minItems: Schema.optionalKey(Schema.Int),
    maxItems: Schema.optionalKey(Schema.Int),
  }),
]);

export type ElicitationField = typeof ElicitationField.Type;

/** A form: its fields, in the order the server listed them. A form with none is a confirmation gate. */
export const ElicitationForm = Schema.Struct({
  fields: Schema.Array(ElicitationField),
});

export type ElicitationForm = typeof ElicitationForm.Type;

/** What the owner enters for one field, as it goes to the server: a string, a number, a boolean, or a list of strings. */
export const ElicitationValue = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Array(Schema.String),
]);

export type ElicitationValue = typeof ElicitationValue.Type;

/** The values of a form by field name; an empty optional field is left out. */
export const ElicitationContent = Schema.Record(Schema.String, ElicitationValue);

export type ElicitationContent = typeof ElicitationContent.Type;
