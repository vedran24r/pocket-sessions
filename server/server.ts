import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notify, publicKey, subscribe } from "./push.ts";
import { hookToken, save, state, type SessionInfo, type Status } from "./store.ts";
import * as codex from "./codex.ts";
import * as tmux from "./tmux.ts";
import { BranchView, lastAssistantText, TranscriptTail, transcriptTitles } from "./transcript.ts";

const PORT = Number(process.env.POCKET_PORT ?? 8787);
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
// Every non-hook request must arrive through `tailscale serve`, which stamps the caller's identity.
// The server binds to localhost only, so that header can't come from anywhere else.
const DEV = process.env.POCKET_DEV === "1";
const ALLOWED_USERS = (process.env.POCKET_USERS ?? "").split(",").map((user) => user.trim()).filter(Boolean);
// Anyone who can open the app can type into your sessions, so an empty allow-list is a mistake, not "allow all".
if (!DEV && ALLOWED_USERS.length === 0) {
  console.error("POCKET_USERS is empty. Set it to your Tailscale login (scripts/install.sh does this).");
  process.exit(1);
}
// Profiles whose pushes include Claude's reply text ("*" = all). Narrow it for profiles whose
// sessions may hold data you don't want on a lock screen.
const PREVIEW_PROFILES = new Set((process.env.POCKET_PREVIEW_PROFILES ?? "*").split(",").map((profile) => profile.trim()));
const preview = (profile: string) => PREVIEW_PROFILES.has("*") || PREVIEW_PROFILES.has(profile);
// A read-only session that has sent no hook event this long is assumed gone (killed without SessionEnd).
const READONLY_STALE_MS = 12 * 3600_000;
// Someone typing on the laptop this recently doesn't need a push on their phone.
const LAPTOP_ACTIVE_SECONDS = 90;
const TOKEN = hookToken();

type Listener = () => void;
const agentOf = new Map<string, string>();
const conversationOf = new Map<string, string>();
// A title that's just the program or machine name says nothing about the conversation.
const GENERIC_TITLES = /^(claude( code)?|codex|bash|zsh|-?zsh|tmux|[\w.-]+\.local)$/i;
// Name priority: the person's /rename, then the terminal title (agents put the conversation name
// there), then Claude's generated title, then the folder.
const titleCache = new Map<string, { mtime: number; custom?: string; ai?: string }>();
async function refreshTitle(session: string): Promise<void> {
  const file = state.sessions[session]?.transcript;
  if (!file) return;
  const mtime = (await stat(file).catch(() => undefined))?.mtimeMs;
  const cached = titleCache.get(file);
  if (!mtime || cached?.mtime === mtime) return;
  const titles = await transcriptTitles(file);
  // A /rename long ago can fall outside the tail that's read; keep the one already seen.
  titleCache.set(file, { mtime, custom: titles.custom ?? cached?.custom, ai: titles.ai ?? cached?.ai });
}
const displayTitle = (session: string) => {
  const file = state.sessions[session]?.transcript;
  const titles = file ? titleCache.get(file) : undefined;
  const pane = conversationOf.get(session);
  return titles?.custom || (pane && !GENERIC_TITLES.test(pane) ? pane : undefined) || titles?.ai || short(session);
};
const statusListeners = new Map<string, Set<Listener>>();

function profileOf(session: string): string {
  return session.split("-")[1] ?? "claude";
}

function short(session: string): string {
  const cwd = state.sessions[session]?.cwd;
  if (!tmux.isTmux(session) && cwd) return path.basename(cwd);
  return session.replace(/^(pk|ro)-[a-z0-9]+-/, "");
}

function setStatus(session: string, profile: string, status: Status, note?: string): SessionInfo {
  const info = (state.sessions[session] ??= { profile, status, statusAt: Date.now() });
  info.profile = profile;
  info.status = status;
  info.statusAt = Date.now();
  info.note = note;
  save();
  statusListeners.get(session)?.forEach((listener) => listener());
  return info;
}

