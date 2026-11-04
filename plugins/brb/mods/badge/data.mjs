// data.mjs — the badge's pure functions: the snapshot query.mjs prints read back into one typed
// shape, the one line the badge shows, the clock and duration formats in it, and the path of the
// session's away.json (the mod's cheap "is the hold on" probe between queries).
//
// No imports: this file is loaded inside Claude Code by the hooks module (register.mjs), where
// only relative imports and `claude-code` are allowed, and by `node --test` for its unit tests.

/** The word that ends the hold; the badge names it. */
export const BACK_WORD = "back";

/** The most of the `brb <note>` text the badge repeats; the status line is cut at 200 characters by the app. */
export const NOTE_CAP = 40;

/** The most bytes query.mjs reads from away.json; a larger file is a fault, never a parse. */
export const AWAY_MAX_BYTES = 65536;

/** The argv after `node` that runs the query for `sessionId`: `[<script>, "--session", <id>]`. */
export function queryArgv(script, sessionId) {
  return [script, "--session", String(sessionId ?? "")];
}

/** The snapshot before the first query answers: home. */
export function emptySnapshot() {
  return { ok: true, away: false };
}

/**
 * What query.mjs printed → a snapshot the badge can show, with every field present and typed:
 *   { ok: true, away: false }
 *   { ok: true, away: true, since, note, held, onFire }
 *   { ok: false, error }
 * Anything unparseable or mis-shaped becomes `{ ok: false, error }`, never a throw.
 */
export function readSnapshot(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? "").trim());
  } catch {
    return { ok: false, error: "query printed no JSON" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "query printed no object" };
  if (parsed.ok === false) return { ok: false, error: String(parsed.error ?? "query failed") };
  if (parsed.away !== true) return { ok: true, away: false };
  if (typeof parsed.since !== "string") return { ok: false, error: "query printed an away record with no since" };
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  return { ok: true, away: true, since: parsed.since, note: typeof parsed.note === "string" ? parsed.note : "", held: n(parsed.held), onFire: n(parsed.onFire) };
}

/** `10:42 AM` in the app's zone (or `timeZone`); the ISO text itself when it is not a date. */
export function clockTime(iso, timeZone) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  return new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
}

/** How long since `iso`, to the minute: `0m`, `40m`, `1h 5m`, `2h`, `1d 3h`; a future or unparsable `since` is `0m`. */
export function elapsed(iso, now = Date.now()) {
  const t = Date.parse(iso);
  const minutes = Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60_000)) : 0;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/**
 * The badge's text, or null when there is nothing to show (home, or a query that failed). The app
 * draws it after `⚠ brb:`, so the line does not repeat the name:
 *   away since 10:42 AM (40m) · 12 held · say back
 *   away since 10:42 AM (40m) · lunch · 1 held · say back        (the note, cut at NOTE_CAP)
 */
export function badgeText(snapshot, { now = Date.now(), timeZone } = {}) {
  if (!snapshot.ok || !snapshot.away) return null;
  const parts = [`away since ${clockTime(snapshot.since, timeZone)} (${elapsed(snapshot.since, now)})`];
  const note = snapshot.note.replace(/\s+/g, " ").trim();
  if (note) parts.push(note.length > NOTE_CAP ? `${note.slice(0, NOTE_CAP - 1)}…` : note);
  parts.push(`${snapshot.held} held`, `say ${BACK_WORD}`);
  return parts.join(" · ");
}

/** lib/state.mjs `sessionKey`, repeated here because this file may import nothing: the session id as a directory name. */
export function sessionKey(sessionId) {
  const s = typeof sessionId === "string" ? sessionId.trim().replace(/[^A-Za-z0-9._-]/g, "_") : "";
  return s && s !== "." && s !== ".." ? s.slice(0, 120) : "no-session";
}

/**
 * `${XDG_STATE_HOME:-$HOME/.local/state}/brb/<session key>/away.json`, as lib/state.mjs places it;
 * null when neither variable has a value (the mod then relies on its query alone).
 */
export function awayPath({ xdgStateHome, home, sessionId }) {
  const root = xdgStateHome?.trim() ? xdgStateHome : home ? `${home.replace(/[\\/]+$/, "")}/.local/state` : null;
  if (!root) return null;
  return `${root.replace(/[\\/]+$/, "")}/brb/${sessionKey(sessionId)}/away.json`;
}
