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
  const tabs = readonly ? undefined : h("nav", { class: "tabs" }, chatTab, termTab);
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
    h("header", { class: "bar" }, back, titleEl, statusEl, rename, end),
    ...(tabs ? [tabs] : []),
    shared,
    chat,
    termWrap,
    readonly
      ? takeOverBar(name)
      : h("footer", { class: "composer" }, keys, attachments, h("div", { class: "input-row" }, attach, picker, input, send)),
  );

  // Chat stream
  const nearBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
  const chatSource = new EventSource(`/api/sessions/${name}/chat`);

  // A sent message shows at once as "sending…" and turns into the real bubble when the agent
  // records it; the working line shows the agent's own status ("✻ Thinking… (12s)") while it runs.
  const pending: { text: string; el: HTMLElement }[] = [];
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const workingText = h("span", { class: "working-text" }, "Working…");
  const working = h("div", { class: "working", hidden: true }, h("span", { class: "working-dots" }), workingText);
  let currentStatus: Status = "idle";
  let activity = "";
  const placeholder = h("p", { class: "muted pad" }, "Waiting for the first message in this session…");
  const settleBottom = () => {
    chat.append(...pending.map((entry) => entry.el), working);
    const busy = currentStatus === "working" || pending.length > 0;
    working.hidden = !busy;
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
