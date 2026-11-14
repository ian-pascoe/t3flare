// The Container's copy of the Environment skill set, read-only from a launch's first command (SPI-1148, ADR-0033):
// computerd serves the Workspace's read-only mount writable in the Container, so every command that reaches the
// Container starts with this snippet. It binds the directory over itself and remounts it read-only, once per launch
// (`flock` makes two first commands share one attempt), and costs one `grep` after that. It guards against accident, not
// against an agent set on it: the agent is root and could remount, and its writes would still never reach the Workspace.
//
// It prints nothing and leaves the command's status alone. A failure (a Container that may not mount) is written to
// `SKILLS_LOCK_FAILED` and not tried again in that launch; the Workspace reads the marker with a passive command and
// logs it once.

/** Where every Workspace serves the Environment skill set (`@t3flare/skills`' `SKILLS_MOUNT`, pinned equal by a test). */
export const ENVIRONMENT_SKILLS_DIR = "/workspace/.agents/skills";

/** The marker a failed lock leaves in the Container, with the reason. */
export const SKILLS_LOCK_FAILED = "/tmp/t3flare-skills-lock.failed";

/** The POSIX sh snippet put before a Container command (it ends with a newline). */
export const SKILLS_LOCK_SCRIPT = [
  `if ! grep -qs " ${ENVIRONMENT_SKILLS_DIR} " /proc/self/mountinfo && [ ! -e ${SKILLS_LOCK_FAILED} ]; then`,
  `  ( exec 9>/tmp/t3flare-skills.lock; flock 9; grep -qs " ${ENVIRONMENT_SKILLS_DIR} " /proc/self/mountinfo || { mkdir -p ${ENVIRONMENT_SKILLS_DIR} && mount --bind ${ENVIRONMENT_SKILLS_DIR} ${ENVIRONMENT_SKILLS_DIR} && mount -o remount,bind,ro ${ENVIRONMENT_SKILLS_DIR}; } ) >${SKILLS_LOCK_FAILED}.tmp 2>&1 && rm -f ${SKILLS_LOCK_FAILED}.tmp || mv -f ${SKILLS_LOCK_FAILED}.tmp ${SKILLS_LOCK_FAILED} 2>/dev/null || true`,
  `fi`,
  ``,
].join("\n");