async function pushUnlessAtLaptop(session: string, notice: { title: string; body: string }): Promise<void> {
  if (tmux.isTmux(session) && (await tmux.secondsSinceLaptopInput(session)) < LAPTOP_ACTIVE_SECONDS) return;
  await notify({ ...notice, url: `/#/s/${session}`, tag: session });
}

async function handleHook(session: string, event: any, configDir: string, pid: number): Promise<void> {
  const profile = profileOf(session);
  const info = (state.sessions[session] ??= { profile, status: "idle", statusAt: Date.now() });
  if (event.transcript_path) info.transcript = event.transcript_path;
  if (event.cwd) info.cwd = event.cwd;
  if (event.session_id) info.sessionId = event.session_id;
  info.seenAt = Date.now();
  if (configDir) info.configDir = configDir;
  if (pid > 1) info.pid = pid;
  save();
  const anchor =
    event.hook_event_name === "UserPromptSubmit" && typeof event.prompt === "string" ? `prompt:${event.prompt.trim()}`
    : event.hook_event_name === "PostToolUse" && typeof event.tool_use_id === "string" ? `tool:${event.tool_use_id}`
    : event.hook_event_name === "Stop" && typeof event.last_assistant_message === "string" ? `reply:${event.last_assistant_message.trim()}`
    : undefined;
  if (anchor) info.anchors = [...(info.anchors ?? []), anchor].slice(-12);
  await refreshTitle(session);
  const name = displayTitle(session);
  console.log(new Date().toISOString(), session, event.hook_event_name, event.notification_type ?? event.source ?? "");

  switch (event.hook_event_name) {
    case "SessionStart":
      setStatus(session, profile, "idle");
      break;
    case "UserPromptSubmit":
      delete info.hidden;
      setStatus(session, profile, "working");
      break;
    case "PostToolUse":
      // Also covers sessions first seen mid-turn, and a permission granted on the laptop.
      if (info.status !== "working") setStatus(session, profile, "working");
      break;
    case "Stop": {
      setStatus(session, profile, "done");
      const reply = preview(profile) && event.transcript_path
        ? (event.last_assistant_message ?? (await lastAssistantText(event.transcript_path)))
        : undefined;
      await pushUnlessAtLaptop(session, { title: `✅ ${name} finished`, body: reply?.slice(0, 180) ?? "Ready for your next message" });
      break;
    }
    case "StopFailure":
      setStatus(session, profile, "done", "stopped with an error");
      await pushUnlessAtLaptop(session, { title: `⚠️ ${name} stopped`, body: "Stopped with an error" });
      break;
    case "Notification": {
      // idle_prompt repeats the Stop we already pushed, a minute later.
      if (event.notification_type === "idle_prompt") break;
      const message = event.message ?? "Needs your input";
      setStatus(session, profile, "waiting", message);
      await pushUnlessAtLaptop(session, { title: `⏳ ${name} needs you`, body: message });
      break;
    }
    case "SessionEnd":
      if (tmux.isTmux(session)) setStatus(session, profile, "ended");
      else delete state.sessions[session];
      save();
      break;
  }
}

/** Codex `notify`: fires once per finished turn ("agent-turn-complete"). */
async function handleCodexTurn(session: string, event: any, home: string): Promise<void> {
  if (event.type !== "agent-turn-complete" || typeof event["thread-id"] !== "string") return;
  const known = state.sessions[session];
  const transcript = known?.transcript ?? (await codex.findRollout(home, event["thread-id"]));
  if (transcript && !codex.isInteractive(await codex.readMeta(transcript))) return; // `codex exec` run
  const profile = profileOf(session);
  const info = (state.sessions[session] ??= { profile, status: "idle", statusAt: Date.now() });
  Object.assign(info, { agent: "codex", codexHome: home, sessionId: event["thread-id"], seenAt: Date.now() });
  if (transcript) info.transcript = transcript;
  if (event.cwd) info.cwd = event.cwd;
  delete info.hidden;
  setStatus(session, profile, "done");
  const reply = preview(profile) ? event["last-assistant-message"] : undefined;
  info.pushedAt = Date.now();
  await pushUnlessAtLaptop(session, { title: `✅ ${short(session)} finished`, body: typeof reply === "string" && reply ? reply.slice(0, 180) : "Ready for your next message" });
}

