#!/usr/bin/env bash
# Sets up Pocket Sessions on macOS, Linux, or Windows via WSL2. Re-running is safe.
# Installs what a script can install, asks before doing so, and stops with clear instructions
# (then waits for Enter) for the few steps only a person can do.
#
#   scripts/install.sh                        interactive
#   scripts/install.sh --yes                  answer yes to every question
#   scripts/install.sh ~/.claude ~/.claude-x  Claude config dirs to hook (default: ~/.claude and any ~/.claude-*)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

YES=0
CONFIG_DIRS=()
for arg in "$@"; do
  case "$arg" in
    -y | --yes) YES=1 ;;
    *) CONFIG_DIRS+=("$arg") ;;
  esac
done

# ---------- output ----------
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
say() { printf '\033[1;33m▸ %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m✓ %s\033[0m\n' "$*"; DONE+=("$*"); }
warn() { printf '\033[1;31m! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
DONE=()
MANUAL=()
manual() { MANUAL+=("$*"); }

# Prompts read from the terminal, so they work under `curl ... | bash` too.
HAVE_TTY=0
if (exec </dev/tty) 2>/dev/null; then HAVE_TTY=1; fi
ask() {
  [[ $YES == 1 ]] && return 0
  [[ $HAVE_TTY == 1 ]] || return 1
  local answer
  read -r -p "$1 [Y/n] " answer </dev/tty || return 1
  [[ ! "$answer" =~ ^[Nn] ]]
}
wait_for() {
  [[ $HAVE_TTY == 1 ]] || return 1
  read -r -p "   → $1 Press Enter when done (or Ctrl-C to stop here). " _ </dev/tty || return 1
}

# ---------- platform ----------
OS="$(uname)"
PLATFORM=""
case "$OS" in
  Darwin) PLATFORM=mac ;;
  Linux) if grep -qi microsoft /proc/version 2>/dev/null; then PLATFORM=wsl; else PLATFORM=linux; fi ;;
  *) die "Pocket Sessions runs on macOS, Linux, or Windows through WSL2. On Windows, open PowerShell as admin, run: wsl --install, then run this installer inside Ubuntu." ;;
esac

PM=""
if [[ $PLATFORM == mac ]]; then
  PM=brew
