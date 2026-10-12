import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Read-only view of what a session has changed in its folder, from git. */

// `git diff --no-index` exits 1 when the files differ, which is the normal case here.
function git(cwd: string, args: string[], okExitCodes = [0]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) =>
      !err || okExitCodes.includes(Number(err.code)) ? resolve(stdout) : reject(err),
    ),
  );
}

/** A new, untracked file counts as all-added; huge or binary files count as 0. */
async function lineCount(file: string): Promise<number> {
  const data = await readFile(file).catch(() => undefined);
  if (!data || data.length > 2 * 1024 * 1024 || data.includes(0)) return 0;
  return data.toString("utf8").split("\n").length - (data.at(-1) === 10 ? 1 : 0);
}

export interface ChangedFile {
  path: string;
  /** git status letters, e.g. "M", "A", "D", "??" (new, not yet added). */
  status: string;
  added: number;
  removed: number;
}

export async function changedFiles(cwd: string): Promise<{ repo: boolean; root?: string; branch?: string; files: ChangedFile[] }> {
  const rootDir = (await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  if (!rootDir) return { repo: false, files: [] };
  const [status, numstat, branch] = await Promise.all([
    git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(cwd, ["diff", "--numstat", "-z", "HEAD"]).catch(() => ""),
    git(cwd, ["branch", "--show-current"]).catch(() => ""),
  ]);
  const counts = new Map<string, { added: number; removed: number }>();
  // -z numstat: "added\tremoved\tpath\0" (renames add two more NUL-separated paths; rare here).
  for (const record of numstat.split("\0")) {
    const [added, removed, file] = record.split("\t");
    if (file) counts.set(file, { added: Number(added) || 0, removed: Number(removed) || 0 });
  }
  const files: ChangedFile[] = [];
  const records = status.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const file = record.slice(3);
    if (code[0] === "R" || code[0] === "C") i++; // the next record is the old name
    const count = counts.get(file) ?? (code === "??" ? { added: await lineCount(path.join(rootDir, file)), removed: 0 } : { added: 0, removed: 0 });
    files.push({ path: file, status: code.trim() || code, ...count });
  }
  return { repo: true, root: rootDir, branch: branch.trim() || undefined, files };
}

const MAX_DIFF = 300 * 1024;

/** Diff of one file that git reports as changed. Anything not in that list is refused. */
export async function fileDiff(cwd: string, file: string): Promise<string> {
  // Paths from `git status` are relative to the repository root, so diff from there.
  const { files, root = cwd } = await changedFiles(cwd);
  const entry = files.find((changed) => changed.path === file);
  if (!entry) throw Object.assign(new Error("That file has no changes"), { status: 404 });
  const diff =
    entry.status === "??"
      ? await git(root, ["diff", "--no-index", "--", "/dev/null", file], [0, 1])
      : await git(root, ["diff", "HEAD", "--", file]);
  return diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff cut off at 300 KB)` : diff;
}
