// digest.mjs — `ledger digest`: the weekly report posted as a comment on the digest issue, and
// the dead-man's switch that makes a missing digest visible at the next session start.
//
//   digest [--dry-run] [--force]
//       Builds the 7-day report (lib/report.mjs, judge included), writes cc_meta
//       digest_last_attempt FIRST, then posts with `gh issue comment <issue> --body-file -`
//       (30 s deadline). Success → digest_last_posted; failure → digest_last_error with the
//       reason, exit 1, and the body on stdout so nothing is lost. An empty week still posts
//       ("week of …: 0 bounces, 0 canary runs, nothing graded"): no comment means the job did
//       not run. A second post within 24 h is refused unless --force. --dry-run prints the body
//       and writes no key. Body ≤ 60 KiB, cut with a marker.
//   digest install
//       Writes <state>/launchd/com.jo-wolff-plugins.ledger-digest.plist (Monday 09:00 local),
//       lints it, prints the bootstrap line. Never bootstraps.
//
// THE SWITCH (sessionStartLines, read by SessionStart from the local db only, so it works
// offline): `ledger: weekly digest overdue (last: <date>); run \`… digest\` or check launchd`
// when the last post, or when never posted the first time this db was seen after migration 7
// (digest_first_seen, stamped by SessionStart), is older than OVERDUE_DAYS (8); and
// `ledger: weekly digest attempted <date>, post failed: <reason>` when the last attempt is newer
// than the last post and left an error. `digest.enabled: false` in the user config turns both
// lines and the post off; doctor says so.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseIssue, stateDir } from "./config.mjs";
import { transaction } from "./db.mjs";
import { runReport } from "./report.mjs";
import { nowIso } from "./time.mjs";

export const KEYS = Object.freeze({ attempt: "digest_last_attempt", posted: "digest_last_posted", error: "digest_last_error", firstSeen: "digest_first_seen" });
export const OVERDUE_DAYS = 8;
export const REPOST_MIN_MS = 24 * 3_600_000;
export const GH_TIMEOUT_MS = 30_000;
export const BODY_MAX = 60 * 1024;
export const DEFAULT_ISSUE = "thewolff/jo-issues#325";

export const LABEL = "com.jo-wolff-plugins.ledger-digest";
const DAY_MS = 24 * 3_600_000;

export function meta(db, key) {
  try {
    return db.prepare("SELECT value FROM cc_meta WHERE key = ?").get(key)?.value ?? null;
  } catch {
    return null;
  }
}

