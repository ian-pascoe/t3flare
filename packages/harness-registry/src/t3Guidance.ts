// t3's guidance as a Durable agent is told it (SPI-1060, plan SPI-1061 §11.1, D8): the agent is never told about a t3
// tool it is denied. t3's `T3_CODE_ORCHESTRATION_INSTRUCTIONS` and its tools' descriptions name tools in backticks; a
// bullet (or paragraph) of the guidance, or a sentence of a description, that names a denied tool (`T3_TOOL_DENYLIST`)
// is dropped whole, and a heading left with nothing under it goes with it. Everything else is t3's, as stock t3 gives it
// (owner, 2026-11-12, back to stock: filtered by the denylist, no longer fail-closed on unclassified names; U49).
import { isDeniedT3Tool } from "./t3Tools.ts";

/**
 * Our own line, after t3's guidance (§11.1). True before the Outbound link exists: nothing here can make a link.
 * Once it does (SPI-1061 M2), it says that every message to another machine asks the owner first, as a fact.
 */
export const OTHER_MACHINES =
  "- Other machines: links to them are made by the owner, never by an agent, and this Environment cannot link to another machine yet. `t3_environment_links` lists what is linked; with nothing linked, say you cannot work on another machine from here. When it can link, every message to another machine will ask the owner first.";

/** A backticked name that could be a tool: an identifier, or `prefix_*` for a family. */
const TOOL_LIKE = /^[A-Za-z_][A-Za-z0-9_]*\*?$/;

/** The tool-like names a text puts in backticks, in order, once each. */
export const toolLikeNamesIn = (text: string): ReadonlyArray<string> => [
  ...new Set([...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!).filter((name) => TOOL_LIKE.test(name))),
];

/** Whether `text` names no denied tool. */
const namesNoDenied = (text: string) => !toolLikeNamesIn(text).some(isDeniedT3Tool);

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s/;
const HEADING = /^#{1,6}\s/;

/**
 * t3's guidance with every bullet or paragraph that names a denied tool dropped whole (a bullet's indented continuation
 * lines with it), and every heading left with nothing under it before the next heading.
 */
export const guidanceFor = (text: string): string => {
  // Units: a heading, a blank line, a bullet with its continuation lines, or a paragraph's lines.
  const units: Array<{ kind: "heading" | "blank" | "text"; lines: Array<string> }> = [];
  for (const line of text.split("\n")) {
    const last = units.at(-1);
    if (line.trim() === "") units.push({ kind: "blank", lines: [line] });
    else if (HEADING.test(line)) units.push({ kind: "heading", lines: [line] });
    else if (!BULLET.test(line) && last?.kind === "text") last.lines.push(line);
    else units.push({ kind: "text", lines: [line] });
  }
  const kept = units.filter((unit) => unit.kind !== "text" || namesNoDenied(unit.lines.join("\n")));
  const hadText = (from: ReadonlyArray<typeof units[number]>, heading: (typeof units)[number]) => {
    const at = from.indexOf(heading);
    const next = from.findIndex((unit, index) => index > at && unit.kind === "heading");
    return from.slice(at + 1, next === -1 ? undefined : next).some((unit) => unit.kind === "text");
  };
  return kept
    .filter((unit) => unit.kind !== "heading" || hadText(kept, unit) || !hadText(units, unit))
    .flatMap((unit) => unit.lines)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

/** An offered tool's description with every sentence that names a denied tool dropped. */
export const descriptionFor = (text: string): string =>
  text
    .split("\n")
    .flatMap((line) => {
      if (line.trim() === "") return [line];
      const kept = line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => namesNoDenied(sentence))
        .join(" ");
      return kept.trim() === "" ? [] : [kept];
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
