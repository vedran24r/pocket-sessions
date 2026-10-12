#!/usr/bin/env bash
# One-time setup on macOS. Re-running is safe.
#   scripts/install.sh                         hooks for ~/.claude
#   scripts/install.sh ~/.claude ~/.claude-x   hooks for several Claude config dirs
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

say() { printf '\033[1;33m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(uname)" == "Darwin" ]] || die "The installer supports macOS for now (the app itself is plain Node + tmux)."
command -v tmux >/dev/null || die "tmux is missing: brew install tmux"
command -v node >/dev/null || die "Node is missing (23.6+ needed)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>23||(a===23&&b>=6)?0:1)' || die "Node 23.6+ needed (runs TypeScript directly)"
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
[[ -x "$TS" ]] || die "Tailscale is missing: https://tailscale.com/download"

say "Building"
npm install --no-fund --no-audit --silent
npm run build --silent

say "Linking pocket into ~/.local/bin"
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/bin/pocket" "$HOME/.local/bin/pocket"

say "Installing Claude Code hooks"
node scripts/install-hooks.mjs "$@"

say "Starting the server at login (launchd)"
LOGIN="$("$TS" status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.User[String(j.Self.UserID)].LoginName)})')"
PLIST="$HOME/Library/LaunchAgents/ai.claude-pocket.plist"
sed -e "s|{{NODE}}|$(command -v node)|" -e "s|{{ROOT}}|$ROOT|g" -e "s|{{HOME}}|$HOME|g" -e "s|{{USERS}}|$LOGIN|" \
  -e "s|{{PATH}}|$(dirname "$(command -v tmux)"):/usr/bin:/bin|" launchd/plist.template >"$PLIST"
launchctl bootout "gui/$(id -u)/ai.claude-pocket" 2>/dev/null || true
for _ in {1..20}; do launchctl print "gui/$(id -u)/ai.claude-pocket" >/dev/null 2>&1 || break; sleep 0.25; done
launchctl bootstrap "gui/$(id -u)" "$PLIST"

say "Publishing on your tailnet"
"$TS" serve --bg 8787 || die "Enable Serve + HTTPS for your tailnet (link above), then re-run"
URL="$("$TS" status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("https://"+JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')"

cat <<EOF

Done. Open $URL on your phone → browser menu → Add to Home screen → open it → Enable alerts.
Only $LOGIN can open it.

Last step: make every new Claude session phone-ready. Add to ~/.zshrc (or ~/.bashrc):

  claude() { pocket run "\$@"; }

and for extra profiles, e.g.:

  alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work pocket run'

Sessions already running keep working and show on the phone as view-only.
EOF
