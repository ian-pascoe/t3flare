// The Container's git credential helper (ADR-0013), apart from the Workspace DO so it can be tested as a shell script.

/** Where the Container's git credential helper asks this object for the repo's token (through computer's egress host). */
export const CREDENTIAL_PATH = "/t3flare/git-credential";

/**
 * git's credential helper in the Container (ADR-0013): the command's own `T3FLARE_GIT_TOKEN` when the router gave one
 * (t3's push, fetch and pull), else a token asked of this Workspace DO at that moment (the agent's own git), which asks
 * the Environment DO: the Workspace's one repo, `workflows` only when opted in. Nothing is kept in a file or the shell.
 * It answers only `protocol=https host=github.com`: a `pushurl` or remote on any other host gets no token (SPI-992).
 */
export const CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; pr=; h=; ' +
  'while IFS== read -r k v; do [ -n "$k" ] || break; case "$k" in protocol) pr="$v";; host) h="$v";; esac; done; ' +
  '[ "$pr" = https ] && [ "$h" = github.com ] || exit 0; t="${T3FLARE_GIT_TOKEN:-}"; ' +
  // Step 3 (D1): what git is doing, from the helper's git ancestors (`git push`, `git fetch`, …), and its command line.
  'p=$PPID; op=unknown; cmd=; for i in 1 2 3 4 5; do c="$(tr "\\0" " " < /proc/$p/cmdline 2>/dev/null)"; ' +
  'case "$c" in *"git push"*|*"git-push"*) op=push; cmd="$c"; break;; *"git fetch"*|*"git pull"*|*"git clone"*|*"git ls-remote"*|*"git-fetch"*) op=fetch; cmd="$c"; break;; esac; ' +
  'p="$(awk \'{print $4}\' /proc/$p/stat 2>/dev/null)"; [ -n "$p" ] && [ "$p" != 0 ] || break; done; ' +
  '[ -n "$t" ] || t="$(curl -fsS --max-time 660 -G --data-urlencode "op=$op" --data-urlencode "cmd=$(printf %s "$cmd" | head -c 300)" http://computer.internal' + CREDENTIAL_PATH + ' 2>/dev/null)"; ' +
  '[ -n "$t" ] || exit 0; echo username=x-access-token; echo "password=$t"; }; f';
