import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONF = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tmux.conf");
const TMUX = process.env.TMUX_BIN ?? "tmux";
const BASE = ["-L", "pocket", "-f", CONF];

// tmux rewrites tabs in format output when the locale isn't UTF-8, so use a printable separator.
const SEP = "|:|";

/** pk-* live in the pocket tmux server; ro-* are sessions running elsewhere, known only from hooks. */
export const SESSION_RE = /^(pk|ro)-[a-z0-9._-]+$/;
export const isTmux = (session: string) => session.startsWith("pk-");

function run(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(TMUX, [...BASE, ...args], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

export interface TmuxSession {
  name: string;
  /** "claude" (hooks + transcript available) or the command name of any other agent. */
  agent: string;
  attached: boolean;
  activity: number;
  path: string;
  created: number;
  conversation: string;
}

export async function listSessions(): Promise<TmuxSession[]> {
  let out: string;
  try {
    out = await run(["list-sessions", "-F", ["#{session_name}", "#{session_attached}", "#{session_activity}", "#{pane_current_path}", "#{@pocket_agent}", "#{session_created}", "#{pane_title}"].join(SEP)]);
  } catch {
    return []; // no tmux server running yet
  }
  return out
    .split("\n")
    .filter((line) => line.startsWith("pk-"))
    .map((line) => {
      const [name, attached, activity, cwd, agent, created, paneTitle] = line.split(SEP);
      return {
        // Agents put the conversation's name in the terminal title, behind status icons ("🟠 💻 fix-login").
        conversation: (paneTitle ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim(), name, agent: agent || "claude", attached: attached !== "0", activity: Number(activity), path: cwd, created: Number(created) * 1000 };
    });
}

export interface Screen {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  data: string;
}

export async function captureScreen(session: string): Promise<Screen> {
  const [dims, data] = await Promise.all([
    run(["display-message", "-p", "-t", `=${session}:`, "#{pane_width} #{pane_height} #{cursor_x} #{cursor_y}"]),
    run(["capture-pane", "-p", "-e", "-t", `=${session}:`]),
  ]);
  const [cols, rows, cursorX, cursorY] = dims.trim().split(" ").map(Number);
  return { cols, rows, cursorX, cursorY, data: data.replace(/\n$/, "") };
}

/** Bracketed paste keeps multi-line dictation as one message instead of submitting at each newline. */
export async function sendText(session: string, text: string, submit: boolean): Promise<void> {
  const buffer = `pocket-${process.pid}-${Date.now()}`;
  await run(["load-buffer", "-b", buffer, "-"], text);
  await run(["paste-buffer", "-p", "-d", "-b", buffer, "-t", `=${session}:`]);
  if (!submit) return;
  // Claude Code debounces pastes and takes longer over pasted file paths; an Enter that arrives
  // too early is swallowed. Press it, then check the text left the input box, up to three times.
  const snippet = text.split("\n")[0].trim().slice(0, 24);
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 150 + attempt * 350));
    await run(["send-keys", "-t", `=${session}:`, "Enter"]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!snippet || !(await stillInInput(session, snippet))) return;
  }
}

/** Whether the agent's input line (Claude's "❯", Codex's "›") still holds this text. */
async function stillInInput(session: string, snippet: string): Promise<boolean> {
  const screen = await run(["capture-pane", "-p", "-t", `=${session}:`]).catch(() => "");
  const inputLine = screen.split("\n").reverse().find((row) => /^\s*[❯›]\s/.test(row));
  return !!inputLine && inputLine.includes(snippet);
}

export const KEYS: Record<string, string[]> = {
  esc: ["Escape"],
  enter: ["Enter"],
  up: ["Up"],
  down: ["Down"],
  tab: ["Tab"],
  stab: ["BTab"],
  ctrlc: ["C-c"],
  y: ["-l", "y"],
  n: ["-l", "n"],
  "1": ["-l", "1"],
  "2": ["-l", "2"],
  "3": ["-l", "3"],
};

export async function sendKey(session: string, key: string): Promise<void> {
  const keys = KEYS[key];
  if (!keys) throw new Error(`unknown key ${key}`);
  await run(["send-keys", "-t", `=${session}:`, ...keys]);
}

/** Seconds since someone last typed into this session from the laptop. */
export async function secondsSinceLaptopInput(session: string): Promise<number> {
  try {
    const out = await run(["list-clients", "-t", `=${session}`, "-F", "#{client_activity}"]);
    const latest = Math.max(0, ...out.split("\n").filter(Boolean).map(Number));
    return latest ? Date.now() / 1000 - latest : Infinity;
  } catch {
    return Infinity;
  }
}

export async function uniqueName(base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const exists = await run(["has-session", "-t", `=${name}`]).then(() => true, () => false);
    if (!exists) return name;
  }
}

export async function newSession(name: string, cwd: string, env: Record<string, string>, command: string[], agent: string): Promise<void> {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  await run(["new-session", "-d", "-s", name, "-c", cwd, "-x", "100", "-y", "40", ...envArgs, ...command, ";", "set-option", "-t", `=${name}:`, "@pocket_agent", agent]);
}

/**
 * While no terminal is attached, size the window to the phone so TUIs reflow instead of
 * rendering 120 columns at an unreadable font size. tmux.conf hands the size back to the
 * terminal as soon as one attaches.
 */
export async function fitToPhone(session: string, cols: number, rows: number): Promise<void> {
  const clients = await run(["list-clients", "-t", `=${session}`, "-F", "x"]).catch(() => "");
  if (clients.trim()) return;
  await run(["resize-window", "-t", `=${session}:`, "-x", String(cols), "-y", String(rows)]);
}

/** Replaces the conversation name in the pane title, keeping any leading status icons ("⚪ 🧩 old" → "⚪ 🧩 new"). */
export async function renamePaneTitle(session: string, name: string): Promise<void> {
  const current = (await run(["display-message", "-p", "-t", `=${session}:`, "#{pane_title}"])).trim();
  const icons = current.match(/^[^\p{L}\p{N}]*/u)?.[0] ?? "";
  await run(["select-pane", "-t", `=${session}:`, "-T", `${icons}${name}`]);
}

/**
 * The agent's own "busy" line from the screen: Claude's "✻ Determining… (8s · ↓ 89 tokens)" (an
 * icon, a word ending in "…", then the elapsed time) or Codex's "• Working (8s • esc to interrupt)".
 * Claude's footer also says "esc to interrupt" but carries no timer, so the timer is what's matched.
 */
export async function activityLine(session: string): Promise<string> {
  const screen = await run(["capture-pane", "-p", "-t", `=${session}:`]).catch(() => "");
  const rows = screen.split("\n").reverse();
  const line =
    rows.find((row) => /^\s*\S\s+\S.*…\s*\(\d+\s*[smh]/u.test(row)) ??
    rows.find((row) => /\(\d+\s*[smh][^)]*esc to interrupt/i.test(row));
  if (!line) return "";
  return line
    .replace(/\s*[·•]?\s*esc to interrupt/i, "")
    .replace(/\(\s*\)/, "")
    .replace(/\s+\)/, ")")
    .replace(/^[\s│|]+|[\s│|]+$/g, "")
    .slice(0, 120);
}

export function killSession(session: string): Promise<string> {
  return run(["kill-session", "-t", `=${session}`]);
}

export function startServerIfNeeded(): void {
  spawn(TMUX, [...BASE, "start-server"], { stdio: "ignore" }).on("error", () => {});
}