/**
 * Makes a session started outside pocket typeable: resumes its conversation in a new tmux session.
 * --fork-session gives the copy its own transcript, so the original terminal's process and the
 * phone's never append to the same file.
 */
async function takeOver(session: string): Promise<string> {
  const info = state.sessions[session];
  if (tmux.isTmux(session)) return session;
  if (info?.movedTo) return info.movedTo;
  if (!info?.sessionId || !info.cwd) throw Object.assign(new Error("Not enough known about this session yet — wait for its next message."), { status: 409 });
  const profile = profileOf(session);
  const slug = path.basename(info.cwd).toLowerCase().replace(/[^a-z0-9._]+/g, "-").replace(/^-|-$/g, "") || "session";
  const name = await tmux.uniqueName(`pk-${profile}-${slug}`);
  const shell = process.env.SHELL || "/bin/zsh";
  const agent = info.agent ?? "claude";
  // A fork, not a resume: both `claude --resume` and `codex resume` would append to the original's
  // transcript while its terminal may still be open.
  const command = agent === "codex" ? `exec codex fork ${info.sessionId}` : `exec claude --resume ${info.sessionId} --fork-session`;
  const env: Record<string, string> = {};
  if (info.configDir) env.CLAUDE_CONFIG_DIR = info.configDir;
  if (info.codexHome && info.codexHome !== codex.defaultHome()) env.CODEX_HOME = info.codexHome;
  // A login + interactive shell picks up the user's PATH, nvm, AWS profile etc. from their rc files.
  await tmux.newSession(name, info.cwd, env, [shell, "-lic", command], agent);
  info.movedTo = name;
  // Claude's fork shows the history right away from the old transcript; Codex's fork gets found by cwd.
  state.sessions[name] = { profile, agent, status: "idle", statusAt: Date.now(), cwd: info.cwd, transcript: agent === "claude" ? info.transcript : undefined };
  save();
  return name;
}

/** Closes a pocket session (its agent exits; Claude's transcript stays resumable) or hides a read-only one. */
async function endSession(session: string): Promise<void> {
  if (tmux.isTmux(session)) {
    await tmux.killSession(session).catch(() => {}); // already gone is fine
    delete state.sessions[session];
    screenWatch.delete(session);
  } else if (state.sessions[session]) {
    state.sessions[session].hidden = true;
  }
  save();
}

