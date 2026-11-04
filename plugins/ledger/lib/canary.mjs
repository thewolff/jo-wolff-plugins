// canary.mjs — `ledger canary`: run every plugin's live run headless, nightly, and keep the result.
//
//   canary run [--repo <path>] [--plugins a,b] [--timeout <s>] [--no-prune | --prunes-only]
//       For each plugin under <repo>/plugins/ (every directory with hooks/hooks.json or
//       .claude-plugin/plugin.json), run `e2e/live-run.sh` from the plugin directory with the
//       canary contract below, and insert one cc_canary_runs row: status pass (exit 0), fail
//       (any other exit, or the deadline), unavailable (no script, exit 75, or `claude` missing).
//       The script's own stream-json transcript, written by it to CANARY_TRANSCRIPT
//       (<state>/canary/<plugin>/<iso>.jsonl), is kept as it wrote it (transcript_path; NULL
//       with a note when the script wrote none); the script's stdout and stderr go to
//       <iso>.out.txt beside it (output_path), and the row keeps their last 16 KiB as `summary`
//       and a line diff against the last pass as `diff`. The row also keeps `tree_sha`, the
//       plugin tree the run certifies (`git rev-parse HEAD:plugins/<p>`; NULL when the plugin
//       has uncommitted changes or the repo is none: the gate's `evals` row only trusts a row
//       for the committed tree), and `writes`, the script's `wrote: <path>` lines (files the
//       live run left outside its work directory, in placeholder form; the gate's `retention`
//       row checks them against the plugin's declared `state`). After the live runs, every
//       `prune` command the plugins declare in `.claude-plugin/plugin.json` `state[]` is run
//       once, in the canary's own environment (the real state is what is pruned), and recorded
//       as a cc_canary_prunes row with the bytes it reported freed (`… <n> bytes freed` on its
//       last stdout line; NULL when it reported none). Exit 0 when every plugin passed or was
//       unavailable, 1 when any failed, 2 when the store could not be written (the canary has no
//       session to fail open into; the prunes still run before it exits, so a read-only store
//       never skips them). A prune that fails is its own row and never fails the run.
//   canary run --prunes-only [--repo <path>] [--plugins a,b]
//       The daily job: no live runs, no cc_canary_runs row. Every declared prune runs, before
//       and independently of any database write (a cc_canary_prunes row per prune is still
//       attempted; one that cannot be written is `not recorded: …` on the line and changes
//       nothing else). One line per prune, `prune <plugin>: <its last stdout line>`. Exit 0 when
//       every prune ran (pass, or unavailable by its own exit 75), 1 when any failed or could
//       not be started, naming it on the last line.
//   canary grade <id> biting|silent|fine ["<note>"]
//       Records who read the run and what they made of it.
//   canary prune [--days 30] [--dry-run]
//       Removes transcript and output files older than that; rows stay. This is the ledger's
//       own declared prune verb, under the plugin-kit contract: the last line is
//       `pruned: <n> file(s), <bytes> bytes freed[ (dry run)]; kept <k>`, a file that cannot be
//       removed is named on stderr and counted as kept, exit 0.
//   canary status
//       The last run per plugin, the last prune per declared path, and when each last passed.
//   canary install [--repo <path>] [--hour 3] [--minute 30] [--prunes-only]
//       Writes <state>/launchd/com.jo-wolff-plugins.ledger-canary.plist (with --prunes-only:
//       …ledger-prunes.plist, `canary run --prunes-only`, default 10:00), checks it with
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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLUGIN_ROOT } from "./doctor.mjs";
import { stateDir } from "./config.mjs";
import { transaction } from "./db.mjs";
import { nowIso } from "./time.mjs";

export const DEFAULT_TIMEOUT_S = 600;
export const SUMMARY_MAX = 16 * 1024;
export const PRUNE_DAYS = 30;
export const LABEL = "com.jo-wolff-plugins.ledger-canary";
export const PRUNES_LABEL = "com.jo-wolff-plugins.ledger-prunes";
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

/**
 * The environment a live-run.sh gets: the caller's, minus every LEDGER_* key. The script builds
 * its own throwaway config and db; a caller's LEDGER_DB (or LEDGER_CONFIG, LEDGER_ENABLED, …)
 * would otherwise outrank what the script sets and point the seeded question and the headless
 * session at the real store.
 */
