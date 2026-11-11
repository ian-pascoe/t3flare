// Killing an aborted command's processes in the Container (step 2a part 2; ADR-0004's refinement). No Node imports, so
// the agents Worker can import it: the Workspace DO runs it with `bash -c` (`WorkspaceDO.killExecs`), so it ships with
// the Worker's code rather than in the image.
//
// Every command the Session runs in the Container carries its exec id in `T3FLARE_EXEC` (computer-env's `exec.ts`), and
// starts as the leader of its own process group (`setsid`, computer-env's `shell.ts`); its children inherit both. The
// script is given exec ids and kills every process whose environment carries one of them:
//
// - a group is signalled whole when its leader is marked, or when every process in it is (its leader gone): the
//   command's own group, and a group a marked process started with `setsid`;
// - a marked process in a group with an unmarked leader is signalled alone: never computerd's, the supervisor's or
//   another command's group;
// - TERM first, KILL from 2 s; the processes are found again every 100 ms until none is left or 3 s have passed.
//
// It prints one JSON line: `{"signalled":<processes signalled>,"survivors":<marked processes still alive>}`. Not
// covered, by design: a process that clears its environment and starts its own session (`env -i setsid …`).

export const KILL_SCRIPT = String.raw`
set -u
want=" $* "
signalled=0

# The marked processes, one "pid pgid" per line. A process's environ is read with bash's own read: no fork per process.
marked() {
  local dir pid pair stat rest
  for dir in /proc/[0-9]*; do
    pid=\${dir#/proc/}
    [ "$pid" = "$$" ] && continue
    while IFS= read -r -d '' pair; do
      case "$pair" in
        T3FLARE_EXEC=*)
          if [[ "$want" == *" \${pair#T3FLARE_EXEC=} "* ]]; then
            read -r stat < "$dir/stat" 2>/dev/null || break
            rest=\${stat##*) }
            set -- $rest
            echo "$pid $3"
          fi
          break ;;
      esac
    done < "$dir/environ" 2>/dev/null
  done
}

# Every process's group, one "pid pgid" per line.
groups() {
  local dir stat rest
  for dir in /proc/[0-9]*; do
    read -r stat < "$dir/stat" 2>/dev/null || continue
    rest=\${stat##*) }
    set -- $rest
    echo "\${dir#/proc/} $3"
  done
}

signal() {
  local sig=$1 lines all pid pgid g member leader every
  lines=$(marked)
  [ -z "$lines" ] && return 1
  declare -A isMarked=() groupOf=() done=()
  while read -r pid pgid; do isMarked[$pid]=1; groupOf[$pid]=$pgid; done <<< "$lines"
  all=$(groups)
  for pid in "\${!isMarked[@]}"; do
    g=\${groupOf[$pid]}
    [ -n "\${done[$g]:-}" ] && continue
    leader=0; every=1
    while read -r member pgid; do
      [ "$pgid" = "$g" ] || continue
      [ "$member" = "$g" ] && [ -n "\${isMarked[$member]:-}" ] && leader=1
      [ -z "\${isMarked[$member]:-}" ] && every=0
    done <<< "$all"
    if [ "$g" -gt 1 ] && { [ $leader = 1 ] || [ $every = 1 ]; }; then
      kill -s "$sig" -- "-$g" 2>/dev/null
      done[$g]=1
    else
      kill -s "$sig" "$pid" 2>/dev/null
    fi
    signalled=$((signalled + 1))
  done
  return 0
}

start=\${EPOCHREALTIME/[.,]/}
sig=TERM
while signal "$sig"; do
  now=\${EPOCHREALTIME/[.,]/}
  elapsed=$(( (now - start) / 1000 ))
  [ $elapsed -ge 3000 ] && break
  [ $elapsed -ge 2000 ] && sig=KILL
  sleep 0.1
done
survivors=$(marked | grep -c . || true)
printf '{"signalled":%d,"survivors":%d}\n' "$signalled" "$survivors"
`.replaceAll("\\${", "${"); // \${ keeps bash's own expansions out of the template literal

/** The ids the script takes: nothing a shell would read as more than a word. */
const killIds = (execIds: ReadonlyArray<string>) => execIds.filter((id) => /^[A-Za-z0-9-]+$/.test(id));

/** The argv that runs the script for `execIds`, as the Workspace DO execs it on the Container (empty: nothing to kill). */
export const killArgv = (execIds: ReadonlyArray<string>): ReadonlyArray<string> => {
  const ids = killIds(execIds);
  return ids.length === 0 ? [] : ["bash", "-c", KILL_SCRIPT, "t3flare-kill", ...ids];
};

/** The same as one `/bin/sh -c` command line (the kill script's tests run it so). */
export const killCommand = (execIds: ReadonlyArray<string>): string =>
  `exec bash -c '${KILL_SCRIPT.replaceAll("'", "'\\''")}' t3flare-kill ${killIds(execIds).join(" ")}`;
