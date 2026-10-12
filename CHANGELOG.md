# Changelog

## Unreleased

- **Allow / Deny on the notification:** answer a permission question from the lock screen (Android). Pocket reads the menu and picks the narrowest answer: a one-time Yes, or a No that blocks nothing for later. It never picks "don't ask again" or "keep allowing". If the question is already gone, it opens the session instead.
- **Quick replies:** one-tap messages above the keyboard ("continue", "yes, go ahead", "commit and push", "run the tests"). Tap ✎ to edit them; they're saved on the phone.
- **New session from the phone:** pick the agent (each Claude profile, or Codex) and a recent folder, and it starts there.
- **Sessions that need you come first,** then working ones. The app icon shows a badge with how many are waiting.
- **Stop button** on the working line, to interrupt the agent.
- **Changes tab:** the session folder's changed files, with lines added and removed. Tap a file for its diff. Read-only.
- Send images from the phone's gallery (📎). They're shrunk on the phone, saved on the computer, and passed to the agent by file path. They show as pictures in the chat. Claude sessions are started with that folder allowed, so reading an image doesn't ask for permission.
- Sending makes sure the message is actually submitted: Pocket presses Enter again if the text is still sitting in the agent's input line.

## 1.0.0 — 2026-10-12

First release.

- Every `claude` session runs in a dedicated tmux server, so your phone can watch it and type into it. You keep typing `claude` as usual.
- Phone app (installable PWA):
  - a session list, by conversation name, with live status
  - a Chat view and a Terminal view
  - a composer made for voice dictation, and quick keys
- A message you send shows in the chat at once ("sending…"), including one typed while the agent is busy. That kind is queued by Claude and used to be missing from the chat entirely.
- While the agent works, the chat shows its live status line, e.g. "✻ Determining… (8s · ↓ 89 tokens)" or Codex's "Working (8s)".
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
