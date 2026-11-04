// doctor.mjs — `ledger doctor`: is the ledger healthy? Read-only: the database is opened with a
// read-only handle and never created, migrated or written.
//
// Checks, in order, each printed as `ok|warn|fail <name>: <one line>`:
//   db       the configured path resolves; the file opens and both it and its folder are writable
//            (fail otherwise); a file that does not exist yet is `warn` (it is created on first use)
//   schema   cc_meta schema_version equals the version this plugin ships (fail otherwise)
//   config   which layer set `db` and `enabled`; warn when `enabled` resolves false or a config
//            file did not parse
//   hooks    hooks/hooks.json lists every event the plugin handles and each script exists
//   errors   errors.log lines from the last 7 days, counted per hook; warn when any, last 5 shown
//   bounces  open bounce rows older than 24 hours (warn when any)
//   review <lab>  one per lab in review.labs, unless review.mode is off: the lab's binary is on
//            PATH (or LEDGER_REVIEW_BIN_<LAB>); warn when missing
//
// The SessionStart line (inject.doctor) runs only the cheap subset, quickIssues: schema version
// and the errors.log count. The db-open check is implied (the hook has the store open already).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { probe, SCHEMA_VERSION, storeVersion } from "./db.mjs";
import { errorsLogPath, readErrors } from "./failopen.mjs";
import { nowIso } from "./time.mjs";
import { labChecks } from "./review.mjs";

export const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const EXPECTED_EVENTS = Object.freeze(["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "SessionEnd"]);
export const ERRORS_WINDOW_MS = 7 * 86_400_000;
export const STALE_BOUNCE_MS = 86_400_000;
export const MISSING_DB = "db does not exist yet";

const check = (status, name, text, detail = []) => ({ status, name, text, detail });

function layerName(label, cfg) {
  if (label === "user file") return `user file ${cfg.path}`;
  if (label === "project file") return `project file ${cfg.projectPath}`;
  if (label === "env") return "env";
  return "default";
}

/** errors.log lines of the last 7 days: { lines, byHook: [[hook, n], …] }. */
export function recentErrors(env, now) {
  const lines = readErrors(env, { since: now - ERRORS_WINDOW_MS });
  const counts = new Map();
  for (const l of lines) counts.set(l.hook, (counts.get(l.hook) ?? 0) + 1);
  return { lines, byHook: [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])) };
}

function errorsCheck(env, now) {
  const { lines, byHook } = recentErrors(env, now);
  if (!lines.length) return check("ok", "errors", `no errors.log lines in the last 7 days (${errorsLogPath(env)})`);
  const detail = lines.slice(-5).map((l) => `${l.at} ${l.hook} ${l.message}`);
  return check("warn", "errors", `${lines.length} errors.log line(s) in the last 7 days: ${byHook.map(([h, n]) => `${h} ${n}`).join(", ")} (${errorsLogPath(env)})`, detail);
}

function hooksCheck(pluginRoot) {
  const path = join(pluginRoot, "hooks", "hooks.json");
  let hooks;
  try {
    hooks = JSON.parse(readFileSync(path, "utf8")).hooks ?? {};
  } catch (err) {
    return check("fail", "hooks", `${path} could not be read: ${err.message}`);
  }
  const missing = EXPECTED_EVENTS.filter((e) => !Array.isArray(hooks[e]) || !hooks[e].length);
  if (missing.length) return check("fail", "hooks", `${path} does not list ${missing.join(", ")}`);
  const scripts = EXPECTED_EVENTS.flatMap((e) => hooks[e].flatMap((m) => (m.hooks ?? []).flatMap((h) => h.args ?? [])))
    .filter((a) => typeof a === "string" && a.includes("${CLAUDE_PLUGIN_ROOT}"))
    .map((a) => a.replace("${CLAUDE_PLUGIN_ROOT}", pluginRoot.replace(/\/$/, "")));
  const absent = scripts.filter((s) => !existsSync(s));
  if (absent.length) return check("fail", "hooks", `hook script(s) missing: ${absent.join(", ")}`);
  return check("ok", "hooks", `${path} lists ${EXPECTED_EVENTS.join(", ")}`);
}

