// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// The launch video's beat 6 (tools/demo-video): a Remote task runs in the Cloud Environment's own checkout of the
// fixture, so each take first puts that checkout back on its remote's default branch, through t3's terminal RPC.
//
//   node scripts/stage.ts run demo demo-reset
import { pair, uuid } from "./lib/client.ts";
import { fixtureRepo } from "./lib/scriptSettings.ts";
import { attachTerminal, stripAnsi } from "./lib/terminal.ts";

const checkout = `/w/${fixtureRepo().split("/").pop()}`;
const cookie = await pair();
const terminal = await attachTerminal(cookie, {
  threadId: `terminal-${uuid()}`,
  terminalId: "default",
  cwd: checkout,
});
try {
  await terminal.until(/[$#] $/, 90_000);
  const { text } = await terminal.run(
    [
      "git fetch -q origin",
      'git checkout -q -f -B "$(git rev-parse --abbrev-ref origin/HEAD | cut -d/ -f2-)" origin/HEAD',
      "git clean -qfd",
      "git status --short | wc -l",
    ].join(" && "),
    30_000,
  );
  const left = stripAnsi(text).match(/^\s*(\d+)\s*$/m)?.[1];
  if (left !== "0")
    throw new Error(`${checkout} is not clean: ${stripAnsi(text).trim().slice(-200)}`);
  console.log(`${checkout} is clean`);
} finally {
  await terminal.close(true);
}
// The RPC client's socket keeps the process alive.
process.exit(0);
