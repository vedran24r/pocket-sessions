import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PushSubscription } from "web-push";

export const STATE_DIR = process.env.POCKET_STATE_DIR ?? path.join(os.homedir(), ".pocket-sessions");
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

export type Status = "idle" | "working" | "waiting" | "done" | "ended";

export interface SessionInfo {
  profile: string;
  transcript?: string;
  status: Status;
  statusAt: number;
  seenAt?: number;
  cwd?: string;
  note?: string;
  /** Read-only sessions: what's needed to resume the conversation inside tmux. */
  sessionId?: string;
  configDir?: string;
  /** "claude" when absent. */
  agent?: string;
  codexHome?: string;
  /** Last push sent from an agent's own signal, so the quiet-screen watcher doesn't repeat it. */
  pushedAt?: number;
  movedTo?: string;
  /** Read-only session the person hid; it comes back when they next send it a prompt. */
  hidden?: boolean;
  /** The agent process, for read-only sessions: gone means its window was closed. */
  pid?: number;
  /** Recent prompts / tool calls / replies this session wrote, to find its thread in a shared transcript. */
  anchors?: string[];
}

interface State {
  sessions: Record<string, SessionInfo>;
  /** Claude profiles seen in hooks: label → CLAUDE_CONFIG_DIR ("" = the default ~/.claude). */
  profiles?: Record<string, string>;
  /** Folders sessions recently ran in, newest first, for starting a session from the phone. */
  recentDirs?: string[];
  subscriptions: PushSubscription[];
  vapid?: { publicKey: string; privateKey: string };
}

const FILE = path.join(STATE_DIR, "state.json");

function load(): State {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return { sessions: {}, subscriptions: [] };
  }
}

export const state: State = load();

let saveTimer: NodeJS.Timeout | undefined;
export function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    renameSync(tmp, FILE);
  }, 200);
}

/** Shared secret the hook script sends, so only local Claude hooks can post events. */
export function hookToken(): string {
  const file = path.join(STATE_DIR, "hook-token");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    const token = randomBytes(24).toString("hex");
    writeFileSync(file, token, { mode: 0o600 });
    return token;
  }
}