function setMeta(db, dbPath, pairs) {
  transaction(
    db,
    () => {
      const st = db.prepare("INSERT INTO cc_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      for (const [k, v] of pairs) if (v === null) db.prepare("DELETE FROM cc_meta WHERE key = ?").run(k);
      else st.run(k, v);
    },
    dbPath,
  );
}

/** Stamp digest_first_seen once; returns true when it was written now. Caller's transaction. */
export function stampFirstSeen(db, now = Date.now()) {
  const r = db.prepare("INSERT INTO cc_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").run(KEYS.firstSeen, nowIso(now));
  return r.changes > 0;
}

const day = (iso) => String(iso).slice(0, 10);

/**
 * The SessionStart exception lines: [] when nothing is wrong or the digest is off.
 * `cli` is the invocation prefix for the way out.
 */
export function sessionStartLines(db, { config, now = Date.now(), cli = "ledger" } = {}) {
  if (config?.digest?.enabled === false) return [];
  const lines = [];
  const posted = meta(db, KEYS.posted);
  const attempt = meta(db, KEYS.attempt);
  const error = meta(db, KEYS.error);
  const anchor = posted ?? meta(db, KEYS.firstSeen);
  if (anchor && now - Date.parse(anchor) > OVERDUE_DAYS * DAY_MS) lines.push(`ledger: weekly digest overdue (last: ${posted ? day(posted) : `never; first seen ${day(anchor)}`}); run \`${cli} digest\` or check launchd`);
  if (attempt && error && (!posted || Date.parse(attempt) > Date.parse(posted))) lines.push(`ledger: weekly digest attempted ${day(attempt)}, post failed: ${error}`);
  return lines;
}

/** The comment body: a heading with the week, then the report. Cut at BODY_MAX with a marker. */
export function body(reportText, data, { now = Date.now(), version = "" } = {}) {
  const counts = `${data.rules.reduce((s, r) => s + r.fired, 0)} bounces, ${data.canary.length} canary runs (${data.canary.filter((r) => r.status === "fail").length} failed), ${data.canary.filter((r) => r.grade).length ? `${data.canary.filter((r) => r.grade).length} graded` : "nothing graded"}`;
  const head = `## ledger weekly digest${version ? ` (ledger ${version})` : ""}\n\nweek of ${day(data.from)} to ${day(nowIso(now))}: ${counts}\n\n`;
  const text = `${head}\`\`\`\n${reportText}\n\`\`\`\n`;
  if (Buffer.byteLength(text) <= BODY_MAX) return text;
  const marker = "\n…[cut to 60 KiB; the full report is `ledger report`]\n```\n";
  const keep = Buffer.from(text).subarray(0, BODY_MAX - Buffer.byteLength(marker)).toString();
  return keep + marker;
}

/**
 * `gh issue comment <number> --repo <owner/repo> --body-file -` with a deadline; resolves
 * { ok, error, url }. `issue` is `parseIssue`'s; the repository is always given, so gh's cwd
 * and GH_REPO never choose the destination.
 */
export function postComment(issue, text, { env = process.env, timeoutMs = GH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const args = ["issue", "comment", issue.number, "--repo", issue.repo, "--body-file", "-"];
    let child;
    try {
      child = spawn("gh", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, error: `gh could not start: ${err.message}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ ok: false, error: `gh timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => settle({ ok: false, error: err.code === "ENOENT" ? "gh not found on PATH" : `gh failed: ${err.message}` }));
    child.on("close", (code) => {
      const tail = (stderr || stdout).replace(/\s+/g, " ").trim().slice(-300);
      settle(code === 0 ? { ok: true, error: null, url: stdout.trim().split("\n").pop() ?? "" } : { ok: false, error: `gh exited ${code}${tail ? `: ${tail}` : ""}` });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}

/**
 * The digest run. `post` is injectable (tests); returns { code, text }.
 */
export async function runDigest({ db, dbPath, config, env = process.env, now = Date.now(), dryRun = false, force = false, post = postComment, version = "" }) {
  if (config?.digest?.enabled === false && !dryRun) return { code: 1, text: "digest.enabled is false in the user config; nothing posted (--dry-run still prints the body)" };
  const target = parseIssue(config?.digest?.issue || DEFAULT_ISSUE);
  if (!target) return { code: 1, text: `digest: digest.issue is "${config?.digest?.issue}", which names no repository; set it to owner/repo#number (or a github.com issue URL) in the user config; nothing posted` };
  const issue = target.text;
  const report = await runReport({ db, config, env, now, since: "7d" });
  const text = body(report.text, report.data, { now, version });
  if (dryRun) return { code: 0, text: `digest --dry-run: would post to ${issue} (${Buffer.byteLength(text)} bytes); nothing recorded\n\n${text}` };
  const posted = meta(db, KEYS.posted);
  if (!force && posted && now - Date.parse(posted) < REPOST_MIN_MS) return { code: 1, text: `digest: last posted ${posted}, less than 24h ago; pass --force to post again` };
  try {
    setMeta(db, dbPath, [[KEYS.attempt, nowIso(now)]]);
  } catch (err) {
    return { code: 2, text: `digest: could not record the attempt (${err.message}); nothing posted` };
  }
  const r = await post(target, text, { env });
  if (r.ok) {
    try {
      setMeta(db, dbPath, [[KEYS.posted, nowIso(now)], [KEYS.error, null]]);
    } catch (err) {
      return { code: 1, text: `digest: posted to ${issue}${r.url ? ` (${r.url})` : ""} but could not record it (${err.message}); the next session will say the post failed` };
    }
    return { code: 0, text: `digest: posted to ${issue}${r.url ? ` (${r.url})` : ""} at ${nowIso(now)}` };
  }
  try {
    setMeta(db, dbPath, [[KEYS.error, r.error]]);
  } catch {
    /* the attempt is recorded; the error line will be missing its reason */
  }
  return { code: 1, text: `digest: post to ${issue} failed: ${r.error}; the body follows so nothing is lost\n\n${text}` };
}

/** Doctor's view: { status, detail }. */
export function doctorCheck(db, { config, now = Date.now() } = {}) {
  if (config?.digest?.enabled === false) return { status: "warn", detail: "digest.enabled is false: no weekly digest, no overdue line" };
  const lines = sessionStartLines(db, { config, now });
  if (lines.length) return { status: "warn", detail: lines.map((l) => l.replace(/^ledger: /, "")).join("; ") };
  const posted = meta(db, KEYS.posted);
  return { status: "ok", detail: posted ? `last posted ${posted}` : `never posted; first seen ${meta(db, KEYS.firstSeen) ?? "(not yet)"}` };
}

export function plistText({ label = LABEL, cliPath, logDir, node = process.execPath, weekday = 1, hour = 9, minute = 0 }) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>${esc(cliPath)}</string>
    <string>digest</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>${weekday}</integer>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${esc(join(logDir, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(join(logDir, `${label}.err.log`))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}</string>
  </dict>
</dict>
</plist>
`;
}

function runCheck(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 10_000 });
  if (r.error?.code === "ENOENT") return { missing: true, code: null, output: "" };
  return { missing: false, code: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Write + lint the plist, print the bootstrap line, report launchd's view. Never bootstraps. */
export function install({ env = process.env, cliPath, config, label = LABEL, uid = process.getuid?.() ?? 501, check = runCheck }) {
  const dir = join(stateDir(env), "launchd");
  const file = join(dir, `${label}.plist`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, plistText({ label, cliPath, logDir: dir }));
  } catch (err) {
    return { code: 1, text: `digest install: could not write ${file} (${err.message})` };
  }
  const lines = [`wrote ${file} (${label}, Monday 09:00 local, posts to ${parseIssue(config?.digest?.issue || DEFAULT_ISSUE)?.text ?? `"${config?.digest?.issue}", which names no repository: the job will post nothing until digest.issue is owner/repo#number`})`];
  if (config?.digest?.enabled === false) lines.push("digest.enabled is false in the user config: the job will run and post nothing until that changes");
  const lint = check("plutil", ["-lint", file]);
  if (lint.missing) lines.push("plutil not found: the plist was not checked (not macOS?)");
  else if (lint.code !== 0) return { code: 1, text: `${lines.join("\n")}\nplutil -lint failed: ${lint.output.trim()}` };
  else lines.push("plutil -lint: OK");
  const loaded = check("launchctl", ["print", `gui/${uid}/${label}`]);
  if (loaded.missing) lines.push("launchctl not found: could not tell whether the job is loaded");
  else if (loaded.code === 0) lines.push(`launchd already has ${label}; to pick up this plist: launchctl bootout gui/${uid}/${label} && launchctl bootstrap gui/${uid} ${file}`);
  else lines.push(`launchd does not have ${label} yet. To install it, run:\n  launchctl bootstrap gui/${uid} ${file}\nthen check with:\n  launchctl print gui/${uid}/${label}`);
  return { code: 0, text: lines.join("\n"), file };
}

export function parseDigestArgs(tokens) {
  const usage = "usage: digest [--dry-run] [--force] | digest install";
  if (tokens[0] === "install") return tokens.length === 1 ? { action: "install" } : { error: usage };
  const out = { action: "run", dryRun: false, force: false };
  for (const t of tokens) {
    if (t === "--dry-run") out.dryRun = true;
    else if (t === "--force") out.force = true;
    else return { error: usage };
  }
  return out;
}
