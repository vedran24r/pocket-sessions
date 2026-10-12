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

## Install

**macOS, Linux, or Windows (through WSL2)** — one command:

```bash
curl -fsSL https://raw.githubusercontent.com/vedran24r/pocket-sessions/main/scripts/bootstrap.sh | bash
```

It downloads Pocket to `~/pocket-sessions` and runs the installer, which:

- **installs what's missing, after asking once:** git, curl, tmux, Node, Tailscale and Claude Code (Homebrew on a Mac; apt, dnf or pacman on Linux)
- sets up the Claude Code hooks (in `~/.claude` and any `~/.claude-*` config dirs), plus the Codex notifier if Codex is installed
- starts the server in the background (launchd on macOS, a systemd user service on Linux and WSL)
- publishes it on your tailnet
- adds the `claude()` wrapper to your shell, so every new session is phone-ready

Where only you can act, such as signing in to Tailscale or switching on the tailnet's HTTPS, it says exactly what to do and waits for Enter. It ends with what it did, what's left (the phone steps), and a QR code to open the app on your phone.

Re-run it any time to update or repair; it's safe to run twice. Add `--yes` to skip the questions.

**Windows:** Pocket needs tmux, which Windows doesn't have, so it runs inside WSL2 (Windows' built-in Linux). Claude Code runs there too.

1. Open PowerShell as administrator and run `wsl --install`. Restart if asked, then open **Ubuntu**.
2. Inside Ubuntu, run the command above. If it asks to switch on systemd, say yes, run `wsl --shutdown` in PowerShell, reopen Ubuntu and run it again.
3. Start your Claude sessions inside Ubuntu, not in PowerShell.

Native Windows (Claude Code started from PowerShell) isn't supported.

**On the phone** (the installer reminds you):

1. Install the Tailscale app and sign in to the same account.
2. Open the address the installer printed, or scan its QR code.
3. Browser menu → **Add to Home screen**. Open the app from there and tap **🔔 Enable alerts**.

Use Chrome on Android, or Safari on iOS 16.4+. On iPhone, alerts only work from the Home Screen icon.

### Setup notes for AI assistants

If someone asks you (an AI coding assistant) to install Pocket Sessions for them, everything below is what it needs:

- **Supported:** macOS 13+, Linux with systemd, Windows only through WSL2 (run everything inside the WSL distro).
- **Command:** `curl -fsSL https://raw.githubusercontent.com/vedran24r/pocket-sessions/main/scripts/bootstrap.sh | bash`. It is interactive: it reads answers from `/dev/tty`, and pauses for the person at the Tailscale sign-in and admin steps. Pass `--yes` to accept every install question.
- **Installed automatically if missing:** git, curl, tmux, Node ≥ 23.6 (Homebrew `node`, NodeSource 24 on apt/dnf, `nodejs` on pacman), Tailscale (`brew install --cask tailscale-app`, or tailscale.com/install.sh on Linux), Claude Code (`curl -fsSL https://claude.ai/install.sh | bash`). On a Mac with no Homebrew, it offers the official Homebrew installer.
- **Steps the person must do themselves:**
  - sign in to Tailscale (a browser login)
  - in the Tailscale admin console, enable **MagicDNS**, **HTTPS Certificates** and **Serve** (https://login.tailscale.com/admin/dns)
  - on WSL, restart WSL once if systemd had to be switched on
  - sign in to Claude Code the first time it runs
  - the phone steps above
- **Changes it makes:**
  - `~/pocket-sessions` (the code) and `~/.pocket-sessions/` (state and logs)
  - a `pocket` link in `~/.local/bin`
  - hook entries in each Claude config dir's `settings.json` (backed up as `settings.json.bak-pocket`)
  - a `notify` line in `~/.codex/config.toml` if Codex is present
  - a launchd agent `ai.pocket-sessions` or a systemd user unit `pocket-sessions.service`
  - `tailscale serve` on HTTPS port 443 → 127.0.0.1:8787
  - a marked `# >>> pocket-sessions >>>` block in `~/.zshrc` or `~/.bashrc` (backed up as `.bak-pocket`)
- **Checking it worked:** the installer's summary lists ✓ for every step. The web app answers at `https://<machine>.<tailnet>.ts.net`, and a new terminal's `type claude` shows the wrapper function.

Aliases that set `CLAUDE_CONFIG_DIR` and then call `claude` keep working. The profile name shown on the phone comes from the config dir (`~/.claude-work` → `work`), or from `POCKET_PROFILE`.

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
