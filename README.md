# Pocket Sessions

**Your AI coding agents on your phone.** See every running session live, scroll the conversation, reply by voice, send screenshots, answer prompts, and get a push notification when a session finishes or needs you. Claude Code gets the richest integration; Codex, Gemini CLI, Aider, OpenCode or any other terminal agent works too.

The use case: you have three or four Claude Code sessions going, you step away for coffee, and they finish one by one. With Pocket you check your phone, send the next instruction to each, put the phone away, and the work keeps going.

- **Private by design:** it runs on your own computer (macOS, Linux or Windows) and is reachable only from your own network. There's no relay server and no account.
- **Zero habit change:** you keep typing `claude` in your terminal. Every session is phone-ready automatically.
- **Fast:** the app shell is about 4 KB gzipped. It's an installable web app (PWA), so it works on Android and iOS without an app store.
- **Voice:** a big text box made for your keyboard's dictation (Gboard on Android, Apple's keyboard mic on iOS).

> Anthropic's own [Remote Control](https://code.claude.com/docs/en/remote-control) does something similar through claude.ai. Use that if your plan and org allow it. Pocket is for when they don't, or when you'd rather keep everything self-hosted.

## What you can do from the phone

- **Watch:** live status per session, a readable Chat view, and the real Terminal. Sessions that need you come first, and the app icon shows a badge.
- **Reply:** type or dictate, use one-tap quick replies ("continue", "commit and push"…), or send images from your gallery.
- **Steer:** answer prompts with quick keys, **Stop** a session that's going the wrong way, or **Allow / Deny** a permission question straight from the notification.
- **Review:** the **Changes** tab lists the files a session changed, with a diff for each.
- **Manage:** start a new session in a recent folder, rename one, or end one.

## How it works

```
phone (web app) ──your network──▶ pocket server (port 8787) on your computer
                                        │
              Claude Code hooks ────────┤ status + push notifications
              session transcripts ──────┤ Chat view
              tmux -L pocket ───────────┘ Terminal view + typing
```

- `claude` becomes a small shell function that starts Claude inside a dedicated tmux server (`tmux -L pocket`), and your terminal attaches to it as usual. Closing the window ends the session, and it disappears from the phone within a few seconds. To leave a session running for the phone without a window, detach instead (`Ctrl-b d`), or set `POCKET_KEEP_ON_CLOSE=1`.
- Claude Code **hooks** tell the server when a session starts, works, finishes or waits for permission. The server turns that into status dots and Web Push notifications.
- **Chat view:** the conversation as readable bubbles, built from the agent's transcript file.
- **Terminal view:** the actual screen, for menus and prompts. Quick keys: `Esc y n 1 2 3 ⏎ ↑ ↓ ⇧Tab ^C`.
- Typed or dictated text is pasted with bracketed paste, so a multi-line message stays one message.
- Sessions started outside Pocket (or before you installed it) still appear: **view only**, with chat and notifications. Tap **Continue on phone** and the conversation resumes in a new, typeable session on your computer (a fork, so the original window is left alone).

## Install

