import { open, stat } from "node:fs/promises";

/** One chat line as the phone renders it. Kept small: the phone may be on mobile data. */
export interface Item {
  k: "user" | "assistant" | "tool" | "error";
  t: string;
  ts?: string;
}

const INITIAL_BYTES = 3 * 1024 * 1024;
const INITIAL_ITEMS = 400;
const TOOL_SUMMARY_KEYS = ["command", "description", "file_path", "pattern", "path", "url", "query", "prompt", "skill"];

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function summarizeTool(name: string, input: Record<string, unknown> | undefined): string {
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = input?.[key];
    if (typeof value === "string" && value) return `${name} · ${clip(value, 160)}`;
  }
  return name;
}

function userText(raw: string): string | null {
  const command = raw.match(/<command-name>([^<]*)<\/command-name>/);
  if (command) {
    const args = raw.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    return args ? `${command[1]} ${args}` : command[1];
  }
  // Harness messages injected as user turns, not something the person typed.
  if (/^\s*<(local-command|system-reminder|command-|task-notification)/.test(raw)) return null;
  if (raw.startsWith("[Request interrupted")) return null;
  return raw.trim() || null;
}

export function parseLine(line: string): Item[] {
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if (entry.isSidechain || entry.isMeta || entry.isCompactSummary) return [];
  if (entry.type !== "user" && entry.type !== "assistant") return [];
  const ts: string | undefined = entry.timestamp;
  const content = entry.message?.content;

  if (typeof content === "string") {
    const text = entry.type === "user" ? userText(content) : content.trim();
    return text ? [{ k: entry.type, t: text, ts }] : [];
  }
  if (!Array.isArray(content)) return [];

  const items: Item[] = [];
  for (const block of content) {
    if (block.type === "text") {
      const text = entry.type === "user" ? userText(block.text ?? "") : (block.text ?? "").trim();
      if (text) items.push({ k: entry.type, t: text, ts });
    } else if (block.type === "tool_use") {
      items.push({ k: "tool", t: summarizeTool(block.name, block.input), ts });
    } else if (block.type === "tool_result" && block.is_error) {
      const raw = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      items.push({ k: "error", t: clip(raw, 240), ts });
    }
  }
  return items;
}

/** Follows a growing JSONL transcript, starting from its last INITIAL_ITEMS items. */
export class TranscriptTail {
  private offset = 0;
  private remainder = "";
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async initial(): Promise<Item[]> {
    const { size } = await stat(this.file);
    const start = Math.max(0, size - INITIAL_BYTES);
    const chunk = await this.read(start, size);
    this.offset = size;
    const lines = chunk.split("\n");
    if (start > 0) lines.shift(); // first line is partial
    this.remainder = lines.pop() ?? "";
    return lines.flatMap(parseLine).slice(-INITIAL_ITEMS);
  }

  async next(): Promise<Item[]> {
    const { size } = await stat(this.file);
    if (size < this.offset) {
      this.offset = 0; // rewritten
      this.remainder = "";
    }
    if (size === this.offset) return [];
    const chunk = this.remainder + (await this.read(this.offset, size));
    this.offset = size;
    const lines = chunk.split("\n");
    this.remainder = lines.pop() ?? "";
    return lines.flatMap(parseLine);
  }

  private async read(from: number, to: number): Promise<string> {
    const handle = await open(this.file, "r");
    try {
      const buffer = Buffer.alloc(to - from);
      await handle.read(buffer, 0, buffer.length, from);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  }
}

/** Last assistant text in a transcript, for the "finished" notification body. */
export async function lastAssistantText(file: string): Promise<string | undefined> {
  const tail = new TranscriptTail(file);
  const items = await tail.initial().catch(() => []);
  return items.findLast((item) => item.k === "assistant")?.t;
}
