# Sourced by every hook in this directory, never run directly.
#
# Git invokes hooks with a minimal PATH that often excludes a user-local Node install —
# `~/.local/bin`, nvm's per-version bin, Homebrew's `/opt/homebrew/bin` on Apple Silicon — so a
# bare `exec node ...` can fail with `exec: node: not found`. That reads as a git problem, and a
# QA round measured exactly that reading it caused: a push aborted on this line, on a machine
# where node was installed and worked everywhere else, under `~/.local`. Widen the search before
# giving up, and say plainly what happened and how to recover if it still cannot be found, rather
# than leaving the generic shell error as the only trace.
if ! command -v node >/dev/null 2>&1; then
  for candidate in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do
    if [ -x "$candidate/node" ]; then
      PATH="$candidate:$PATH"
      export PATH
      break
    fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo "$(basename "$0"): node not found on PATH or in common install locations" \
    "(~/.local/bin, Homebrew, Volta). The privacy check could not run — add node to PATH," \
    "or run 'npm run verify:privacy' by hand before pushing." >&2
  exit 1
fi
