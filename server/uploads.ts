import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { STATE_DIR } from "./store.ts";

/**
 * Images sent from the phone. They're saved on this computer and the message carries the file's
 * path, which is how a terminal agent receives an image (Claude Code reads image files directly).
 */
export const UPLOADS = path.join(STATE_DIR, "uploads");
const MAX_BYTES = 20 * 1024 * 1024;
const KEEP_DAYS = 7;
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

export async function saveUpload(req: IncomingMessage, session: string): Promise<string> {
  const ext = TYPES[String(req.headers["content-type"] ?? "").split(";")[0].trim()];
  if (!ext) throw Object.assign(new Error("Only JPEG, PNG, WebP and GIF images can be sent"), { status: 415 });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) throw Object.assign(new Error("Image is over 20 MB"), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) throw Object.assign(new Error("Empty upload"), { status: 400 });
  const dir = path.join(UPLOADS, session);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const file = path.join(dir, `phone-${stamp}-${randomBytes(3).toString("hex")}.${ext}`);
  await writeFile(file, Buffer.concat(chunks), { mode: 0o600 });
  return file;
}

const FILE_RE = /^phone-[\w-]+\.(jpg|png|webp|gif)$/;

/** An uploaded image for the chat to show; names are checked so nothing else can be read. */
export function uploadPath(session: string, file: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(session) || !FILE_RE.test(file)) return undefined;
  return path.join(UPLOADS, session, file);
}

/** Uploads are only needed while the agent reads them; drop anything older than a week. */
export async function pruneUploads(): Promise<void> {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const session of await readdir(UPLOADS).catch(() => [] as string[])) {
    const dir = path.join(UPLOADS, session);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const file = path.join(dir, name);
      if (((await stat(file).catch(() => undefined))?.mtimeMs ?? Infinity) < cutoff) await rm(file, { force: true });
    }
  }
}
