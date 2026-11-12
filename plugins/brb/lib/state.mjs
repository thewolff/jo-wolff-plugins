// state.mjs — where brb keeps the away flag and the digest, one directory per session.
//
//   ${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/away.json   the hold: since, note, counts
//   ${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/digest.md   held items, append-only while away
//   ${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/archive/<ts>.md   digests `back` released
//   ${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/checklist.json   the returned digest: written by `back` (each row's text, entry heading, done), ticked by `done N` (typed, or the band's Done), removed once every row is ticked or by `brb clear` after the open rows are shown (lib/back.mjs)
//   ${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/export/<ts>-<what>.md   the whole text of a `brb clear` block or one item too long for a hook's context (lib/back.mjs), written and fsync'd before the message that points at it; scripts/prune.mjs ages it out with the rest
//   ${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/away.lock   held while away.json is read-modified-written; holds `<pid> <token>`
//   ${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/section.json   written by the band mod (mods/band/data.mjs sectionPath, `$.fs.write`): the away state each environment section of the system prompt last carried, so a resumed conversation drops a saved away text once; written only when that state changes; scripts/prune.mjs ages it out with the rest
//   ${XDG_CONFIG_HOME:-~/.config}/brb/config.json                  optional: onFireCap, idleStops, hideRows
//
// The times Jo reads (a digest entry's heading, the digest's `held since`) are local time
// (localTime: `2026-11-10 5:50 PM PST`, in env.TZ or the machine's zone); the times a program
// reads (away.json `since`, checklist.json, archive file names) stay ISO.
//
// away.json is the one record that the session is away: present means away, absent means home.
// It is written whole through a temp file and a rename, so a reader never sees half of it.
// Every function here returns a value or throws; the hooks run under lib/hook-runner.mjs, which
// turns a throw into one errors.log line and an allow. A missing or unparsable config file is
// the defaults, and a missing or unparsable away.json is "home" (readAway returns null).

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CONFIG = Object.freeze({ onFireCap: 3, idleStops: 2 });

/** `${XDG_STATE_HOME:-~/.local/state}/brb`. */
export function stateRoot(env = process.env) {
  const xdg = env.XDG_STATE_HOME?.trim() ? env.XDG_STATE_HOME : join(env.HOME || homedir(), ".local", "state");
  return join(xdg, "brb");
}

/** `${XDG_CONFIG_HOME:-~/.config}/brb/config.json`. */
export function configPath(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME?.trim() ? env.XDG_CONFIG_HOME : join(env.HOME || homedir(), ".config");
  return join(xdg, "brb", "config.json");
}

/** A session id as a directory name: anything outside [A-Za-z0-9._-] becomes `_`; empty is `no-session`. */
export function sessionKey(sessionId) {
  const s = typeof sessionId === "string" ? sessionId.trim().replace(/[^A-Za-z0-9._-]/g, "_") : "";
  return s && s !== "." && s !== ".." ? s.slice(0, 120) : "no-session";
}

export function sessionDir(sessionId, env = process.env) {
  return join(stateRoot(env), sessionKey(sessionId));
}

const awayPath = (sessionId, env) => join(sessionDir(sessionId, env), "away.json");
/** `<session dir>/digest.md`, the live digest. */
export const digestPath = (sessionId, env = process.env) => join(sessionDir(sessionId, env), "digest.md");

