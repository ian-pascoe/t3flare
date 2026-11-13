// A setting's schema and its validation, shared by the Harness settings' extension registry (index.ts) and the
// Environment settings (environment.ts): the panel renders a form from each and the API validates against it.

/** A setting's schema: the JSON Schema subset the panel renders as a form and the API validates against. */
export type FieldSchema =
  | { readonly type: "boolean"; readonly default: boolean }
  | { readonly type: "integer"; readonly minimum: number; readonly maximum: number; readonly default: number }
  | { readonly type: "enum"; readonly values: ReadonlyArray<string>; readonly default: string }
  /** Free text (SPI-1058: guardian's rules and policy, typed as pi-guardian's menu takes them); `multiline` is a text area. */
  | { readonly type: "text"; readonly maxLength: number; readonly default: string; readonly multiline?: boolean };

export type SettingValue = boolean | number | string;

export interface SettingEntry {
  readonly title: string;
  readonly description: string;
  readonly schema: FieldSchema;
}

/** Why `value` does not fit `schema`, or undefined. */
export const fieldProblem = (schema: FieldSchema, value: unknown): string | undefined => {
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
  }
};