/**
 * Run every check. `extraChecks(cfg, env)` returns more checks (default: the review labs' binaries).
 * @returns {{ checks: Array<{status, name, text, detail}>, fails: number, issues: number }}
 *   `issues`: fails plus warns other than a database that does not exist yet.
 */
export function runDoctor({ env = process.env, cwd = null, now = Date.now(), pluginRoot = PLUGIN_ROOT, extraChecks = labChecks } = {}) {
  const cfg = loadConfig({ env, cwd });
  const checks = [];
  const dbPath = cfg.config.db;
  const p = probe(dbPath);
  if (!p.exists) checks.push(check("warn", "db", `${MISSING_DB} at ${dbPath}; it is created on first use`));
  else if (p.error) checks.push(check("fail", "db", `${dbPath} does not open: ${p.error}`));
  else if (!p.writable) checks.push(check("fail", "db", `${dbPath} opens but is not writable (file or folder is read-only)`));
  else checks.push(check("ok", "db", `${dbPath} opens read-write`));

  if (!p.exists) checks.push(check("ok", "schema", `created at version ${SCHEMA_VERSION} on first use`));
  else if (p.version === null) checks.push(check("fail", "schema", "not readable"));
  else if (p.version !== SCHEMA_VERSION) checks.push(check("fail", "schema", `version ${p.version}, this plugin expects ${SCHEMA_VERSION}`));
  else checks.push(check("ok", "schema", `version ${p.version}`));

  const layers = `db from ${layerName(cfg.sources.db, cfg)}, enabled = ${cfg.config.enabled} from ${layerName(cfg.sources.enabled, cfg)}`;
  if (cfg.notices.length) checks.push(check("warn", "config", `${layers}; ${cfg.notices.length} config problem(s)`, cfg.notices));
  else if (!cfg.config.enabled) checks.push(check("warn", "config", `${layers}; the hooks are off for ${cwd}`));
  else checks.push(check("ok", "config", layers));

  checks.push(hooksCheck(pluginRoot));
  checks.push(errorsCheck(env, now));

  if (p.query && p.version === SCHEMA_VERSION) {
    try {
      const cutoff = nowIso(now - STALE_BOUNCE_MS);
      const stale = p.query((db) => db.prepare("SELECT rule, count(*) AS n FROM cc_bounces WHERE outcome IS NULL AND at < ? GROUP BY rule ORDER BY rule").all(cutoff));
      const total = stale.reduce((s, r) => s + r.n, 0);
      if (total) checks.push(check("warn", "bounces", `${total} open bounce(s) older than 24h: ${stale.map((r) => `${r.rule} ${r.n}`).join(", ")}`));
      else checks.push(check("ok", "bounces", "no open bounces older than 24h"));
    } catch (err) {
      checks.push(check("fail", "bounces", `could not read cc_bounces: ${err.message}`));
    }
  } else {
    checks.push(check("ok", "bounces", "not checked (no current database yet)"));
  }

  if (extraChecks) checks.push(...extraChecks(cfg, env));
  return summarize(checks);
}

function summarize(checks) {
  const fails = checks.filter((c) => c.status === "fail").length;
  const issues = checks.filter((c) => c.status === "fail" || (c.status === "warn" && !(c.name === "db" && c.text.startsWith(MISSING_DB)))).length;
  return { checks, fails, issues };
}

export function renderDoctor({ checks }) {
  const out = [];
  for (const c of checks) {
    out.push(`${c.status.padEnd(4)} ${c.name}: ${c.text}`);
    for (const d of c.detail) out.push(`       ${d}`);
  }
  return out.join("\n");
}

/**
 * The SessionStart subset, cheap: schema version of the open store and the errors.log count.
 * Returns the number of issues (0, 1 or 2).
 */
export function quickIssues(db, { env = process.env, now = Date.now() } = {}) {
  let n = 0;
  if (storeVersion(db) !== SCHEMA_VERSION) n++;
  if (recentErrors(env, now).lines.length) n++;
  return n;
}
