import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONF = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tmux.conf");
const TMUX = process.env.TMUX_BIN ?? "tmux";
const BASE = ["-L", "pocket", "-f", CONF];

// tmux rewrites tabs in format output when the locale isn't UTF-8, so use a printable separator.
const SEP = "|:|";

/** cc-* live in the pocket tmux server; ro-* are sessions running elsewhere, known only from hooks. */
export const SESSION_RE = /^(cc|ro)-[a-z0-9._-]+$/;
export const isTmux = (session: string) => session.startsWith("cc-");

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
  attached: boolean;
  activity: number;
  path: string;
}

export async function listSessions(): Promise<TmuxSession[]> {
  let out: string;
  try {
    out = await run(["list-sessions", "-F", ["#{session_name}", "#{session_attached}", "#{session_activity}", "#{pane_current_path}"].join(SEP)]);
  } catch {
    return []; // no tmux server running yet
  }
  return out
    .split("\n")
    .filter((line) => line.startsWith("cc-"))
    .map((line) => {
      const [name, attached, activity, cwd] = line.split(SEP);
      return { name, attached: attached !== "0", activity: Number(activity), path: cwd };
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
  if (submit) {
    // Claude Code debounces pastes; an Enter that arrives too soon becomes part of the paste.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await run(["send-keys", "-t", `=${session}:`, "Enter"]);
  }
}

export const KEYS: Record<string, string[]> = {
  esc: ["Escape"],
  enter: ["Enter"],
  up: ["Up"],
  down: ["Down"],
  tab: ["Tab"],
  stab: ["BTab"],
  ctrlc: ["C-c"],
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

export async function newSession(name: string, cwd: string, env: Record<string, string>, command: string[]): Promise<void> {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  await run(["new-session", "-d", "-s", name, "-c", cwd, "-x", "100", "-y", "40", ...envArgs, ...command]);
}

export function killSession(session: string): Promise<string> {
  return run(["kill-session", "-t", `=${session}`]);
}

export function startServerIfNeeded(): void {
  spawn(TMUX, [...BASE, "start-server"], { stdio: "ignore" }).on("error", () => {});
}
