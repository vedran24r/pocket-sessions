import "./style.css";
import type { Terminal } from "@xterm/xterm";

type Status = "idle" | "working" | "waiting" | "done" | "ended";
interface Session {
  name: string;
  title: string;
  profile: string;
  status: Status;
  statusAt: number;
  note?: string;
  cwd: string;
  readonly: boolean;
}
interface Item {
  k: "user" | "assistant" | "tool" | "error";
  t: string;
  ts?: string;
}
interface Screen {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  data: string;
}

const app = document.getElementById("app")!;
let cleanup: (() => void) | undefined;

const STATUS_LABEL: Record<Status, string> = {
  idle: "idle",
  working: "working",
  waiting: "needs you",
  done: "finished",
  ended: "ended",
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) el.className = className;
  Object.assign(el, rest);
  el.append(...children);
  return el;
}

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText);
  return response.json();
}

function toast(message: string) {
  const el = h("div", { class: "toast" }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 2500);
}

// ---------- notifications ----------

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function enableNotifications(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser can't receive push. Install the app to the home screen first.");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications were blocked");
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>("/api/push/key");
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(publicKey) }));
  await api("/api/push/subscribe", { subscription: subscription.toJSON() });
}

async function notificationsOn(): Promise<boolean> {
  if (!("serviceWorker" in navigator) || Notification.permission !== "granted") return false;
  const registration = await navigator.serviceWorker.ready;
  return !!(await registration.pushManager.getSubscription());
}

// ---------- home ----------

