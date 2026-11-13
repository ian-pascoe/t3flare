// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off
// `pnpm run test:docker` (SPI-1150 M0): the Global mise config on the Workspace image's own pinned mise
// (apps/sandbox-image/image/Dockerfile, built here for linux/amd64), before the design is built. Not part of
// `pnpm run check`: it needs Docker and the network (mise-versions, nodejs.org, github.com).
//
// The four questions of the ticket's M0, each answered in a file when T3FLARE_MISE_M0_OUT names a directory:
//
// - m0-version.json: the image's mise, and the layering re-checked on it.
// - m0-layering.json: the image's base mise.toml as mise's system config and the owner's as its global; git and gh
//   under a typical owner file; what in an owner's file could still remove them, without and with the design's guards
//   (two variables, and the start's check that git and gh still run); an empty or absent global file against today.
// - m0-requests.json: the hosts mise asks, and how often api.github.com, installing an exact `node` and one
//   GitHub-backed tool, through a logging TLS proxy.
// - m0-token.json: with gh's hosts.yml present and the image's own git credential helper answering, no request carries
//   a token; the variables that turn those sources off, and that they beat the owner's and a repo's file.
//
//   pnpm --filter @t3flare/environment exec vitest run --config vitest.docker.config.ts test/docker/mise.docker.test.ts
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, it } from "vitest";

const here = import.meta.dirname;
const imageContext = path.resolve(here, "../../../sandbox-image/image");
const IMAGE = "t3flare-mise-test";
const NET = "t3flare-mise-test-net";
const PROXY = "t3flare-mise-test-proxy";
const out = process.env.T3FLARE_MISE_M0_OUT;

/** The base mise.toml in the image (`BASE_MISE_CONFIG`, apps/sandbox-image/src/env.ts). */
const BASE = "/usr/local/share/cloudpid/mise.toml";
/** Where the design lays the owner's text down: the Container's own disk, outside /workspace. */
const GLOBAL = "/var/lib/t3flare/mise/config.toml";

