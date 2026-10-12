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

  app.replaceChildren(h("header", { class: "bar" }, h("h1", {}, "Pocket"), bell), list);

  let timer: number | undefined;
  const refresh = async () => {
    try {
      const sessions = await api<Session[]>("/api/sessions");
      list.replaceChildren(...(sessions.length ? sessions.map(sessionCard) : [emptyState()]));
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

// ---------- session ----------

function inlineMarkdown(text: string): DocumentFragment {
  // Escape first, then a tiny subset: fenced code, inline code, bold. Enough for Claude's replies.
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = escaped
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => `<pre>${code}</pre>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  return document.createRange().createContextualFragment(html);
}

function chatItem(item: Item): HTMLElement {
  if (item.k === "tool") return h("div", { class: "tool" }, item.t);
  if (item.k === "error") return h("div", { class: "tool error" }, item.t);
  const bubble = h("div", { class: `msg ${item.k}` });
  bubble.append(inlineMarkdown(item.t));
  return bubble;
}

function takeOverBar(name: string): HTMLElement {
  const button = h("button", { class: "takeover", textContent: "Continue on phone" });
  button.onclick = async () => {
    button.disabled = true;
    button.textContent = "Starting…";
    try {
      const { name: typeable } = await api<{ name: string }>(`/api/sessions/${name}/takeover`, {});
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
    h("p", {}, "This session was started outside pocket, so it's view only. Continue it here: the conversation resumes in a new session on your computer that you can type into. The original window stays as it is."),
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

  const chat = h("div", { class: "chat" });
  const tabs = readonly ? undefined : h("nav", { class: "tabs" }, chatTab, termTab);
  let terminalOnly = false;
  const termWrap = h("div", { class: "term", hidden: true });
  const termInner = h("div", { class: "term-inner" });
  termWrap.append(termInner);

  const input = h("textarea", { rows: 1, placeholder: "Message — tap the mic on your keyboard", enterKeyHint: "send" });
  const send = h("button", { class: "send", textContent: "↑", ariaLabel: "Send" });
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
      ["stab", "⇧Tab"],
      ["ctrlc", "^C"],
    ].map(([key, label]) => {
      const button = h("button", { textContent: label });
      button.onclick = () => api(`/api/sessions/${name}/key`, { key }).catch((err) => toast(err.message));
      return button;
    }),
  );

  app.replaceChildren(
    h("header", { class: "bar" }, back, titleEl, statusEl),
    ...(tabs ? [tabs] : []),
    chat,
    termWrap,
    readonly
      ? takeOverBar(name)
      : h("footer", { class: "composer" }, keys, h("div", { class: "input-row" }, input, send)),
  );

  // Chat stream
  const nearBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
  const chatSource = new EventSource(`/api/sessions/${name}/chat`);
  chatSource.addEventListener("chat", (event) => {
    const { reset, items } = JSON.parse((event as MessageEvent).data) as { reset?: boolean; items: Item[] };
    const stick = reset || nearBottom();
    if (reset) chat.replaceChildren();
    chat.append(...items.map(chatItem));
    if (stick) chat.scrollTop = chat.scrollHeight;
  });
  chatSource.addEventListener("status", (event) => {
    const { status, note, title: liveTitle, agent } = JSON.parse((event as MessageEvent).data) as { status: Status; note?: string; title?: string; agent?: string };
    if (liveTitle) titleEl.textContent = liveTitle;
    statusEl.textContent = STATUS_LABEL[status];
    statusEl.className = `status-pill status-${status}`;
    statusEl.title = note ?? "";
    // Agents other than Claude have no transcript, so the terminal is the whole view.
    if (agent && agent !== "claude" && !terminalOnly) {
      terminalOnly = true;
      tabs?.remove();
      showTab(true);
    }
  });
  if (!chat.childElementCount) chat.append(h("p", { class: "muted pad" }, "Waiting for the first message in this session…"));

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
    if (!term.element) term.open(termInner);
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

  const showTab = (terminal: boolean) => {
    chatTab.classList.toggle("active", !terminal);
    termTab.classList.toggle("active", terminal);
    chat.hidden = terminal;
    termWrap.hidden = !terminal;
    terminal ? void openTerminal() : closeTerminal();
  };
  chatTab.onclick = () => showTab(false);
  termTab.onclick = () => showTab(true);

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
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      await api(`/api/sessions/${name}/send`, { text });
      input.value = "";
      sessionStorage.removeItem(draftKey);
      grow();
      chat.scrollTop = chat.scrollHeight;
    } catch (err) {
      toast((err as Error).message);
    } finally {
      send.disabled = false;
    }
  };
  send.onclick = submit;
  grow();

  cleanup = () => {
    chatSource.close();
    closeTerminal();
    term?.dispose();
  };
}

// ---------- routing ----------

function route() {
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