export function childEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("LEDGER_")));
}

function hasBinary(name, env) {
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { env, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() !== "";
}

/** Run one script with a deadline, capturing stdout and stderr; resolves always. */
function runScript(script, { cwd, env, timeoutMs, shell = false }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = shell
        ? spawn("/bin/sh", ["-c", script], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" })
        : spawn("bash", [script], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
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

/** The committed tree of plugins/<name> in `repo`: null with uncommitted changes under it or outside a repository. */
export function pluginTreeSha(repo, name) {
  const run = (args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 10_000 });
  const dirty = run(["status", "--porcelain", "--", `plugins/${name}`]);
  if (dirty.error || dirty.status !== 0 || dirty.stdout.trim()) return null;
  const sha = run(["rev-parse", "--verify", "-q", `HEAD:plugins/${name}`]);
  return !sha.error && sha.status === 0 ? sha.stdout.trim() || null : null;
}

/** The `wrote: <path>` lines of a live run's stdout, deduplicated and sorted. */
export function observedWrites(stdout) {
  const out = new Set();
  for (const line of String(stdout ?? "").split("\n")) {
    const m = line.match(/^wrote:\s+(\S.*)$/);
    if (m) out.add(m[1].trim());
  }
  return [...out].sort();
}

/** The declared `state[]` prune commands of a plugin: `[{ path, command }]`; [] without any. */
export function declaredPrunes(pluginDir) {
  try {
    const json = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
    if (!Array.isArray(json.state)) return [];
    return json.state.filter((e) => e && typeof e === "object" && typeof e.path === "string" && typeof e.prune === "string" && e.prune.trim()).map((e) => ({ path: e.path, command: e.prune.trim() }));
  } catch {
    return [];
  }
}

/** The bytes a prune reported on its last stdout line (`… 1234 bytes freed`), or null. */
export function bytesFreedFrom(stdout) {
  const last = String(stdout ?? "").trim().split("\n").pop() ?? "";
  const m = last.match(/(\d+)\s+bytes?\s+freed/i);
  return m ? Number(m[1]) : null;
}

/**
 * Run every declared prune of `plugins` once and record each as a cc_canary_prunes row.
 * `run` is injectable (same shape as runScript's result, given a shell line). Never throws on a
 * failed prune: that is the row. Returns the rows.
 */
export async function runPrunes({ db, dbPath, env = process.env, plugins, timeoutS = 120, run = runShell }) {
  const rows = [];
  for (const p of plugins) {
    for (const { path, command } of declaredPrunes(p.dir)) {
      const at = nowIso(Date.now());
      const row = { plugin: p.name, at, path, command, status: "fail", exit_code: null, bytes_freed: null, note: null };
      const r = await run(command, { cwd: p.dir, env: { ...env, CLAUDE_PLUGIN_ROOT: p.dir }, timeoutMs: timeoutS * 1000 });
      row.exit_code = r.code;
      if (r.spawnError) {
        row.status = "unavailable";
        row.note = `could not run: ${r.spawnError}`;
        row.ran = false;
      } else if (r.timedOut) row.note = `timeout after ${timeoutS}s`;
      else if (r.code === 0) {
        row.status = "pass";
        row.bytes_freed = bytesFreedFrom(r.stdout);
        row.note = r.stdout.trim().split("\n").pop()?.slice(0, 300) || null;
      } else if (r.code === UNAVAILABLE_EXIT) {
        row.status = "unavailable";
        row.note = r.stdout.trim().split("\n").pop()?.slice(0, 300) || "exit 75";
      } else row.note = `exit ${r.code ?? r.signal}${(r.stderr || r.stdout).trim() ? `: ${(r.stderr || r.stdout).trim().split("\n").pop().slice(0, 300)}` : ""}`;
      try {
        transaction(
          db,
          () => {
            const ins = db.prepare("INSERT INTO cc_canary_prunes (plugin, at, path, command, status, exit_code, bytes_freed, note) VALUES (?,?,?,?,?,?,?,?)").run(row.plugin, row.at, row.path, row.command, row.status, row.exit_code, row.bytes_freed, row.note);
            row.id = Number(ins.lastInsertRowid);
          },
          dbPath,
        );
      } catch (err) {
        row.note = `${row.note ? `${row.note}; ` : ""}not recorded: ${err.message}`;
      }
      rows.push(row);
    }
  }
  return rows;
}

function runShell(line, opts) {
  return runScript(line, { ...opts, shell: true });
}

export function renderPrune(r) {
  const freed = r.bytes_freed === null || r.bytes_freed === undefined ? "" : ` ${r.bytes_freed} bytes freed`;
  return `${r.plugin.padEnd(16)} prune ${r.status.padEnd(11)}${freed}${r.id ? `  #${r.id}` : ""}  ${r.path}${r.note ? `; ${r.note}` : ""}`;
}

/** The last `limit` prune rows, newest first. */
export function listPrunes(db, { limit = 20, plugin = null } = {}) {
  const rows = plugin
    ? db.prepare("SELECT * FROM cc_canary_prunes WHERE plugin = ? ORDER BY at DESC, id DESC LIMIT ?").all(plugin, limit)
    : db.prepare("SELECT * FROM cc_canary_prunes ORDER BY at DESC, id DESC LIMIT ?").all(limit);
  return rows.map((r) => ({ ...r }));
}

/** `canary status`: the last run per plugin, when it last passed, and the last prune per declared path. */
export function canaryStatus(db) {
  const runs = db.prepare("SELECT plugin, MAX(at) AS at FROM cc_canary_runs GROUP BY plugin ORDER BY plugin").all();
  const lines = [];
  if (!runs.length) lines.push("no canary runs recorded");
  for (const { plugin } of runs) {
    const last = db.prepare("SELECT id, at, status, note, tree_sha FROM cc_canary_runs WHERE plugin = ? ORDER BY at DESC, id DESC LIMIT 1").get(plugin);
    const pass = db.prepare("SELECT id, at FROM cc_canary_runs WHERE plugin = ? AND status = 'pass' ORDER BY at DESC, id DESC LIMIT 1").get(plugin);
    lines.push(`${plugin.padEnd(16)} last ${last.status.padEnd(11)} #${last.id} ${last.at}${last.tree_sha ? ` tree ${last.tree_sha.slice(0, 8)}` : " (uncommitted tree)"}${last.note ? `; ${last.note}` : ""}${pass ? `; last pass #${pass.id} ${pass.at}` : "; never passed"}`);
  }
  const prunes = db.prepare("SELECT plugin, path, MAX(at) AS at FROM cc_canary_prunes GROUP BY plugin, path ORDER BY plugin, path").all();
  for (const { plugin, path } of prunes) {
    const last = db.prepare("SELECT * FROM cc_canary_prunes WHERE plugin = ? AND path = ? ORDER BY at DESC, id DESC LIMIT 1").get(plugin, path);
    lines.push(`${renderPrune({ ...last, id: null })} at ${last.at}`);
  }
  return lines.join("\n");
}

/** The last pass row's summary for a plugin, or null. */
function lastPassSummary(db, plugin) {
  const r = db.prepare("SELECT summary FROM cc_canary_runs WHERE plugin = ? AND status = 'pass' ORDER BY at DESC, id DESC LIMIT 1").get(plugin);
  return r ? r.summary : null;
}

/**
 * Run the canary for `plugins` (default: every plugin in `repo`). Returns { code, text, rows }.
 * `run` is injectable for tests (same shape as runScript's result). `prunesOnly` runs the
 * declared prunes and nothing else (see the header): no live run, no cc_canary_runs row, exit 1
 * only for a prune that failed or could not start.
 */
export async function runCanary({ db, dbPath, env = process.env, now = Date.now(), repo, plugins = null, timeoutS = DEFAULT_TIMEOUT_S, run = runScript, claudePresent = null, prunes = true, prunesOnly = false, runPrune = runShell }) {
  const root = repo ? resolve(repo) : defaultRepo();
  if (!root) return { code: 2, text: "canary: no repository: pass --repo <path to the plugins checkout>", rows: [] };
  let all;
  try {
    all = listPlugins(root);
  } catch (err) {
    return { code: 2, text: `canary: ${err.message}`, rows: [] };
  }
  const wanted = plugins ? all.filter((p) => plugins.includes(p.name)) : all;
  const missing = plugins ? plugins.filter((n) => !all.some((p) => p.name === n)) : [];
  if (prunesOnly) {
    const pruneRows = await runPrunes({ db, dbPath, env, plugins: wanted, run: runPrune });
    const lines = pruneRows.map((r) => `prune ${r.plugin}: ${r.status === "pass" ? "" : `${r.status}, `}${r.note ?? "(no output)"}`);
    for (const n of missing) lines.push(`prune ${n}: not a plugin under ${root}/plugins`);
    const failed = pruneRows.filter((r) => r.status === "fail" || r.ran === false);
    if (failed.length) lines.push(`canary: ${failed.length} prune(s) failed: ${failed.map((r) => `${r.plugin} (${r.path})`).join(", ")}`);
    else lines.push(`canary: ${pruneRows.length} prune(s) ran${pruneRows.some((r) => r.status === "unavailable") ? ` (${pruneRows.filter((r) => r.status === "unavailable").length} unavailable)` : ""}`);
    return { code: failed.length ? 1 : 0, text: lines.join("\n"), rows: [], prunes: pruneRows };
  }
  const hasClaude = claudePresent ?? hasBinary("claude", env);
  const rows = [];
  const lines = [];
  let unrecorded = null;
  for (const p of wanted) {
    const at = nowIso(Date.now());
    const script = join(p.dir, "e2e", "live-run.sh");
    const row = { plugin: p.name, at, status: "unavailable", exit_code: null, duration_ms: 0, transcript_path: null, output_path: null, summary: null, diff: null, note: null, tree_sha: pluginTreeSha(root, p.name), writes: null };
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
      const r = await run(script, { cwd: p.dir, env: { ...childEnv(env), CANARY_PLUGIN: p.name, CANARY_TRANSCRIPT: file, CANARY_TIMEOUT_S: String(timeoutS) }, timeoutMs: timeoutS * 1000 });
      row.duration_ms = r.durationMs;
      row.exit_code = r.code;
      row.writes = JSON.stringify(observedWrites(r.stdout));
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
            .prepare("INSERT INTO cc_canary_runs (plugin, at, status, exit_code, duration_ms, transcript_path, output_path, summary, diff, note, tree_sha, writes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(row.plugin, row.at, row.status, row.exit_code, row.duration_ms, row.transcript_path, row.output_path, row.summary, row.diff, row.note, row.tree_sha, row.writes);
          row.id = Number(r.lastInsertRowid);
        },
        dbPath,
      );
    } catch (err) {
      // The prunes still run: a store that cannot be written is no reason to leave state growing.
      unrecorded = `canary: could not record the ${p.name} run (${err.message}); its transcript is at ${row.transcript_path ?? "(none)"}, its output at ${row.output_path ?? "(not written)"}`;
      break;
    }
    rows.push(row);
    lines.push(renderRow(row));
  }
  if (!unrecorded) for (const n of missing) lines.push(`${n.padEnd(16)} unavailable  not a plugin under ${root}/plugins`);
  if (!lines.length && !unrecorded) lines.push(`canary: no plugins under ${root}/plugins`);
  const pruneRows = prunes ? await runPrunes({ db, dbPath, env, plugins: wanted, run: runPrune }) : [];
  for (const r of pruneRows) lines.push(renderPrune(r));
  if (unrecorded) return { code: 2, text: [...lines, unrecorded].join("\n"), rows, prunes: pruneRows };
  return { code: rows.some((r) => r.status === "fail") ? 1 : 0, text: lines.join("\n"), rows, prunes: pruneRows };
}

export function renderRow(r) {
  const secs = r.duration_ms ? ` ${(r.duration_ms / 1000).toFixed(1)}s` : "";
  const extra = [r.note ? r.note : null, r.tree_sha ? `tree ${r.tree_sha.slice(0, 8)}` : r.tree_sha === null && r.exit_code !== null ? "uncommitted tree" : null, r.diff ? `diff vs last pass: ${r.diff.split("\n").filter((l) => /^[+-]/.test(l)).length} line(s)` : null, r.transcript_path ? `transcript ${r.transcript_path}` : null, r.output_path ? `output ${r.output_path}` : null].filter(Boolean);
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

/**
 * Remove transcript and output files older than `days` (`dryRun`: count, remove nothing);
 * `{ removed, kept, bytes, problems }`, a file that cannot be removed kept and named in
 * `problems`. Rows are untouched.
 */
export function prune({ env = process.env, now = Date.now(), days = PRUNE_DAYS, dryRun = false } = {}) {
  const base = canaryDir(env);
  const cutoff = now - days * 24 * 3_600_000;
  const out = { removed: 0, kept: 0, bytes: 0, problems: [] };
  if (!existsSync(base)) return out;
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
          if (!dryRun) rmSync(file, { force: true });
          out.removed++;
          out.bytes += st.size;
        } catch (err) {
          out.kept++;
          out.problems.push(`could not remove ${file}: ${err.message}`);
        }
      } else out.kept++;
    }
  }
  return out;
}