/** What every command's environment carries today (`COMMAND_ENV` at 660f922, BASH_ENV aside). */
const TODAY_ENV: Readonly<Record<string, string>> = {
  MISE_GLOBAL_CONFIG_FILE: BASE,
  MISE_TRUSTED_CONFIG_PATHS: "/usr/local/share/cloudpid:/workspace",
  MISE_YES: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/** The two layers alone: the base as system config, the owner's as global; no guard. */
const LAYERED_ENV: Readonly<Record<string, string>> = {
  MISE_SYSTEM_CONFIG_FILE: BASE,
  MISE_GLOBAL_CONFIG_FILE: GLOBAL,
  MISE_TRUSTED_CONFIG_PATHS: "/usr/local/share/cloudpid:/workspace",
  MISE_YES: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/** The token sources turned off (an environment variable beats every config file's setting). */
const TOKEN_GUARDS: Readonly<Record<string, string>> = {
  MISE_GITHUB_GH_CLI_TOKENS: "false",
  MISE_GITHUB_USE_GIT_CREDENTIALS: "false",
  MISE_GITHUB_CREDENTIAL_COMMAND: "",
};

/** The settings that drop a tool without naming it, held empty. */
const TOOL_GUARDS: Readonly<Record<string, string>> = {
  MISE_DISABLE_TOOLS: "",
  MISE_DISABLE_BACKENDS: "",
};

/** The design's command environment (the plan's `COMMAND_ENV`). */
const DESIGN_ENV: Readonly<Record<string, string>> = { ...LAYERED_ENV, ...TOKEN_GUARDS, ...TOOL_GUARDS };

/**
 * The design's lay-down at a Container start (the plan's bootstrap): the owner's text into a staging file, `mise
 * install` from `/` with it as the global config, then git and gh must still run under it, or it is not laid down.
 * Prints one JSON line.
 */
const layDown = (text: string): string => `
dir=${path.dirname(GLOBAL)}; file=${GLOBAL}; next="$dir/config.next.toml"
mkdir -p "$dir"; rm -f "$file"
printf %s '${Buffer.from(text).toString("base64")}' | base64 -d > "$next"
cd /
started=$(date +%s%N)
MISE_GLOBAL_CONFIG_FILE="$next" timeout 600 mise install > "$dir/install.log" 2>&1; install=$?
if MISE_GLOBAL_CONFIG_FILE="$next" git --version > /dev/null 2>&1 && MISE_GLOBAL_CONFIG_FILE="$next" gh --version > /dev/null 2>&1; then
  mv "$next" "$file"; laid=true
else
  rm -f "$next"; laid=false
fi
ms=$(( ($(date +%s%N) - started) / 1000000 ))
printf '{"laid":%s,"install":%s,"ms":%s}\\n' "$laid" "$install" "$ms"
`;

const docker = (args: ReadonlyArray<string>, options: { input?: string; quiet?: boolean } = {}) => {
  const result = spawnSync("docker", args, { encoding: "utf8", input: options.input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && options.quiet !== true) throw new Error(`docker ${args.slice(0, 3).join(" ")} failed: ${(result.stderr ?? "").slice(-1500)}`);
  return result;
};

/** Token-shaped text shortened (the fakes are fakes, but the files keep none whole). */
const redact = (text: string) => text.replaceAll(/\b(gh[a-z]_[A-Za-z0-9]{4})[A-Za-z0-9]+/g, "$1…");

interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

it("M0: the owner's mise config over the image's base, git and gh kept, no GitHub token sent", () => {
  const work = fs.mkdtempSync(path.join(here, ".work-mise-"));
  fs.chmodSync(work, 0o777);
  const cleanup = () => {
    docker(["rm", "-f", PROXY], { quiet: true });
    docker(["network", "rm", NET], { quiet: true });
  };
  cleanup();
  const failures: Array<string> = [];
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 800)}`}`);
    return ok;
  };
  try {
    console.log("building the Workspace image (linux/amd64)…");
    docker(["build", "-q", "--platform", "linux/amd64", "-t", IMAGE, imageContext]);
    docker(["network", "create", NET]);
    // The logging proxy: mitmdump with an addon that records each request's method, host, path and whether it carried
    // an Authorization header (and the header's first characters, which name the token's kind).
    fs.writeFileSync(
      path.join(work, "log.py"),
      `import json
def request(flow):
    h = flow.request.headers
    with open("/home/mitmproxy/.mitmproxy/requests.jsonl", "a") as f:
        f.write(json.dumps({"method": flow.request.method, "host": flow.request.pretty_host, "path": flow.request.path.split("?")[0], "authorization": h.get("authorization", "")[:13]}) + "\\n")
`,
    );
    docker(["run", "-d", "--name", PROXY, "--network", NET, "-v", `${work}:/home/mitmproxy/.mitmproxy`, "mitmproxy/mitmproxy", "mitmdump", "-q", "-s", "/home/mitmproxy/.mitmproxy/log.py"]);
    for (let tries = 0; !fs.existsSync(path.join(work, "mitmproxy-ca-cert.pem")) && tries < 60; tries++) spawnSync("sleep", ["1"]);
    const requestsFile = path.join(work, "requests.jsonl");

    /** One fresh Container: `script` in bash under `env`, offline unless `proxied` (then through the logging proxy). */
    const run = (env: Readonly<Record<string, string>>, script: string, options: { proxied?: boolean; hostsYml?: boolean; gitHelper?: boolean; plainGit?: boolean } = {}): Run => {
      const prelude = [
        "set -u",
        // The image's Python by its path, never a shim: the probes must run whatever an owner's file did to mise.
        "PY=/usr/local/share/mise/installs/python/3.14.10/bin/python3",
        "mkdir -p /workspace/repo",
        options.proxied === true ? "cp /m0/mitmproxy-ca-cert.pem /usr/local/share/ca-certificates/m0.crt && update-ca-certificates > /dev/null 2>&1" : "",
        // gh's own file, as an agent's `gh auth login` would leave it.
        options.hostsYml === true ? "mkdir -p /root/.config/gh && printf 'github.com:\\n    oauth_token: ghp_m0hostsyml00000000000000000000000000\\n    user: m0\\n    git_protocol: https\\n' > /root/.config/gh/hosts.yml" : "",
        // The image's own git credential helper (/etc/gitconfig) answering: a stand-in computer.internal on 127.0.0.1.
        options.gitHelper === true
          ? `mkdir -p /tmp/cred/t3flare && printf ghs_m0gitcredential000000000000000000000 > /tmp/cred/t3flare/git-credential && (cd /tmp/cred && $PY -m http.server 80 --bind 127.0.0.1 > /dev/null 2>&1 &) && for i in $(seq 50); do curl -fs http://computer.internal/t3flare/git-credential > /dev/null && break; sleep 0.2; done`
          : "",
        // A git outside mise's shims: mise runs \`git credential fill\` with the shims taken off PATH, and the image has none.
        options.plainGit === true ? "ln -sf /usr/local/share/mise/installs/conda-git/2.56.0/bin/git /usr/local/bin/git" : "",
        "cd /workspace/repo",
      ].filter((line) => line !== "");
      const flags = Object.entries({ ...env, ...(options.proxied === true ? { HTTPS_PROXY: `http://${PROXY}:8080`, HTTP_PROXY: `http://${PROXY}:8080`, NO_PROXY: "computer.internal,127.0.0.1" } : { MISE_OFFLINE: "1" }) }).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
      const result = spawnSync("docker", ["run", "--rm", "-i", "--platform", "linux/amd64", "--network", NET, "--add-host", "computer.internal:127.0.0.1", "-v", `${work}:/m0`, ...flags, "--entrypoint", "bash", IMAGE, "-s"], {
        encoding: "utf8",
        input: `${prelude.join("\n")}\n${script}\n`,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15 * 60_000,
      });
      return { stdout: redact(result.stdout ?? ""), stderr: redact(result.stderr ?? ""), status: result.status };
    };
    const proxiedRun = (env: Readonly<Record<string, string>>, script: string, options: { hostsYml?: boolean; gitHelper?: boolean; plainGit?: boolean } = {}) => {
      fs.writeFileSync(requestsFile, "");
      const result = run(env, script, { ...options, proxied: true });
      const requests = fs
        .readFileSync(requestsFile, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { method: string; host: string; path: string; authorization: string });
      return { ...result, requests: requests.map((request) => ({ ...request, authorization: redact(request.authorization) })) };
    };
    const lastJson = (text: string): any => {
      try {
        return JSON.parse(text.trim().split("\n").at(-1) ?? "");
      } catch {
        return { unparsed: text.slice(-600) };
      }
    };
    /** git, gh and node in the repo, and mise's resolved tools, as one JSON line. */
    const PROBE = `
probe() {
  git=$(git --version 2>&1); git_rc=$?; git=\${git%%$'\n'*}
  gh=$(gh --version 2>&1); gh_rc=$?; gh=\${gh%%$'\n'*}
  tools=$(mise ls --current --json 2>/dev/null | $PY -c 'import json,sys
d=json.load(sys.stdin)
print(json.dumps({k:{"version":v[0]["version"],"source":v[0].get("source",{}).get("path"),"installed":v[0].get("installed")} for k,v in d.items()}))' 2>/dev/null || echo null)
  files=$(mise config ls --no-header 2>/dev/null | awk '{print $1}' | $PY -c 'import json,sys; print(json.dumps(sys.stdin.read().split()))' 2>/dev/null || echo null)
  printf '{"git":%s,"gitOk":%s,"gh":%s,"ghOk":%s,"tools":%s,"configFiles":%s}\\n' "$(printf %s "$git" | $PY -c 'import json,sys; print(json.dumps(sys.stdin.read()[:160]))')" "$([ $git_rc = 0 ] && echo true || echo false)" "$(printf %s "$gh" | $PY -c 'import json,sys; print(json.dumps(sys.stdin.read()[:160]))')" "$([ $gh_rc = 0 ] && echo true || echo false)" "$tools" "$files"
}`;
    const writeGlobal = (text: string | undefined) => (text === undefined ? `rm -f ${GLOBAL}` : `mkdir -p ${path.dirname(GLOBAL)} && printf %s '${Buffer.from(text).toString("base64")}' | base64 -d > ${GLOBAL}`);
    const writeRepo = (text: string) => `printf %s '${Buffer.from(text).toString("base64")}' | base64 -d > /workspace/repo/mise.toml`;

    // --- m0-version -----------------------------------------------------------------------------------------------
    const dockerfile = fs.readFileSync(path.join(imageContext, "Dockerfile"), "utf8");
    const pinned = /ARG MISE_VERSION=v(\S+)/.exec(dockerfile)?.[1];
    const versionRun = run(DESIGN_ENV, "mise --version 2>/dev/null | head -1");
    const version = versionRun.stdout.trim().split(" ")[0];
    check("version: the image runs the pinned mise", version === pinned, { pinned, ran: versionRun.stdout });
    const hierarchy = run(DESIGN_ENV, `${writeGlobal('[tools]\nnode = "24.11.1"\n')}\n${writeRepo('[tools]\npython = "3.13.1"\n')}\nmise config ls --no-header 2>&1`);

    // --- m0-layering ----------------------------------------------------------------------------------------------
    const TYPICAL = '[settings]\nexperimental = true\njobs = 8\n\n[tools]\nnode = "24.11.1"\npython = "3.13.1"\ngo = "1.25.4"\n"github:junegunn/fzf" = "0.56.3"\n\n[env]\nOWNER_VAR = "from the global config"\n';
    const probeWith = (env: Readonly<Record<string, string>>, globalText: string | undefined, repoText?: string) => {
      const result = run(env, `${PROBE}\n${writeGlobal(globalText)}\n${repoText === undefined ? "" : writeRepo(repoText)}\nprobe`);
      return lastJson(result.stdout);
    };
    const today = probeWith(TODAY_ENV, undefined);
    const absent = probeWith(DESIGN_ENV, undefined);
    const empty = probeWith(DESIGN_ENV, "");
    const typical = probeWith(DESIGN_ENV, TYPICAL);
    const override = probeWith(DESIGN_ENV, TYPICAL, '[tools]\nnode = "22.12.0"\n');
    const versions = (probe: any) => Object.fromEntries(Object.entries(probe?.tools ?? {}).map(([tool, value]: [string, any]) => [tool, value.version]));
    check("layering: absent global resolves as today", JSON.stringify(versions(absent)) === JSON.stringify(versions(today)) && absent.git === today.git && absent.gh === today.gh, { today, absent });
    check("layering: empty global resolves as today", JSON.stringify(versions(empty)) === JSON.stringify(versions(today)) && empty.git === today.git && empty.gh === today.gh, { today, empty });
    check("layering: base is system, owner's global", JSON.stringify(typical.configFiles) === JSON.stringify([BASE, GLOBAL]), typical.configFiles);
    check("layering: git and gh under a typical owner file", typical.gitOk === true && typical.ghOk === true && typical.tools?.["conda:git"]?.source === BASE && typical.tools?.gh?.source === BASE, typical);
    check("layering: the owner's node beats the base's", typical.tools?.node?.version === "24.11.1" && typical.tools?.node?.source === GLOBAL, typical.tools?.node);
    check("layering: a repo's node beats the owner's, the owner's other tools stay", override.tools?.node?.source === "/workspace/repo/mise.toml" && override.tools?.python?.source === GLOBAL && override.tools?.["github:junegunn/fzf"]?.source === GLOBAL, override.tools);
    const envVar = lastJson(run(DESIGN_ENV, `${writeGlobal(TYPICAL)}\nprintf '{"OWNER_VAR":"%s"}\\n' "$(mise env --json 2>/dev/null | $PY -c 'import json,sys; print(json.load(sys.stdin).get("OWNER_VAR",""))')"`).stdout);

    // What an owner's file could do to git and gh: each case without guards, with the design's variables, and through
    // the design's lay-down (which keeps the file only when git and gh still run under it).
    const removers: ReadonlyArray<{ readonly name: string; readonly text: string }> = [
      { name: "disable_tools", text: '[settings]\ndisable_tools = ["gh", "conda:git"]\n' },
      { name: "disable_backends", text: '[settings]\ndisable_backends = ["conda", "aqua"]\n' },
      { name: "enable_tools", text: '[settings]\nenable_tools = ["node"]\n' },
      { name: "invalid TOML", text: "this is = = not toml\n" },
      { name: "gh pinned to a version that does not install", text: '[tools]\ngh = "0.0.1"\n' },
      { name: "git named by a key mise does not know", text: '[tools]\ngit = "2.40.0"\n' },
      { name: "[env] PATH replaced", text: '[env]\nPATH = "/nowhere"\n' },
    ];
    const removerResults = removers.map(({ name, text }) => {
      const bare = probeWith(LAYERED_ENV, text);
      const guarded = probeWith(DESIGN_ENV, text);
      const lines = run(DESIGN_ENV, `${PROBE}\n${layDown(text)}\nprobe`).stdout.split("\n").filter((line) => line.startsWith("{"));
      const laid = lastJson(lines[0] ?? "");
      const after = lastJson(lines[1] ?? "");
      return { name, text, withoutGuards: { git: bare.gitOk, gh: bare.ghOk }, withGuardVariables: { git: guarded.gitOk, gh: guarded.ghOk }, layDown: { laid: laid.laid, install: laid.install, gitAfter: after.gitOk, ghAfter: after.ghOk } };
    });
    for (const result of removerResults) check(`layering: git and gh survive "${result.name}" through the design`, result.layDown.gitAfter === true && result.layDown.ghAfter === true, result);

    // --- m0-requests ----------------------------------------------------------------------------------------------
    const INSTALL = '[tools]\nnode = "24.11.1"\n"github:junegunn/fzf" = "0.56.3"\n';
    const install = proxiedRun(DESIGN_ENV, `${layDown(INSTALL)}\nnode --version; fzf --version`);
    const installAnswer = lastJson(install.stdout.split("\n").filter((line) => line.startsWith("{")).at(0) ?? "");
    const byHost = (requests: ReadonlyArray<{ host: string }>) => requests.reduce<Record<string, number>>((counts, request) => Object.assign(counts, { [request.host]: (counts[request.host] ?? 0) + 1 }), {});
    const api = (requests: ReadonlyArray<{ host: string }>) => requests.filter((request) => request.host === "api.github.com").length;
    check("requests: the install laid the file down and installed", installAnswer.laid === true && installAnswer.install === 0 && install.stdout.includes("v24.11.1") && install.stdout.includes("0.56.3"), { installAnswer, stdout: install.stdout.slice(-400) });
    check("requests: no api.github.com request", api(install.requests) === 0, byHost(install.requests));
    check("requests: no request carries a token", install.requests.every((request) => request.authorization === ""), install.requests);
    const direct = proxiedRun({ ...DESIGN_ENV, MISE_USE_VERSIONS_HOST: "false" }, `${layDown(INSTALL)}`);

    // --- m0-token -------------------------------------------------------------------------------------------------
    const FZF = '[tools]\n"github:junegunn/fzf" = "0.56.3"\n';
    const SOURCES_ON = '[settings]\ngithub.gh_cli_tokens = true\ngithub.use_git_credentials = true\ngithub.credential_command = "echo ghp_m0credentialcommand000000000000000000"\n';
    // MISE_USE_VERSIONS_HOST=false sends mise to api.github.com, where a token would go; the default path asks
    // mise-versions instead, to which mise sends none.
    const toApi = { MISE_USE_VERSIONS_HOST: "false" };
    const tokenCase = (name: string, env: Readonly<Record<string, string>>, globalText: string, repoText: string | undefined, sources: { hostsYml?: boolean; gitHelper?: boolean; plainGit?: boolean }) => {
      const result = proxiedRun({ ...env, ...toApi }, `${writeGlobal(globalText)}\n${repoText === undefined ? "" : writeRepo(repoText)}\nmise token github 2>&1 | sed 's/^/token: /' \ncd / && mise install > /dev/null 2>&1; cd /workspace/repo && mise install > /dev/null 2>&1; echo "fzf: $(fzf --version 2>&1 | head -1)"`, sources);
      const authorized = result.requests.filter((request) => request.authorization !== "");
      return {
        name,
        sources,
        guards: Object.keys(env).filter((key) => key in TOKEN_GUARDS),
        miseToken: /^token: (github\.com: .*)$/m.exec(result.stdout)?.[1] ?? null,
        miseWarnings: [...result.stdout.matchAll(/^token: (.*WARN.*)$/gm)].map((match) => match[1]),
        fzf: /fzf: (.*)/.exec(result.stdout)?.[1] ?? null,
        apiGithubRequests: api(result.requests),
        withAuthorization: authorized.length,
        authorizationKinds: [...new Set(authorized.map((request) => request.authorization))],
      };
    };
    const all = { hostsYml: true, gitHelper: true, plainGit: true };
    const tokenCases = [
      tokenCase("control: hosts.yml, no guard", LAYERED_ENV, FZF, undefined, { hostsYml: true, gitHelper: true }),
      tokenCase("control: the image's git helper (git outside the shims), owner turns git credentials on, no guard", LAYERED_ENV, `[settings]\ngithub.use_git_credentials = true\n${FZF}`, undefined, { gitHelper: true, plainGit: true }),
      tokenCase("control: the image's git helper, owner turns git credentials on, no guard, the image's PATH", LAYERED_ENV, `[settings]\ngithub.use_git_credentials = true\n${FZF}`, undefined, { gitHelper: true }),
      tokenCase("control: owner's credential_command, no guard", LAYERED_ENV, `[settings]\ngithub.credential_command = "echo ghp_m0credentialcommand000000000000000000"\n${FZF}`, undefined, {}),
      tokenCase("design: every source present", DESIGN_ENV, FZF, undefined, all),
      tokenCase("design: every source present, the owner's file turns each on", DESIGN_ENV, `${SOURCES_ON}${FZF}`, undefined, all),
      tokenCase("design: every source present, a repo's file turns each on", DESIGN_ENV, FZF, SOURCES_ON, all),
    ];
    const [hostsControl, helperControl, helperImagePath, commandControl, ...designCases] = tokenCases;
    check("token: the hosts.yml control sends its token (the proxy sees one)", hostsControl!.withAuthorization > 0, hostsControl);
    check("token: the git helper control sends its token", helperControl!.withAuthorization > 0, helperControl);
    check("token: the credential_command control sends its token", commandControl!.withAuthorization > 0, commandControl);
    for (const design of designCases) check(`token: ${design.name}: none sent`, design.withAuthorization === 0 && design.apiGithubRequests > 0 && String(design.miseToken).includes("(none)"), design);

    const at = new Date().toISOString();
    // The commit the test ran at (its tree clean), and the image it built, so each file names what it ran against.
    const git = (args: ReadonlyArray<string>) => spawnSync("git", args, { cwd: here, encoding: "utf8" }).stdout.trim();
    const commit = `${git(["rev-parse", "--short", "HEAD"])}${git(["status", "--porcelain", "--", imageContext, here]) === "" ? "" : " (with uncommitted changes)"}`;
    const image = docker(["image", "inspect", "-f", "{{.Id}}", IMAGE]).stdout.trim();
    const files: Record<string, unknown> = {
      "m0-version.json": {
        at,
        pinned: `v${pinned}`,
        ran: versionRun.stdout.trim(),
        layeringOnIt: { configFiles: redact(hierarchy.stdout.trim()).split("\n"), note: "mise config ls in /workspace/repo with the design's variables, an owner's global and a repo's mise.toml: system, then global, then the repo (lowest first)" },
        researchedOn: "2026.11.7 (local) and 2026.11.8 (source); the image pins 2026.11.2: every finding below is from the image's own binary",
      },
      "m0-layering.json": {
        at,
        variables: { today: TODAY_ENV, design: DESIGN_ENV },
        today,
        absentGlobal: absent,
        emptyGlobal: empty,
        typicalOwnerFile: { text: TYPICAL, probe: typical, ownerEnv: envVar },
        repoOverride: { repo: '[tools]\nnode = "22.12.0"\n', probe: override },
        removers: removerResults,
      },
      "m0-requests.json": {
        at,
        config: INSTALL,
        default: { layDown: installAnswer, byHost: byHost(install.requests), apiGithub: api(install.requests), withAuthorization: install.requests.filter((request) => request.authorization !== "").length, requests: install.requests },
        versionsHostOff: { note: "MISE_USE_VERSIONS_HOST=false, for comparison", byHost: byHost(direct.requests), apiGithub: api(direct.requests), requests: direct.requests },
      },
      "m0-token.json": {
        at,
        variables: TOKEN_GUARDS,
        precedence: "MISE_GITHUB_TOKEN > GITHUB_API_TOKEN > GITHUB_TOKEN > github.credential_command > OAuth > github_tokens.toml > gh hosts.yml (github.gh_cli_tokens) > git credential fill (github.use_git_credentials)",
        cases: tokenCases,
        imagePath: helperImagePath,
      },
    };
    if (out !== undefined) {
      fs.mkdirSync(out, { recursive: true });
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(out, name), `${JSON.stringify({ ok: failures.length === 0, commit, image, ...(content as object) }, null, 1)}\n`);
    }
    console.log(JSON.stringify({ failures, ...files }, null, 1).slice(0, 20_000));
  } finally {
    cleanup();
    fs.rmSync(work, { recursive: true, force: true });
  }
  expect(failures).toEqual([]);
}, 60 * 60_000);
