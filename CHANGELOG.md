# Changelog

## 1.0.0 — 2026-10-12

First release.

**Sessions**

- Every `claude` session runs in a dedicated tmux server, so your phone can watch it and type into it. You keep typing `claude` as usual.
- Closing a terminal window ends its session, and the phone drops it within seconds. Detach with `Ctrl-b d` to keep a session running for the phone.
- Sessions started outside Pocket appear view-only. **Continue on phone** starts a typeable copy, and shows the `pocket attach` command to open that copy on the laptop too.
- Sessions are named after the conversation, and a `/rename` name always wins. **Rename** on the phone renames the session, and the phone and the laptop tab update together.
- Any terminal agent works with `pocket run -- <cmd>`, with "went quiet" notifications.
- Codex adapter: a Chat view, a push on every finished turn, view-only sessions, and Continue on phone via `codex fork`.

**Phone app** (installable web app)

- Session list by conversation name with live status. Sessions that need you come first, and the app icon shows a badge with how many are waiting.
- Chat view, Terminal view, and a **Changes** tab: what the session changed in every repository it worked in (its folder, plus worktrees or other repos it edited). On a feature branch it counts everything since the branch split off the main branch, committed or not. It shows lines added and removed, with a diff per file.
- A message you send shows at once ("sending…"), including one typed while the agent is busy. Pocket makes sure it's actually submitted.
- While the agent works, the chat shows its live status line (e.g. "✻ Determining… (8s · ↓ 89 tokens)"), with a **Stop** button. Once it stops (finished, Stop, Esc or Ctrl-C), the line goes away within seconds.
- A message box made for voice dictation, one-tap **quick replies** ("continue", "commit and push"…) that you can edit, and a minimal keys bar (Esc, ⏎, ⇧Tab, ^C, and ⋯ for the rest). Menus are answered by tapping the option.
- **Tap and swipe in the Terminal tab:** a tap is a click, and a vertical swipe scrolls with phone-like momentum, so menus like `/status` and `/config` work by touch. The screen refreshes right after each touch. It only applies when the program on screen accepts mouse input.
- The app fits exactly the visible screen, above the keyboard and the system navigation bar. The terminal always fits whole (scaled down if a laptop window keeps it larger), and the chat stays on the newest message.
- **Images** from the gallery: shrunk on the phone and passed to the agent; they show as pictures in the chat.
- Tappable links in messages.
- **＋ New** starts a session in a recent folder, with any Claude profile or Codex. **End** closes a session; **Hide** removes a view-only one.
- While you view the Terminal tab, the session takes the phone's size (unless you're using the laptop window right now) and reflows to it. It gives the laptop window its size back when you leave. **Pinch** zooms the terminal text, as do A− / A+. Tab titles follow the agent's own title.

**Notifications**

- A push when a session finishes a turn or needs you. None are sent while you're typing on the laptop.
- **Allow / Deny** on permission notifications (Android). It picks the narrowest answer on Claude's menu and never "don't ask again"; if the question is gone, it opens the session.

**Install and connection**

- One-line install (`curl … | bash`) on macOS, Linux and Windows (in WSL). It installs anything missing (git, curl, tmux, Node 26, Claude Code) after asking once. It adds the shell wrapper, waits for you at the steps only you can do, and ends with a summary and a QR code for the phone.
- Works on any network the phone and computer share. Tailscale is recommended: it connects them from anywhere with HTTPS and signs your phone in automatically. On your own network (home Wi-Fi, your own VPN), a private access link (`pocket link`) signs each phone in once.
