// canary.mjs — `ledger canary`: run every plugin's live run headless, nightly, and keep the result.
//
//   canary run [--repo <path>] [--plugins a,b] [--timeout <s>]
//       For each plugin under <repo>/plugins/ (every directory with hooks/hooks.json or
//       .claude-plugin/plugin.json), run `e2e/live-run.sh` from the plugin directory with the
//       canary contract below, and insert one cc_canary_runs row: status pass (exit 0), fail
//       (any other exit, or the deadline), unavailable (no script, exit 75, or `claude` missing).
//       The script's own stream-json transcript, written by it to CANARY_TRANSCRIPT
//       (<state>/canary/<plugin>/<iso>.jsonl), is kept as it wrote it (transcript_path; NULL
//       with a note when the script wrote none); the script's stdout and stderr go to
//       <iso>.out.txt beside it (output_path), and the row keeps their last 16 KiB as `summary`
//       and a line diff against the last pass as `diff`. Exit 0 when every plugin passed or was
//       unavailable, 1 when any failed, 2 when the store could not be written (the canary has no
//       session to fail open into).
//   canary grade <id> biting|silent|fine ["<note>"]
//       Records who read the run and what they made of it.
//   canary prune [--days 30]
//       Removes transcript files older than that; rows stay.
//   canary install [--repo <path>] [--hour 3] [--minute 30]
//       Writes <state>/launchd/com.jo-wolff-plugins.ledger-canary.plist, checks it with
//       `plutil -lint` when plutil exists, prints the `launchctl bootstrap` line for the human to
//       run, and reports whether launchd already has the job (`launchctl print`). Never runs
//       bootstrap itself.
//
// THE CANARY CONTRACT for a plugin's e2e/live-run.sh (documented for new plugins in
// plugin-kit's new-plugin skill): run from the plugin directory with CANARY_PLUGIN (its name),
// CANARY_TRANSCRIPT (a path the script writes its stream-json transcript to; the canary never
// writes there itself) and CANARY_TIMEOUT_S; exit 0 = pass, 75 = unavailable (say why on the
// last stdout line: no `claude`, no credentials), anything else = fail. Every line of stdout is
// kept, in its own file.
//
// How it fails: a plugin with no script → unavailable, note `no e2e/live-run.sh`. A run past the
// deadline (default 600 s) is killed with its process group → fail, note `timeout after Ns`.
// `claude` not on PATH → every scripted plugin unavailable, note `claude not found on PATH`. A
// output file that cannot be written → the row is still inserted, output_path NULL, the error in
// note; a script that wrote no transcript → transcript_path NULL, `no transcript from the script`
// in note. Summary and diff are cut at 16 KiB with a marker. Rerun-safe: one row per run; running
// twice makes two rows, which is the record. Evidence kept: rows forever, files 30 days.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLUGIN_ROOT } from "./doctor.mjs";
import { stateDir } from "./config.mjs";
import { transaction } from "./db.mjs";
import { nowIso } from "./time.mjs";

export const DEFAULT_TIMEOUT_S = 600;
export const SUMMARY_MAX = 16 * 1024;
export const PRUNE_DAYS = 30;
export const LABEL = "com.jo-wolff-plugins.ledger-canary";
export const UNAVAILABLE_EXIT = 75;
const GRADES = ["biting", "silent", "fine"];

/** The repository the plugins live in: `--repo`, else this plugin's checkout (<root>/plugins/ledger). */
export function defaultRepo(pluginRoot = PLUGIN_ROOT) {
  const up = resolve(pluginRoot, "..", "..");
  return existsSync(join(up, "plugins")) ? up : null;
}

/** Plugin directories under <repo>/plugins, by name. */
export function listPlugins(repo) {
  const dir = join(repo, "plugins");
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (err) {
    throw new Error(`no plugins/ directory under ${repo} (${err.message})`);
  }
  return names.filter((n) => existsSync(join(dir, n, "hooks", "hooks.json")) || existsSync(join(dir, n, ".claude-plugin", "plugin.json"))).map((n) => ({ name: n, dir: join(dir, n) }));
}

export function canaryDir(env = process.env) {
  return join(stateDir(env), "canary");
}

/** Cut to `max` bytes keeping the tail, with a marker. */
export function cut(text, max = SUMMARY_MAX) {
  const t = String(text ?? "");
  if (Buffer.byteLength(t) <= max) return t;
  const keep = Buffer.from(t).subarray(-max).toString();
  return `…[cut to the last ${max} bytes]\n${keep.slice(keep.indexOf("\n") + 1)}`;
}

