# Changelog

## Unreleased

- View-only sessions show their conversation name too, read from Claude's transcript.

## 1.0.1 — 2026-10-12

- Sessions are listed by their conversation's name (e.g. "Scalability and performance metrics baseline"), not only by folder, so copies and duplicates are easy to tell apart.
- **Continue on phone** says plainly that it starts a copy, and shows the `pocket attach` command to open that copy on the laptop too.
- Two windows resumed into the same Claude conversation: each window's Chat shows only its own thread, with a note saying the history is shared.
- Terminal tab titles follow the agent's own title (e.g. Claude's status icons), even inside tmux.

## 1.0.0 — 2026-10-12

First release.

- Every `claude` session runs in a dedicated tmux server, so your phone can watch it and type into it. You keep typing `claude` as usual.
- Phone app (installable PWA): a session list with live status, a Chat view, a Terminal view, a voice-friendly composer and quick keys.
- Push notifications when a session finishes a turn or needs you. None are sent while you're typing on the laptop.
- Sessions started outside Pocket appear view-only. **Continue on phone** forks them into a typeable session.
- **End** closes a session from the phone; **Hide** removes a view-only one from the list.
- Closing a terminal window ends its session. Detach with `Ctrl-b d` to leave it running for the phone, or set `POCKET_KEEP_ON_CLOSE=1`.
- The terminal resizes to fit the phone while no laptop terminal is attached.
- Any terminal agent works with `pocket run -- <cmd>`, with "went quiet" notifications.
- Codex adapter: Chat view, a push on every finished turn, view-only sessions, and Continue on phone via `codex fork`.
- One-command install on macOS (launchd) and Linux (systemd user service; the Linux path is lint-checked but not yet run on a real Linux machine — reports welcome). It's reachable only over your Tailscale network, and only your Tailscale login can open it.
