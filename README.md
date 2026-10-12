# Pocket Sessions

**Your AI coding agents on your phone.** See every running session live, scroll the conversation, reply by voice, answer prompts, and get a push notification when a session finishes or needs you. Claude Code gets the richest integration; Codex, Gemini CLI, Aider, OpenCode or any other terminal agent works too.

The use case: you have three or four Claude Code sessions going, you step away for coffee, and they finish one by one. With Pocket you check your phone, send the next instruction to each, put the phone away, and the work keeps going.

- **Private by design:** it runs on your own Mac and is reachable only over your [Tailscale](https://tailscale.com) network. There's no relay server and no account, and nothing leaves your tailnet.
- **Zero habit change:** you keep typing `claude` in your terminal. Every session is phone-ready automatically.
- **Fast:** the app shell is about 4 KB gzipped. It's an installable web app (PWA), so it works on Android and iOS without an app store.
- **Voice:** a big text box made for your keyboard's dictation (Gboard on Android, Apple's keyboard mic on iOS).

> Anthropic's own [Remote Control](https://code.claude.com/docs/en/remote-control) does something similar through claude.ai. Use that if your plan and org allow it. Pocket is for when they don't, or when you'd rather keep everything self-hosted.

## How it works

```
phone (PWA) ──HTTPS over Tailscale──▶ tailscale serve ──▶ pocket server (127.0.0.1:8787)
                                                              │
                         Claude Code hooks ───────────────────┤ status + push notifications
                         session transcripts (JSONL) ─────────┤ Chat view
                         tmux -L pocket ──────────────────────┘ Terminal view + typing
```

- `claude` becomes a small shell function that starts Claude inside a dedicated tmux server (`tmux -L pocket`). Your terminal attaches to it as usual. Closing the window ends the session and it disappears from the phone within a few seconds, just like before. To leave a session running for the phone without a window, detach instead (`Ctrl-b d`), or set `POCKET_KEEP_ON_CLOSE=1`.
- Claude Code **hooks** tell the server when a session starts, works, finishes or waits for permission. The server turns that into status dots and Web Push notifications.
- **Chat view:** the conversation as readable bubbles, built from Claude's transcript file.
- **Terminal view:** the actual screen, for menus and prompts. Quick keys: `Esc 1 2 3 ⏎ ↑ ↓ ⇧Tab ^C`.
- Typed or dictated text is pasted with bracketed paste, so a multi-line message stays one message.
- Sessions started outside Pocket (or before you installed it) still appear: **view only**, with chat and notifications. Tap **Continue on phone** and the conversation resumes in a new, typeable session on your computer (a fork, so the original window is left alone).

## Other agents

Any terminal program can run under Pocket:

```bash
pocket run -- codex
pocket run -- gemini
pocket run -- aider --model sonnet
```

Add a wrapper like `codex() { pocket run -- codex "$@"; }` to make it automatic (the installer prints these).

| | Claude Code | Codex | Any other agent |
|---|---|---|---|
| Terminal view, typing, quick keys | ✅ | ✅ | ✅ |
| Terminal fits the phone while the laptop is detached | ✅ | ✅ | ✅ |
| Chat view (readable conversation) | ✅ | ✅ | — |
| Push when a turn finishes | ✅ hooks | ✅ `notify` | ✅ screen goes quiet after working |
| Push when it needs permission | ✅ | ✅ screen goes quiet | ✅ screen goes quiet |
| View sessions started outside Pocket | ✅ | ✅ | — |
| Continue on phone | ✅ `claude --resume --fork-session` | ✅ `codex fork` | — |

**Codex:** the installer adds `notify = [".../hooks/codex-notify.sh"]` to `~/.codex/config.toml` (or `$CODEX_HOME`). If you already have a `notify` program it's left alone, and the installer prints how to call ours from it. The Chat view reads Codex's session logs in `~/.codex/sessions`, and `codex exec` runs are ignored.

Adapters for more agents are welcome: one parser in `server/transcript.ts` and one notifier in `hooks/`.

## Requirements

