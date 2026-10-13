import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONF = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tmux.conf");
const TMUX = process.env.TMUX_BIN ?? "tmux";
// POCKET_TMUX_SOCKET runs a separate, isolated tmux server (tests, a second install).
const BASE = ["-L", process.env.POCKET_TMUX_SOCKET || "pocket", "-f", CONF];

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

// Messages are typed, not pasted: Claude Code marks pasted text (bracketed paste, or a big block
// arriving at once) as <pasted_content> and treats it as text from elsewhere, not as instructions
// from the person. Chunks of 200 characters 20 ms apart read as typing; a 4,000-character message
// takes about half a second.
const TYPE_CHUNK = 200;
const TYPE_GAP_MS = 20;
const sending = new Map<string, Promise<unknown>>();

/** One message at a time per session, so two quick sends can't interleave into one message. */
export function sendText(session: string, text: string, submit: boolean): Promise<void> {
  const previous = sending.get(session) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => typeText(session, text, submit));
  sending.set(session, next);
  void next.finally(() => sending.get(session) === next && sending.delete(session)).catch(() => {});
  return next;
}

async function typeText(session: string, text: string, submit: boolean): Promise<void> {
  const target = `=${session}:`;
  // Typed characters act as keys: a Tab would trigger completion instead of appearing, and other
  // control characters (a stray Ctrl-C or Escape in pasted text) would interrupt or cancel.
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .split("\n");
  for (let index = 0; index < lines.length; index++) {
    // Ctrl-J starts a new line in the agent's input (Claude Code, Codex) without sending.
    if (index > 0) await run(["send-keys", "-t", target, "C-j"]);
    for (let at = 0; at < lines[index].length; at += TYPE_CHUNK) {
      await run(["send-keys", "-t", target, "-l", lines[index].slice(at, at + TYPE_CHUNK)]);
      await new Promise((resolve) => setTimeout(resolve, TYPE_GAP_MS));
    }
  }
  if (!submit) return;
  // The agent can lag behind fast input (file paths especially), and an Enter that arrives too
  // early is swallowed. Press it, then check the text left the input box, up to three times.
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
  left: ["Left"],
  right: ["Right"],
  down: ["Down"],
  tab: ["Tab"],
  stab: ["BTab"],
  ctrlc: ["C-c"],
  y: ["-l", "y"],
  n: ["-l", "n"],
  "4": ["-l", "4"],
  "5": ["-l", "5"],
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

// A laptop window counts as in use if someone typed into it this recently.
const LAPTOP_IN_USE_SECONDS = 120;

/**
 * Sizes the window to the phone so the agent reflows for it, instead of a 180-column screen shrunk
 * to unreadable. Happens when no terminal is attached, or the attached ones have been idle (you're
 * away, the laptop window just stayed open). Returns whether the phone now sets the size.
 */
export async function fitToPhone(session: string, cols: number, rows: number): Promise<boolean> {
  const activity = await run(["list-clients", "-t", `=${session}`, "-F", "#{client_activity}"]).catch(() => "");
  const lastInput = Math.max(0, ...activity.split("\n").filter(Boolean).map(Number));
  if (lastInput && Date.now() / 1000 - lastInput < LAPTOP_IN_USE_SECONDS) {
    await releasePhoneSize(session); // you're back at the laptop: it gets its own size
    return false;
  }
  await run(["resize-window", "-t", `=${session}:`, "-x", String(cols), "-y", String(rows)]);
  return true;
}

/** Hands the size back to the attached terminal (resize-window pinned it to the phone). */
export async function releasePhoneSize(session: string): Promise<void> {
  await run(["set-option", "-wu", "-t", `=${session}:`, "window-size"]).catch(() => {});
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

// Answers that grant or refuse more than this one request ("keep allowing", "don't ask again", "block … from now on").
const STICKY = /don'?t ask again|keep allowing|always|from now on|for this session|all /i;

/**
 * The menu option to press for a one-tap Allow or Deny on Claude's permission menu, or undefined
 * when no such menu is showing. Picks the narrowest answer: a one-time Yes, or a No that doesn't
 * block anything for later; never a "don't ask again" option.
 */
export async function permissionChoice(session: string, choice: "allow" | "deny"): Promise<string | undefined> {
  const screen = await run(["capture-pane", "-p", "-t", `=${session}:`]).catch(() => "");
  if (!/❯\s*1\.\s*\S/.test(screen)) return undefined;
  const options = [...screen.matchAll(/^\s*(?:❯\s*)?(\d)\.\s+(.+?)\s*$/gm)].map((match) => ({ key: match[1], text: match[2] }));
  const word = choice === "allow" ? /^yes\b/i : /^no\b/i;
  const candidates = options.filter((option) => word.test(option.text) && !STICKY.test(option.text));
  return candidates[0]?.key;
}

export type MouseAction = "click" | "wheel-up" | "wheel-down";

/**
 * A tap on a menu in a screen that doesn't take mouse input (Claude's "trust this folder?" prompt
 * comes before its mouse support). Menus mark the selected option with "❯"; the option under the
 * finger is reached with arrow keys from there, then Enter. Does nothing unless such a menu is
 * on screen and the tap lands on one of its options.
 */
async function tapMenu(session: string, row: number): Promise<boolean> {
  const lines = (await run(["capture-pane", "-p", "-t", `=${session}:`])).split("\n");
  const marker = lines.findIndex((line) => /^\s*❯\s+\S/.test(line));
  if (marker < 0) return false;
  const prefix = lines[marker].match(/^(\s*❯\s+)/)![1].length;
  const numbered = /^\d+\.\s/.test(lines[marker].slice(prefix));
  // An option starts where text begins at the marker's text column (numbered menus: with "N. ").
  const isOption = (line: string) =>
    line.length > prefix && /^\s*(❯\s+)?$/.test(line.slice(0, prefix)) && /\S/.test(line[prefix]) && (!numbered || /^\d+\.\s/.test(line.slice(prefix)));
  // The menu is the run of non-blank lines around the marker.
  let top = marker;
  while (top > 0 && lines[top - 1].trim()) top--;
  let bottom = marker;
  while (bottom < lines.length - 1 && lines[bottom + 1].trim()) bottom++;
  const tapped = row - 1;
  if (tapped < top || tapped > bottom) return false;
  const options = [];
  for (let i = top; i <= bottom; i++) if (isOption(lines[i])) options.push(i);
  const target = options.filter((start) => start <= tapped).at(-1);
  if (target === undefined) return false;
  const steps = options.indexOf(target) - options.indexOf(marker);
  const keys = Array.from({ length: Math.abs(steps) }, () => (steps > 0 ? "Down" : "Up"));
  await run(["send-keys", "-t", `=${session}:`, ...keys, "Enter"]);
  return true;
}

/**
 * Sends a tap or swipe from the phone as a real mouse event (SGR encoding), the way a desktop
 * terminal would. Only when the program on screen has turned mouse reporting on: otherwise the
 * escape sequence would arrive as typed text (in a shell, for instance). Returns whether it was sent.
 */
export async function sendMouse(session: string, action: MouseAction, col: number, row: number): Promise<boolean> {
  const flags = await run(["display-message", "-p", "-t", `=${session}:`, "#{mouse_any_flag}#{mouse_button_flag}#{mouse_standard_flag} #{mouse_sgr_flag} #{pane_width} #{pane_height}"]);
  const [tracking, sgr, width, height] = flags.trim().split(" ");
  if (!/1/.test(tracking) || sgr !== "1") return action === "click" ? tapMenu(session, Math.round(row)) : false;
  const x = Math.min(Math.max(1, Math.round(col)), Number(width));
  const y = Math.min(Math.max(1, Math.round(row)), Number(height));
  const esc = "\x1b";
  const sequence =
    action === "click" ? `${esc}[<0;${x};${y}M${esc}[<0;${x};${y}m` : `${esc}[<${action === "wheel-up" ? 64 : 65};${x};${y}M`;
  await run(["send-keys", "-t", `=${session}:`, "-l", sequence]);
  return true;
}

export function killSession(session: string): Promise<string> {
  return run(["kill-session", "-t", `=${session}`]);
}

export function startServerIfNeeded(): void {
  spawn(TMUX, [...BASE, "start-server"], { stdio: "ignore" }).on("error", () => {});
}

export async function exists(session: string): Promise<boolean> {
  return run(["has-session", "-t", `=${session}`]).then(() => true, () => false);
}
