// lib/repair.mjs — `ctx-watch repair`: the repair an agent (or a person) runs when ctx is down,
// with no prompts. It is the 2026-11-11 hand-run sequence that brought the daemon back after six
// days, with that run's typed confirmations turned into gates that refuse instead of asking.
//
// Order, stopping at the first refusal or failure:
//   1. probe `ctx daemon status`: healthy → exit 0, nothing changed;
//   2. LANG: this shell's, else the LANG ctx recorded in supervisor-environment.json, else one
//      derived from AppleLocale (launchd.mjs resolveLang), passed to every ctx spawn; refuse
//      only when none of the three gives one (ctx would record a daemon launch environment
//      without LANG and report `environment_invalid`, the 2026-11-11 state). A shell launchd
//      started (Claude Desktop's Bash tool) has no LANG of its own, so this is the usual path
//      from Desktop;
//   3. refuse when the GUI launchd domain gui/<uid> is not reachable (`launchctl print` fails:
//      an ssh or sandboxed shell), since the ctx-watch timer could not be paused and restored;
//   4. refuse when ctx's indexing mode is not `auto` or its config file is missing (ctx-watch
//      never flips a deliberate `manual` and never sets ctx up);
//   5. the upgrade gate (probe.mjs upgradeGate and readHandoff): refuse while an upgrade is in
//      progress, while a handoff owner process is alive, or while the handoff marker is younger
//      than ctx's DAEMON_UPGRADE_HANDOFF_STALE_AFTER (15 min) even with its owner dead; refuse a
//      stuck state other than `quiescing` (the release below was only observed on quiescing);
//   6. pause the ctx-watch timer when launchd has it (`launchctl bootout`), so a tick cannot
//      heal into the middle of the repair;
//   7. on a stuck `quiescing` upgrade: `ctx upgrade disable` (when automatic upgrades are on,
//      so the failing upgrade does not retry) and `ctx upgrade --dry-run --format json`, which
//      moved the state from `quiescing` to `dry_run` on 2026-11-11 (observed; ctx does not
//      document it as a release);
//   8. `ctx index mode auto` under probe.mjs HEAL_TIMEOUT_MS with a SIGTERM grace;
//   9. verify: poll `ctx daemon status` until the daemon reads running, supervisor installed,
//      and no restart required (VERIFY_TRIES × VERIFY_GAP_MS);
//  10. restore the timer (`launchctl bootstrap`) when step 6 paused it, whatever happened in 7-9.
//
// Every ctx spawn has CI removed (probe.mjs ctxEnv), LANG as resolved in step 2, and keeps
// everything else. Output: the first line is one JSON object `{ ok, changed, refused, reason,
// lang: { value, source }, steps, timer, verified }` (source `env`, `ctx-recorded`,
// `AppleLocale`, or null); the last line is `ctx-watch repair: <repaired | healthy; nothing
// changed | refused: … | failed: …>`. Exit 0 repaired or healthy, 1 failed, 3 refused (nothing
// changed).

import { existsSync } from "node:fs";
import { CTX, HANDOFF_STALE_MS, HEAL_GRACE_MS, HEAL_TIMEOUT_MS, MODE_ARGV, PROBE_TIMEOUT_MS, STATUS_ARGV, age, ctxEnv, handoffPath, parseJson, readHandoff, runCtx, upgradeGate } from "./probe.mjs";
import { LABEL, loaded, plistPath, resolveLang, runCheck } from "./launchd.mjs";

export const VERIFY_TRIES = 10;
export const VERIFY_GAP_MS = 3_000;
const DISABLE_ARGV = Object.freeze([CTX, "upgrade", "disable"]);
const RELEASE_ARGV = Object.freeze([CTX, "upgrade", "--dry-run", "--format", "json"]);
const HEAL_ARGV = Object.freeze([CTX, "index", "mode", "auto", "--format", "json"]);

const withCtx = (argv, ctx) => [ctx, ...argv.slice(1)];
const field = (o, k) => (o && typeof o === "object" && !Array.isArray(o) ? o[k] : undefined);
const firstLine = (r) => (r.error ? r.error : (r.stderr || r.stdout || "").trim().split("\n")[0]?.slice(0, 160) || "(no output)");