function renderHome() {
  const list = h("div", { class: "list" });
  const bell = h("button", { class: "ghost", textContent: "🔔 Enable alerts", hidden: true });
  bell.onclick = async () => {
    try {
      await enableNotifications();
      await api("/api/push/test", {});
      bell.hidden = true;
    } catch (err) {
      toast((err as Error).message);
    }
  };
  void notificationsOn().then((on) => (bell.hidden = on));

  const create = h("button", { class: "new-session", textContent: "＋ New" });
  create.onclick = () => openNewSession();
  app.replaceChildren(h("header", { class: "bar" }, h("h1", {}, "Pocket"), bell, create), list);

  let timer: number | undefined;
  const refresh = async () => {
    try {
      const sessions = await api<Session[]>("/api/sessions");
      list.replaceChildren(...(sessions.length ? sessions.map(sessionCard) : [emptyState()]));
      // The home-screen icon shows how many sessions are waiting on you (where the phone supports badges).
      const waiting = sessions.filter((session) => session.status === "waiting").length;
      const badge = navigator as Navigator & { setAppBadge?: (count: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
      void (waiting ? badge.setAppBadge?.(waiting) : badge.clearAppBadge?.())?.catch(() => {});
    } catch (err) {
      list.replaceChildren(h("p", { class: "muted pad" }, `Can't reach the Mac: ${(err as Error).message}`));
    }
  };
  void refresh();
  timer = window.setInterval(() => document.visibilityState === "visible" && refresh(), 3000);
  const onVisible = () => document.visibilityState === "visible" && refresh();
  document.addEventListener("visibilitychange", onVisible);
  cleanup = () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

interface LaunchOptions {
  profiles: string[];
  dirs: string[];
  codex: boolean;
}

/** Bottom sheet: pick an agent/profile and a folder, start a session on the computer, open it. */
async function openNewSession(): Promise<void> {
  let options: LaunchOptions;
  try {
    options = await api<LaunchOptions>("/api/launch-options");
  } catch (err) {
    toast((err as Error).message);
    return;
  }
  const agents = [...options.profiles.map((profile) => ({ value: `claude:${profile}`, label: profile === "claude" ? "Claude" : `Claude · ${profile}` })), ...(options.codex ? [{ value: "codex:codex", label: "Codex" }] : [])];
  const agentSelect = h("select", {}, ...agents.map((agent) => h("option", { value: agent.value }, agent.label)));
  agentSelect.value = localStorage.getItem("pocket-last-agent") ?? agents[0]?.value ?? "claude:claude";
  const dirSelect = h("select", {}, ...options.dirs.map((dir) => h("option", { value: dir }, dir.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~"))), h("option", { value: "" }, "Other folder…"));
  const dirInput = h("input", { type: "text", placeholder: "~/path/to/project", hidden: options.dirs.length > 0 });
  dirSelect.onchange = () => (dirInput.hidden = dirSelect.value !== "");
  if (!options.dirs.length) dirSelect.hidden = true;
  const start = h("button", { class: "primary", textContent: "Start session" });
  const cancel = h("button", { class: "ghost", textContent: "Cancel" });
  const sheet = h("div", { class: "sheet" },
    h("h2", {}, "New session"),
    h("label", {}, "Agent", agentSelect),
    h("label", {}, "Folder", dirSelect, dirInput),
    h("div", { class: "sheet-actions" }, cancel, start));
  const overlay = h("div", { class: "overlay" }, sheet);
  const close = () => overlay.remove();
  overlay.onclick = (event) => event.target === overlay && close();
  cancel.onclick = close;
  start.onclick = async () => {
    const [agent, profile] = agentSelect.value.split(":");
    const cwd = dirSelect.value || dirInput.value.trim();
    if (!cwd) return toast("Pick a folder");
    start.disabled = true;
    start.textContent = "Starting…";
    try {
      const { name } = await api<{ name: string }>("/api/sessions", { agent, profile, cwd });
      localStorage.setItem("pocket-last-agent", agentSelect.value);
      close();
      location.hash = `#/s/${name}`;
    } catch (err) {
      toast((err as Error).message);
      start.disabled = false;
      start.textContent = "Start session";
    }
  };
  document.body.append(overlay);
}

function emptyState(): HTMLElement {
  return h("div", { class: "pad muted" }, h("p", {}, "No sessions yet."), h("p", {}, "On the Mac, start one with "), h("code", {}, "pocket game <name>"));
}

function profileBadge(profile: string): HTMLElement {
  const hue = [...profile].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
  const badge = h("span", { class: "badge" }, profile);
  badge.style.color = `hsl(${hue} 70% 75%)`;
  return badge;
}

function sessionCard(session: Session): HTMLElement {
  const card = h(
    "a",
    { class: `card status-${session.status}`, href: `#/s/${session.name}` },
    h("span", { class: "dot" }),
    h(
      "span",
      { class: "card-main" },
      h("span", { class: "card-title" }, session.title, profileBadge(session.profile), ...(session.readonly ? [h("span", { class: "badge", title: "Started outside pocket" }, "view only")] : [])),
      h("span", { class: "card-sub" }, `${STATUS_LABEL[session.status]} · ${ago(session.statusAt)}${session.note && session.status === "waiting" ? ` · ${session.note}` : ""}`),
      h("span", { class: "card-path" }, session.cwd.replace(/^\/Users\/[^/]+/, "~")),
    ),
  );
  return card;
}

// ---------- images ----------

/**
 * Shrinks a gallery image before it crosses mobile data: a 5 MB phone screenshot becomes a few
 * hundred KB, which is still far more detail than the model uses. GIFs keep their animation.
 */
async function shrinkImage(file: File): Promise<Blob> {
  if (file.type === "image/gif") return file;
  const MAX_SIDE = 2000;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // Screenshots (PNG) stay PNG so text stays crisp; photos become JPEG.
  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
  return blob && blob.size < file.size ? blob : file;
}

async function uploadImage(session: string, file: File): Promise<string> {
  const body = await shrinkImage(file);
  const response = await fetch(`/api/sessions/${session}/upload`, { method: "POST", headers: { "content-type": body.type || "image/jpeg" }, body });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText);
  return (await response.json()).path;
}

// ---------- session ----------

const LINK_ATTRS = 'target="_blank" rel="noopener noreferrer"';

/** Makes web links tappable: [text](url) and bare http(s) addresses. Runs on already-escaped text. */
function linkify(html: string): string {
  return html
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)"]+)\)/g, (_, label, url) => `<a href="${url}" ${LINK_ATTRS}>${label}</a>`)
    .replace(/(^|[\s(>])(https?:\/\/[^\s<"]+)/g, (_, before, url: string) => {
      // Sentence punctuation after a link belongs to the sentence, not the address.
      const trailing = url.match(/[.,;:!?)\]]+$/)?.[0] ?? "";
      const clean = url.slice(0, url.length - trailing.length);
      return `${before}<a href="${clean}" ${LINK_ATTRS}>${clean}</a>${trailing}`;
    });
}

function inlineMarkdown(text: string): DocumentFragment {
  // Escape first, then a tiny subset: fenced code, inline code, bold, links. Enough for Claude's replies.
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = escaped
    // Code blocks are set aside so addresses inside them stay plain text.
    .split(/(```[^\n]*\n[\s\S]*?```)/g)
    .map((part) =>
      part.startsWith("```")
        ? part.replace(/```[^\n]*\n([\s\S]*?)```/, (_, code) => `<pre>${code}</pre>`)
        : linkify(part.replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")),
    )
    .join("");
  return document.createRange().createContextualFragment(html);
}

function chatItem(item: Item): HTMLElement {
  if (item.k === "tool") return h("div", { class: "tool" }, item.t);
  if (item.k === "error") return h("div", { class: "tool error" }, item.t);
  const bubble = h("div", { class: `msg ${item.k}` });
  // Images sent from the phone travel as file paths; show the picture instead of the path.
  const upload = /^\S*\/\.pocket-sessions\/uploads\/([a-z0-9._-]+)\/(phone-[\w-]+\.(?:jpg|png|webp|gif))$/;
  const lines = item.t.split("\n");
  const pictures = item.k === "user" ? lines.map((line) => line.trim().match(upload)).filter((match) => !!match) : [];
  const text = pictures.length ? lines.filter((line) => !upload.test(line.trim())).join("\n").trim() : item.t;
  if (text) bubble.append(inlineMarkdown(text));
  for (const [, session, file] of pictures) {
    bubble.append(h("img", { class: "msg-image", src: `/api/uploads/${session}/${file}`, alt: "Sent image", loading: "lazy" }));
  }
  return bubble;
}

function takeOverBar(name: string): HTMLElement {
  const button = h("button", { class: "takeover", textContent: "Continue on phone" });
  button.onclick = async () => {
    button.disabled = true;
    button.textContent = "Starting…";
    try {
      const { name: typeable } = await api<{ name: string }>(`/api/sessions/${name}/takeover`, {});
      alert(`Copy started. To have this copy on your laptop too, run this in a new terminal tab:\n\npocket attach ${typeable}\n\nThen close the old window, so you only use one of them.`);
      location.hash = `#/s/${typeable}`;
    } catch (err) {
      toast((err as Error).message);
      button.disabled = false;
      button.textContent = "Continue on phone";
    }
  };
  return h(
    "footer",
    { class: "composer readonly-note" },
    h("p", {}, "This window was opened outside pocket, so the phone can only watch it. Continue on phone starts a copy of this conversation that you can type into from here. Messages to the copy won't appear in the original window."),
    button,
  );
}

function renderSession(name: string) {
  const readonly = name.startsWith("ro-");
  const title = readonly ? "…" : name.replace(/^pk-[a-z0-9]+-/, "");
  const titleEl = h("h1", { class: "session-title" }, title);
  const statusEl = h("span", { class: "status-pill" }, "…");
  const chatTab = h("button", { class: "tab active", textContent: "Chat" });
  const termTab = h("button", { class: "tab", textContent: "Terminal" });
  const back = h("a", { class: "back", href: "#/", textContent: "‹" });
  const end = h("button", { class: "end", textContent: readonly ? "Hide" : "End" });
  // Renaming types /rename into the session, so the laptop tab and the phone pick up the same name.
  const rename = h("button", { class: "end", textContent: "Rename", hidden: true });
  rename.onclick = async () => {
    const newName = prompt("New name for this session (shows on the phone and in the laptop tab):", titleEl.textContent ?? "")?.trim();
    if (!newName) return;
    try {
      await api(`/api/sessions/${name}/send`, { text: `/rename ${newName}` });
      titleEl.textContent = newName;
    } catch (err) {
      toast((err as Error).message);
    }
  };
  end.onclick = async () => {
    const question = readonly
      ? "Hide this session from the list? It comes back when you next use it."
      : "End this session? The agent on your computer is closed. Claude conversations can be resumed later with claude --resume.";
    if (!confirm(question)) return;
    try {
      await api(`/api/sessions/${name}/end`, {});
      location.hash = "#/";
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const chat = h("div", { class: "chat" });
  const shared = h("div", { class: "shared-note", hidden: true });
  const changesTab = h("button", { class: "tab", textContent: "Changes" });
  const tabs = readonly ? undefined : h("nav", { class: "tabs" }, chatTab, termTab, changesTab);
  const changesWrap = h("div", { class: "changes", hidden: true });
  let terminalOnly = false;
  const termWrap = h("div", { class: "term", hidden: true });
  const termInner = h("div", { class: "term-inner" });
  termWrap.append(termInner);

  const input = h("textarea", { rows: 1, placeholder: "Message — tap the mic on your keyboard", enterKeyHint: "send" });
  const send = h("button", { class: "send", textContent: "↑", ariaLabel: "Send" });
  const attach = h("button", { class: "attach", textContent: "📎", ariaLabel: "Add images" });
  const picker = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
  const attachments = h("div", { class: "attachments", hidden: true });
  // Each image is uploaded as soon as it's picked; its path joins the message on Send.
  const images: { path?: string; ready: Promise<void>; chip: HTMLElement }[] = [];
  const refreshAttachments = () => (attachments.hidden = images.length === 0);
  attach.onclick = () => picker.click();
  picker.onchange = () => {
    for (const file of Array.from(picker.files ?? [])) {
      const chip = h("div", { class: "chip uploading" }, h("img", { src: URL.createObjectURL(file), alt: "" }));
      const remove = h("button", { class: "chip-remove", textContent: "✕", ariaLabel: "Remove image" });
      chip.append(remove);
      const image: (typeof images)[number] = { chip, ready: Promise.resolve() };
      remove.onclick = () => {
        images.splice(images.indexOf(image), 1);
        chip.remove();
        refreshAttachments();
      };
      image.ready = uploadImage(name, file).then(
        (path) => {
          image.path = path;
          chip.classList.remove("uploading");
        },
        (err) => {
          chip.classList.replace("uploading", "failed");
          toast(`Image not sent: ${(err as Error).message}`);
        },
      );
      images.push(image);
      attachments.append(chip);
    }
    picker.value = "";
    refreshAttachments();
  };
  // One-tap replies for the phrases you'd otherwise dictate all day. Long-press (or ✎) to edit; saved on this phone.
  const DEFAULT_REPLIES = ["continue", "yes, go ahead", "commit and push", "run the tests"];
  const loadReplies = (): string[] => {
    try {
      return JSON.parse(localStorage.getItem("pocket-quick-replies") ?? "null") ?? DEFAULT_REPLIES;
    } catch {
      return DEFAULT_REPLIES;
    }
  };
  const replies = h("div", { class: "replies" });
  const renderReplies = () => {
    const edit = h("button", { class: "reply edit", textContent: "✎", ariaLabel: "Edit quick replies" });
    edit.onclick = () => {
      const next = prompt("Quick replies, separated by | :", loadReplies().join(" | "));
      if (next === null) return;
      const list = next.split("|").map((reply) => reply.trim()).filter(Boolean);
      try {
        localStorage.setItem("pocket-quick-replies", JSON.stringify(list.length ? list : DEFAULT_REPLIES));
      } catch {}
      renderReplies();
    };
    replies.replaceChildren(...loadReplies().map((reply) => {
      const chip = h("button", { class: "reply", textContent: reply });
      chip.onclick = () => {
        input.value = reply;
        void submit();
      };
      return chip;
    }), edit);
  };
  const keys = h(
    "div",
    { class: "keys" },
    ...[
      ["esc", "Esc"],
      ["y", "y"],
      ["n", "n"],
      ["1", "1"],
      ["2", "2"],
      ["3", "3"],
      ["enter", "⏎"],
      ["up", "↑"],
      ["down", "↓"],
      ["left", "←"],
      ["right", "→"],
      ["stab", "⇧Tab"],
      ["ctrlc", "^C"],
    ].map(([key, label]) => {
      const button = h("button", { textContent: label });
      button.onclick = () => api(`/api/sessions/${name}/key`, { key }).catch((err) => toast(err.message));
      return button;
    }),
  );

  app.replaceChildren(
    h("header", { class: "bar" }, back, titleEl, statusEl, rename, end),
    ...(tabs ? [tabs] : []),
    shared,
    chat,
    termWrap,
    changesWrap,
    readonly
      ? takeOverBar(name)
      : h("footer", { class: "composer" }, replies, keys, attachments, h("div", { class: "input-row" }, attach, picker, input, send)),
  );

  // Chat stream
  const nearBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
  const chatSource = new EventSource(`/api/sessions/${name}/chat`);

  // A sent message shows at once as "sending…" and turns into the real bubble when the agent
  // records it; the working line shows the agent's own status ("✻ Thinking… (12s)") while it runs.
  const pending: { text: string; el: HTMLElement }[] = [];
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const workingText = h("span", { class: "working-text" }, "Working…");
  const stop = h("button", { class: "stop", textContent: "■ Stop", hidden: true });
  stop.onclick = () => api(`/api/sessions/${name}/key`, { key: "esc" }).catch((err) => toast(err.message));
  const working = h("div", { class: "working", hidden: true }, h("span", { class: "working-dots" }), workingText, stop);
  let currentStatus: Status = "idle";
  let activity = "";
  const placeholder = h("p", { class: "muted pad" }, "Waiting for the first message in this session…");
  const settleBottom = () => {
    chat.append(...pending.map((entry) => entry.el), working);
    const busy = currentStatus === "working" || pending.length > 0;
    working.hidden = !busy;
    stop.hidden = readonly || currentStatus !== "working";
    workingText.textContent = activity || (currentStatus === "working" ? "Working…" : "Sending…");
  };
  chatSource.addEventListener("chat", (event) => {
    const { reset, items } = JSON.parse((event as MessageEvent).data) as { reset?: boolean; items: Item[] };
    const stick = reset || nearBottom();
    if (reset) chat.replaceChildren();
    chat.append(...items.map(chatItem));
    for (const item of items) {
      if (item.k !== "user") continue;
      const index = pending.findIndex((entry) => normalize(entry.text) === normalize(item.t));
      if (index >= 0) pending.splice(index, 1)[0].el.remove();
    }
    settleBottom();
    if (stick) chat.scrollTop = chat.scrollHeight;
  });
  chatSource.addEventListener("activity", (event) => {
    activity = (JSON.parse((event as MessageEvent).data) as { text: string }).text;
    settleBottom();
  });
  chatSource.addEventListener("status", (event) => {
    const { status, note, title: liveTitle, agent, hasChat, sharedWith } = JSON.parse((event as MessageEvent).data) as { status: Status; note?: string; title?: string; agent?: string; hasChat?: boolean; sharedWith?: string[] };
    if (liveTitle) titleEl.textContent = liveTitle;
    rename.hidden = readonly || (agent ?? "claude") !== "claude";
    shared.hidden = !sharedWith?.length;
    shared.textContent = sharedWith?.length
      ? `This conversation is also open in ${sharedWith.join(", ")}. Both windows write to the same history, so you're seeing only this window's thread. Start one of them with a fresh claude to keep them apart.`
      : "";
    currentStatus = status;
    if (status !== "working") activity = "";
    settleBottom();
    statusEl.textContent = STATUS_LABEL[status];
    statusEl.className = `status-pill status-${status}`;
    statusEl.title = note ?? "";
    // Agents with no readable transcript (yet) get the terminal as the whole view.
    const chatless = !readonly && !!agent && agent !== "claude" && !hasChat;
    if (chatless !== terminalOnly) {
      terminalOnly = chatless;
      if (tabs) tabs.hidden = chatless;
      if (chatless) showTab(true);
    }
  });
  if (!chat.childElementCount) chat.append(placeholder);

  // Terminal snapshot stream — only while that tab is open, it changes constantly.
  let term: Terminal | undefined;
  let screenSource: EventSource | undefined;
  let fontSize = Number(localStorage.getItem("pocket-term-font") ?? 11);
  const fontFamily = "ui-monospace, Menlo, monospace";
  // How many columns and rows fit the phone at this font size. Measured once per open, not on
  // every resize: the on-screen keyboard changes the height and would reflow the agent on each tap.
  const phoneGrid = () => {
    const probe = h("span", { textContent: "W".repeat(40) });
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${fontSize}px ${fontFamily}`;
    document.body.append(probe);
    const charWidth = probe.getBoundingClientRect().width / 40;
    probe.remove();
    const cols = Math.floor((termWrap.clientWidth - 16) / charWidth);
    const rows = Math.floor((window.innerHeight - termWrap.getBoundingClientRect().top - 150) / Math.ceil(fontSize * 1.2));
    return { cols: Math.max(20, cols), rows: Math.max(10, rows) };
  };
  const openTerminal = async () => {
    // xterm is most of the bundle; load it only when the Terminal tab is opened.
    const [{ Terminal }] = await Promise.all([import("@xterm/xterm"), import("@xterm/xterm/css/xterm.css")]);
    if (chat.hidden === false) return; // switched back to Chat while loading
    term ??= new Terminal({ fontSize, disableStdin: true, scrollback: 0, cursorBlink: false, theme: { background: "#14120f" }, fontFamily });
    if (!term.element) {
      term.open(termInner);
      enableTouch(term);
    }
    const { cols, rows } = phoneGrid();
    screenSource?.close();
    screenSource = new EventSource(`/api/sessions/${name}/screen?cols=${cols}&rows=${rows}`);
    screenSource.addEventListener("screen", (event) => {
      const screen = JSON.parse((event as MessageEvent).data) as Screen;
      if (term!.cols !== screen.cols || term!.rows !== screen.rows) term!.resize(screen.cols, screen.rows);
      term!.write(`\x1b[H\x1b[2J${screen.data.replace(/\n/g, "\r\n")}\x1b[${screen.cursorY + 1};${screen.cursorX + 1}H`);
    });
  };
  const closeTerminal = () => {
    screenSource?.close();
    screenSource = undefined;
  };
  // Taps on the Terminal tab become mouse clicks and vertical swipes become scroll-wheel steps, so
  // menus like /status (tabs) and /config (long lists) work by touch. Sideways swipes still pan.
  let warnedNoMouse = false;
  const sendMouse = async (kind: "click" | "wheel-up" | "wheel-down", col: number, row: number, count = 1) => {
    try {
      const { sent } = await api<{ sent: boolean }>(`/api/sessions/${name}/mouse`, { kind, col, row, count });
      if (!sent && !warnedNoMouse) {
        warnedNoMouse = true;
        toast("This screen doesn't take taps. Use the keys below.");
      }
    } catch (err) {
      toast((err as Error).message);
    }
  };
  const enableTouch = (terminal: Terminal) => {
    const surface = terminal.element!;
    const cell = (x: number, y: number) => {
      const box = surface.querySelector(".xterm-screen")!.getBoundingClientRect();
      return {
        col: Math.floor(((x - box.left) / box.width) * terminal.cols) + 1,
        row: Math.floor(((y - box.top) / box.height) * terminal.rows) + 1,
        height: box.height / terminal.rows,
      };
    };
    const tapAt = (x: number, y: number) => {
      const { col, row } = cell(x, y);
      const ripple = h("span", { class: "tap-ripple" });
      ripple.style.left = `${x}px`;
      ripple.style.top = `${y}px`;
      document.body.append(ripple);
      setTimeout(() => ripple.remove(), 400);
      void sendMouse("click", col, row);
    };
    // Scroll steps are batched so a fast swipe is a few requests, not dozens.
    let queued = 0;
    let queuedAt = { col: 1, row: 1 };
    let flushTimer: number | undefined;
    const queueScroll = (steps: number, col: number, row: number) => {
      queued += steps;
      queuedAt = { col, row };
      flushTimer ??= window.setTimeout(() => {
        flushTimer = undefined;
        const count = queued;
        queued = 0;
        // Finger moving up pulls the content up, i.e. scrolls down.
        if (count) void sendMouse(count > 0 ? "wheel-down" : "wheel-up", queuedAt.col, queuedAt.row, Math.abs(count));
      }, 70);
    };

    // One gesture: decided as a tap, a vertical swipe (scrolls the agent's list) or a sideways
    // swipe (left to the browser, which pans a terminal wider than the phone).
    let gesture: { x: number; y: number; lastY: number; axis?: "x" | "y"; pending: number } | undefined;
    const begin = (x: number, y: number) => (gesture = { x, y, lastY: y, pending: 0 });
    const move = (x: number, y: number, stopBrowserScroll: () => void) => {
      if (!gesture) return;
      if (!gesture.axis && (Math.abs(x - gesture.x) > 8 || Math.abs(y - gesture.y) > 8)) {
        gesture.axis = Math.abs(y - gesture.y) >= Math.abs(x - gesture.x) ? "y" : "x";
      }
      if (gesture.axis !== "y") return;
      stopBrowserScroll();
      const { col, row, height } = cell(x, y);
      gesture.pending += gesture.lastY - y;
      gesture.lastY = y;
      const steps = Math.trunc(gesture.pending / height);
      if (steps) {
        gesture.pending -= steps * height;
        queueScroll(steps, col, row);
      }
    };
    const finish = (x: number, y: number) => {
      if (gesture && !gesture.axis) tapAt(x, y);
      gesture = undefined;
    };

    // Phones: touch events, so a vertical swipe can be kept from scrolling the page instead.
    surface.addEventListener("touchstart", (event) => {
      gesture = undefined;
      if (event.touches.length === 1) begin(event.touches[0].clientX, event.touches[0].clientY);
    }, { passive: true });
    surface.addEventListener("touchmove", (event) => {
      const touch = event.touches[0];
      if (touch) move(touch.clientX, touch.clientY, () => event.preventDefault());
    }, { passive: false });
    surface.addEventListener("touchend", (event) => {
      const touch = event.changedTouches[0];
      if (touch && gesture) {
        finish(touch.clientX, touch.clientY);
        event.preventDefault(); // no follow-up emulated mouse click
      }
    }, { passive: false });
    surface.addEventListener("touchcancel", () => (gesture = undefined));

    // A mouse (desktop browser) gets the same behaviour.
    surface.addEventListener("pointerdown", (event) => event.pointerType === "mouse" && begin(event.clientX, event.clientY));
    surface.addEventListener("pointermove", (event) => event.pointerType === "mouse" && move(event.clientX, event.clientY, () => {}));
    surface.addEventListener("pointerup", (event) => event.pointerType === "mouse" && finish(event.clientX, event.clientY));
  };

  const zoom = (delta: number) => {
    fontSize = Math.min(16, Math.max(5, fontSize + delta));
    localStorage.setItem("pocket-term-font", String(fontSize));
    if (term) term.options.fontSize = fontSize;
    if (screenSource) void openTerminal(); // refit the session to the new font size
  };
  const zoomOut = h("button", { class: "zoom", textContent: "A−" });
  const zoomIn = h("button", { class: "zoom", textContent: "A+" });
  zoomOut.onclick = () => zoom(-1);
  zoomIn.onclick = () => zoom(1);
  termWrap.prepend(h("div", { class: "zoom-row" }, zoomOut, zoomIn));

  const showTab = (view: boolean | "changes") => {
    const terminal = view === true;
    const changes = view === "changes";
    chatTab.classList.toggle("active", !terminal && !changes);
    termTab.classList.toggle("active", terminal);
    changesTab.classList.toggle("active", changes);
    chat.hidden = terminal || changes;
    termWrap.hidden = !terminal;
    changesWrap.hidden = !changes;
    terminal ? void openTerminal() : closeTerminal();
    if (changes) void loadChanges();
  };
  chatTab.onclick = () => showTab(false);
  termTab.onclick = () => showTab(true);
  changesTab.onclick = () => showTab("changes");

  // Read-only "what did it change" view: git's changed files in the session folder, tap one for its diff.
  interface ChangedFile { path: string; status: string; added: number; removed: number }
  const STATUS_NAMES: Record<string, string> = { "??": "new", A: "added", M: "modified", D: "deleted", R: "renamed" };
  const loadChanges = async () => {
    changesWrap.replaceChildren(h("p", { class: "muted pad" }, "Loading…"));
    try {
      const result = await api<{ repo: boolean; branch?: string; cwd: string; files: ChangedFile[] }>(`/api/sessions/${name}/changes`);
      if (!result.repo) return changesWrap.replaceChildren(h("p", { class: "muted pad" }, "This folder isn't a git repository, so there's nothing to compare against."));
      const totals = result.files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
      const refresh = h("button", { class: "ghost", textContent: "↻ Refresh" });
      refresh.onclick = () => void loadChanges();
      const header = h("div", { class: "changes-head" },
        h("span", {}, `${result.files.length} file${result.files.length === 1 ? "" : "s"} changed${result.branch ? ` on ${result.branch}` : ""}`),
        h("span", { class: "plus" }, `+${totals.added}`), h("span", { class: "minus" }, `−${totals.removed}`), refresh);
      if (!result.files.length) return changesWrap.replaceChildren(header, h("p", { class: "muted pad" }, "No uncommitted changes."));
      const rows = result.files.map((file) => {
        const row = h("button", { class: "change-row" },
          h("span", { class: `change-status s-${file.status === "??" ? "new" : file.status[0]}` }, STATUS_NAMES[file.status] ?? STATUS_NAMES[file.status[0]] ?? file.status),
          h("span", { class: "change-path" }, file.path),
          h("span", { class: "plus" }, file.added ? `+${file.added}` : ""), h("span", { class: "minus" }, file.removed ? `−${file.removed}` : ""));
        row.onclick = () => void showDiff(file.path);
        return row;
      });
      changesWrap.replaceChildren(header, ...rows);
    } catch (err) {
      changesWrap.replaceChildren(h("p", { class: "muted pad" }, (err as Error).message));
    }
  };
  const showDiff = async (file: string) => {
    const back = h("button", { class: "ghost", textContent: "‹ All changes" });
    back.onclick = () => void loadChanges();
    changesWrap.replaceChildren(h("div", { class: "changes-head" }, back, h("span", { class: "change-path" }, file)), h("p", { class: "muted pad" }, "Loading…"));
    try {
      const { diff } = await api<{ diff: string }>(`/api/sessions/${name}/changes?file=${encodeURIComponent(file)}`);
      const pre = h("pre", { class: "diff" });
      for (const line of diff.split("\n")) {
        const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
        pre.append(h("span", { class: kind }, `${line}\n`));
      }
      changesWrap.replaceChildren(changesWrap.firstChild!, pre);
    } catch (err) {
      toast((err as Error).message);
    }
  };

  // Composer
  const draftKey = `pocket-draft-${name}`;
  input.value = sessionStorage.getItem(draftKey) ?? "";
  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  };
  input.oninput = () => {
    sessionStorage.setItem(draftKey, input.value);
    grow();
  };
  const submit = async () => {
    send.disabled = true;
    await Promise.all(images.map((image) => image.ready));
    const paths = images.flatMap((image) => (image.path ? [image.path] : []));
    // The agent reads images by path; put them on their own lines after the message.
    const typed = input.value.trim();
    const text = [typed || (paths.length ? "Look at this image:" : ""), ...paths].filter(Boolean).join("\n");
    if (!text) {
      send.disabled = false;
      return;
    }
    const bubble = chatItem({ k: "user", t: text });
    bubble.classList.add("pending");
    const entry = { text, el: bubble };
    const isCommand = text.startsWith("/"); // slash commands aren't recorded as messages
    placeholder.remove();
    if (!isCommand) pending.push(entry);
    settleBottom();
    if (isCommand) chat.insertBefore(bubble, working);
    chat.scrollTop = chat.scrollHeight;
    try {
      await api(`/api/sessions/${name}/send`, { text });
      images.splice(0).forEach((image) => image.chip.remove());
      refreshAttachments();
      input.value = "";
      sessionStorage.removeItem(draftKey);
      grow();
      // Not recorded within a minute (e.g. the agent was showing a menu): stop pretending it's on its way.
      setTimeout(() => {
        const index = pending.indexOf(entry);
        if (index >= 0) {
          pending.splice(index, 1);
          bubble.classList.replace("pending", "unconfirmed");
          bubble.title = "Sent, but the agent hasn't recorded it yet — check the Terminal tab";
          settleBottom();
        }
      }, 60_000);
    } catch (err) {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
      bubble.classList.replace("pending", "failed");
      settleBottom();
      toast((err as Error).message);
    } finally {
      send.disabled = false;
    }
  };
  send.onclick = submit;
  renderReplies();
  grow();

  cleanup = () => {
    chatSource.close();
    closeTerminal();
    term?.dispose();
  };
}

// ---------- routing ----------

function route() {
  document.querySelectorAll(".overlay").forEach((overlay) => overlay.remove()); // an open sheet belongs to the old page
  cleanup?.();
  cleanup = undefined;
  const match = location.hash.match(/^#\/s\/((?:pk|ro)-[a-z0-9._-]+)$/);
  match ? renderSession(match[1]) : renderHome();
}

window.addEventListener("hashchange", route);
route();

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.navigate) location.href = event.data.navigate;
  });
}
