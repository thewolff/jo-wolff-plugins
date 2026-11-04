#!/usr/bin/env node
// query.mjs — what the badge shows, as one JSON object on stdout. Run by the mod out of process
// (`node mods/badge/query.mjs --session <id>`), because the hooks module runs inside Claude Code
// and may import no node builtin, so it cannot read lib/state.mjs itself.
//
//   { ok: true, away: false }                                  home: no away.json, or one that does not parse (parseAway's rule)
//   { ok: true, away: true, since, note, held, onFire }        the hold, from away.json alone (the digest is not read)
//   { ok: false, error }                                       no --session; away.json a link or not a regular file; over AWAY_MAX_BYTES
//
// Read-only: nothing under the state directory is written. Always exits 0 and always prints JSON.

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAway, sessionDir } from "../../lib/state.mjs";
import { AWAY_MAX_BYTES } from "./data.mjs";

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
 * The snapshot for `sessionId`. away.json is opened once (no link followed), the open descriptor
 * is checked to be a regular file of at most AWAY_MAX_BYTES, and at most AWAY_MAX_BYTES + 1 bytes
 * are read from that same descriptor, so a file replaced or grown after the check is still bounded.
 */
export function snapshot(sessionId, { env = process.env } = {}) {
  const path = join(sessionDir(sessionId, env), "away.json");
  let fd;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, away: false };
    if (err?.code === "ELOOP") return { ok: false, error: `${path} is not a regular file` };
    throw err;
  }
  let text;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, error: `${path} is not a regular file` };
    if (st.size > AWAY_MAX_BYTES) return { ok: false, error: `${path} is ${st.size} bytes, over the ${AWAY_MAX_BYTES} byte limit` };
    const buf = Buffer.alloc(AWAY_MAX_BYTES + 1);
    let n = 0;
    for (let got = 1; got > 0 && n < buf.length; n += got) got = readSync(fd, buf, n, buf.length - n, null);
    if (n > AWAY_MAX_BYTES) return { ok: false, error: `${path} is over the ${AWAY_MAX_BYTES} byte limit` };
    text = buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
  const away = parseAway(text);
  if (!away) return { ok: true, away: false };
  return { ok: true, away: true, since: away.since, note: away.note, held: away.held, onFire: away.onFire };
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
