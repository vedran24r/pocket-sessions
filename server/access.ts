import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { STATE_DIR } from "./store.ts";

/**
 * Who may open the app. Anyone who gets in can type into your sessions, so there are exactly two ways:
 *  - Tailscale: `tailscale serve` adds the caller's login, and it's in POCKET_USERS. That header is only
 *    trusted on loopback connections (where tailscale serve connects from); on any other network a
 *    client could simply send it.
 *  - The access key: opening the access link (…/?key=…) once stores it in a cookie on that phone.
 */
const ALLOWED_USERS = (process.env.POCKET_USERS ?? "").split(",").map((user) => user.trim()).filter(Boolean);
const COOKIE = "pocket_key";

export function accessKey(): string {
  const file = path.join(STATE_DIR, "access-key");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    const key = randomBytes(24).toString("base64url");
    writeFileSync(file, key, { mode: 0o600 });
    return key;
  }
}
const KEY = accessKey();

function sameKey(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const given = Buffer.from(candidate);
  const expected = Buffer.from(KEY);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function cookieKey(req: IncomingMessage): string | undefined {
  const match = String(req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return match?.[1];
}

export function allowed(req: IncomingMessage): boolean {
  const login = req.headers["tailscale-user-login"];
  if (typeof login === "string" && isLoopback(req) && ALLOWED_USERS.includes(login)) return true;
  return sameKey(cookieKey(req));
}

/**
 * Handles an access link: a valid ?key= sets the cookie and redirects to the same page without the key
 * (so it doesn't linger in history or screenshots). Returns true when it answered the request.
 */
export function acceptAccessLink(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const key = url.searchParams.get("key");
  if (!key) return false;
  if (!sameKey(key)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("That access link is out of date. Run `pocket link` on your computer for the current one.");
    return true;
  }
  url.searchParams.delete("key");
  const secure = req.headers["x-forwarded-proto"] === "https" || "tailscale-user-login" in req.headers ? "; Secure" : "";
  res.writeHead(302, {
    "set-cookie": `${COOKIE}=${KEY}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${secure}`,
    location: `${url.pathname}${url.search}${url.hash}`,
  });
  res.end();
  return true;
}
