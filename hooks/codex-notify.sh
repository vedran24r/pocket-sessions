#!/usr/bin/env bash
# Codex `notify` program: Codex runs it after every turn with the JSON payload as the last argument.
# Forwards it to the pocket server; sessions outside pocket's tmux are reported read-only.
# Always exits 0 quickly; Codex doesn't wait for it, but keep it cheap anyway.

payload="${*: -1}"
[[ "$payload" == "{"* ]] || exit 0
token="$(cat "${POCKET_STATE_DIR:-$HOME/.pocket-sessions}/hook-token" 2>/dev/null)" || exit 0

session=""
if [[ -n "${TMUX_PANE:-}" ]]; then
  TMUX_BIN="$(command -v tmux || echo /opt/homebrew/bin/tmux)"
  session="$("$TMUX_BIN" display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null)"
  [[ "$session" == pk-* ]] || session=""
fi
if [[ -z "$session" ]]; then
  id="$(printf '%s' "$payload" | sed -n 's/.*"thread-id" *: *"\([0-9a-fA-F-]\{8\}\).*/\1/p' | head -1 | tr 'A-F' 'a-f')"
  [[ -n "$id" ]] || exit 0
  session="ro-codex-$id"
fi

(
  curl -s -m 3 -X POST \
    -H "content-type: application/json" \
    -H "x-pocket-token: $token" \
    -H "x-pocket-agent: codex" \
    -H "x-pocket-codex-home: ${CODEX_HOME:-$HOME/.codex}" \
    --data-binary @- \
    "http://127.0.0.1:${POCKET_PORT:-8787}/api/hook?session=$session" \
    <<<"$payload" >/dev/null 2>&1 &
)
exit 0
