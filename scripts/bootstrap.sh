#!/usr/bin/env bash
# One-line install: curl -fsSL https://raw.githubusercontent.com/vedran24r/pocket-sessions/main/scripts/bootstrap.sh | bash
# Downloads Pocket Sessions to ~/pocket-sessions (or $POCKET_HOME) and runs the installer.
set -euo pipefail
DEST="${POCKET_HOME:-$HOME/pocket-sessions}"
REPO="https://github.com/vedran24r/pocket-sessions"

if [[ -d "$DEST/.git" ]]; then
  git -C "$DEST" pull --ff-only --quiet
elif command -v git >/dev/null; then
  git clone --quiet "$REPO.git" "$DEST"
else
  # No git yet (fresh Mac): the installer installs it; a tarball is enough to get started.
  mkdir -p "$DEST"
  curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$DEST" --strip-components=1
fi
exec bash "$DEST/scripts/install.sh" "$@"
