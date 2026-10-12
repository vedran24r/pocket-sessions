import { open, stat } from "node:fs/promises";

/** One chat line as the phone renders it. Kept small: the phone may be on mobile data. */
export interface Item {
  k: "user" | "assistant" | "tool" | "error";
  t: string;
  ts?: string;
}

const INITIAL_BYTES = 3 * 1024 * 1024;
const INITIAL_ITEMS = 400;
const TOOL_SUMMARY_KEYS = ["command", "cmd", "description", "file_path", "pattern", "path", "url", "query", "prompt", "skill"];

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

function codexToolSummary(name: string, raw: unknown): string {
  let args: any = raw;
  if (typeof raw === "string") {
    try {
      args = JSON.parse(raw);
    } catch {
      // apply_patch and other custom tools take free text: show its first meaningful line.
      const first = raw.split("\n").find((line) => line.trim() && !line.startsWith("*** Begin"));
      return first ? `${name} · ${clip(first.replace(/^\*\*\* /, ""), 160)}` : name;
    }
  }
  const command = args?.command ?? args?.cmd;
  if (Array.isArray(command)) {
    // ["bash", "-lc", "npm test"] → "npm test"
    const shown = command.length >= 3 && /^-\w*c$/.test(command[1]) ? command[command.length - 1] : command.join(" ");
    return `${name} · ${clip(String(shown), 160)}`;
  }
  return summarizeTool(name, args);
}

/**
 * One line of a Codex rollout file: {timestamp, type, payload}. What the person typed comes from
 * event_msg/user_message: response_item user messages also carry context Codex injects
 * (AGENTS.md, <environment_context>, ...). Replies and tool calls come from response_item.
 */
function parseCodex(entry: any): Item[] {
  const item = entry.payload ?? {};
  const ts: string | undefined = entry.timestamp;
  if (entry.type === "event_msg") {
    const text = item.type === "user_message" && typeof item.message === "string" ? item.message.trim() : "";
    return text ? [{ k: "user", t: text, ts }] : [];
  }
  if (entry.type !== "response_item") return [];
  switch (item.type) {
    case "message": {
      if (item.role !== "assistant") return [];
      const text = (Array.isArray(item.content) ? item.content : [])
        .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n")
        .trim();
      return text ? [{ k: "assistant", t: text, ts }] : [];
    }
    case "function_call":
      return [{ k: "tool", t: codexToolSummary(item.name ?? "tool", item.arguments), ts }];
    case "custom_tool_call":
      return [{ k: "tool", t: codexToolSummary(item.name ?? "tool", item.input), ts }];
    case "local_shell_call":
      return [{ k: "tool", t: codexToolSummary("shell", item.action), ts }];
    default:
      return [];
  }
}

export function parseLine(line: string): Item[] {
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if (entry.payload && typeof entry.type === "string" && !entry.message) return parseCodex(entry);
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
    return (await this.initialLines()).flatMap(parseLine).slice(-INITIAL_ITEMS);
  }

  async next(): Promise<Item[]> {
    return (await this.nextLines()).flatMap(parseLine);
  }

  async initialLines(maxBytes = INITIAL_BYTES): Promise<string[]> {
    const { size } = await stat(this.file);
    const start = Math.max(0, size - maxBytes);
    const chunk = await this.read(start, size);
    this.offset = size;
    const lines = chunk.split("\n");
    if (start > 0) lines.shift(); // first line is partial
    this.remainder = lines.pop() ?? "";
    return lines;
  }

  async nextLines(): Promise<string[]> {
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
    return lines;
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

/**
 * Two terminals that resume the same Claude conversation both append to one transcript, so the
 * file holds two interleaved threads. Every entry names its parent (parentUuid), so each window's
 * thread is the chain of parents behind the newest entry it wrote. Hooks tell us which entries a
 * window wrote (its prompts, tool calls and replies): those are its anchors.
 * Only used when two live sessions share a transcript; parallel tool calls also branch the chain,
 * so a normal session keeps the plain, complete view.
 */
export class BranchView {
  private entries = new Map<string, { parent?: string; items: Item[]; order: number }>();
  private byAnchor = new Map<string, string>();
  private count = 0;

  add(line: string): void {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof entry.uuid !== "string" || entry.isSidechain) return;
    const parent = entry.parentUuid ?? entry.logicalParentUuid ?? undefined;
    this.entries.set(entry.uuid, { parent, items: parseLine(line), order: this.count++ });
    for (const anchor of anchorsOf(entry)) this.byAnchor.set(anchor, entry.uuid);
  }

  /** The newest entry this window is known to have written, from its most recent anchors. */
  leaf(anchors: string[]): string | undefined {
    let best: string | undefined;
    for (const anchor of anchors) {
      const uuid = this.byAnchor.get(anchor);
      if (uuid && (!best || this.entries.get(uuid)!.order > this.entries.get(best)!.order)) best = uuid;
    }
    return best;
  }

  /** Ancestors of the leaf, oldest first, then anything written below it since. */
  items(leaf: string): Item[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    for (let at: string | undefined = leaf; at && !seen.has(at) && this.entries.has(at); at = this.entries.get(at)!.parent) {
      seen.add(at);
      chain.push(at);
    }
    chain.reverse();
    const below = new Set([leaf]);
    const after = [...this.entries.entries()]
      .filter(([, entry]) => entry.order > this.entries.get(leaf)!.order)
      .sort((a, b) => a[1].order - b[1].order)
      .filter(([uuid, entry]) => entry.parent && below.has(entry.parent) && below.add(uuid));
    return [...chain.flatMap((uuid) => this.entries.get(uuid)!.items), ...after.flatMap(([, entry]) => entry.items)].slice(-INITIAL_ITEMS);
  }
}

/** Keys a hook event can be matched against: a prompt's text, a tool call id, a reply's text. */
export function anchorsOf(entry: any): string[] {
  const content = entry.message?.content;
  if (entry.type === "user" && typeof content === "string") return [`prompt:${content.trim()}`];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: any) => {
    if (entry.type === "user" && block.type === "text" && block.text) return [`prompt:${block.text.trim()}`];
    if (entry.type === "assistant" && block.type === "tool_use" && block.id) return [`tool:${block.id}`];
    if (entry.type === "assistant" && block.type === "text" && block.text) return [`reply:${block.text.trim()}`];
    return [];
  });
}

/**
 * The conversation's name as Claude records it in the transcript: a title the person set
 * (custom-title) wins over the generated one (ai-title). Only the tail is read; the latest wins.
 */
export async function conversationTitle(file: string): Promise<string | undefined> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    const last = (key: string) => [...text.matchAll(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, "g"))].at(-1)?.[1];
    const raw = last("customTitle") ?? last("aiTitle");
    return raw ? JSON.parse(`"${raw}"`) : undefined;
  } finally {
    await handle.close();
  }
}
