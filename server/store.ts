import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PushSubscription } from "web-push";

export const STATE_DIR = process.env.POCKET_STATE_DIR ?? path.join(os.homedir(), ".claude-pocket");
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
}

interface State {
  sessions: Record<string, SessionInfo>;
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
