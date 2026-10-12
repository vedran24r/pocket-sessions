# Changelog

## 1.0.0 — unreleased

First release.

- Every `claude` session runs in a dedicated tmux server, so your phone can watch it and type into it. You keep typing `claude` as usual.
- Phone app (installable PWA):
  - a session list, by conversation name, with live status
  - a Chat view and a Terminal view
  - a composer made for voice dictation, and quick keys
- Push notifications when a session finishes a turn or needs you. None are sent while you're typing on the laptop.
- Closing a terminal window ends its session, and the phone drops it within seconds. Detach with `Ctrl-b d` to keep a session running for the phone.
- Sessions started outside Pocket appear view-only. **Continue on phone** starts a typeable copy, and shows the `pocket attach` command to open that copy on the laptop too.
- Two windows on the same Claude conversation each show their own thread, with a note that the history is shared.
- **End** closes a session from the phone; **Hide** removes a view-only one from the list.
- The terminal resizes to fit the phone while no laptop terminal is attached. Tab titles follow the agent's own title.
- Any terminal agent works with `pocket run -- <cmd>`, with "went quiet" notifications.
- Codex adapter: a Chat view, a push on every finished turn, view-only sessions, and Continue on phone via `codex fork`.
- One-command install on macOS (launchd) and Linux (systemd user service; the Linux path is lint-checked but not yet run on a real Linux machine). Pocket is reachable only over your Tailscale network, and only your Tailscale login can open it.