elif command -v apt-get >/dev/null; then PM=apt
elif command -v dnf >/dev/null; then PM=dnf
elif command -v pacman >/dev/null; then PM=pacman
fi
SUDO=""; [[ $(id -u) != 0 ]] && SUDO=sudo
USER="${USER:-$(id -un)}" # unset under docker exec, cron and some SSH setups

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
TS="$(command -v tailscale || true)"
[[ -z "$TS" && -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale

node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>23||(a===23&&b>=6)?0:1)'; }

bold "Pocket Sessions installer ($PLATFORM)"

# ---------- 1. tools ----------
if [[ $PLATFORM == mac ]] && ! command -v brew >/dev/null; then
  say "Homebrew (the Mac package manager) is needed to install the rest."
  if ask "Install Homebrew now?"; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
    eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
  else
    die "Install Homebrew from https://brew.sh, then run this again."
  fi
fi

missing=()
command -v git >/dev/null || missing+=(git)
command -v curl >/dev/null || missing+=(curl)
command -v tmux >/dev/null || missing+=(tmux)
node_ok || missing+=("node (23.6 or newer)")
[[ -n "$TS" ]] || missing+=(tailscale)

if ((${#missing[@]})); then
  say "Missing: ${missing[*]}"
  [[ -n "$PM" ]] || die "No supported package manager found (brew, apt, dnf, pacman). Install these yourself, then run this again: ${missing[*]}"
  ask "Install them now? (may ask for your password)" || die "Install these, then run this again: ${missing[*]}"
  pkgs=()
  for tool in git curl tmux; do command -v "$tool" >/dev/null || pkgs+=("$tool"); done
  case "$PM" in
    brew)
      ((${#pkgs[@]})) && brew install "${pkgs[@]}"
      node_ok || brew install node
      if [[ -z "$TS" ]]; then
        brew install --cask tailscale-app
        TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
      fi ;;
    apt)
      $SUDO apt-get update -qq
      ((${#pkgs[@]})) && $SUDO apt-get install -y "${pkgs[@]}"
      if ! node_ok; then curl -fsSL https://deb.nodesource.com/setup_24.x | $SUDO -E bash - && $SUDO apt-get install -y nodejs; fi ;;
    dnf)
      ((${#pkgs[@]})) && $SUDO dnf install -y "${pkgs[@]}"
      if ! node_ok; then curl -fsSL https://rpm.nodesource.com/setup_24.x | $SUDO -E bash - && $SUDO dnf install -y nodejs; fi ;;
    pacman)
      $SUDO pacman -S --needed --noconfirm ${pkgs[@]+"${pkgs[@]}"} nodejs npm ;;
  esac
  if [[ -z "$TS" && $PLATFORM != mac ]]; then
    curl -fsSL https://tailscale.com/install.sh | sh
    TS="$(command -v tailscale)"
  fi
  hash -r
fi
node_ok || die "Node 23.6+ is still missing. Install it from https://nodejs.org, then run this again."
command -v tmux >/dev/null || die "tmux is still missing. Install it, then run this again."
[[ -n "$TS" ]] || die "Tailscale is still missing. Install it from https://tailscale.com/download, then run this again."
ok "Tools: git, curl, tmux, Node $(node -v), Tailscale"

# ---------- 2. Claude Code ----------
if ! command -v claude >/dev/null; then
  say "Claude Code isn't installed."
  if ask "Install Claude Code now? (official installer from claude.ai)"; then
    curl -fsSL https://claude.ai/install.sh | bash
    hash -r
  fi
fi
if command -v claude >/dev/null; then
  ok "Claude Code $(claude --version 2>/dev/null | head -1)"
else
  manual "Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash   (then run claude once to sign in)"
fi

# ---------- 3. Tailscale sign-in ----------
ts_json() { "$TS" status --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log($1)}catch{}})"; }
ts_ready() { [[ "$(ts_json 'j.BackendState')" == "Running" ]]; }

if [[ $PLATFORM != mac ]]; then
  # Linux/WSL: let this user run `tailscale serve` without sudo.
  if ! systemctl is-active --quiet tailscaled 2>/dev/null; then $SUDO systemctl enable --now tailscaled 2>/dev/null || true; fi
fi
for _ in 1 2 3; do
  ts_ready && break
  say "Tailscale isn't signed in on this computer."
  if [[ $PLATFORM == mac ]]; then
    open -a Tailscale 2>/dev/null || true
    wait_for "In the Tailscale menu-bar app, sign in." || break
  else
    $SUDO "$TS" up --operator="$USER" || true
  fi
done
ts_ready || die "Tailscale isn't signed in. Sign in, then run this again."
[[ $PLATFORM != mac ]] && $SUDO "$TS" set --operator="$USER" 2>/dev/null || true
LOGIN="$(ts_json 'j.User[String(j.Self.UserID)].LoginName')"
ok "Tailscale signed in as $LOGIN"

# ---------- 4. Pocket itself ----------
say "Building Pocket"
npm install --no-fund --no-audit --silent
npm run build --silent
mkdir -p "$HOME/.local/bin" "$HOME/.pocket-sessions"
ln -sf "$ROOT/bin/pocket" "$HOME/.local/bin/pocket"
ok "Built, and linked the pocket command into ~/.local/bin"

if ((${#CONFIG_DIRS[@]} == 0)); then
  CONFIG_DIRS=("$HOME/.claude")
  for dir in "$HOME"/.claude-*; do [[ -f "$dir/settings.json" ]] && CONFIG_DIRS+=("$dir"); done
fi
node scripts/install-hooks.mjs "${CONFIG_DIRS[@]}" >/dev/null
ok "Claude Code hooks installed in: ${CONFIG_DIRS[*]/#$HOME/~}"

if command -v codex >/dev/null || [[ -d "${CODEX_HOME:-$HOME/.codex}" ]]; then
  node scripts/install-codex.mjs
  ok "Codex notifier installed"
fi

# ---------- 5. background service ----------
fill() {
  sed -e "s|{{NODE}}|$(command -v node)|" -e "s|{{ROOT}}|$ROOT|g" -e "s|{{HOME}}|$HOME|g" -e "s|{{USERS}}|$LOGIN|" \
    -e "s|{{PATH}}|$(dirname "$(command -v tmux)"):$(dirname "$(command -v node)"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin|" "$1"
}
if [[ $PLATFORM == mac ]]; then
  PLIST="$HOME/Library/LaunchAgents/ai.pocket-sessions.plist"
  fill service/launchd.plist.template >"$PLIST"
  launchctl bootout "gui/$(id -u)/ai.pocket-sessions" 2>/dev/null || true
  for _ in {1..20}; do launchctl print "gui/$(id -u)/ai.pocket-sessions" >/dev/null 2>&1 || break; sleep 0.25; done
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  ok "Server runs in the background and starts at login (launchd)"
else
  if [[ ! -d /run/systemd/system ]]; then
    if [[ $PLATFORM == wsl ]] && ask "WSL needs systemd switched on to keep Pocket running. Turn it on?"; then
      printf '[boot]\nsystemd=true\n' | $SUDO tee -a /etc/wsl.conf >/dev/null
      die "systemd is now on. In Windows PowerShell run: wsl --shutdown   then reopen Ubuntu and run this installer again."
    fi
    die "systemd isn't running here, so Pocket can't run in the background. Start it by hand instead: node $ROOT/server/server.ts"
  fi
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  fill service/systemd.service.template >"$UNIT_DIR/pocket-sessions.service"
  systemctl --user daemon-reload
  systemctl --user enable --now pocket-sessions.service >/dev/null 2>&1
  systemctl --user restart pocket-sessions.service
  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]] && ask "Keep Pocket running while you're logged out?"; then
    $SUDO loginctl enable-linger "$USER" || true
  fi
  ok "Server runs in the background (systemd user service)"
fi

# ---------- 6. publish on the tailnet ----------
served=0
for _ in 1 2 3; do
  if "$TS" serve --bg 8787 >/dev/null 2>&1; then served=1; break; fi
  say "Your tailnet needs three switches on (one time, in your browser):"
  echo "   1. https://login.tailscale.com/admin/dns   → enable MagicDNS and HTTPS Certificates"
  echo "   2. Run once, and follow the link it prints to enable Serve: $TS serve --bg 8787"
  wait_for "Turn those on." || break
done
URL="https://$(ts_json 'j.Self.DNSName.replace(/\.$/,"")')"
if [[ $served == 1 ]]; then
  ok "Published at $URL (only your tailnet can reach it; only $LOGIN can open it)"
else
  manual "Enable MagicDNS + HTTPS Certificates at https://login.tailscale.com/admin/dns, then run: $TS serve --bg 8787"
fi

# ---------- 7. shell wrapper ----------
RC="$HOME/.zshrc"; [[ "${SHELL:-}" == */bash ]] && RC="$HOME/.bashrc"
if grep -Eqs '>>> pocket-sessions >>>|pocket"? run' "$RC"; then
  ok "Shell wrapper already in ${RC/#$HOME/~}"
elif ask "Make every new 'claude' session phone-ready by adding a wrapper to ${RC/#$HOME/~}?"; then
  [[ -f "$RC" ]] && cp "$RC" "$RC.bak-pocket"
  {
    echo ""
    echo "# >>> pocket-sessions >>> (makes claude sessions reachable from your phone; 'command claude' bypasses it)"
    echo 'claude() { "$HOME/.local/bin/pocket" run "$@"; }'
    command -v codex >/dev/null && echo 'codex() { "$HOME/.local/bin/pocket" run -- codex "$@"; }'
    echo "# <<< pocket-sessions <<<"
  } >>"$RC"
  ok "Shell wrapper added to ${RC/#$HOME/~} (backup: ${RC/#$HOME/~}.bak-pocket)"
else
  manual "Add to ${RC/#$HOME/~}:  claude() { \"\$HOME/.local/bin/pocket\" run \"\$@\"; }"
fi

# ---------- summary ----------
echo
bold "Done on this computer:"
for line in "${DONE[@]}"; do echo "  ✓ $line"; done
echo
bold "Left for you (about 2 minutes):"
step=1
for line in ${MANUAL[@]+"${MANUAL[@]}"}; do echo "  $step. $line"; step=$((step + 1)); done
echo "  $step. Open a NEW terminal tab (so the wrapper loads) and start claude as usual."; step=$((step + 1))
echo "  $step. On your phone: install Tailscale, sign in as $LOGIN."; step=$((step + 1))
echo "  $step. On your phone, open $URL (or scan the code below), then: browser menu → Add to Home screen → open it → tap 🔔 Enable alerts."
echo "     (iPhone: Safari, iOS 16.4+, and alerts only work from the Home Screen icon.)"
if [[ $served == 1 ]]; then
  echo
  node -e "require('qrcode-terminal').generate(process.argv[1], { small: true })" "$URL" 2>/dev/null || true
fi
