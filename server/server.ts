import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notify, publicKey, subscribe } from "./push.ts";
import { hookToken, save, state, type SessionInfo, type Status } from "./store.ts";
import * as tmux from "./tmux.ts";
import { lastAssistantText, TranscriptTail } from "./transcript.ts";

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
const statusListeners = new Map<string, Set<Listener>>();

function profileOf(session: string): string {
  return session.split("-")[1] ?? "claude";
}

function short(session: string): string {
  const cwd = state.sessions[session]?.cwd;
  if (!tmux.isTmux(session) && cwd) return path.basename(cwd);
  return session.replace(/^(cc|ro)-[a-z0-9]+-/, "");
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

async function handleHook(session: string, event: any): Promise<void> {
  const profile = profileOf(session);
  const info = (state.sessions[session] ??= { profile, status: "idle", statusAt: Date.now() });
  if (event.transcript_path) info.transcript = event.transcript_path;
  if (event.cwd) info.cwd = event.cwd;
  info.seenAt = Date.now();
  save();
  const name = short(session);
  console.log(new Date().toISOString(), session, event.hook_event_name, event.notification_type ?? event.source ?? "");

  switch (event.hook_event_name) {
    case "SessionStart":
      setStatus(session, profile, "idle");
      break;
    case "UserPromptSubmit":
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

async function listSessions() {
  const live = await tmux.listSessions();
  const liveNames = new Set(live.map((session) => session.name));
  const now = Date.now();
  for (const [name, info] of Object.entries(state.sessions)) {
    const gone = tmux.isTmux(name) ? !liveNames.has(name) : now - (info.seenAt ?? info.statusAt) > READONLY_STALE_MS;
    if (gone) delete state.sessions[name];
  }
  const describe = (name: string, cwd: string | undefined, fallbackAt: number) => {
    const info = state.sessions[name];
    return {
      name,
      title: short(name),
      profile: profileOf(name),
      status: info?.status ?? "idle",
      statusAt: info?.statusAt ?? fallbackAt,
      note: info?.note,
      cwd: cwd ?? info?.cwd ?? "",
      readonly: !tmux.isTmux(name),
    };
  };
  const readonly = Object.keys(state.sessions).filter((name) => !tmux.isTmux(name));
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

function chatStream(req: IncomingMessage, res: ServerResponse, session: string) {
  let tail: TranscriptTail | undefined;
  let lastStatus = "";
  const listeners = statusListeners.get(session) ?? new Set();
  statusListeners.set(session, listeners);

  const sendStatus = (send: (event: string, data: unknown) => void) => {
    const info = state.sessions[session];
    const status = { status: info?.status ?? "idle", statusAt: info?.statusAt, note: info?.note, title: short(session) };
    const key = JSON.stringify(status);
    if (key !== lastStatus) {
      lastStatus = key;
      send("status", status);
    }
  };

  let pushStatus: Listener = () => {};
  openEventStream(
    req,
    res,
    400,
    async (send) => {
      pushStatus = () => sendStatus(send);
      sendStatus(send);
      const file = state.sessions[session]?.transcript;
      if (!file) return;
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

function screenStream(req: IncomingMessage, res: ServerResponse, session: string) {
  let last = "";
  openEventStream(req, res, 500, async (send) => {
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
      await handleHook(session, event);
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
      if (!tmux.isTmux(session)) return json(res, 409, { error: "This session runs outside pocket, so it's read-only. Restart it with `claude --continue` to type from the phone." });
      if (action === "screen" && req.method === "GET") return screenStream(req, res, session);
      if (action === "send" && req.method === "POST") {
        const { text, submit = true } = await readJson(req);
        if (typeof text !== "string" || !text.trim()) return json(res, 400, { error: "empty" });
        await tmux.sendText(session, text, submit);
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