One command on **macOS**, **Linux** and **Windows** (on Windows, run it in WSL, Windows' built-in Linux; see below):

```bash
curl -fsSL https://raw.githubusercontent.com/vedran24r/pocket-sessions/main/scripts/bootstrap.sh | bash
```

It downloads Pocket to `~/pocket-sessions` and runs the installer, which:

- **installs what's missing, after asking once:** git, curl, tmux, Node 26 and Claude Code (Homebrew on macOS; apt, dnf or pacman on Linux and WSL)
- **connects your phone:** Tailscale, or the network you already have (see [Connecting your phone](#connecting-your-phone))
- sets up the Claude Code hooks (in `~/.claude` and any `~/.claude-*` config dirs), plus the Codex notifier if Codex is installed
- starts the server in the background (launchd on macOS, a systemd user service on Linux and WSL)
- adds the `claude()` wrapper to your shell, so every new session is phone-ready

Where only you can act, such as signing in to Tailscale, it says exactly what to do and waits for Enter. It ends with what it did, what's left, and a QR code that opens the app on your phone and signs it in.

Re-run it any time to update or repair; it's safe to run twice. Add `--yes` to accept every question.

### Windows

Claude Code and Pocket both run inside WSL, which comes with Windows:

1. Open PowerShell as administrator and run `wsl --install`. Restart if asked, then open **Ubuntu**.
2. Inside Ubuntu, run the install command above. If it asks to switch on systemd, say yes, run `wsl --shutdown` in PowerShell, reopen Ubuntu and run it again.
3. Start your Claude sessions inside Ubuntu.

### Connecting your phone

Your phone and your computer just need to reach each other on the same network. Any of these works:

- **[Tailscale](https://tailscale.com) (recommended).** It joins your phone and computer into one private network that works from anywhere, home or not, and gives Pocket an HTTPS address. The installer sets it up: install the Tailscale app on the phone and sign in to the same account. Tailscale also tells Pocket who you are, so your phone is signed in automatically.
- **Your home or office network.** Choose "no" to Tailscale and Pocket listens on your local network (`http://<computer-ip>:8787`). This works while the phone is on the same Wi-Fi.
- **A VPN or network you already run** (WireGuard, ZeroTier, your router's VPN…). Same as the home-network option: if the phone can reach the computer, it works.

Without Tailscale, you sign a phone in once by opening the **access link**: the installer shows it as a QR code, and `pocket link` prints it again any time. Keep it private, because it opens your sessions.

**HTTPS:** phones only let a web app be installed to the home screen and send notifications over HTTPS. Tailscale handles that for you. On another network everything else works over plain `http`; for notifications, put an HTTPS proxy you already run (Caddy, nginx, a router feature) in front of port 8787 and tell Pocket its address with `pocket link --url https://your-address`.

**On WSL** with your own network, the phone needs to reach WSL directly: in Windows, add `[wsl2]` and `networkingMode=mirrored` to `%UserProfile%\.wslconfig`, then run `wsl --shutdown`. Tailscale doesn't need this.

### On the phone

1. Scan the installer's QR code, or open the link from `pocket link`.
2. Browser menu → **Add to Home screen**. Open the app from there and tap **🔔 Enable alerts**.

Use Chrome on Android, or Safari on iOS 16.4+. On iPhone, alerts only work from the Home Screen icon. The Allow / Deny buttons on notifications show on Android; on iPhone, tap the notification and answer in the app.

### Setup notes for AI assistants

If someone asks you (an AI coding assistant) to install Pocket Sessions for them, everything below is what it needs:

- **Platforms:** macOS 13+, Linux with systemd, and Windows through WSL2 (run everything inside the WSL distro).
- **Command:** `curl -fsSL https://raw.githubusercontent.com/vedran24r/pocket-sessions/main/scripts/bootstrap.sh | bash`. It's interactive: it reads answers from `/dev/tty`, and pauses for the person at sign-in steps. Pass `--yes` to accept every question. Set `POCKET_NETWORK=tailscale` or `POCKET_NETWORK=own` to choose the network without asking.
- **Installed automatically if missing:**
  - git, curl, tmux
  - Node 26 (Homebrew `node`, NodeSource 26 on apt/dnf, `nodejs` on pacman)
  - Claude Code (`curl -fsSL https://claude.ai/install.sh | bash`)
  - Tailscale, when chosen (`brew install --cask tailscale-app`, or tailscale.com/install.sh on Linux)
  - on a Mac with no Homebrew, it offers the official Homebrew installer
- **Steps the person must do themselves:**
  - with Tailscale: sign in (a browser login), and enable **MagicDNS**, **HTTPS Certificates** and **Serve** in the admin console (https://login.tailscale.com/admin/dns)
  - without Tailscale: make sure the phone can reach the computer; for notifications, provide an HTTPS proxy and run `pocket link --url <https address>`
  - on WSL: restart WSL once if systemd had to be switched on
  - sign in to Claude Code the first time it runs
  - the phone steps above
- **Changes it makes:**
  - `~/pocket-sessions` (the code) and `~/.pocket-sessions/` (state, logs, access key, uploaded images)
  - a `pocket` link in `~/.local/bin`
  - hook entries in each Claude config dir's `settings.json` (backed up as `settings.json.bak-pocket`)
  - a `notify` line in `~/.codex/config.toml` if Codex is present
  - a launchd agent `ai.pocket-sessions`, or a systemd user unit `pocket-sessions.service`
  - with Tailscale, `tailscale serve` on HTTPS port 443 → 127.0.0.1:8787; without it, the server listens on 0.0.0.0:8787
  - a marked `# >>> pocket-sessions >>>` block in `~/.zshrc` or `~/.bashrc` (backed up as `.bak-pocket`)
- **Checking it worked:** the installer's summary lists ✓ for every step, `pocket link` prints the phone's link, and in a new terminal `type claude` shows the wrapper function.

Aliases that set `CLAUDE_CONFIG_DIR` and then call `claude` keep working. The profile name shown on the phone comes from the config dir (`~/.claude-work` → `work`), or from `POCKET_PROFILE`.

## Other agents

Any terminal program can run under Pocket:

```bash
pocket run -- codex
pocket run -- gemini
pocket run -- aider --model sonnet
```

Add a wrapper like `codex() { pocket run -- codex "$@"; }` to make it automatic (the installer adds one for Codex).

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

## Everyday use

| You want to… | Do |
|---|---|
| Start a session | `claude` as usual, or **＋ New** on the phone |
| Bypass Pocket once | `command claude` |
| See what's running | `pocket ls` |
| Sign in another phone | `pocket link` |
| Leave a session running for the phone | detach with `Ctrl-b d` |
| Get a detached session back | `pocket attach <name>` |
| Close a session from the phone | open it → **End** (a view-only one: **Hide**) |

One-shot commands (`claude -p`, `claude --version`, `claude mcp …`) are passed straight through and never notify.

## Notifications

You get a push when a session **finishes a turn** or **needs input** (a permission prompt, a question). Tapping it opens that session. Nothing is pushed for a session you typed into on the laptop in the last 90 seconds, because you're clearly there.

**Allow / Deny** on a permission notification picks the narrowest answer on Claude's menu: a one-time Yes, or a No that blocks nothing for later. It never picks "don't ask again" or "keep allowing". If the question is already gone, it opens the session instead.

Pushes include the start of Claude's reply. To limit that to some profiles, set `POCKET_PREVIEW_PROFILES=game,personal` in the service file (launchd plist or systemd unit). Payloads are end-to-end encrypted by the Web Push protocol.

## Security

Anyone who can open the app can type into your sessions, so a phone gets in only one of two ways:

- **Tailscale:** the request comes through `tailscale serve`, which adds your Tailscale login, and that login is in `POCKET_USERS`. Pocket trusts that header only on connections from the computer itself (where `tailscale serve` connects from), so another device can't fake it.
- **The access key:** opening the access link (`pocket link`) once stores a random key in a cookie on that phone. To sign every phone out, delete `~/.pocket-sessions/access-key` and restart the service; a new key is created.

Also:

- Hooks authenticate with a separate random token in `~/.pocket-sessions/hook-token` (mode 600).
- Uploaded images are kept for 7 days in `~/.pocket-sessions/uploads`.
- Don't expose Pocket to the public internet (for example with `tailscale funnel`).

## Development

```bash
npm install
POCKET_DEV=1 POCKET_PORT=8788 node server/server.ts   # no sign-in check; keep it on your own machine
npm run dev                                            # Vite on :5173, proxies /api to :8787
npm run typecheck
```

After changing `web/`, run `npm run build`. After changing `server/`, restart the service: `launchctl kickstart -k gui/$(id -u)/ai.pocket-sessions` on macOS, `systemctl --user restart pocket-sessions` on Linux and WSL. Logs are in `~/.pocket-sessions/server.log`.

## Uninstall

```bash
# macOS
launchctl bootout gui/$(id -u)/ai.pocket-sessions && rm ~/Library/LaunchAgents/ai.pocket-sessions.plist
# Linux and WSL
systemctl --user disable --now pocket-sessions && rm ~/.config/systemd/user/pocket-sessions.service

tailscale serve --https=443 off   # if you used Tailscale
rm ~/.local/bin/pocket
```

Then remove the `# >>> pocket-sessions >>>` block from your shell rc and the `pocket-hook.sh` entries from each `settings.json` (a backup sits next to each one as `settings.json.bak-pocket`).

## License

MIT. Not affiliated with Anthropic.
