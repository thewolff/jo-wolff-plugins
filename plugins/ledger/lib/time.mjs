// time.mjs — ISO-8601 UTC timestamps, duration parsing, and display helpers.
//
// Storage is always UTC with milliseconds (`2026-11-03T22:30:00.000Z`). A time zone is used
// only when rendering for a person (`pending`, `log`, the SessionStart text); null means the
// process's own zone.

/** Now as the stored ISO form. */
export function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/**
 * `2h`, `30m`, `3d`, `1w`, `1.5h` → milliseconds; null when the text is not a duration.
 */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(String(text).trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  return Math.round(n * UNIT_MS[m[2].toLowerCase()]);
}

/**
 * A deadline flag: a duration (`2h`) counted from `now`, or an ISO date/time. Returns the ISO
 * deadline and the span from now, or null when the text is neither.
 */
export function parseDeadline(text, now = Date.now()) {
  const span = parseDuration(text);
  if (span !== null) return { iso: nowIso(now + span), spanMs: span };
  const t = Date.parse(String(text).trim());
  if (Number.isNaN(t)) return null;
  return { iso: nowIso(t), spanMs: t - now };
}

/** `3m ago`, `2h ago`, `5d ago`, or `in 2h` for a future time. */
export function relative(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = now - t;
  const abs = Math.abs(diff);
  let text;
  if (abs < 60_000) text = "just now";
  else if (abs < 3_600_000) text = `${Math.round(abs / 60_000)}m`;
  else if (abs < 86_400_000) text = `${Math.round(abs / 3_600_000)}h`;
  else text = `${Math.round(abs / 86_400_000)}d`;
  if (text === "just now") return text;
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}

/** The stored ISO rendered for a person in `timezone` (null: the process zone). */
export function formatLocal(iso, timezone = null) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone ?? undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).format(new Date(t));
  } catch {
    return iso;
  }
}