function processAlive(pid: number | undefined): boolean {
  if (!pid) return true; // unknown: fall back to the staleness timeout
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function listSessions() {
  const live = await tmux.listSessions();
  const liveNames = new Set(live.map((session) => session.name));
  const now = Date.now();
  for (const [name, info] of Object.entries(state.sessions)) {
    const gone = tmux.isTmux(name) ? !liveNames.has(name) : !processAlive(info.pid) || now - (info.seenAt ?? info.statusAt) > READONLY_STALE_MS;
    if (gone) delete state.sessions[name];
    else if (info.movedTo && !liveNames.has(info.movedTo)) delete info.movedTo; // the phone copy was closed
  }
  const describe = (name: string, cwd: string | undefined, fallbackAt: number) => {
    const info = state.sessions[name];
    return {
      name,
      title: displayTitle(name),
      profile: profileOf(name),
      status: info?.status ?? "idle",
      statusAt: info?.statusAt ?? fallbackAt,
      note: info?.note,
      cwd: cwd ?? info?.cwd ?? "",
      readonly: !tmux.isTmux(name),
      agent: agentOf.get(name) ?? info?.agent ?? "claude",
      hasChat: !!info?.transcript,
    };
  };
  for (const session of live) {
    agentOf.set(session.name, session.agent);
    conversationOf.set(session.name, session.conversation);
  }
  const readonly = Object.keys(state.sessions).filter((name) => !tmux.isTmux(name) && !state.sessions[name].movedTo && !state.sessions[name].hidden);
  await Promise.all([...live.map((session) => session.name), ...readonly].map(refreshTitle));
  return [
    ...live.map((session) => describe(session.name, session.path, session.activity * 1000)),
    ...readonly.map((name) => describe(name, undefined, now)),
  ].sort((a, b) => b.statusAt - a.statusAt);
}

function openEventStream(req: IncomingMessage, res: ServerResponse, intervalMs: number, tick: (send: (event: string, data: unknown) => void) => Promise<void>, onClose?: () => void) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await tick(send);
    } catch (err) {
      send("problem", { message: String((err as Error).message ?? err) });
    } finally {
      busy = false;
    }
  };
  void run();
  const timer = setInterval(run, intervalMs);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    onClose?.();
  });
}

/** Other live sessions writing to the same transcript (two terminals resumed one conversation). */
function sharingWith(session: string): string[] {
  const file = state.sessions[session]?.transcript;
  if (!file) return [];
  return Object.entries(state.sessions)
    .filter(([name, info]) => name !== session && info.transcript === file && !info.movedTo && !info.hidden && info.status !== "ended")
    .map(([name]) => short(name));
}

function chatStream(req: IncomingMessage, res: ServerResponse, session: string) {
  let tail: TranscriptTail | undefined;
  let branch: { file: string; source: TranscriptTail; view: BranchView; shown: string } | undefined;
  let lastStatus = "";
  const listeners = statusListeners.get(session) ?? new Set();
  statusListeners.set(session, listeners);

  const sendStatus = (send: (event: string, data: unknown) => void) => {
    const info = state.sessions[session];
    const status = { status: info?.status ?? "idle", statusAt: info?.statusAt, note: info?.note, title: displayTitle(session), agent: agentOf.get(session) ?? info?.agent ?? "claude", hasChat: !!info?.transcript, sharedWith: sharingWith(session) };
    const key = JSON.stringify(status);
    if (key !== lastStatus) {
      lastStatus = key;
      send("status", status);
    }
  };

  let pushStatus: Listener = () => {};
  if (!agentOf.has(session)) void listSessions();
  openEventStream(
    req,
    res,
    400,
    async (send) => {
      pushStatus = () => sendStatus(send);
      await refreshTitle(session);
      sendStatus(send);
      const file = state.sessions[session]?.transcript;
      if (!file) return;
      if (sharingWith(session).length) {
        // Another window writes to this conversation too: show only this window's thread.
        if (branch?.file !== file) {
          const source = new TranscriptTail(file);
          branch = { file, source, view: new BranchView(), shown: "" };
          for (const line of await source.initialLines(64 * 1024 * 1024)) branch.view.add(line);
          tail = undefined;
        } else {
          for (const line of await branch.source.nextLines()) branch.view.add(line);
        }
        const leaf = branch.view.leaf(state.sessions[session]?.anchors ?? []);
        if (leaf) {
          const items = branch.view.items(leaf);
          const shown = `${leaf}:${items.length}`;
          if (shown !== branch.shown) {
            branch.shown = shown;
            send("chat", { reset: true, items });
          }
          return;
        }
        branch = undefined; // no anchor yet: fall back to the whole file
      } else {
        branch = undefined;
      }
      if (tail?.file !== file) {
        tail = new TranscriptTail(file);
        send("chat", { reset: true, items: await tail.initial() });
      } else {
        const items = await tail.next();
        if (items.length) send("chat", { items });
      }
    },
    () => listeners.delete(listener),
  );
  const listener: Listener = () => pushStatus();
  listeners.add(listener);
}