- **Computer:** macOS (launchd) or Linux (systemd user service), with Claude Code (or another terminal agent), Node 23.6+, tmux (`brew install tmux` / `apt install tmux`), git, curl and [Tailscale](https://tailscale.com/download)
- **Phone:** the Tailscale app, signed in to the same tailnet, and a browser that can install web apps and receive push: Chrome on Android, or Safari on iOS 16.4+ (on iOS, push only works after **Add to Home Screen**)
- Linux only: let your user manage Tailscale once with `sudo tailscale set --operator=$USER`, and run `sudo loginctl enable-linger $USER` if sessions should stay reachable while you're logged out
- In the Tailscale admin console: **MagicDNS**, **HTTPS certificates** and **Serve** enabled. The first `tailscale serve` prints the link if they aren't.

## Install

```bash
git clone https://github.com/vedran24r/pocket-sessions.git ~/Projects/pocket-sessions
cd ~/Projects/pocket-sessions
scripts/install.sh                          # or: scripts/install.sh ~/.claude ~/.claude-work   (several config dirs)
```

Then add the wrapper to `~/.zshrc` (the installer prints this too):

```bash
claude() { ~/.local/bin/pocket run "$@"; }
```

Aliases that set `CLAUDE_CONFIG_DIR` and then call `claude` keep working. The profile name shown on the phone comes from the config dir (`~/.claude-work` → `work`), or from `POCKET_PROFILE`.

On the phone: open the `https://<your-mac>.<tailnet>.ts.net` address the installer printed. Then browser menu → **Add to Home screen**, open the app, and tap **🔔 Enable alerts**.

## Everyday use

| You want to… | Do |
|---|---|
| Start a session | `claude` as usual |
| Bypass Pocket once | `command claude` |
| See what's running | `pocket ls` |
| Leave a session running for the phone | detach with `Ctrl-b d` |
| Get a detached session back | `pocket attach <name>` |
| Close a session from the phone | open it → **End** (a view-only one: **Hide**) |

One-shot commands (`claude -p`, `claude --version`, `claude mcp …`) are passed straight through and never notify.

## Notifications

You get a push when a session **finishes a turn** or **needs input** (a permission prompt, a question). Tapping it opens that session. Nothing is pushed for a session you typed into on the laptop in the last 90 seconds, because you're clearly there.

Pushes include the start of Claude's reply. To limit that to some profiles, set `POCKET_PREVIEW_PROFILES=game,personal` in the service file (launchd plist or systemd unit). Payloads are end-to-end encrypted by the Web Push protocol.

## Security

Anyone who can open the app can type into your sessions, so:

- The server binds to `127.0.0.1` and is reachable only through `tailscale serve`.
- Every request must carry Tailscale's `Tailscale-User-Login` header, and that login must be in `POCKET_USERS`. The server refuses to start with an empty list.
- Hooks authenticate with a random token in `~/.pocket-sessions/hook-token` (mode 600).
- Don't expose it with `tailscale funnel`.

## Development

```bash
npm install
POCKET_DEV=1 POCKET_PORT=8788 node server/server.ts   # no auth, localhost only
npm run dev                                            # Vite on :5173, proxies /api to :8787
npm run typecheck
```

After changing `web/`, run `npm run build`. After changing `server/`, restart the service: `launchctl kickstart -k gui/$(id -u)/ai.pocket-sessions` on macOS, `systemctl --user restart pocket-sessions` on Linux. Logs are in `~/.pocket-sessions/server.log`.

## Uninstall

```bash
# macOS
launchctl bootout gui/$(id -u)/ai.pocket-sessions && rm ~/Library/LaunchAgents/ai.pocket-sessions.plist
# Linux
systemctl --user disable --now pocket-sessions && rm ~/.config/systemd/user/pocket-sessions.service

tailscale serve --https=443 off
rm ~/.local/bin/pocket
```

Then remove the `claude()` line from your shell rc and the `pocket-hook.sh` entries from each `settings.json` (a backup sits next to each one as `settings.json.bak-pocket`).

## License

MIT. Not affiliated with Anthropic.
