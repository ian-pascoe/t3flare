// Copied from cloudpid@ae5a7b73:packages/computer-env/src/shell.ts.
// computerd runs a command with `/bin/sh -c`, which is dash on the Ubuntu image, while `bash` promises bash: arrays,
// `[[ ]]`, process substitution. A command for the Container is wrapped to run in bash instead.

/** `script` as one argument of a POSIX shell: in single quotes, each quote itself closed, escaped, and reopened. */
export const quote = (script: string): string => `'${script.replaceAll("'", "'\\''")}'`;

/**
 * A script for `/bin/sh -c` that runs `script` in bash, with bash's exit status and its own stdout and stderr. t3flare:
 * bash starts as the leader of its own session and process group (`setsid`; computerd starts every command in its own
 * group, pgid 1, with the supervisor), so an aborted command's processes can be killed as a group (step 2a part 2,
 * apps/sandbox-image/src/kill.ts). `--wait` keeps the exit status if setsid ever has to fork (a caller already a group
 * leader); otherwise it calls setsid() and execs bash in place.
 */
export const inBash = (script: string): string => `exec setsid --wait bash -c ${quote(script)}`;
