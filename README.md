# Pocket

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

- `claude` becomes a small shell function that starts Claude inside a dedicated tmux server (`tmux -L pocket`). Your terminal attaches to it as usual. Close the window and the session keeps running, so you can reach it from the phone or reattach with `pocket attach <name>`.
- Claude Code **hooks** tell the server when a session starts, works, finishes or waits for permission. The server turns that into status dots and Web Push notifications.
- **Chat view:** the conversation as readable bubbles, built from Claude's transcript file.
- **Terminal view:** the actual screen, for menus and prompts. Quick keys: `Esc 1 2 3 ⏎ ↑ ↓ ⇧Tab ^C`.
- Typed or dictated text is pasted with bracketed paste, so a multi-line message stays one message.
- Sessions that were already running before you installed Pocket, or started outside it, still appear: **view only**, with chat and notifications. Restart one with `claude --continue` to make it typeable.

## Other agents

Any terminal program can run under Pocket:

```bash
pocket run -- codex
pocket run -- gemini
pocket run -- aider --model sonnet
```

Add a wrapper like `codex() { pocket run -- codex "$@"; }` to make it automatic.

| | Claude Code | Any other agent |
|---|---|---|
| Terminal view, typing, quick keys | ✅ | ✅ |
| Fits the terminal to the phone while the laptop is detached | ✅ | ✅ |
| Push when finished | ✅ from hooks | ✅ when the screen goes quiet after working |
| Push when it asks for permission | ✅ | covered by the "went quiet" push |
| Chat view (readable conversation) | ✅ | — terminal only, for now |
| Continue a session started outside Pocket | ✅ | — |

Richer adapters (a chat view and exact notifications for Codex and friends) are the next step. PRs welcome.

## Requirements

- macOS (the installer uses launchd; the server itself is plain Node and tmux, so Linux support is a small PR away)
- Node 23.6+, tmux (`brew install tmux`), and Tailscale on the Mac and the phone
- In the Tailscale admin console: **Serve** and **HTTPS certificates** enabled. The first `tailscale serve` prints the link if they aren't.

## Install

```bash
git clone https://github.com/vedran24r/claude-pocket.git ~/Projects/claude-pocket
cd ~/Projects/claude-pocket
scripts/install.sh                          # or: scripts/install.sh ~/.claude ~/.claude-work   (several config dirs)
```

Then add the wrapper to `~/.zshrc` (the installer prints this too):

```bash
claude() { pocket run "$@"; }
```

Aliases that set `CLAUDE_CONFIG_DIR` and then call `claude` keep working. The profile name shown on the phone comes from the config dir (`~/.claude-work` → `work`), or from `POCKET_PROFILE`.

On the phone: open the `https://<your-mac>.<tailnet>.ts.net` address the installer printed. Then browser menu → **Add to Home screen**, open the app, and tap **🔔 Enable alerts**.

## Everyday use

| You want to… | Do |
|---|---|
| Start a session | `claude` as usual |
| Bypass Pocket once | `command claude` |
| See what's running | `pocket ls` |
| Get a closed window's session back | `pocket attach <name>` |

One-shot commands (`claude -p`, `claude --version`, `claude mcp …`) are passed straight through and never notify.

## Notifications

You get a push when a session **finishes a turn** or **needs input** (a permission prompt, a question). Tapping it opens that session. Nothing is pushed for a session you typed into on the laptop in the last 90 seconds, because you're clearly there.

Pushes include the start of Claude's reply. To limit that to some profiles, set `POCKET_PREVIEW_PROFILES=game,personal` in the launchd plist. Payloads are end-to-end encrypted by the Web Push protocol.

## Security

Anyone who can open the app can type into your sessions, so:

- The server binds to `127.0.0.1` and is reachable only through `tailscale serve`.
- Every request must carry Tailscale's `Tailscale-User-Login` header, and that login must be in `POCKET_USERS`. The server refuses to start with an empty list.
- Hooks authenticate with a random token in `~/.claude-pocket/hook-token` (mode 600).
- Don't expose it with `tailscale funnel`.

## Development

```bash
npm install
POCKET_DEV=1 POCKET_PORT=8788 node server/server.ts   # no auth, localhost only
npm run dev                                            # Vite on :5173, proxies /api to :8787
npm run typecheck
```

After changing `web/`, run `npm run build`. After changing `server/`, run `launchctl kickstart -k gui/$(id -u)/ai.claude-pocket`. Logs are in `~/.claude-pocket/server.log`.

## Uninstall

```bash
launchctl bootout gui/$(id -u)/ai.claude-pocket && rm ~/Library/LaunchAgents/ai.claude-pocket.plist
tailscale serve --https=443 off
rm ~/.local/bin/pocket
```

Then remove the `claude()` line from your shell rc and the `pocket-hook.sh` entries from each `settings.json` (a backup sits next to each one as `settings.json.bak-pocket`).

## License

MIT. Not affiliated with Anthropic.