/**
 * A line diff of `after` against `before` (LCS), unified-style without hunks: ` ` kept, `-` gone,
 * `+` new. Only changed lines and one line of context are printed; cut at SUMMARY_MAX.
 */
export function lineDiff(before, after) {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");
  if (a.length * b.length > 4_000_000) return cut(`(diff skipped: ${a.length} × ${b.length} lines)\n`);
  const n = a.length;
  const m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([" ", a[i]]);
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) ops.push(["-", a[i++]]);
    else ops.push(["+", b[j++]]);
  }
  while (i < n) ops.push(["-", a[i++]]);
  while (j < m) ops.push(["+", b[j++]]);
  if (!ops.some(([k]) => k !== " ")) return "";
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const changed = ops[k][0] !== " ";
    const near = changed || (k > 0 && ops[k - 1][0] !== " ") || (k + 1 < ops.length && ops[k + 1][0] !== " ");
    if (near) out.push(`${ops[k][0]}${ops[k][1]}`);
    else if (out.length && out[out.length - 1] !== "…") out.push("…");
  }
  return cut(out.join("\n"));
}

function hasBinary(name, env) {
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { env, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() !== "";
}

/** Run one script with a deadline, capturing stdout and stderr; resolves always. */
function runScript(script, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn("bash", [script], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (err) {
      resolve({ code: null, signal: null, stdout: "", stderr: String(err.message), timedOut: false, durationMs: 0, spawnError: err.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, stdout, stderr, timedOut, durationMs: Date.now() - started });
    };
    child.on("error", (err) => finish({ code: null, signal: null, spawnError: err.message }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

/** The last pass row's summary for a plugin, or null. */
function lastPassSummary(db, plugin) {
  const r = db.prepare("SELECT summary FROM cc_canary_runs WHERE plugin = ? AND status = 'pass' ORDER BY at DESC, id DESC LIMIT 1").get(plugin);
  return r ? r.summary : null;
}

/**
 * Run the canary for `plugins` (default: every plugin in `repo`). Returns { code, text, rows }.
 * `run` is injectable for tests (same shape as runScript's result).
 */
export async function runCanary({ db, dbPath, env = process.env, now = Date.now(), repo, plugins = null, timeoutS = DEFAULT_TIMEOUT_S, run = runScript, claudePresent = null }) {
  const root = repo ?? defaultRepo();
  if (!root) return { code: 2, text: "canary: no repository: pass --repo <path to the plugins checkout>", rows: [] };
  let all;
  try {
    all = listPlugins(root);
  } catch (err) {
    return { code: 2, text: `canary: ${err.message}`, rows: [] };
  }
  const wanted = plugins ? all.filter((p) => plugins.includes(p.name)) : all;
  const missing = plugins ? plugins.filter((n) => !all.some((p) => p.name === n)) : [];
  const hasClaude = claudePresent ?? hasBinary("claude", env);
  const rows = [];
  const lines = [];
  for (const p of wanted) {
    const at = nowIso(Date.now());
    const script = join(p.dir, "e2e", "live-run.sh");
    const row = { plugin: p.name, at, status: "unavailable", exit_code: null, duration_ms: 0, transcript_path: null, output_path: null, summary: null, diff: null, note: null };
    if (!existsSync(script)) row.note = "no e2e/live-run.sh";
    else if (!hasClaude) row.note = "claude not found on PATH";
    else {
      const stem = join(canaryDir(env), p.name, at.replace(/[:.]/g, "-"));
      const file = `${stem}.jsonl`;
      const outFile = `${stem}.out.txt`;
      try {
        mkdirSync(join(canaryDir(env), p.name), { recursive: true });
      } catch {
        /* the script's own mkdir, or the write below, reports it */
      }
      const r = await run(script, { cwd: p.dir, env: { ...env, CANARY_PLUGIN: p.name, CANARY_TRANSCRIPT: file, CANARY_TIMEOUT_S: String(timeoutS) }, timeoutMs: timeoutS * 1000 });
      row.duration_ms = r.durationMs;
      row.exit_code = r.code;
      const out = r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : "");
      row.summary = cut(out);
      if (r.spawnError) {
        row.status = "unavailable";
        row.note = `could not run bash ${script}: ${r.spawnError}`;
      } else if (r.timedOut) {
        row.status = "fail";
        row.note = `timeout after ${timeoutS}s`;
      } else if (r.code === 0) row.status = "pass";
      else if (r.code === UNAVAILABLE_EXIT) {
        row.status = "unavailable";
        row.note = r.stdout.trim().split("\n").pop() || "exit 75 with no reason on stdout";
      } else {
        row.status = "fail";
        row.note = `exit ${r.code ?? r.signal}`;
      }
      // The script's transcript is its own: kept byte for byte, never written over.
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        /* none written */
      }
      if (size > 0) row.transcript_path = file;
      else if (row.status !== "unavailable") row.note = `${row.note ? `${row.note}; ` : ""}no transcript from the script`;
      try {
        writeFileSync(outFile, out);
        row.output_path = outFile;
      } catch (err) {
        row.note = `${row.note ? `${row.note}; ` : ""}output not written: ${err.message}`;
      }
      const prev = lastPassSummary(db, p.name);
      if (prev !== null && row.status !== "unavailable") row.diff = lineDiff(prev, row.summary) || null;
    }
    try {
      transaction(
        db,
        () => {
          const r = db
            .prepare("INSERT INTO cc_canary_runs (plugin, at, status, exit_code, duration_ms, transcript_path, output_path, summary, diff, note) VALUES (?,?,?,?,?,?,?,?,?,?)")
            .run(row.plugin, row.at, row.status, row.exit_code, row.duration_ms, row.transcript_path, row.output_path, row.summary, row.diff, row.note);
          row.id = Number(r.lastInsertRowid);
        },
        dbPath,
      );
    } catch (err) {
      return { code: 2, text: `${lines.join("\n")}${lines.length ? "\n" : ""}canary: could not record the ${p.name} run (${err.message}); its transcript is at ${row.transcript_path ?? "(none)"}, its output at ${row.output_path ?? "(not written)"}`, rows };
    }
    rows.push(row);
    lines.push(renderRow(row));
  }
  for (const n of missing) lines.push(`${n.padEnd(16)} unavailable  not a plugin under ${root}/plugins`);
  if (!lines.length) lines.push(`canary: no plugins under ${root}/plugins`);
  return { code: rows.some((r) => r.status === "fail") ? 1 : 0, text: lines.join("\n"), rows };
}

export function renderRow(r) {
  const secs = r.duration_ms ? ` ${(r.duration_ms / 1000).toFixed(1)}s` : "";
  const extra = [r.note ? r.note : null, r.diff ? `diff vs last pass: ${r.diff.split("\n").filter((l) => /^[+-]/.test(l)).length} line(s)` : null, r.transcript_path ? `transcript ${r.transcript_path}` : null, r.output_path ? `output ${r.output_path}` : null].filter(Boolean);
  return `${r.plugin.padEnd(16)} ${r.status.padEnd(11)}${secs}${r.id ? `  #${r.id}` : ""}${extra.length ? `  ${extra.join("; ")}` : ""}`;
}

/** `canary grade <id> <grade> ["<note>"]`. */
export function gradeRun({ db, dbPath, id, grade, note = null, by = "human", now = Date.now() }) {
  if (!GRADES.includes(grade)) return { code: 1, text: `usage: canary grade <id> ${GRADES.join("|")} ["<note>"]` };
  const row = db.prepare("SELECT id, plugin, status, grade FROM cc_canary_runs WHERE id = ?").get(Number(id));
  if (!row) return { code: 1, text: `no canary run #${id}; ids are listed by \`canary runs\` and \`report\`` };
  transaction(db, () => db.prepare("UPDATE cc_canary_runs SET grade = ?, graded_by = ?, note = COALESCE(?, note) WHERE id = ?").run(grade, by, note, row.id), dbPath);
  return { code: 0, text: `#${row.id} ${row.plugin} ${row.status} graded ${grade} by ${by}${row.grade && row.grade !== grade ? ` (was ${row.grade})` : ""} at ${nowIso(now)}` };
}

/** The last `limit` runs, newest first. */
export function listRuns(db, { limit = 20, plugin = null } = {}) {
  const rows = plugin
    ? db.prepare("SELECT * FROM cc_canary_runs WHERE plugin = ? ORDER BY at DESC, id DESC LIMIT ?").all(plugin, limit)
    : db.prepare("SELECT * FROM cc_canary_runs ORDER BY at DESC, id DESC LIMIT ?").all(limit);
  return rows.map((r) => ({ ...r }));
}

export function renderRuns(rows) {
  if (!rows.length) return "no canary runs recorded";
  return rows.map((r) => `#${String(r.id).padEnd(5)} ${r.at}  ${renderRow({ ...r, id: null })}${r.grade ? `  graded ${r.grade} by ${r.graded_by}` : ""}`).join("\n");
}

/** Remove transcript files older than `days`; returns { removed, kept }. Rows are untouched. */
export function prune({ env = process.env, now = Date.now(), days = PRUNE_DAYS } = {}) {
  const base = canaryDir(env);
  const cutoff = now - days * 24 * 3_600_000;
  let removed = 0;
  let kept = 0;
  if (!existsSync(base)) return { removed, kept };
  for (const plugin of readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const dir = join(base, plugin.name);
    for (const f of readdirSync(dir)) {
      const file = join(dir, f);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.mtimeMs < cutoff) {
        try {
          rmSync(file, { force: true });
          removed++;
        } catch {
          kept++;
        }
      } else kept++;
    }
  }
  return { removed, kept };
}

/** The plist text for a nightly `canary run` (and `canary prune`) at hour:minute, local time. */
export function plistText({ label = LABEL, cliPath, repo, hour = 3, minute = 30, logDir, node = process.execPath, extraArgs = [] }) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const args = [node, cliPath, "canary", "run", "--repo", repo, ...extraArgs];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
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

/**
 * Write the plist, lint it, print the bootstrap line, report launchd's view. Never bootstraps.
 * `label`, `hour`, `minute` and the argument list are the knobs; `check` runs plutil/launchctl
 * (injectable for tests).
 */
export function install({ env = process.env, cliPath, repo, label = LABEL, hour = 3, minute = 30, extraArgs = [], uid = process.getuid?.() ?? 501, check = runCheck }) {
  const root = repo ?? defaultRepo();
  if (!root) return { code: 1, text: "canary install: no repository: pass --repo <path to the plugins checkout>" };
  const dir = join(stateDir(env), "launchd");
  const file = join(dir, `${label}.plist`);
  const text = plistText({ label, cliPath, repo: root, hour, minute, logDir: dir, extraArgs });
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
  } catch (err) {
    return { code: 1, text: `canary install: could not write ${file} (${err.message})` };
  }
  const lines = [`wrote ${file} (${label}, ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} local, every day)`];
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

function runCheck(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 10_000 });
  if (r.error?.code === "ENOENT") return { missing: true, code: null, output: "" };
  return { missing: false, code: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Parse `canary …` tokens into an action; usage on a bad shape. */
export function parseCanaryArgs(tokens) {
  const usage = 'usage: canary run [--repo <path>] [--plugins a,b] [--timeout <s>] | canary runs [N] [--plugin <name>] | canary grade <id> biting|silent|fine ["<note>"] | canary prune [--days N] | canary install [--repo <path>] [--hour H] [--minute M]';
  const [action, ...rest] = tokens;
  const flags = (allowed) => {
    const out = {};
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (!a.startsWith("--")) {
        positional.push(a);
        continue;
      }
      const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, null];
      const value = inline ?? rest[++i];
      if (value === undefined || !allowed.includes(flag)) return null;
      out[flag.slice(2)] = value;
    }
    out.positional = positional;
    return out;
  };
  if (action === "run") {
    const f = flags(["--repo", "--plugins", "--timeout"]);
    if (!f || f.positional.length) return { error: usage };
    const timeoutS = f.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(f.timeout);
    if (!Number.isInteger(timeoutS) || timeoutS <= 0) return { error: usage };
    return { action, repo: f.repo ?? null, plugins: f.plugins ? f.plugins.split(",").map((s) => s.trim()).filter(Boolean) : null, timeoutS };
  }
  if (action === "runs") {
    const f = flags(["--plugin"]);
    if (!f || f.positional.length > 1) return { error: usage };
    const limit = f.positional.length ? Number(f.positional[0]) : 20;
    if (!Number.isInteger(limit) || limit <= 0) return { error: usage };
    return { action, limit, plugin: f.plugin ?? null };
  }
  if (action === "grade") {
    const [id, grade, ...note] = rest;
    if (!id || !grade) return { error: usage };
    return { action, id, grade, note: note.length ? note.join(" ") : null };
  }
  if (action === "prune") {
    const f = flags(["--days"]);
    if (!f || f.positional.length) return { error: usage };
    const days = f.days === undefined ? PRUNE_DAYS : Number(f.days);
    if (!Number.isInteger(days) || days < 0) return { error: usage };
    return { action, days };
  }
  if (action === "install") {
    const f = flags(["--repo", "--hour", "--minute"]);
    if (!f || f.positional.length) return { error: usage };
    const hour = f.hour === undefined ? 3 : Number(f.hour);
    const minute = f.minute === undefined ? 30 : Number(f.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return { error: usage };
    return { action, repo: f.repo ?? null, hour, minute };
  }
  return { error: usage };
}

