// @effect-diagnostics globalFetch:off
// The version stamp's acceptance check (in-app updates plan D1, D16): the pin's tag, t3's descriptor's `serverVersion`
// and the web client's `APP_VERSION` agree. A stock client offers an Update whenever its own version differs from the
// server's, so a build that stamps one and not the other reads as out of date to every client.

/** The scripts and module preloads `index.html` names, same-origin only. */
export const webScripts = (html: string): ReadonlyArray<string> =>
  [...html.matchAll(/<(?:script[^>]*\bsrc|link[^>]*\brel="modulepreload"[^>]*\bhref)="(\/[^"]+\.js)"/g)].map((match) => match[1]!);

export interface VersionAgreement {
  readonly ok: boolean;
  readonly tag: string | null;
  readonly expected: string | null;
  readonly serverVersion: unknown;
  /** Whether a web script carries the expected version as a string literal. */
  readonly webAppVersion: boolean;
  readonly failures: ReadonlyArray<string>;
}

/** The check, from what the stage answered. `tag` null: the submodule is off a tag, and only the two must agree. */
export const versionAgreement = (input: {
  readonly tag: string | null;
  readonly serverVersion: unknown;
  readonly scripts: ReadonlyArray<string>;
}): VersionAgreement => {
  const expected = input.tag === null ? (typeof input.serverVersion === "string" ? input.serverVersion : null) : input.tag.replace(/^v/, "");
  const failures: Array<string> = [];
  if (input.tag !== null && input.serverVersion !== expected) failures.push(`t3's descriptor reports serverVersion ${String(input.serverVersion)}, the pin is ${input.tag}`);
  // A string literal in any of the minifier's quotes (it prefers backticks).
  const literals = expected === null ? [] : ['"', "'", "`"].map((quote) => `${quote}${expected}${quote}`);
  const webAppVersion = input.scripts.some((text) => literals.some((literal) => text.includes(literal)));
  if (!webAppVersion) failures.push(`no web client script carries APP_VERSION ${String(expected)}`);
  return { ok: failures.length === 0, tag: input.tag, expected, serverVersion: input.serverVersion, webAppVersion, failures };
};

/** Reads the stage's descriptor and web client, and checks them against `tag`. */
export const checkVersionAgreement = async (base: URL, tag: string | null): Promise<VersionAgreement> => {
  const descriptor = (await (await fetch(new URL("/.well-known/t3/environment", base))).json()) as { serverVersion?: unknown };
  const html = await (await fetch(new URL("/", base))).text();
  const scripts = await Promise.all(webScripts(html).map(async (src) => (await fetch(new URL(src, base))).text()));
  return versionAgreement({ tag, serverVersion: descriptor.serverVersion, scripts });
};
