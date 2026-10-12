#!/usr/bin/env bash
# One-time setup on macOS or Linux. Re-running is safe.
#   scripts/install.sh                         Claude hooks for ~/.claude
#   scripts/install.sh ~/.claude ~/.claude-x   Claude hooks for several Claude config dirs
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
OS="$(uname)"

say() { printf '\033[1;33m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$OS" == "Darwin" || "$OS" == "Linux" ]] || die "Supported: macOS and Linux."
command -v tmux >/dev/null || die "tmux is missing (brew install tmux / apt install tmux)"
command -v node >/dev/null || die "Node is missing (23.6+ needed)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>23||(a===23&&b>=6)?0:1)' || die "Node 23.6+ needed (runs TypeScript directly)"
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
[[ -x "$TS" ]] || die "Tailscale is missing: https://tailscale.com/download"
tsjson() { "$TS" status --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log($1)})"; }

say "Building"
npm install --no-fund --no-audit --silent
npm run build --silent

say "Linking pocket into ~/.local/bin"
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/bin/pocket" "$HOME/.local/bin/pocket"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "Add ~/.local/bin to your PATH" ;; esac

say "Installing Claude Code hooks"
node scripts/install-hooks.mjs "$@"

if command -v codex >/dev/null || [[ -d "${CODEX_HOME:-$HOME/.codex}" ]]; then
  say "Installing the Codex notifier"
  node scripts/install-codex.mjs
fi

mkdir -p "$HOME/.pocket-sessions" # the service's log file lives here
LOGIN="$(tsjson 'j.User[String(j.Self.UserID)].LoginName')"
fill() {
  sed -e "s|{{NODE}}|$(command -v node)|" -e "s|{{ROOT}}|$ROOT|g" -e "s|{{HOME}}|$HOME|g" -e "s|{{USERS}}|$LOGIN|" \
    -e "s|{{PATH}}|$(dirname "$(command -v tmux)"):$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin|" "$1"
}

if [[ "$OS" == "Darwin" ]]; then
  say "Starting the server at login (launchd)"
  PLIST="$HOME/Library/LaunchAgents/ai.pocket-sessions.plist"
  fill service/launchd.plist.template >"$PLIST"
  launchctl bootout "gui/$(id -u)/ai.pocket-sessions" 2>/dev/null || true
  for _ in {1..20}; do launchctl print "gui/$(id -u)/ai.pocket-sessions" >/dev/null 2>&1 || break; sleep 0.25; done
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  say "Starting the server at login (systemd user service)"
  command -v systemctl >/dev/null || die "systemd is needed to keep the server running (or run: node server/server.ts)"
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  fill service/systemd.service.template >"$UNIT_DIR/pocket-sessions.service"
  systemctl --user daemon-reload
  systemctl --user enable --now pocket-sessions.service
  systemctl --user restart pocket-sessions.service
  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
    say "To keep sessions reachable while you're logged out: sudo loginctl enable-linger $USER"
  fi
fi

say "Publishing on your tailnet"
if ! "$TS" serve --bg 8787; then
  [[ "$OS" == "Linux" ]] && say "On Linux, let your user manage Tailscale once: sudo tailscale set --operator=$USER"
  die "Enable Serve + HTTPS for your tailnet (link above, if any), then re-run"
fi
URL="https://$(tsjson 'j.Self.DNSName.replace(/\.$/,"")')"

RC=".zshrc"; [[ "${SHELL:-}" == */bash ]] && RC=".bashrc"
cat <<EOF

Done. Open $URL on your phone → browser menu → Add to Home screen → open it → Enable alerts.
Only $LOGIN can open it.

Last step: make every new agent session phone-ready. Add to ~/$RC and open a new terminal:

  claude() { pocket run "\$@"; }
  codex() { pocket run -- codex "\$@"; }      # if you use Codex
  gemini() { pocket run -- gemini "\$@"; }    # any other terminal agent works the same way

Sessions already running keep working; Claude ones show on the phone as view-only.
EOF
