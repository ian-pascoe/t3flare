// A setting's schema and its validation, shared by the Harness settings' extension registry (index.ts) and the
// Environment settings (environment.ts): the panel renders a form from each and the API validates against it.
import { variablesProblem } from "./variables.ts";

/** A setting's schema: the JSON Schema subset the panel renders as a form and the API validates against. */
export type FieldSchema =
  | { readonly type: "boolean"; readonly default: boolean }
  | { readonly type: "integer"; readonly minimum: number; readonly maximum: number; readonly default: number }
  | { readonly type: "enum"; readonly values: ReadonlyArray<string>; readonly default: string }
  /** Free text (SPI-1058: guardian's rules and policy, typed as pi-guardian's menu takes them); `multiline` is a text area. */
  | { readonly type: "text"; readonly maxLength: number; readonly default: string; readonly multiline?: boolean };

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
  }
};
