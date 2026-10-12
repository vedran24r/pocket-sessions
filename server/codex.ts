import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Codex keeps one JSONL "rollout" per conversation at
 * $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl. Resume appends to the same
 * file; `codex fork` starts a new one.
 */
export const defaultHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

// Day directories to search, newest first. A conversation older than this is very unlikely to be live.
const MAX_DAYS = 14;

async function dayDirs(home: string): Promise<string[]> {
  const root = path.join(home, "sessions");
  const dirs: string[] = [];
  const sortedDesc = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((name) => /^\d+$/.test(name)).sort().reverse();
  for (const year of await sortedDesc(root)) {
    for (const month of await sortedDesc(path.join(root, year))) {
      for (const day of await sortedDesc(path.join(root, year, month))) {
        dirs.push(path.join(root, year, month, day));
        if (dirs.length >= MAX_DAYS) return dirs;
      }
    }
  }
  return dirs;
}

export async function findRollout(home: string, threadId: string): Promise<string | undefined> {
  for (const dir of await dayDirs(home)) {
    const match = (await readdir(dir).catch(() => [] as string[])).find((name) => name.endsWith(`${threadId}.jsonl`));
    if (match) return path.join(dir, match);
  }
  return undefined;
}

export interface SessionMeta {
  id?: string;
  cwd?: string;
  source?: string;
}

export async function readMeta(file: string): Promise<SessionMeta> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
    const entry = JSON.parse(first);
    return entry.type === "session_meta" ? (entry.payload ?? {}) : {};
  } catch {
    return {};
  } finally {
    await handle.close();
  }
}

/** Interactive TUI sessions only: `codex exec` runs are scripts, not something to follow on a phone. */
export const isInteractive = (meta: SessionMeta) => !meta.source || meta.source === "cli";

/**
 * A Codex session started under pocket has no transcript path until its first turn finishes.
 * Find it early: the newest interactive rollout for this directory written since the session began.
 */
export async function discoverRollout(home: string, cwd: string, sinceMs: number): Promise<string | undefined> {
  let best: { file: string; mtime: number } | undefined;
  for (const dir of (await dayDirs(home)).slice(0, 2)) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      const { mtimeMs } = await stat(file).catch(() => ({ mtimeMs: 0 }));
      if (mtimeMs < sinceMs || (best && mtimeMs <= best.mtime)) continue;
      const meta = await readMeta(file);
      if (meta.cwd === cwd && isInteractive(meta)) best = { file, mtime: mtimeMs };
    }
  }
  return best?.file;
}
