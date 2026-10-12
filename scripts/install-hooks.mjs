// Adds the pocket hook to each given Claude Code config dir's settings.json (default ~/.claude).
// Idempotent: earlier pocket entries are replaced, every other hook is left as it is.
// A backup is written next to each file as settings.json.bak-pocket.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "StopFailure", "Notification", "SessionEnd"];
const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "pocket-hook.sh");
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : [path.join(os.homedir(), ".claude")];

for (const dir of dirs) {
  const file = path.join(dir, "settings.json");
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (existsSync(file)) copyFileSync(file, `${file}.bak-pocket`);
  settings.hooks ??= {};
  for (const event of EVENTS) {
    const groups = (settings.hooks[event] ?? [])
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((entry) => !String(entry.command ?? "").includes("pocket-hook.sh")) }))
      .filter((group) => group.hooks.length);
    groups.push({ hooks: [{ type: "command", command: hook, timeout: 5 }] });
    settings.hooks[event] = groups;
  }
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`hooks installed in ${file}`);
}