/** A blocking sleep (the CLI is synchronous between its spawns). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The daemon fields the verification reads, from one `ctx daemon status --format json`. */
function daemonFields(r) {
  const d = field(parseJson(r.stdout), "daemon");
  return {
    running: field(d, "running") ?? null,
    status: field(d, "status") ?? null,
    supervisor: field(field(d, "supervisor"), "status") ?? null,
    restartRequired: field(field(field(d, "supervisor"), "environment_snapshot"), "restart_required") ?? null,
  };
}
const up = (f) => f.running === true && f.status === "running" && f.supervisor === "installed" && f.restartRequired !== true;

/**
 * Run the repair. `{ code, text }`. Deps: `run` (runCtx shape), `check` (launchd.mjs runCheck
 * shape, for launchctl), `uid`, `exists` (ctx's config path), `sleep(ms)`, `ctx`, `stateDir`
 * (where the timer's plist lives), `now`.
 */
export function repair({ env: shellEnv = process.env, run = runCtx, check = runCheck, uid = process.getuid?.() ?? 501, exists = existsSync, sleep = sleepSync, ctx = CTX, stateDir, now = Date.now } = {}) {
  const lang = resolveLang({ env: shellEnv, check });
  const env = lang.value ? { ...shellEnv, LANG: lang.value } : shellEnv;
  const e = ctxEnv(env);
  const steps = [];
  const timer = { wasLoaded: false, paused: false, restored: null };
  const report = { ok: false, changed: false, refused: false, reason: null, lang: { value: lang.value, source: lang.source }, steps, timer, verified: null };
  const out = (code, last) => ({ code, text: `${JSON.stringify(report)}\n${last}` });
  const refuse = (reason) => {
    Object.assign(report, { refused: true, reason });
    return out(3, `ctx-watch repair: refused: ${reason}`);
  };
  const ctxRun = (argv, timeoutMs = PROBE_TIMEOUT_MS, opts) => run(withCtx(argv, ctx), e, timeoutMs, opts);
  const cmd = (argv) => `\`${["ctx", ...argv.slice(1)].join(" ")}\``;

  // 1. Healthy: nothing to do.
  const first = ctxRun(STATUS_ARGV);
  const before = first.error ? null : daemonFields(first);
  if (before && up(before)) {
    Object.assign(report, { ok: true, verified: before });
    return out(0, "ctx-watch repair: the ctx daemon is healthy; nothing changed");
  }
  // 2. LANG.
  if (lang.value === null) return refuse(`LANG could not be found: ${lang.detail}; ctx would record a daemon launch environment without it and report \`environment_invalid\`; run from a shell with LANG set (a Terminal login shell has it)`);
  // 3. The GUI launchd domain.
  const domain = check("launchctl", ["print", `gui/${uid}`]);
  if (!domain.missing && domain.code !== 0) return refuse(`launchd domain gui/${uid} is not reachable from this shell (launchctl print exit ${domain.code ?? "none"}: ${(domain.output ?? "").trim().split("\n").at(-1)}); run from a GUI login session`);
  // 4. Indexing mode.
  const mode = ctxRun(MODE_ARGV);
  if (mode.error) return refuse(`ctx could not run: ${mode.error}`);
  const mj = parseJson(mode.stdout);
  const current = field(field(mj, "indexing"), "mode");
  const configPath = field(mj, "config_path");
  if (current !== "auto") return refuse(`ctx indexing mode is ${JSON.stringify(current ?? null)}, not auto; ctx-watch does not change it (\`ctx index mode auto\` is yours to run if you mean it)`);
  if (typeof configPath !== "string" || !exists(configPath)) return refuse(`${configPath ?? "ctx's config file"} does not exist: ctx is not set up here (\`ctx docs show getting-started\`)`);
  // 5. The upgrade gate.
  const gate = upgradeGate({ run, env, ctx, now });
  const h = gate.handoff ?? readHandoff(handoffPath(env), { now: now() });
  if (gate.verdict === "upgrading") return refuse(`${gate.reason.replace(/; not healing$/, "")}; not repairing during a live upgrade`);
  if (h.pid !== null && h.alive) return refuse(`upgrade handoff owner pid ${h.pid} is alive (phase ${JSON.stringify(h.phase)}): an upgrade may be in progress; not repairing`);
  if (h.pid !== null && h.ageMs !== null && h.ageMs < HANDOFF_STALE_MS) return refuse(`the upgrade handoff marker is ${age(h.ageMs)} old, under ctx's 15 min stale bound (owner pid ${h.pid} dead); wait ${age(HANDOFF_STALE_MS - h.ageMs)} and run repair again`);
  const status = gate.upgrade?.status ?? null;
  if (gate.verdict === "stuck" && status !== "quiescing") return refuse(`ctx upgrade is stuck in ${JSON.stringify(status)}, not "quiescing": the observed release covers quiescing only; see \`ctx upgrade status --format json\` and \`ctx docs show upgrade\``);
  const release = gate.verdict === "stuck";

  // 6. Pause the timer.
  const l = loaded({ uid, label: LABEL, check });
  timer.wasLoaded = l.loaded === true;
  if (timer.wasLoaded) {
    const b = check("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
    if (b.code !== 0) return refuse(`could not pause the ctx-watch timer (launchctl bootout exit ${b.code ?? "none"}: ${(b.output ?? "").trim()})`);
    timer.paused = true;
  }
  const restore = () => {
    if (!timer.paused) return;
    const r = check("launchctl", ["bootstrap", `gui/${uid}`, plistPath(env, LABEL, stateDir)]);
    timer.restored = r.code === 0;
    if (!timer.restored) steps.push({ name: "restore-timer", status: "failed", detail: `launchctl bootstrap exit ${r.code ?? "none"}: ${(r.output ?? "").trim()}` });
  };
  const fail = (reason) => {
    restore();
    Object.assign(report, { ok: false, reason });
    return out(1, `ctx-watch repair: failed: ${reason}${timer.paused ? (timer.restored ? " (timer restored)" : " (timer NOT restored: run install's bootstrap line)") : ""}`);
  };
  const ranStep = (name, argv, timeoutMs, opts) => {
    report.changed = true;
    const r = ctxRun(argv, timeoutMs, opts);
    const ok = !r.error && r.code === 0;
    steps.push({ name, status: ok ? "ran" : "failed", detail: `${cmd(argv)} (exit ${r.code ?? "none"}): ${firstLine(r)}` });
    return ok ? null : `${cmd(argv)} (exit ${r.code ?? "none"}): ${firstLine(r)}`;
  };

  // 7. Release a stuck quiescing upgrade.
  if (release && gate.upgrade.autoEnabled !== false) {
    const err = ranStep("disable-upgrades", DISABLE_ARGV);
    if (err) return fail(err);
  } else steps.push({ name: "disable-upgrades", status: "skipped", detail: release ? "automatic upgrades are already off" : "no stuck upgrade: automatic upgrades left as they are" });
  if (release) {
    const err = ranStep("release-upgrade", RELEASE_ARGV);
    if (err) return fail(err);
  } else steps.push({ name: "release-upgrade", status: "skipped", detail: `ctx upgrade state ${JSON.stringify(status)} is not quiescing; nothing to release` });
  // 8. Heal.
  const healErr = ranStep("heal", HEAL_ARGV, HEAL_TIMEOUT_MS, { graceMs: HEAL_GRACE_MS });
  if (healErr) return fail(healErr);
  // 9. Verify.
  let last = null;
  for (let i = 0; i < VERIFY_TRIES; i++) {
    if (i > 0) sleep(VERIFY_GAP_MS);
    const r = ctxRun(STATUS_ARGV);
    last = r.error ? { running: null, status: null, supervisor: null, restartRequired: null, error: r.error } : daemonFields(r);
    if (up(last)) break;
  }
  report.verified = last;
  steps.push({ name: "verify", status: up(last) ? "ran" : "failed", detail: JSON.stringify(last) });
  if (!up(last)) return fail(`verification failed: after ${VERIFY_TRIES} checks the daemon reads ${JSON.stringify(last)}`);
  // 10. Restore.
  restore();
  report.ok = true;
  return out(0, `ctx-watch repair: repaired; the ctx daemon is running, supervisor installed${release ? `; the stuck upgrade was released${gate.upgrade.autoEnabled !== false ? " and automatic upgrades are now off (`ctx upgrade enable` to turn them back on)" : ""}` : ""}${timer.paused ? (timer.restored ? "; ctx-watch timer restored" : "; ctx-watch timer NOT restored: run install's bootstrap line") : ""}`);
}