function screenStream(req: IncomingMessage, res: ServerResponse, session: string, fit?: { cols: number; rows: number }) {
  let last = "";
  let ticks = 0;
  openEventStream(req, res, 500, async (send) => {
    if (fit && ticks++ % 4 === 0) await tmux.fitToPhone(session, fit.cols, fit.rows);
    const screen = await tmux.captureScreen(session);
    const key = `${screen.cols}x${screen.rows}:${screen.cursorX},${screen.cursorY}:${screen.data}`;
    if (key !== last) {
      last = key;
      send("screen", screen);
    }
  });
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const relative = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = path.join(DIST, relative);
  if (!file.startsWith(DIST)) return json(res, 404, { error: "not found" });
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) file = path.join(DIST, "index.html");
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };
  res.writeHead(200, {
    "content-type": types[path.extname(file)] ?? "application/octet-stream",
    "cache-control": relative.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file).on("error", () => res.end()).pipe(res);
}

function allowed(req: IncomingMessage): boolean {
  if (DEV) return true;
  const login = req.headers["tailscale-user-login"];
  if (typeof login !== "string" || !login) return false;
  return ALLOWED_USERS.includes(login);
}

/**
 * Agents without hooks (anything but Claude) get their status from the screen: output that keeps
 * changing means working; quiet for QUIET_MS after at least MIN_ACTIVE_MS of activity means it
 * finished or is waiting for an answer. The minimum keeps a typing echo from counting as a run.
 */
const QUIET_MS = 8000;
const MIN_ACTIVE_MS = 4000;
const screenWatch = new Map<string, { last: string; changedAt: number; activeSince: number }>();

async function watchQuietAgents(): Promise<void> {
  const live = (await tmux.listSessions()).filter((session) => session.agent !== "claude");
  const now = Date.now();
  for (const name of screenWatch.keys()) if (!live.some((session) => session.name === name)) screenWatch.delete(name);
  for (const session of live) {
    agentOf.set(session.name, session.agent);
    if (session.agent === "codex" && !state.sessions[session.name]?.transcript) {
      const found = await codex.discoverRollout(codex.defaultHome(), session.path, session.created - 5000);
      if (found) {
        const info = (state.sessions[session.name] ??= { profile: profileOf(session.name), status: "idle", statusAt: now });
        Object.assign(info, { transcript: found, agent: "codex" });
        save();
      }
    }
    const screen = await tmux.captureScreen(session.name).catch(() => undefined);
    if (!screen) continue;
    const watch = screenWatch.get(session.name);
    if (!watch) {
      screenWatch.set(session.name, { last: screen.data, changedAt: now, activeSince: 0 });
      continue;
    }
    if (screen.data !== watch.last) {
      watch.last = screen.data;
      watch.changedAt = now;
      watch.activeSince ||= now;
      if (state.sessions[session.name]?.status !== "working") setStatus(session.name, profileOf(session.name), "working");
    } else if (watch.activeSince && now - watch.changedAt > QUIET_MS) {
      const ranFor = watch.changedAt - watch.activeSince;
      watch.activeSince = 0;
      setStatus(session.name, profileOf(session.name), "done");
      const pushedAt = state.sessions[session.name]?.pushedAt ?? 0;
      if (ranFor >= MIN_ACTIVE_MS && now - pushedAt > 60_000) {
        await pushUnlessAtLaptop(session.name, { title: `✅ ${short(session.name)} went quiet`, body: `${session.agent} finished or is waiting for you` });
      }
    }
  }
}