/** The `canary prune` lines: the contract's `pruned:` line last. */
export function renderPruneResult(r, { days, dryRun = false, env = process.env }) {
  return `canary prune: files older than ${days} day(s) under ${canaryDir(env)}; rows untouched\npruned: ${r.removed} file(s), ${r.bytes} bytes freed${dryRun ? " (dry run)" : ""}; kept ${r.kept}`;
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
 * `label`, `hour`, `minute` and the argument list are the knobs; `prunesOnly` sets the three for
 * the daily prunes job (PRUNES_LABEL, `--prunes-only`); `check` runs plutil/launchctl
 * (injectable for tests).
 */
export function install({ env = process.env, cliPath, repo, cwd = process.cwd(), prunesOnly = false, label = prunesOnly ? PRUNES_LABEL : LABEL, hour = 3, minute = 30, extraArgs = prunesOnly ? ["--prunes-only"] : [], uid = process.getuid?.() ?? 501, check = runCheck }) {
  // launchd runs the job from / with no cwd of ours: the plist must carry an absolute path.
  const root = repo ? resolve(cwd, repo) : defaultRepo();
  if (!root) return { code: 1, text: "canary install: no repository: pass --repo <path to the plugins checkout>" };
  if (!existsSync(join(root, "plugins"))) return { code: 1, text: `canary install: ${root} has no plugins/ directory; pass --repo <path to the plugins checkout>` };
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
  const usage = 'usage: canary run [--repo <path>] [--plugins a,b] [--timeout <s>] [--no-prune | --prunes-only] | canary runs [N] [--plugin <name>] | canary status | canary grade <id> biting|silent|fine ["<note>"] | canary prune [--days N] [--dry-run] | canary install [--repo <path>] [--hour H] [--minute M] [--prunes-only]';
  const SWITCHES = new Set(["--no-prune", "--prunes-only", "--dry-run"]);
  const [action, ...rest] = tokens;
  const flags = (allowed) => {
    const out = {};
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (SWITCHES.has(a)) continue;
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
    const noPrune = rest.includes("--no-prune");
    const prunesOnly = rest.includes("--prunes-only");
    if (noPrune && prunesOnly) return { error: usage };
    const f = flags(["--repo", "--plugins", "--timeout"]);
    if (!f || f.positional.length) return { error: usage };
    const timeoutS = f.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(f.timeout);
    if (!Number.isInteger(timeoutS) || timeoutS <= 0) return { error: usage };
    return { action, repo: f.repo ?? null, plugins: f.plugins ? f.plugins.split(",").map((s) => s.trim()).filter(Boolean) : null, timeoutS, prunes: !noPrune, prunesOnly };
  }
  if (action === "status") {
    if (rest.length) return { error: usage };
    return { action };
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
    return { action, days, dryRun: rest.includes("--dry-run") };
  }
  if (action === "install") {
    const prunesOnly = rest.includes("--prunes-only");
    const f = flags(["--repo", "--hour", "--minute"]);
    if (!f || f.positional.length) return { error: usage };
    const hour = f.hour === undefined ? (prunesOnly ? 10 : 3) : Number(f.hour);
    const minute = f.minute === undefined ? (prunesOnly ? 0 : 30) : Number(f.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return { error: usage };
    return { action, repo: f.repo ?? null, hour, minute, prunesOnly };
  }
  return { error: usage };
}

