#!/usr/bin/env node
// query.mjs — what the band shows, as one JSON object on stdout. Run by the mod out of process
// (`node mods/band/query.mjs --session <id>`), because the hooks module runs inside Claude Code
// and may import no node builtin, so it cannot read lib/state.mjs itself.
//
//   { ok: true, away: true, since, note, held, onFire, items, hideRows }
//        the hold from away.json; `items` the held lines of digest.md (lib/state.mjs digestItems)
//   { ok: true, away: false, checklist, hideRows }
//        home: no away.json, or one that does not parse (parseAway's rule); `checklist` is
//        checklist.json's record ({ at, since, note, items: [{ text, done }] }) or null
//   `hideRows`: config.json's row-hiding switch (lib/state.mjs hideRowsEnabled), read every query
//   { ok: false, error }
//        no --session; a state file that is a link or not a regular file; one over MAX_BYTES
// Read-only: nothing under the state directory is written. Always exits 0 and always prints JSON.

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestItems, hideRowsEnabled, parseAway, parseChecklist, sessionDir } from "../../lib/state.mjs";
import { MAX_BYTES } from "./data.mjs";

// No link is followed, and a FIFO's open does not wait for a writer (it is then refused as not a regular file).
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** `--session <id>` → { sessionId }; missing or empty → null. */
export function parseArgs(argv) {
  const out = { sessionId: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") out.sessionId = argv[++i] ?? null;
    else if (argv[i].startsWith("--session=")) out.sessionId = argv[i].slice("--session=".length);
  }
  if (typeof out.sessionId !== "string" || !out.sessionId.trim()) out.sessionId = null;
  return out;
}

/**
 * The text of `path`, or null when there is no such file. The file is opened once (no link
 * followed), the open descriptor is checked to be a regular file of at most MAX_BYTES, and at
 * most MAX_BYTES + 1 bytes are read from that same descriptor, so a file replaced or grown after
 * the check is still bounded. A link, a directory, a FIFO or an oversized file throws.
 */
export function readBounded(path) {
  let fd;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    if (err?.code === "ELOOP") throw new Error(`${path} is not a regular file`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
    if (st.size > MAX_BYTES) throw new Error(`${path} is ${st.size} bytes, over the ${MAX_BYTES} byte limit`);
    const buf = Buffer.alloc(MAX_BYTES + 1);
    let n = 0;
    for (let got = 1; got > 0 && n < buf.length; n += got) got = readSync(fd, buf, n, buf.length - n, null);
    if (n > MAX_BYTES) throw new Error(`${path} is over the ${MAX_BYTES} byte limit`);
    return buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}

/** The snapshot for `sessionId`: the hold with its held items, or home with the checklist; a file fault is `{ ok: false, error }`. */
export function snapshot(sessionId, { env = process.env } = {}) {
  try {
    const dir = sessionDir(sessionId, env);
    const awayText = readBounded(join(dir, "away.json"));
    const away = awayText === null ? null : parseAway(awayText);
    if (away) {
      const items = digestItems(readBounded(join(dir, "digest.md")) ?? "");
      return { ok: true, away: true, since: away.since, note: away.note, held: away.held, onFire: away.onFire, items, hideRows: hideRowsEnabled(env) };
    }
    const checklistText = readBounded(join(dir, "checklist.json"));
    return { ok: true, away: false, checklist: checklistText === null ? null : parseChecklist(checklistText), hideRows: hideRowsEnabled(env) };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function main(argv = process.argv.slice(2), { env = process.env, out = (s) => process.stdout.write(s) } = {}) {
  let result;
  try {
    const { sessionId } = parseArgs(argv);
    result = sessionId ? snapshot(sessionId, { env }) : { ok: false, error: "query needs --session <id>" };
  } catch (err) {
    result = { ok: false, error: err?.message ?? String(err) };
  }
  out(JSON.stringify(result) + "\n");
  return 0;
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) process.exitCode = main();