let watching = false;
setInterval(async () => {
  if (watching) return;
  watching = true;
  await watchQuietAgents().catch((err) => console.error("watch failed", err));
  watching = false;
}, 2000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (url.pathname === "/api/hook" && req.method === "POST") {
      if (req.headers["x-pocket-token"] !== TOKEN) return json(res, 403, { error: "bad token" });
      const session = url.searchParams.get("session") ?? "";
      if (!tmux.SESSION_RE.test(session)) return json(res, 400, { error: "bad session" });
      const event = await readJson(req);
      json(res, 200, { ok: true });
      if (req.headers["x-pocket-agent"] === "codex") {
        const home = req.headers["x-pocket-codex-home"];
        await handleCodexTurn(session, event, typeof home === "string" && home ? home : codex.defaultHome());
      } else {
        const configDir = req.headers["x-pocket-config-dir"];
        await handleHook(session, event, typeof configDir === "string" ? configDir : "", Number(req.headers["x-pocket-pid"]) || 0);
      }
      return;
    }

    if (!allowed(req)) return json(res, 403, { error: "open this through tailscale serve" });

    if (parts[0] !== "api") return serveStatic(req, res, url.pathname);

    if (url.pathname === "/api/sessions" && req.method === "GET") return json(res, 200, await listSessions());
    if (url.pathname === "/api/push/key") return json(res, 200, { publicKey });
    if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
      subscribe((await readJson(req)).subscription);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/push/test" && req.method === "POST") {
      await notify({ title: "🔔 Pocket", body: "Notifications work.", url: "/", tag: "test" });
      return json(res, 200, { ok: true });
    }

    if (parts[1] === "sessions" && parts[2]) {
      const session = parts[2];
      if (!tmux.SESSION_RE.test(session)) return json(res, 400, { error: "bad session" });
      const action = parts[3];
      const profile = profileOf(session);

      if (action === "chat" && req.method === "GET") return chatStream(req, res, session);
      if (action === "end" && req.method === "POST") {
        await endSession(session);
        return json(res, 200, { ok: true });
      }
      if (action === "takeover" && req.method === "POST") return json(res, 200, { name: await takeOver(session) });
      if (!tmux.isTmux(session)) return json(res, 409, { error: "This session runs outside pocket, so it's read-only. Restart it with `claude --continue` to type from the phone." });
      if (action === "screen" && req.method === "GET") {
        const cols = Number(url.searchParams.get("cols"));
        const rows = Number(url.searchParams.get("rows"));
        const fit = cols >= 20 && cols <= 400 && rows >= 8 && rows <= 200 ? { cols, rows } : undefined;
        return screenStream(req, res, session, fit);
      }
      if (action === "send" && req.method === "POST") {
        const { text, submit = true } = await readJson(req);
        if (typeof text !== "string" || !text.trim()) return json(res, 400, { error: "empty" });
        await tmux.sendText(session, text, submit);
        // /rename fires no hook, so the laptop tab would keep the old name until the next prompt.
        const renamed = submit && text.trim().match(/^\/rename\s+(.+)$/)?.[1];
        if (renamed) await tmux.renamePaneTitle(session, renamed.trim()).catch(() => {});
        if (submit) setStatus(session, profile, "working");
        return json(res, 200, { ok: true });
      }
      if (action === "key" && req.method === "POST") {
        const { key } = await readJson(req);
        if (!(key in tmux.KEYS)) return json(res, 400, { error: "unknown key" });
        await tmux.sendKey(session, key);
        if (state.sessions[session]?.status === "waiting" && ["1", "2", "3", "enter"].includes(key)) {
          setStatus(session, profile, "working");
        }
        return json(res, 200, { ok: true });
      }
    }
    json(res, 404, { error: "not found" });
  } catch (err: any) {
    if (!res.headersSent) json(res, err.status ?? 500, { error: String(err.message ?? err) });
    else res.end();
  }
});

tmux.startServerIfNeeded();
server.listen(PORT, "127.0.0.1", () => console.log(`pocket listening on http://127.0.0.1:${PORT}${DEV ? " (dev, no auth)" : ""}`));