/** How long a writer waits for the session lock before giving up, and when a held lock is stale. */
export const LOCK_WAIT_MS = 2_000;
export const LOCK_STALE_MS = 60_000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The pid in a lock file's `<pid> <token>` content; null when the file has none (an empty or foreign lock). */
function lockPid(content) {
  const pid = Number.parseInt(String(content).split(/\s/)[0], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Whether a pid is a live process: `kill(pid, 0)`; ESRCH is dead, EPERM is alive (another user's). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

/**
 * Run fn() holding `<session dir>/away.lock`, the one lock every away.json read-modify-write
 * takes (the hold command; `brb`, `back` and the turn reset in the prompt hook; the Stop
 * hook's read-merge-write; `pending`'s read), so a `back` cannot land between another writer's
 * re-read and its write. The lock is an O_EXCL create holding `<pid> <token>`. A lock is taken
 * over only when its holder is dead (the pid is gone, `kill(pid, 0)` → ESRCH; an empty or
 * foreign lock has no pid and is never dead by this test) or when it is older than
 * LOCK_STALE_MS (a holder that hung, or a pid that was reused); a live holder is waited on,
 * and past LOCK_WAIT_MS this throws (`brb: the hold is locked (<path>, held by pid N); try
 * again in a moment`), which the hook runner logs and the hold command reports. Takeover is a
 * rename then a remove, so two waiters that both saw a dead holder cannot each remove the
 * other's fresh lock: only one rename succeeds. Release removes the lock only while it still
 * holds this call's token. fn re-reads away.json itself.
 */
export function withAwayLock(sessionId, env, fn) {
  const dir = sessionDir(sessionId, env);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "away.lock");
  const token = `${process.pid} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let holder = null;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, token);
      closeSync(fd);
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
    let stale;
    try {
      holder = lockPid(readFileSync(lock, "utf8"));
      stale = (holder !== null && !alive(holder)) || Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
    } catch {
      continue; // released between the create and the read
    }
    if (stale) {
      const gone = `${lock}.${process.pid}.stale`;
      try {
        renameSync(lock, gone);
      } catch {
        continue; // another waiter took it over first; its fresh lock is next
      }
      rmSync(gone, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`brb: the hold is locked (${lock}${holder === null ? "" : `, held by pid ${holder}`}); try again in a moment`);
    sleep(20);
  }
  try {
    return fn();
  } finally {
    let mine = false;
    try {
      mine = readFileSync(lock, "utf8") === token;
    } catch {
      // already gone: taken over as stale, or the directory was removed
    }
    if (mine) rmSync(lock, { force: true });
  }
}

/** The effective config: the file's integer fields over the defaults; a missing or bad file is the defaults. */
export function loadConfig(env = process.env) {
  const out = { ...DEFAULT_CONFIG };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath(env), "utf8"));
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const v = parsed[key];
    if (Number.isInteger(v) && v >= 0) out[key] = v;
  }
  return out;
}

/**
 * Whether the band mod hides the hold's transcript rows: config.json `hideRows`. No file is on;
 * `"on"` or `true`, or no `hideRows` key, is on; `"off"` or `false` is off. A file that cannot be
 * read or parsed, or any other value, is off: the switch exists to turn hiding off in one step,
 * so a broken file never leaves it on. (The other keys keep loadConfig's rule: defaults.)
 */
export function hideRowsEnabled(env = process.env) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath(env), "utf8"));
  } catch (err) {
    return err?.code === "ENOENT";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const v = parsed.hideRows;
  return v === undefined || v === "on" || v === true;
}

/** A fresh away record: when the hold began, the note typed after `brb`, zeroed counters, no backstop yet this turn. */
export function freshAway({ since = new Date().toISOString(), note = "" } = {}) {
  return { since, note, held: 0, onFire: 0, toolLessStops: 0, nothingNewStops: 0, backstopped: false, seen: [], lastStop: null };
}

/** The session's away record, or null when home (no file, or a file that does not parse). */
export function readAway(sessionId, env = process.env) {
  let text;
  try {
    text = readFileSync(awayPath(sessionId, env), "utf8");
  } catch {
    return null;
  }
  return parseAway(text);
}

/** away.json's text → the typed away record, or null (home) when it does not parse or has no `since`. */
export function parseAway(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.since !== "string") return null;
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  return {
    since: parsed.since,
    note: typeof parsed.note === "string" ? parsed.note : "",
    held: n(parsed.held),
    onFire: n(parsed.onFire),
    toolLessStops: n(parsed.toolLessStops),
    nothingNewStops: n(parsed.nothingNewStops),
    backstopped: parsed.backstopped === true,
    seen: Array.isArray(parsed.seen) ? parsed.seen.filter((s) => typeof s === "string") : [],
    lastStop: parsed.lastStop && typeof parsed.lastStop === "object" ? parsed.lastStop : null,
  };
}

/** Write the away record whole (temp file + rename). Creates the session directory. */
export function writeAway(sessionId, away, env = process.env) {
  const dir = sessionDir(sessionId, env);
  mkdirSync(dir, { recursive: true });
  const path = awayPath(sessionId, env);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(away));
  renameSync(tmp, path);
  return path;
}

/** Remove the away record; the session is home. The digest is left where it is. */
export function clearAway(sessionId, env = process.env) {
  rmSync(awayPath(sessionId, env), { force: true });
}

/**
 * An ISO time as Jo reads it: `2026-11-10 5:50 PM PST`, in `timeZone` (an IANA name such as
 * `America/Los_Angeles`; absent, or one Intl refuses, the machine's zone). Display only. Anything
 * that is not a time comes back as given.
 */
export function localTime(iso, timeZone) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const format = (zone) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).formatToParts(new Date(t));
    const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
  };
  try {
    return format(timeZone || undefined);
  } catch {
    try {
      return format(undefined);
    } catch {
      return String(iso);
    }
  }
}

/** Append one digest entry: a heading with the time in local time (localTime, env.TZ), one line per held item, the closing ask when there is one. */
export function appendDigest(sessionId, { at = new Date().toISOString(), lines = [], closingAsk = null }, env = process.env) {
  const dir = sessionDir(sessionId, env);
  mkdirSync(dir, { recursive: true });
  const body = [`## ${localTime(at, env.TZ)}`, ...lines.map((l) => (/^\s*([-*+]|\d+[.)])\s+/.test(l) ? l.trim() : `- ${l.trim()}`)), ...(closingAsk ? [`closing ask: ${closingAsk.trim()}`] : []), ""];
  appendFileSync(digestPath(sessionId, env), `${body.join("\n")}\n`);
}

/** The digest's body as written, "" when there is none. */
export function readDigest(sessionId, env = process.env) {
  try {
    return readFileSync(digestPath(sessionId, env), "utf8");
  } catch {
    return "";
  }
}

/** Where archiveDigest would move the digest for `at`: `archive/<ts>.md`, `-2`, `-3` … past a name taken. Creates nothing. */
export function archiveTarget(sessionId, env = process.env, at = new Date().toISOString()) {
  const archive = join(sessionDir(sessionId, env), "archive");
  let to = join(archive, `${at.replace(/[:.]/g, "-")}.md`);
  for (let n = 2; existsSync(to); n++) to = join(archive, `${at.replace(/[:.]/g, "-")}-${n}.md`);
  return to;
}

/** Move the digest to `to` (default archiveTarget); the archived path, or null when there was no digest. */
export function archiveDigest(sessionId, env = process.env, at = new Date().toISOString(), to = null) {
  const from = digestPath(sessionId, env);
  if (!existsSync(from)) return null;
  const target = to ?? archiveTarget(sessionId, env, at);
  mkdirSync(join(target, ".."), { recursive: true });
  renameSync(from, target);
  return target;
}

/**
 * Write `text` whole to `<session dir>/export/<ts>-<name>.md` (a temp file, fsync'd, renamed),
 * then check the file on disk holds every byte; the path. Throws when any step fails (the temp
 * file is removed), so a caller deletes nothing on the strength of an export that is not there.
 */
export function writeExport(sessionId, name, text, env = process.env, at = new Date().toISOString()) {
  const dir = join(sessionDir(sessionId, env), "export");
  mkdirSync(dir, { recursive: true });
  const stem = `${at.replace(/[:.]/g, "-")}-${String(name).replace(/[^A-Za-z0-9._-]/g, "_")}`;
  let to = join(dir, `${stem}.md`);
  for (let n = 2; existsSync(to); n++) to = join(dir, `${stem}-${n}.md`);
  const tmp = `${to}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, to);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  const want = Buffer.byteLength(text);
  const got = statSync(to).size;
  if (got !== want) throw new Error(`the export ${to} holds ${got} of ${want} bytes`);
  return to;
}

/** The digest's header line: `brb digest — held since <local time> (<note>), N items`. */
export function digestHeader(away, env = process.env) {
  const n = away.held;
  return `brb digest — held since ${localTime(away.since, env.TZ)}${away.note ? ` (${away.note})` : ""}, ${n} item${n === 1 ? "" : "s"}`;
}

/** The digest as `pending` prints it (and `back` before 0.6.0): a header line (`held since` in local time, env.TZ), then the body or "(nothing held)". */
export function renderDigest(away, body, env = process.env) {
  const header = digestHeader(away, env);
  return body.trim() ? `${header}\n\n${body.trim()}` : `${header}\n\n(nothing held)`;
}

/** `<session dir>/checklist.json`, the after-back checklist. */
export const checklistPath = (sessionId, env = process.env) => join(sessionDir(sessionId, env), "checklist.json");

/** A digest entry's item line → its text: the list marker off, whitespace collapsed; null for a heading, a blank or anything else. */
export function digestItem(line) {
  const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(line);
  if (m) return m[1].replace(/\s+/g, " ");
  const ask = /^\s*(closing ask:\s*.*\S)\s*$/.exec(line);
  return ask ? ask[1].replace(/\s+/g, " ") : null;
}

/** The held items in a digest body, in order, each with the heading of the entry it sits under (`## <local time>`, "" before any): `[{ text, heading }]`. */
export function digestEntries(body) {
  let heading = "";
  const out = [];
  for (const line of String(body ?? "").split("\n")) {
    const h = /^##\s+(.*\S)\s*$/.exec(line);
    if (h) {
      heading = h[1];
      continue;
    }
    const text = digestItem(line);
    if (text !== null) out.push({ text, heading });
  }
  return out;
}

/** The held items in a digest body, in order: every entry's item lines and `closing ask:` lines (appendDigest's shape); headings and blanks are not items. */
export function digestItems(body) {
  return digestEntries(body).map((e) => e.text);
}

/**
 * A fresh checklist from a hold that just ended: when, the hold's since and note, where its
 * digest was archived, one row per item (a string, or `{ text, heading }` from digestEntries),
 * none done.
 */
export function freshChecklist({ at = new Date().toISOString(), since = "", note = "", archived = [], items = [] } = {}) {
  const row = (i) => (typeof i === "string" ? { text: i, heading: "", done: false } : { text: i.text, heading: i.heading ?? "", done: false });
  return { at, since, note, archived: archived.filter((a) => typeof a === "string"), items: items.map(row) };
}

/**
 * A hold that ends while an earlier returned digest is still open: the open one keeps its rows,
 * their numbers and ticks, and its `at` (the band binds a press to it); the new hold's rows are
 * appended after them, and its since, note and archive path join. Nothing open: `fresh` as is.
 */
export function mergeChecklist(open, fresh) {
  if (!open || !open.items.length) return fresh;
  return { at: open.at, since: fresh.since, note: fresh.note, archived: [...open.archived, ...fresh.archived], items: [...open.items, ...fresh.items] };
}

/** checklist.json's text → the typed checklist, or null when it does not parse or has no `items` list. */
export function parseChecklist(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) return null;
  const str = (v) => (typeof v === "string" ? v : "");
  const items = parsed.items.filter((i) => i && typeof i === "object" && typeof i.text === "string").map((i) => ({ text: i.text, heading: str(i.heading), done: i.done === true }));
  const archived = Array.isArray(parsed.archived) ? parsed.archived.filter((a) => typeof a === "string") : [];
  const out = { at: str(parsed.at), since: str(parsed.since), note: str(parsed.note), archived, items };
  // `taken`: how many items of the hold named by `since` are already rows (lib/back.mjs endHold), so a `back` retried after its archive step failed adds only the rest.
  if (Number.isInteger(parsed.taken) && parsed.taken >= 0) out.taken = parsed.taken;
  // `takenArchive`: the archive path that digest was to be moved to; once it exists, `taken` no longer applies.
  if (typeof parsed.takenArchive === "string") out.takenArchive = parsed.takenArchive;
  return out;
}

/** The session's checklist, or null when there is none (no file, or a file that does not parse). */
export function readChecklist(sessionId, env = process.env) {
  let text;
  try {
    text = readFileSync(checklistPath(sessionId, env), "utf8");
  } catch {
    return null;
  }
  return parseChecklist(text);
}

/** Write the checklist whole (temp file + rename). Creates the session directory. */
export function writeChecklist(sessionId, checklist, env = process.env) {
  const dir = sessionDir(sessionId, env);
  mkdirSync(dir, { recursive: true });
  const path = checklistPath(sessionId, env);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(checklist));
  renameSync(tmp, path);
  return path;
}

/** Remove the checklist: the band clears. Only lib/back.mjs calls it, after the open rows were shown (clearReturned) or once every row is ticked. */
export function clearChecklist(sessionId, env = process.env) {
  rmSync(checklistPath(sessionId, env), { force: true });
}

/**
 * Tick row `index` of the checklist (0-based) done and write it back; ticking a ticked row
 * changes nothing. Once every row is done the file is removed instead (the returned digest is
 * closed). Returns `{ checklist, item, already, closed }`, or null when there is no checklist or
 * the index is off the list.
 */
export function tickChecklistItem(sessionId, index, env = process.env) {
  const checklist = readChecklist(sessionId, env);
  if (!checklist || !Number.isInteger(index) || index < 0 || index >= checklist.items.length) return null;
  const item = checklist.items[index];
  const already = item.done;
  item.done = true;
  const closed = checklist.items.every((i) => i.done);
  if (closed) clearChecklist(sessionId, env);
  else if (!already) writeChecklist(sessionId, checklist, env);
  return { checklist, item, already, closed };
}
