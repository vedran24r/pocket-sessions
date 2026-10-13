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

/**
 * What to compare against. On a feature branch: the point it split off the repository's main
 * branch, so work already committed on the branch still shows. On the main branch (or with no
 * remote): HEAD, i.e. uncommitted changes only.
 */
async function baseOf(root: string): Promise<{ ref: string; label?: string }> {
  const main = (await git(root, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).catch(() => "")).trim();
  if (!main) return { ref: "HEAD" };
  const [forkPoint, head] = await Promise.all([
    git(root, ["merge-base", "HEAD", main]).catch(() => ""),
    git(root, ["rev-parse", "HEAD"]).catch(() => ""),
  ]);
  if (!forkPoint.trim() || forkPoint.trim() === head.trim()) return { ref: "HEAD" };
  return { ref: forkPoint.trim(), label: main };
}

export async function changedFiles(cwd: string): Promise<{ repo: boolean; root?: string; branch?: string; since?: string; files: ChangedFile[] }> {
  const rootDir = (await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  if (!rootDir) return { repo: false, files: [] };
  const base = await baseOf(rootDir);
  const [nameStatus, numstat, untracked, branch] = await Promise.all([
    git(rootDir, ["diff", "--name-status", "-z", base.ref]).catch(() => ""),
    git(rootDir, ["diff", "--numstat", "-z", base.ref]).catch(() => ""),
    git(rootDir, ["ls-files", "--others", "--exclude-standard", "-z"]).catch(() => ""),
    git(rootDir, ["branch", "--show-current"]).catch(() => ""),
  ]);
  const counts = new Map<string, { added: number; removed: number }>();
  // -z numstat: "added\tremoved\tpath\0" (renames add two more NUL-separated paths; rare here).
  for (const record of numstat.split("\0")) {
    const [added, removed, file] = record.split("\t");
    if (file) counts.set(file, { added: Number(added) || 0, removed: Number(removed) || 0 });
  }
  const files: ChangedFile[] = [];
  // -z name-status: "M\0path\0", renames "R100\0old\0new\0".
  const records = nameStatus.split("\0");
  for (let i = 0; i < records.length - 1; i++) {
    const code = records[i];
    if (!/^[A-Z]/.test(code)) continue;
    const file = code[0] === "R" || code[0] === "C" ? records[(i += 2)] : records[++i];
    files.push({ path: file, status: code[0], ...(counts.get(file) ?? { added: 0, removed: 0 }) });
  }
  for (const file of untracked.split("\0").filter(Boolean)) {
    files.push({ path: file, status: "??", added: await lineCount(path.join(rootDir, file)), removed: 0 });
  }
  return { repo: true, root: rootDir, branch: branch.trim() || undefined, since: base.label, files };
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
      : await git(root, ["diff", (await baseOf(root)).ref, "--", file]);
  return diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff cut off at 300 KB)` : diff;
}

/** The repository containing a path (a file or a folder that may no longer exist), if any. */
export async function repoRoot(target: string): Promise<string | undefined> {
  let dir = target;
  for (let depth = 0; depth < 4 && dir !== path.dirname(dir); depth++, dir = path.dirname(dir)) {
    const root = (await git(dir, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
    if (root) return root;
  }
  return undefined;
}

/** The session folder's repository first, then every other repository the session edited files in. */
export async function sessionRepos(cwd: string, edited: string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const target of [cwd, ...edited]) {
    const root = await repoRoot(target);
    if (root && !roots.includes(root)) roots.push(root);
    if (roots.length >= 8) break;
  }
  return roots;
}
