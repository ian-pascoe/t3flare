// The push approval card (SPI-992, review M6): the ref updates the gateway holds, against the tips GitHub advertised
// (the truth), with what the Workspace reports about each new commit (its subject, whether it descends from GitHub's
// tip) labelled as the Workspace's claim: a hostile Workspace can lie about those, never about the refs and ids.
import type { RefUpdate } from "./pushGateway.ts";

/** What the Workspace's own git said about a pushed commit. */
export interface ReportedCommit {
  readonly subject: string;
  /** By ref: whether the commit descends from GitHub's tip of that ref (`merge-base --is-ancestor`). */
  readonly ancestor: Readonly<Record<string, boolean>>;
}

export interface PushCardInput {
  readonly updates: ReadonlyArray<RefUpdate>;
  /** GitHub's tips, by ref (`advertisedTips`). */
  readonly tips: Readonly<Record<string, string>>;
  readonly defaultBranch: string | null;
  /** By commit id. */
  readonly reported?: Readonly<Record<string, ReportedCommit>>;
  /** The link the work came from; null on an owner's thread in a tainted Workspace. */
  readonly linkLabel: string | null;
}

const ZERO = /^0+$/;

/** Printable ASCII as is, anything else as `\u{…}` (review M6: no look-alikes, no bidi or terminal controls). */
export const escapeText = (value: string): string =>
  value.replace(/[^\x20-\x5b\x5d-\x7e]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);

const short = (oid: string): string => oid.slice(0, 8);

/** A button of the card (t3's `ProviderApprovalOption`): its decision, label and warning. */
export interface PushCardOption {
  readonly decision: "accept" | "acceptForSession" | "decline";
  readonly label: string;
  readonly warning?: string;
}

/** The trust option's label: the one answer that clears the Workspace's taint, so it says so (never t3's default "Always allow this session"). */
export const TRUST_LABEL = "Allow and trust this Workspace again (clears the linked-work mark)";

/**
 * The card's buttons. A linked card approves one push or declines it: there is nothing to accept for the session. An
 * owner's card in a tainted Workspace adds the trust option, labelled and warned, under t3's "more" menu.
 */
export const pushCardOptions = (linked: boolean): ReadonlyArray<PushCardOption> =>
  linked
    ? [
        { decision: "decline", label: "Decline" },
        { decision: "accept", label: "Allow this push" },
      ]
    : [
        { decision: "decline", label: "Decline" },
        { decision: "accept", label: "Allow this push once" },
        {
          decision: "acceptForSession",
          label: TRUST_LABEL,
          warning: "Anything linked work left in this Workspace (git hooks, git config, scripts, background processes) can then push without asking.",
        },
      ];

/** The card's summary (one line per update), its detail and its buttons. */
export const pushCard = (input: PushCardInput): { readonly summary: string; readonly detail: string; readonly options: ReadonlyArray<PushCardOption> } => {
  const lines: Array<string> = [];
  const details: Array<string> = [];
  for (const update of input.updates) {
    const ref = escapeText(update.ref);
    const tip = input.tips[update.ref];
    const tag = update.ref.startsWith("refs/tags/");
    const main = input.defaultBranch !== null && update.ref === `refs/heads/${input.defaultBranch}` ? " (default branch)" : "";
    const reported = input.reported?.[update.new];
    const ancestor = tip === undefined ? undefined : reported?.ancestor[update.ref];
    if (ZERO.test(update.new)) lines.push(`delete ${tag ? "tag " : ""}${ref}${main} (${short(tip ?? update.old)})`);
    else if (tip === undefined) lines.push(`create ${tag ? "tag " : ""}${ref}${main} → ${short(update.new)}`);
    else if (ancestor === false) lines.push(`force-push ${tag ? "tag " : ""}${ref}${main} ${short(tip)} → ${short(update.new)}`);
    else lines.push(`push ${tag ? "tag " : ""}${ref}${main} ${short(tip)} → ${short(update.new)}${ancestor === true ? "" : " (may not be a fast-forward)"}`);
    const github = tip === undefined ? "GitHub does not have it" : `GitHub has ${short(tip)}${tip === update.old ? "" : ` (the Workspace said ${short(update.old)})`}`;
    const claim = reported === undefined ? "" : ` — as reported by the Workspace: "${escapeText(reported.subject.slice(0, 120))}"${ancestor === true ? ", a fast-forward" : ancestor === false ? ", not a fast-forward" : ""}`;
    details.push(`${ref}: ${github}; new ${short(update.new)}${claim}`);
  }
  const intro = input.linkLabel === null
    ? `This Workspace ran work from a linked environment, so each push asks until you trust the Workspace again. "Allow this push once" keeps asking; "${TRUST_LABEL}" stops asking for every later push, including any a linked environment's leftovers make.`
    : `Work started from ${escapeText(input.linkLabel)} through a linked environment wants to push to this project's repository. Each push asks.`;
  return { summary: lines.join("\n"), detail: [intro, ...details].join("\n"), options: pushCardOptions(input.linkLabel !== null) };
};

/** The refs a receive-pack advertisement lists (GitHub's real tips), by name. */
export const advertisedTips = (body: Uint8Array): Record<string, string> => {
  const text = new TextDecoder().decode(body);
  const tips: Record<string, string> = {};
  let at = 0;
  while (at + 4 <= text.length) {
    const length = Number.parseInt(text.slice(at, at + 4), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      at += 4;
      continue;
    }
    const line = text.slice(at + 4, at + length).replace(/\n$/, "").split("\0")[0]!;
    at += length;
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+)$/.exec(line);
    if (match !== null) tips[match[2]!] = match[1]!;
  }
  return tips;
};
