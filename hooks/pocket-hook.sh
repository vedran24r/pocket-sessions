#!/usr/bin/env bash
# Claude Code hook: forwards the event to the pocket server.
# Sessions inside the pocket tmux server are typeable from the phone; any other session is
# reported read-only (chat + notifications), keyed by its Claude session id.
# Backgrounds the POST and always exits 0, so it never slows down or blocks Claude.

# Only interactive sessions: `claude -p` runs (scripts, other tools) report "sdk-cli" and would spam pushes.
[[ "${CLAUDE_CODE_ENTRYPOINT:-cli}" == "cli" ]] || exit 0

token="$(cat "${POCKET_STATE_DIR:-$HOME/.claude-pocket}/hook-token" 2>/dev/null)" || exit 0
payload="$(cat)"

session=""
if [[ -n "${TMUX_PANE:-}" ]]; then
  TMUX_BIN="$(command -v tmux || echo /opt/homebrew/bin/tmux)"
  session="$("$TMUX_BIN" display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null)"
  [[ "$session" == cc-* ]] || session=""
fi
if [[ -z "$session" ]]; then
  id="$(printf '%s' "$payload" | sed -n 's/.*"session_id" *: *"\([0-9a-fA-F-]\{8\}\).*/\1/p' | head -1 | tr 'A-F' 'a-f')"
  [[ -n "$id" ]] || exit 0
  if [[ -n "${POCKET_PROFILE:-}" ]]; then
    profile="$(printf '%s' "$POCKET_PROFILE" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
  elif [[ -n "${CLAUDE_CONFIG_DIR:-}" ]]; then
    profile="$(basename "$CLAUDE_CONFIG_DIR" | sed -e 's/^\.//' -e 's/^claude-//' | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
  else
    profile="claude"
  fi
  session="ro-$profile-$id"
fi

(
  curl -s -m 3 -X POST \
    -H "content-type: application/json" \
    -H "x-pocket-token: $token" \
    -H "x-pocket-config-dir: ${CLAUDE_CONFIG_DIR:-}" \
    --data-binary @- \
    "http://127.0.0.1:${POCKET_PORT:-8787}/api/hook?session=$session" \
    <<<"$payload" >/dev/null 2>&1 &
)
exit 0
