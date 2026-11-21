# What every Container command's bash reads before the command: the Workspace DO points BASH_ENV here (`COMMAND_ENV`),
# and bash reads the file named there when it starts non-interactively, as the `exec bash -c '…'` a command runs in
# does. The command's own text is not changed, so its line numbers are its own.
#
# When the command ends, it prints on stderr each note the memory guard left while it ran (`t3flare-memory-guard`):
# the guard stops the largest process when the Container is nearly out of memory, and the command it belonged to would
# otherwise only show a process that died. Notes from before the command started are not repeated. A command that sets
# its own EXIT trap replaces this one, and gets no note.
#
# BASH_ENV is unset first, so a bash the command starts reads nothing and prints no note a second time.
#
# bash skips BASH_ENV when its stdin is a socket and SHLVL is unset or 0: it takes itself for a command rshd started
# and reads ~/.bashrc instead. computerd gives a command /dev/null for stdin, so that never happens here.
#
# T3FLARE_MEMORY_NOTES overrides its default; the image sets none.
unset BASH_ENV

__t3flare_started=${EPOCHREALTIME/[.,]/}

__t3flare_memory_notes() {
  local note name

  for note in "${T3FLARE_MEMORY_NOTES:-/run/t3flare-memory-guard}"/*; do
    name=${note##*/}
    [[ $name =~ ^[0-9]+$ ]] && ((name >= __t3flare_started)) || continue
    printf '%s\n' "$(<"$note")" >&2
  done
}

trap __t3flare_memory_notes EXIT
