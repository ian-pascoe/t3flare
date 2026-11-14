// A setting's schema and its validation, shared by the Harness settings' extension registry (index.ts) and the
// Environment settings (environment.ts): the panel renders a form from each and the API validates against it.
import { variablesProblem } from "./variables.ts";

/** A setting's schema: the JSON Schema subset the panel renders as a form and the API validates against. */
export type FieldSchema =
  | { readonly type: "boolean"; readonly default: boolean }
  | { readonly type: "integer"; readonly minimum: number; readonly maximum: number; readonly default: number }
  | { readonly type: "enum"; readonly values: ReadonlyArray<string>; readonly default: string }
  /** Free text (SPI-1058: guardian's rules and policy, typed as pi-guardian's menu takes them); `multiline` is a text area. */
  | { readonly type: "text"; readonly maxLength: number; readonly default: string; readonly multiline?: boolean }
  /**
   * The text of a file a Container gets (SPI-1150: the Global mise config): at most `maxBytes` of UTF-8, no NUL, line
   * ends stored as LF (`normalizeField`). The panel renders it as a monospace text area without `maxlength`, which would
   * count UTF-16 units; this check is the limit.
   */
  | { readonly type: "file"; readonly maxBytes: number; readonly default: string };

/**
 * An Environment setting's schema: a field's, or Variables (SPI-1152): `{ NAME: "value" }`, checked by
 * `variablesProblem`, which the panel renders as a list. Harness settings hold scalars only.
 */
export type EnvironmentFieldSchema = FieldSchema | { readonly type: "variables"; readonly default: Readonly<Record<string, string>> };

export type SettingValue = boolean | number | string;

/** A value an Environment setting may hold: a Harness setting's, or a set of Variables (SPI-1152). */
export type EnvironmentValue = SettingValue | Readonly<Record<string, string>>;

export interface SettingEntry {
  readonly title: string;
  readonly description: string;
  readonly schema: FieldSchema;
}

/** An Environment setting: a `SettingEntry` whose schema may also be Variables. */
export interface EnvironmentSettingEntry {
  readonly title: string;
  readonly description: string;
  readonly schema: EnvironmentFieldSchema;
}

const utf8 = new TextEncoder();

/** Why `text` cannot be a `file` field of at most `maxBytes` (cloudpid's `toolchainsProblem`), or undefined. */
const fileProblem = (text: string, maxBytes: number): string | undefined => {
  if (text.includes("\u0000")) return "contains a NUL character";
  // A UTF-16 unit is at most 3 bytes of UTF-8 (a surrogate pair 4 for 2 units): only a long text needs encoding.
  if (text.length > maxBytes / 3 && utf8.encode(text).length > maxBytes) return `is longer than ${maxBytes / 1024} KiB of UTF-8`;
  return undefined;
};

/** `value` as it is stored: a `file` field's line ends as LF, so a browser's CRLF round trip is never a change. */
export const normalizeField = (schema: EnvironmentFieldSchema, value: unknown): unknown =>
  schema.type === "file" && typeof value === "string" ? value.replaceAll("\r\n", "\n") : value;

/** Why `value` does not fit `schema`, or undefined. */
export const fieldProblem = (schema: EnvironmentFieldSchema, value: unknown): string | undefined => {
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean" ? undefined : "true or false";
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return "an integer";
      if (value < schema.minimum) return `at least ${schema.minimum}`;
      return value > schema.maximum ? `at most ${schema.maximum}` : undefined;
    case "enum":
      return typeof value === "string" && schema.values.includes(value) ? undefined : `one of ${schema.values.join(", ")}`;
    case "text":
      return typeof value === "string" && value.length <= schema.maxLength ? undefined : `text of at most ${schema.maxLength} characters`;
    case "variables":
      return variablesProblem(value);
    case "file":
      return typeof value === "string" ? fileProblem(value, schema.maxBytes) : "text";
  }
};
