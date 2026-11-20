// SPI-1209: the programs a POSIX shell script runs by name. The image puts mise's shims first on PATH and trusts
// /workspace's mise configuration, so on a CLI agent's launch path (where the model handle is reachable) every program
// must be named by its absolute path; this finds the ones that are not. A small lexer, not a full shell parser: it
// knows what the launch path's scripts use (simple commands, pipelines, lists, `$(…)` in and out of double quotes,
// `$((…))`, subshells, functions, if/while/for/case, redirections, `exec [-a name]`, `env -u`, `setsid`), and its own
// test pins that. What it knows it does not follow throws rather than passing a command it never saw: backticks,
// heredocs, a substitution inside `${…}` or `$((…))`, unterminated quoting, and the words and arguments in `UNFOLLOWED`
// and `UNFOLLOWED_ARGUMENTS` (a runner missing from those lists, `ionice` say, would still pass: add it there).

/** Builtins of both dash and bash, and the reserved words: neither is looked up on PATH. */
const SHELL = new Set([
  ":", "[", "break", "cd", "continue", "echo", "exec", "exit", "export", "false", "getopts", "kill", "local", "printf", "pwd", "read", "readonly", "return", "set", "shift", "test", "true", "ulimit", "umask", "unset", "wait",
  "!", "{", "}", "if", "then", "elif", "else", "fi", "while", "until", "for", "do", "done", "case", "esac", "in",
]);
const STARTS_COMMAND = new Set(["!", "{", "if", "then", "elif", "else", "while", "until", "do"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECTION = /^[0-9]*(?:>>|>&|<&|<>|>\||>|<)/;
/**
 * Words that run the program they are given (`exec`, and programs that do): the options of each that take an argument.
 * The first word after their options (and env's assignments) is a command too, looked up on PATH as any other.
 */
const RUNS_NEXT = new Map<string, ReadonlySet<string>>([
  ["exec", new Set(["-a"])],
  ["env", new Set(["-u", "--unset", "-C", "--chdir", "-a", "--argv0"])],
  ["setsid", new Set()],
]);
/** Words that run a string, a file or another program this lexer does not follow: a script using one is refused. */
const UNFOLLOWED = new Set([".", "source", "eval", "command", "trap", "builtin", "sh", "bash", "dash", "xargs", "timeout", "nohup", "nice", "sudo", "su", "chroot", "flock", "stdbuf", "unshare", "nsenter", "watch"]);
/** Arguments that make the program before them run another (`find -exec`, `env -S`): refused as well. */
const UNFOLLOWED_ARGUMENTS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-S", "--split-string"]);

const unfollowed = (what: string): never => {
  throw new Error(`shellCommands: ${what} is not followed; extend the lexer (and its test) before using it`);
};

/** The first word of every simple command in `script` (after assignments and `exec`), in order. */
export const commandWords = (script: string): ReadonlyArray<string> => {
  const words: Array<string> = [];
  const functions = new Set<string>();
  let i = 0;

  /** The index just past the next `token` from `from`; an unterminated one is refused (it would loop forever). */
  const past = (token: string, from: number): number => {
    const at = script.indexOf(token, from);
    return at === -1 ? unfollowed(`an unterminated \`${token}\``) : at + token.length;
  };

  /** Reads one word from `i`, recursing into the command substitutions inside it. */
  const word = (): string => {
    const start = i;
    while (i < script.length) {
      const c = script[i]!;
      if (/[\s;&|()<>]/.test(c)) break;
      if (c === "\\") i += 2;
      else if (c === "`") unfollowed("a backtick substitution");
      else if (c === "'") i = past("'", i + 1);
      else if (c === '"') {
        i++;
        while (script[i] !== '"') {
          if (i >= script.length) unfollowed('an unterminated `"`');
          if (script[i] === "\\") i += 2;
          else if (script[i] === "`") unfollowed("a backtick substitution");
          else if (script.startsWith("$((", i)) i = arithmetic(i);
          else if (script.startsWith("$(", i)) {
            i += 2;
            list(")");
          } else if (script.startsWith("${", i)) i = parameter(i);
          else i++;
        }
        i++;
      } else if (script.startsWith("$((", i)) i = arithmetic(i);
      else if (script.startsWith("$(", i)) {
        i += 2;
        list(")");
      } else if (script.startsWith("${", i)) i = parameter(i);
      else i++;
    }
    return script.slice(start, i);
  };

  /** Skips a `${…}` from its `$`, refusing one with a substitution inside (its `}` may not be the first one). */
  const parameter = (from: number): number => expansion(from, "${", "}");

  /** Skips a `$((…))` from its `$`, refusing one with a substitution inside. */
  const arithmetic = (from: number): number => expansion(from, "$((", "))");

  /** Skips an expansion from its `open` to its `close`, refusing one with a substitution inside. */
  const expansion = (from: number, open: string, close: string): number => {
    const end = past(close, from);
    const body = script.slice(from + open.length, end);
    if (body.includes("$(") || body.includes("`")) unfollowed(`a substitution inside \`${open}…${close}\``);
    return end;
  };

  /** A command list up to `stop` (`)` for a subshell or substitution, none for the script). */
  const list = (stop?: string) => {
    let command = true;
    /** After `exec` or a program that runs the next word: its options take that argument. */
    let runsNext: ReadonlySet<string> | undefined;
    /** The `case`s open here: reading the subject (up to `in`), a pattern (up to its `)`), or a pattern's commands. */
    const cases: Array<"subject" | "pattern" | "body"> = [];
    while (i < script.length) {
      const c = script[i]!;
      const state = cases.at(-1);
      if (c === " " || c === "\t" || (c === "\\" && script[i + 1] === "\n")) {
        i += c === "\\" ? 2 : 1;
      } else if (c === "#") {
        const end = script.indexOf("\n", i);
        i = end === -1 ? script.length : end;
      } else if (c === ")" && state === "pattern") {
        i++;
        cases[cases.length - 1] = "body";
        command = true;
      } else if (c === ")" && stop === ")") {
        i++;
        return;
      } else if (script.startsWith(";;", i)) {
        i += 2;
        if (state === "body") cases[cases.length - 1] = "pattern";
        command = false;
      } else if (c === "\n" || c === ";") {
        i++;
        if (state === "subject") cases[cases.length - 1] = "pattern";
        command = state !== "pattern";
        runsNext = undefined;
      } else if (c === "|" && state === "pattern") {
        i++;
      } else if (script.startsWith("&&", i) || script.startsWith("||", i)) {
        i += 2;
        command = true;
        runsNext = undefined;
      } else if (c === "|" || c === "&") {
        i++;
        command = true;
        runsNext = undefined;
      } else if (c === "(") {
        i++;
        if (state === "pattern") continue;
        list(")");
        command = false;
      } else {
        if (script.startsWith("<<", i)) unfollowed("a heredoc");
        const redirection = REDIRECTION.exec(script.slice(i));
        if (redirection !== null) {
          i += redirection[0].length;
          while (script[i] === " ") i++;
          word();
          continue;
        }
        const w = word();
        if (w === "") {
          i++;
          continue;
        }
        if (state === "subject") {
          if (w === "in") cases[cases.length - 1] = "pattern";
          continue;
        }
        if (state === "pattern") {
          if (w === "esac") {
            cases.pop();
            command = false;
          }
          continue;
        }
        if (UNFOLLOWED_ARGUMENTS.has(w)) unfollowed(`\`${w}\``);
        if (!command) continue;
        // A function definition: `name() {`.
        if (/^\s*\(\s*\)/.test(script.slice(i))) {
          functions.add(w);
          i = script.indexOf(")", i) + 1;
          continue;
        }
        if (w === "case") {
          cases.push("subject");
          command = false;
        } else if (w === "esac" && state === "body") {
          cases.pop();
          command = false;
        } else if (w === "for") {
          command = false;
        } else if (STARTS_COMMAND.has(w)) {
          command = true;
        } else if (w === "fi" || w === "done" || w === "}") {
          command = false;
        } else if (ASSIGNMENT.test(w)) {
          command = true;
        } else if (runsNext !== undefined && w.startsWith("-")) {
          // An option of `exec` or of a program that runs the next word; `exec -a name` names argv[0], not a program.
          if (runsNext.has(w)) {
            while (script[i] === " ") i++;
            word();
          }
        } else {
          const name = w.replaceAll(/['"]/g, "");
          const base = name.slice(name.lastIndexOf("/") + 1);
          if (UNFOLLOWED.has(base)) unfollowed(`\`${base}\``);
          if (name !== "exec") words.push(name);
          runsNext = RUNS_NEXT.get(base);
          command = runsNext !== undefined;
        }
      }
    }
    if (stop !== undefined) unfollowed(`an unterminated \`$(\` or \`(\``);
  };

  list();
  return words.filter((w) => !functions.has(w));
};

/**
 * The programs `script` runs by name: every command word that is neither the shell's nor an absolute path. `$0`, a
 * launcher running itself again, counts as absolute: `processCommand` starts a process's binary only by its absolute path.
 */
export const bareCommands = (script: string): ReadonlyArray<string> => commandWords(script).filter((w) => !SHELL.has(w) && !w.startsWith("/") && w !== "$0");
