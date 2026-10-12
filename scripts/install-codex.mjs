// Points Codex's `notify` at the pocket notifier in $CODEX_HOME/config.toml (default ~/.codex).
// `notify` must be a top-level key, so it goes above the first [table]. An existing notify that
// isn't ours is left alone; we print how to chain it instead of overwriting someone's setup.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const file = path.join(home, "config.toml");
const notifier = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "codex-notify.sh");
const line = `notify = [${JSON.stringify(notifier)}]`;

mkdirSync(home, { recursive: true });
const toml = existsSync(file) ? readFileSync(file, "utf8") : "";
const existing = toml.split("\n").findIndex((row) => /^\s*notify\s*=/.test(row));

if (existing >= 0) {
  if (toml.split("\n")[existing].includes("codex-notify.sh")) {
    const updated = toml.split("\n");
    updated[existing] = line;
    writeFileSync(file, updated.join("\n"));
    console.log(`codex notifier updated in ${file}`);
  } else {
    console.log(`${file} already has a notify program; to also notify your phone, call this from it:\n  ${notifier} "$@"`);
  }
} else {
  if (toml) copyFileSync(file, `${file}.bak-pocket`);
  const rows = toml ? toml.split("\n") : [];
  const firstTable = rows.findIndex((row) => /^\s*\[/.test(row));
  const at = firstTable >= 0 ? firstTable : rows.length;
  rows.splice(at, 0, "# Pocket Sessions: phone notification when a turn finishes", line, ...(firstTable >= 0 ? [""] : []));
  writeFileSync(file, `${rows.join("\n").replace(/\n*$/, "")}\n`);
  console.log(`codex notifier installed in ${file}`);
}
