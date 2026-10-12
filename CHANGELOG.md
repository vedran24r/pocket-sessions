# Changelog

## 1.0.0 — 2026-10-12

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
- Sessions are named after the conversation, and a `/rename` name always wins. **Rename** on the phone renames the session, and the phone and the laptop tab update together.
- The terminal resizes to fit the phone while no laptop terminal is attached. Tab titles follow the agent's own title.
- Any terminal agent works with `pocket run -- <cmd>`, with "went quiet" notifications.
- Codex adapter: a Chat view, a push on every finished turn, view-only sessions, and Continue on phone via `codex fork`.
- One-line install (`curl … | bash`) for macOS, Linux and Windows through WSL2. It installs anything missing (git, curl, tmux, Node, Tailscale, Claude Code) after asking once, adds the shell wrapper, waits for you at the steps only you can do, and ends with a summary and a QR code for the phone. Tested on macOS and on a clean Ubuntu 24.04 (with systemd); WSL uses the same Linux path but hasn't been run on a real Windows machine yet. Pocket is reachable only over your Tailscale network, and only your Tailscale login can open it.
