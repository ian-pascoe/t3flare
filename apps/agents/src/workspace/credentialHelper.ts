// The Container's git credential helper (ADR-0013), apart from the Workspace DO so it can be tested as a shell script.

/** Where the Container's git credential helper asks this object for the repo's token (through computer's egress host). */
export const CREDENTIAL_PATH = "/t3flare/git-credential";

/** The helper's version on its request: the Workspace DO answers only this helper, never one an old repo still names. */
export const CREDENTIAL_HELPER_VERSION = "2";

/**
 * git's credential helper in the Container (ADR-0013; SPI-992): a **read-only** token for the Workspace's one repo,
 * asked of the Workspace DO at that moment, which asks the Environment DO. Nothing is kept in a file or the shell, and
 * no token is read from the environment. It answers only `protocol=https host=github.com`: a `pushurl` or remote on any
 * other host gets nothing. Pushes never use it: they go through t3flare's push gateway (`pushInsteadOf` in the image's
 * system gitconfig), which adds the write token outside the Container.
 */
export const CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; pr=; h=; ' +
  'while IFS== read -r k v; do [ -n "$k" ] || break; case "$k" in protocol) pr="$v";; host) h="$v";; esac; done; ' +
  '[ "$pr" = https ] && [ "$h" = github.com ] || exit 0; ' +
  `t="$(curl -fsS --max-time 60 -G --data-urlencode v=${CREDENTIAL_HELPER_VERSION} --data-urlencode protocol=https --data-urlencode host=github.com http://computer.internal${CREDENTIAL_PATH} 2>/dev/null)"; ` +
  '[ -n "$t" ] || exit 0; echo username=x-access-token; echo "password=$t"; }; f';
