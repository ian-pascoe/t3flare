// The Variables setting's seam (SPI-1152, ADR-0032): what the panel may store (`applyEnvironmentChange`) and what every
// reader gets (`resolveEnvironment`): the limits, each refused-name class, the credential-looking values, and a stored
// Variable a later Worker refuses. The names t3flare sets are derived from the code in
// apps/environment/test/variableNames.test.ts.
import { describe, expect, it } from "vitest";

import { applyEnvironmentChange, EMPTY_ENVIRONMENT, resolveEnvironment } from "./environment.ts";

const apply = (variables: unknown) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { variables } });
const refusal = (variables: unknown) => {
  const applied = apply(variables);
  return applied.ok ? undefined : applied.error;
};

describe("Variables", () => {
  it("are none by default, and a change stores them, bumps the revision and resolves them", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT).variables).toEqual({});
    const applied = apply({ DATABASE_URL: "postgres://localhost/dev", NODE_ENV: "development" });
    if (!applied.ok) throw new Error(applied.error);
    expect(applied.changed).toEqual(["variables"]);
    expect(applied.environment.revision).toBe(1);
    expect(resolveEnvironment(applied.environment).variables).toEqual({ DATABASE_URL: "postgres://localhost/dev", NODE_ENV: "development" });
  });

  it("a save with the same Variables moves nothing; a changed value or a removed Variable moves them", () => {
    const first = apply({ A: "1", B: "2" });
    if (!first.ok) throw new Error(first.error);
    const same = applyEnvironmentChange(first.environment, { settings: { variables: { A: "1", B: "2" }, containerBudget: 3 } });
    expect(same).toMatchObject({ ok: true, changed: [] });
    expect(applyEnvironmentChange(first.environment, { settings: { variables: { A: "1", B: "3" } } })).toMatchObject({ ok: true, changed: ["variables"] });
    const removed = applyEnvironmentChange(first.environment, { settings: { variables: { A: "1" } } });
    if (!removed.ok) throw new Error(removed.error);
    expect(resolveEnvironment(removed.environment).variables).toEqual({ A: "1" });
  });

  it("keeps cloudpid's limits: 50 Variables, names up to 128 characters, values up to 4,096", () => {
    const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, at) => [`V${at}`, "x"]));
    expect(apply(fifty)).toMatchObject({ ok: true });
    expect(refusal({ ...fifty, V50: "x" })).toBe("variables: at most 50 Variables (51 given)");
    expect(apply({ [`N${"A".repeat(127)}`]: "x" })).toMatchObject({ ok: true });
    expect(refusal({ [`N${"A".repeat(128)}`]: "x" })).toBe(`variables: "N${"A".repeat(128)}" is longer than 128 characters`);
    expect(apply({ BIG: "y".repeat(4096) })).toMatchObject({ ok: true });
    expect(refusal({ BIG: "y".repeat(4097) })).toBe('variables: "BIG"\'s value is longer than 4096 characters');
  });

  it("takes only names a shell can export, and text values without a NUL", () => {
    for (const name of ["", "1ABC", "MY-VAR", "MY VAR", "É"]) expect(refusal({ [name]: "x" })).toMatch(/^variables: /);
    expect(refusal({ "1ABC": "x" })).toBe('variables: "1ABC" is not a name a shell can export: letters, digits and _, not starting with a digit');
    expect(refusal({ OK: "a\u0000b" })).toBe('variables: "OK"\'s value holds a NUL character, which no environment can');
    expect(refusal({ OK: 3 })).toBe('variables: "OK"\'s value is not text');
    expect(refusal(["A=1"])).toBe('variables: an object of Variables, { "NAME": "value" }');
    expect(apply({ _private: "x", lower_case: "multi\nline" })).toMatchObject({ ok: true });
  });

  it("refuses the exact names PATH, HOME, PWD, SHELL and USER", () => {
    for (const name of ["PATH", "HOME", "PWD", "SHELL", "USER"]) expect(refusal({ [name]: "x" })).toBe(`variables: "${name}" is refused: the shell or the Container sets it for every command`);
    expect(apply({ PATHS: "x", MY_HOME: "x" })).toMatchObject({ ok: true });
  });

  it("refuses the prefixes T3, MISE_, GIT_, GH_, GITHUB_, SSH_ and LD_", () => {
    expect(refusal({ T3CODE_THREAD_ID: "x" })).toBe(`variables: "T3CODE_THREAD_ID" is refused: names starting T3 are t3's and t3flare's own`);
    expect(refusal({ T3FLARE_EXEC: "x" })).toMatch(/names starting T3 /);
    expect(refusal({ MISE_ENV: "x" })).toBe(`variables: "MISE_ENV" is refused: names starting MISE_ are mise's settings, which t3flare sets for every command`);
    expect(refusal({ GIT_DIR: "x" })).toMatch(/names starting GIT_ /);
    expect(refusal({ GH_HOST: "x" })).toMatch(/names starting GH_ /);
    expect(refusal({ GITHUB_REPOSITORY: "x" })).toMatch(/names starting GITHUB_ /);
    expect(refusal({ SSH_AUTH_SOCK: "x" })).toMatch(/names starting SSH_ /);
    expect(refusal({ LD_PRELOAD: "x" })).toMatch(/names starting LD_ /);
    expect(apply({ MISE: "x", GITLAB_HOST: "x", LDFLAGS: "x" })).toMatchObject({ ok: true });
  });

  it("refuses the loader hooks NODE_OPTIONS, BASH_ENV, ENV and PROMPT_COMMAND", () => {
    for (const name of ["NODE_OPTIONS", "BASH_ENV", "ENV", "PROMPT_COMMAND"]) expect(refusal({ [name]: "x" })).toBe(`variables: "${name}" is refused: it makes programs load code before a command runs`);
    expect(apply({ NODE_ENV: "production" })).toMatchObject({ ok: true });
  });

  it("refuses a name with a KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL segment, in any case, singular or plural", () => {
    expect(refusal({ STRIPE_API_KEY: "x" })).toBe('variables: "STRIPE_API_KEY" is refused: its KEY part names a credential, and secrets never enter a Container (ADR-0016)');
    for (const name of ["NPM_TOKEN", "app_secret", "DB_PASSWORD", "CREDENTIALS", "SIGNING_KEYS", "Token"]) expect(refusal({ [name]: "x" })).toMatch(/part names a credential/);
    expect(apply({ MONKEY: "x", KEYBOARD: "x", TOKENIZER_MODEL: "x", PASSWORDLESS: "x" })).toMatchObject({ ok: true });
  });

  it("refuses a name t3flare sets itself for a CLI agent", () => {
    expect(refusal({ ANTHROPIC_BASE_URL: "https://elsewhere.example" })).toBe('variables: "ANTHROPIC_BASE_URL" is refused: t3flare sets it itself, for every command or for a CLI agent');
    for (const name of ["HTTPS_PROXY", "https_proxy", "LANG", "CODEX_HOME", "XDG_CONFIG_HOME"]) expect(refusal({ [name]: "x" })).toMatch(/t3flare sets it itself/);
  });

  it("refuses a value that looks like a credential, naming what it looks like", () => {
    const values: ReadonlyArray<readonly [string, string]> = [
      [`sk-${"a".repeat(24)}`, "an API key (sk-…)"],
      [`ghp_${"b".repeat(36)}`, "a GitHub token"],
      [`ghs_${"c".repeat(40)}`, "a GitHub installation token"],
      [`github_pat_${"d".repeat(40)}`, "a GitHub personal access token"],
      [`glpat-${"e".repeat(20)}`, "a GitLab token"],
      [`npm_${"f".repeat(36)}`, "an npm token"],
      ["AKIAABCDEFGHIJKLMNOP", "an AWS access key"],
      ["xoxb-1234567890-abc", "a Slack token"],
      [`AIza${"g".repeat(35)}`, "a Google API key"],
      ["eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghijklmnop", "a signed token (JWT)"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----", "a private key"],
      [`config: password = "${"h".repeat(24)}"`, "an assigned key, token, secret or password"],
    ];
    for (const [value, looksLike] of values) expect(refusal({ SETTING: value })).toBe(`variables: "SETTING"'s value looks like ${looksLike}, and secrets never enter a Container (ADR-0016)`);
    // cloudpid's local-path patterns are not taken: a path on a machine is a fine value.
    expect(apply({ CACHE: "/home/runner/.cache", DIR: "/Users/me/x" })).toMatchObject({ ok: true });
  });

  it("names every refused Variable in one answer", () => {
    expect(refusal({ PATH: "x", OK: "y", GH_HOST: "z" })).toBe(
      'variables: "PATH" is refused: the shell or the Container sets it for every command; "GH_HOST" is refused: names starting GH_ are the GitHub CLI\'s',
    );
  });

  it("reads a stored Variable a later rule refuses as gone, keeping the others", () => {
    const stored = { revision: 7, settings: { variables: { NODE_ENV: "test", HTTPS_PROXY: "http://proxy", LEAK: `ghp_${"b".repeat(36)}` } } };
    expect(resolveEnvironment(stored).variables).toEqual({ NODE_ENV: "test" });
    expect(resolveEnvironment({ revision: 7, settings: { variables: "A=1" } }).variables).toEqual({});
  });
});
