// Adapted from ian-pascoe/pi-extensions@a5e15d1:packages/pi-guardian/src/guardian-assessment.ts (SPI-1058): the Guardian's
// assessment, its parsing and the Decision Table, unchanged but for plain checks in place of typebox's.
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const USER_AUTHORIZATIONS = ["unknown", "low", "medium", "high"] as const;
export type UserAuthorization = (typeof USER_AUTHORIZATIONS)[number];

/**
 * Risk Categories: the only grounds for `high` or `critical` risk. A `high` or `critical`
 * assessment without a valid one is decided as `medium`.
 */
export const riskCategories = [
  "data_egress",
  "credential_access",
  "destruction",
  "persistence",
  "sensitive_path",
  "safety_weakening",
  "remote_code",
  "unreviewed_execution",
  "security_policy",
] as const;
export type RiskCategory = (typeof riskCategories)[number];

/**
 * The Risk Categories a review may name: `security_policy` only when the user configured a
 * Security Policy for the call to violate.
 */
export function validRiskCategories(securityPolicy: boolean): readonly RiskCategory[] {
  return securityPolicy
    ? riskCategories
    : riskCategories.filter((name) => name !== "security_policy");
}

/** A stated category in canonical form: `Data-Egress` and `data egress` mean `data_egress`. */
function normalizedCategory(value: string | null | undefined): string | undefined {
  const text = value
    ?.trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/g, "_");
  return text || undefined;
}

/**
 * The Guardian's required answer; extra fields are tolerated and ignored. The rationale and Risk
 * Category are optional and may be `null`: the category is given only for `high` or `critical`
 * risk, and unless `verbose` is on, so is the rationale. An unknown category is kept out rather
 * than failing the parse; the review asks again once for a `high` or `critical` assessment
 * without a valid one.
 */
const isAssessment = (
  value: unknown,
): value is { risk_level: RiskLevel; user_authorization: UserAuthorization; risk_category?: string | null; rationale?: string | null } => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  const optionalText = (field: unknown) => field === undefined || field === null || typeof field === "string";
  return (
    RISK_LEVELS.includes(fields.risk_level as RiskLevel) &&
    USER_AUTHORIZATIONS.includes(fields.user_authorization as UserAuthorization) &&
    optionalText(fields.risk_category) &&
    optionalText(fields.rationale)
  );
};
/** One Guardian Review's assessment, with the risk as the Guardian stated it. */
export type Assessment = {
  risk: RiskLevel;
  authorization: UserAuthorization;
  /** The valid Risk Category the Guardian named, if any. */
  category: RiskCategory | undefined;
  rationale: string;
};

/** Whether a `high` or `critical` assessment names no valid Risk Category. */
export function uncategorized(assessment: Assessment): boolean {
  return (
    (assessment.risk === "high" || assessment.risk === "critical") &&
    assessment.category === undefined
  );
}

/** The risk the Decision Table uses: `medium` for an uncategorized `high` or `critical`. */
export function decidedRisk(assessment: Assessment): RiskLevel {
  return uncategorized(assessment) ? "medium" : assessment.risk;
}

/** Outcome of a Guardian Review, derived only by the Decision Table. */
export type Outcome = "allowed" | "rejected";

/**
 * Decision Table: `low` and `medium` risk are allowed; `high` risk is allowed only with at least
 * `medium` User Authorization; `critical` risk is always rejected.
 */
export function decide(risk: RiskLevel, authorization: UserAuthorization): Outcome {
  if (risk === "low" || risk === "medium") return "allowed";
  if (risk === "high" && (authorization === "medium" || authorization === "high")) return "allowed";
  return "rejected";
}

/** Every top-level `{…}` span in a reply, skipping braces inside JSON strings. */
function objectSpans(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  // Every structural character is ASCII, so UTF-16 indexes are safe here.
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && depth > 0) inString = true;
    else if (character === "{") {
      if (depth++ === 0) start = index;
    } else if (character === "}" && depth > 0 && --depth === 0)
      spans.push(text.slice(start, index + 1));
  }
  return spans;
}

/** The assessment a JSON text holds, if it is a valid one. */
function assessmentIn(
  candidate: string,
  categories: readonly RiskCategory[],
): Assessment | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  if (!isAssessment(parsed)) return undefined;
  const stated = normalizedCategory(parsed.risk_category);
  return {
    risk: parsed.risk_level,
    authorization: parsed.user_authorization,
    category: categories.find((name) => name === stated),
    rationale: parsed.rationale?.trim() ?? "",
  };
}

/** Valid assessments in a reply: the whole text, or each top-level JSON object in it. */
function assessments(text: string, categories: readonly RiskCategory[]): Assessment[] {
  return [text.trim(), ...objectSpans(text)].flatMap(
    (candidate) => assessmentIn(candidate, categories) ?? [],
  );
}

/** The index of the `}` closing the JSON object that opens at `start`, skipping strings. */
function objectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  // Every structural character is ASCII, so UTF-16 indexes are safe here.
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return index;
  }
  return undefined;
}

/**
 * Parse a reply that reasons before its answer, such as an Escalation Pass's: the valid
 * assessment whose JSON object ends last, from any `{`, so an unbalanced brace or an example
 * object in the reasoning cannot hide or contradict the final answer. Throws a Review Failure
 * message when it holds none.
 */
export function parseFinalAssessment(
  text: string,
  categories: readonly RiskCategory[] = validRiskCategories(false),
): Assessment {
  let found: { assessment: Assessment; end: number } | undefined;
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const end = objectEnd(text, start);
    if (end === undefined || (found && end <= found.end)) continue;
    const assessment = assessmentIn(text.slice(start, end + 1), categories);
    if (assessment) found = { assessment, end };
  }
  if (!found)
    throw new Error("Guardian returned malformed output (expected the assessment JSON object)");
  return found.assessment;
}

/**
 * Parse a Guardian reply; throws a Review Failure message unless it holds exactly one valid
 * assessment. Repeating the same assessment is tolerated; differing assessments are ambiguous.
 * A category outside `categories` (by default every one but `security_policy`) is left out.
 */
export function parseAssessment(
  text: string,
  categories: readonly RiskCategory[] = validRiskCategories(false),
): Assessment {
  const [first, ...rest] = assessments(text, categories);
  if (!first)
    throw new Error("Guardian returned malformed output (expected the assessment JSON object)");
  if (rest.some((other) => JSON.stringify(other) !== JSON.stringify(first)))
    throw new Error(
      "Guardian returned malformed output (more than one differing assessment JSON object)",
    );
  return first;
}

/** The risk with its Risk Category, such as `critical (data_egress)`. */
export function riskLabel(assessment: Pick<Assessment, "risk" | "category">): string {
  return assessment.category ? `${assessment.risk} (${assessment.category})` : assessment.risk;
}

/** The assessment's rationale, or a fixed reason when the Guardian gave none. */
export function statedRationale(assessment: Assessment): string {
  return assessment.rationale || "The Guardian gave no specific rationale.";
}

/** Codex-style feedback for a Rejection, as reported to the Guarded Agent. */
export function rejectionReason(assessment: Assessment): string {
  const rationale = statedRationale(assessment);
  return [
    "This action was rejected due to unacceptable risk.",
    `Risk: ${riskLabel(assessment)}. Authorization: ${assessment.authorization}.`,
    `Reason: ${rationale}`,
    "Do not attempt to achieve the same outcome through a workaround, indirect execution, or variations of this call, and do not retry it. Explain the risk to the user and ask whether they want to proceed; continue only with a materially safer alternative or after the user explicitly approves this action.",
  ].join("\n");
}
