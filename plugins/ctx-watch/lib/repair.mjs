// lib/repair.mjs — `ctx-watch repair`: the repair an agent (or a person) runs when ctx is down,
// with no prompts. It is the 2026-11-11 hand-run sequence that brought the daemon back after six
// days, with that run's typed confirmations turned into gates that refuse instead of asking.
//
// Order, stopping at the first refusal or failure:
//   1. probe `ctx daemon status`: healthy → exit 0, nothing changed;
//   2. LANG: this shell's, else the LANG ctx recorded in supervisor-environment.json, else one
//      derived from AppleLocale (launchd.mjs resolveLang, which checks each fallback against
//      `locale -a` and reports what it skipped), passed to every ctx spawn; refuse only when
//      none gives one (ctx would record a daemon launch environment without LANG and report
//      `environment_invalid`, the 2026-11-11 state). A shell launchd started (Claude Desktop's
//      Bash tool) has no LANG of its own, so the fallback is the usual path from Desktop;
//   3. refuse when launchctl is not found or this shell cannot write to the GUI launchd domain
//      gui/<uid> (launchd.mjs reachProbe: bootstrap and bootout a throwaway LaunchAgent that
//      runs nothing, labelled per run, its plist removed on every path, a killed run's leftovers
//      cleared first), since the ctx-watch timer could not be paused and restored. A signal
//      during the probe ends the run once the probe's own cleanup has run (exit 128 + n,
//      nothing changed; an unload is claimed only when launchctl confirmed it, else launchctl's
//      error and the label that may still be loaded). Until 0.4.0 this was `launchctl print gui/<uid>`, which a sandboxed
//      shell passes while its `launchctl bootstrap` fails ("Bootstrap failed: 5: Input/output
//      error", 2026-11-11): repair would have booted the timer out and failed to restore it;
//   4. refuse when ctx's indexing mode is not `auto` or its config file is missing (ctx-watch
//      never flips a deliberate `manual` and never sets ctx up);
//   5. the upgrade gate (probe.mjs upgradeGate and readHandoff): refuse while an upgrade is in
//      progress, while the upgrade state is unknown (`ctx upgrade status` failed or named a
//      state ctx-watch does not know), while a handoff owner process is alive, or while the
//      handoff marker is younger than ctx's DAEMON_UPGRADE_HANDOFF_STALE_AFTER (15 min) even
//      with its owner dead; refuse a stuck state other than `quiescing` (the release below was
//      only observed on quiescing);
//   6. refuse when launchctl cannot say whether the ctx-watch timer is loaded (anything but
//      loaded, or launchctl's 113 "no such service"); else pause it when loaded (`launchctl
//      bootout`), so a tick cannot heal into the middle of the repair;
//   7. on a stuck `quiescing` upgrade: `ctx upgrade disable` (when automatic upgrades are on,
//      so the failing upgrade does not retry; never turned back on here) and `ctx upgrade
//      --dry-run --format json`, which moved the state from `quiescing` to `dry_run` on
//      2026-11-11 (observed; ctx does not document it as a release);
//   8. `ctx index mode auto` under probe.mjs HEAL_TIMEOUT_MS with a SIGTERM grace;
//   9. verify: poll `ctx daemon status` until the daemon reads running, supervisor installed,
//      and no restart required (VERIFY_TRIES × VERIFY_GAP_MS);
//  10. restore the timer (`launchctl bootstrap`) when step 6 paused it, in a `finally`: after a
//      failure, a throw, or SIGINT/SIGTERM/SIGHUP. A restore that fails makes the run a failure.
//
// The gate of step 5 is read again before each state-changing ctx command in 7 and 8 (the
// preflight is a snapshot, and pausing the timer is no check that no upgrade has started): a
// live or unknown upgrade, a live owner, a young marker, or, before 7, a state or attempt other
// than the stuck `quiescing` attempt the preflight saw, stops the run there. The reads are not
// atomic with the command that follows them; the window is the time between one ctx spawn and
// the next. A signal arriving while a ctx command runs takes effect when that command returns
// (each is bounded: 10 s, the heal 120 s + 15 s); SIGKILL cannot be handled at all.
//
// Every ctx spawn has CI removed (probe.mjs ctxEnv), LANG as resolved in step 2, and keeps
// everything else. Output: the first line is one JSON object `{ ok, changed, refused, reason,
// lang: { value, source, skipped }, steps, timer, verified }` (source `env`, `ctx-recorded`,
// `AppleLocale`, or null; timer `{ wasLoaded, paused, restored }`, wasLoaded null = not checked:
// the healthy return and refusals before step 6 never ask launchctl about the timer, 0.4.0; until
// then it read false there even with the timer loaded); the last line is `ctx-watch repair:
// <repaired | healthy; nothing
// changed | refused: … | failed: … | interrupted by SIG…>`. Exit 0 repaired or healthy, 1 failed,
// 3 refused (no ctx change; the timer, if paused, restored), 128 + n on signal n.

import { existsSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { CTX, HANDOFF_STALE_MS, HEAL_GRACE_MS, HEAL_TIMEOUT_MS, MODE_ARGV, PROBE_TIMEOUT_MS, STATUS_ARGV, age, ctxEnv, parseJson, runCtx, upgradeGate } from "./probe.mjs";
import { LABEL, loaded, plistPath, reachProbe, resolveLang, runCheck } from "./launchd.mjs";

export const VERIFY_TRIES = 10;
export const VERIFY_GAP_MS = 3_000;
/** The signals the protected section turns into "restore the timer, then exit 128 + n". */
export const HANDLED_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
const DISABLE_ARGV = Object.freeze([CTX, "upgrade", "disable"]);
const RELEASE_ARGV = Object.freeze([CTX, "upgrade", "--dry-run", "--format", "json"]);
const HEAL_ARGV = Object.freeze([CTX, "index", "mode", "auto", "--format", "json"]);

const withCtx = (argv, ctx) => [ctx, ...argv.slice(1)];
const field = (o, k) => (o && typeof o === "object" && !Array.isArray(o) ? o[k] : undefined);
const firstLine = (r) => (r.error ? r.error : (r.stderr || r.stdout || "").trim().split("\n")[0]?.slice(0, 160) || "(no output)");
const sleepAsync = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** One trip round the event loop, so a signal that arrived during a synchronous spawn is delivered. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

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

/** Why the gate forbids changing anything now, or null. */
function blocker(gate) {
  const h = gate.handoff ?? { pid: null };
  if (gate.verdict === "upgrading") return `${gate.reason.replace(/; not healing$/, "")}; not repairing during a live upgrade`;
  if (gate.verdict === "unknown") return `${gate.reason.replace(/; not healing$/, "")}; not repairing while it cannot be read`;
  if (h.pid !== null && h.alive) return `upgrade handoff owner pid ${h.pid} is alive (phase ${JSON.stringify(h.phase)}): an upgrade may be in progress; not repairing`;
  if (h.pid !== null && h.ageMs !== null && h.ageMs < HANDOFF_STALE_MS) return `the upgrade handoff marker is ${age(h.ageMs)} old, under ctx's 15 min stale bound (owner pid ${h.pid} dead); wait ${age(HANDOFF_STALE_MS - h.ageMs)} and run repair again`;
  const status = gate.upgrade?.status ?? null;
  if (gate.verdict === "stuck" && status !== "quiescing") return `ctx upgrade is stuck in ${JSON.stringify(status)}, not "quiescing": the observed release covers quiescing only; see \`ctx upgrade status --format json\` and \`ctx docs show upgrade\``;
  return null;
}

/** A stop inside the protected section: `interrupted` names the signal when it was one. */
class Stop extends Error {
  constructor(reason, interrupted = null) {
    super(reason);
    this.interrupted = interrupted;
  }
}

/**
 * Run the repair. Resolves to `{ code, text }`. Deps: `run` (runCtx shape), `check`
 * (launchd.mjs runCheck shape, for launchctl, `defaults` and `locale`), `uid`, `exists` (ctx's
 * config path), `sleep(ms)` (may return a promise), `ctx`, `stateDir` (where the timer's plist
 * lives), `now`, `signals` (false: do not install SIGINT/SIGTERM/SIGHUP handlers).
 */
export async function repair({ env: shellEnv = process.env, run = runCtx, check = runCheck, uid = process.getuid?.() ?? 501, exists = existsSync, sleep = sleepAsync, ctx = CTX, stateDir, now = Date.now, signals = true } = {}) {
  const lang = resolveLang({ env: shellEnv, check });
  const env = lang.value ? { ...shellEnv, LANG: lang.value } : shellEnv;
  const e = ctxEnv(env);
  const steps = [];
  // wasLoaded: null = not checked (the healthy return and every refusal before step 6 never ask
  // launchctl about the timer), true/false = what `launchctl print` said before pausing it.
  const timer = { wasLoaded: null, paused: false, restored: null };
  const report = { ok: false, changed: false, refused: false, reason: null, lang: { value: lang.value, source: lang.source, skipped: lang.skipped }, steps, timer, verified: null };
  const out = (code, last) => ({ code, text: `${JSON.stringify(report)}\n${last}` });
  const refuse = (reason) => {
    Object.assign(report, { refused: true, reason });
    return out(3, `ctx-watch repair: refused: ${reason}`);
  };
  const ctxRun = (argv, timeoutMs = PROBE_TIMEOUT_MS, opts) => run(withCtx(argv, ctx), e, timeoutMs, opts);
  const cmd = (argv) => `\`${["ctx", ...argv.slice(1)].join(" ")}\``;
  const gate = () => upgradeGate({ run, env, ctx, now });

  // 1. Healthy: nothing to do.
  const first = ctxRun(STATUS_ARGV);
  const before = first.error ? null : daemonFields(first);
  if (before && up(before)) {
    Object.assign(report, { ok: true, verified: before });
    return out(0, "ctx-watch repair: the ctx daemon is healthy; nothing changed");
  }
  // 2. LANG.
  if (lang.value === null) return refuse(`LANG could not be found: ${lang.detail}; ctx would record a daemon launch environment without it and report \`environment_invalid\`; run from a shell with LANG set (a Terminal login shell has it)`);
  // 3. launchctl, and write access to the GUI launchd domain, before anything is paused. A
  // signal during the probe is held until the probe has run its own cleanup (it runs
  // synchronously), then ends the run: nothing changed, exit 128 + n, and the reason says what
  // the cleanup did: unloaded only when launchctl confirmed it, else launchctl's error and the
  // label that may still be loaded.
  let probeSignal = null;
  const onProbeSignal = (sig) => {
    probeSignal ??= sig;
  };
  if (signals) for (const s of HANDLED_SIGNALS) process.on(s, onProbeSignal);
  let reach;
  try {
    reach = reachProbe({ uid, check, tmp: shellEnv.TMPDIR || tmpdir() });
    await turn();
  } finally {
    if (signals) for (const s of HANDLED_SIGNALS) process.removeListener(s, onProbeSignal);
  }
  if (probeSignal) {
    const plist = reach.plistRemoved ? "" : "; its temp plist directory could not be removed";
    const probe = reach.ok
      ? `the probe ${reach.label} was unloaded${reach.plistRemoved ? " and its plist removed" : ""}${plist}`
      : reach.missing
        ? `launchctl not found; nothing was loaded`
        : reach.loaded === null
          ? `the probe failed and ${reach.label} may still be loaded (it runs nothing; the next repair boots it out once this process has exited): ${reach.detail}${plist}`
          : `the probe failed: ${reach.detail}; ${reach.label} was not loaded, or no longer is${plist}`;
    report.reason = `interrupted by ${probeSignal} during the launchd reach probe (${probe}); the ctx-watch timer was not touched; nothing changed`;
    return out(128 + (constants.signals[probeSignal] ?? 0), `ctx-watch repair: ${report.reason}`);
  }
  if (reach.missing) return refuse("launchctl not found: the ctx-watch timer could not be paused and restored; run from a macOS GUI login session");
  if (!reach.ok) return refuse(`this shell cannot load LaunchAgents into launchd domain gui/${uid} (${reach.detail}): the ctx-watch timer could not be paused and restored; run from a GUI login session (a Terminal window), not a sandboxed or ssh shell`);
  // 4. Indexing mode.
  const mode = ctxRun(MODE_ARGV);
  if (mode.error) return refuse(`ctx could not run: ${mode.error}`);
  const mj = parseJson(mode.stdout);
  const current = field(field(mj, "indexing"), "mode");
  const configPath = field(mj, "config_path");
  if (current !== "auto") return refuse(`ctx indexing mode is ${JSON.stringify(current ?? null)}, not auto; ctx-watch does not change it (\`ctx index mode auto\` is yours to run if you mean it)`);
  if (typeof configPath !== "string" || !exists(configPath)) return refuse(`${configPath ?? "ctx's config file"} does not exist: ctx is not set up here (\`ctx docs show getting-started\`)`);
  // 5. The upgrade gate.
  const pre = gate();
  const preBlock = blocker(pre);
  if (preBlock) return refuse(preBlock);
  const release = pre.verdict === "stuck";
  const attempt = { id: pre.upgrade?.attemptId ?? null, sinceMs: pre.upgrade?.sinceMs ?? null };
  const autoWasOn = pre.upgrade?.autoEnabled !== false;

  // 6. The timer: known loaded or known absent, else refuse; pause it when loaded.
  const l = loaded({ uid, label: LABEL, check });
  if (l.loaded === null) return refuse(`launchctl could not say whether the ctx-watch timer is loaded (${l.detail}); not repairing without pausing it`);
  timer.wasLoaded = l.loaded === true;
  if (timer.wasLoaded) {
    const b = check("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
    if (b.code !== 0) return refuse(`could not pause the ctx-watch timer (launchctl bootout exit ${b.code ?? "none"}: ${(b.output ?? "").trim()})`);
    timer.paused = true;
  }

  // 7-9, protected: whatever happens, the timer is restored once, in `finally`.
  let interrupted = null;
  const onSignal = (sig) => {
    interrupted ??= sig;
  };
  if (signals) for (const s of HANDLED_SIGNALS) process.on(s, onSignal);
  const checkpoint = async () => {
    await turn();
    if (interrupted) throw new Stop(`interrupted by ${interrupted}`, interrupted);
  };
  const ranStep = async (name, argv, timeoutMs, opts) => {
    report.changed = true;
    const r = ctxRun(argv, timeoutMs, opts);
    const ok = !r.error && r.code === 0;
    steps.push({ name, status: ok ? "ran" : "failed", detail: `${cmd(argv)} (exit ${r.code ?? "none"}): ${firstLine(r)}` });
    await checkpoint();
    if (!ok) throw new Stop(`${cmd(argv)} (exit ${r.code ?? "none"}): ${firstLine(r)}`);
  };
  /** Read the gate again just before `what`; throw when it no longer allows it. */
  const recheck = async (what, { stuckAttempt }) => {
    const g = gate();
    await checkpoint();
    const block = blocker(g);
    if (block) throw new Stop(`before ${what}: ${block}`);
    if (stuckAttempt) {
      if (g.verdict !== "stuck" || g.upgrade.status !== "quiescing") throw new Stop(`before ${what}: the upgrade state changed since the preflight (now ${JSON.stringify(g.upgrade.status)}, ${g.verdict}); not releasing`);
      if (attempt.id !== null ? g.upgrade.attemptId !== attempt.id : g.upgrade.sinceMs !== attempt.sinceMs) throw new Stop(`before ${what}: ctx reports a different upgrade attempt (${g.upgrade.attemptId ?? "no id"}) than the one checked (${attempt.id ?? "no id"}); not releasing`);
    } else if (g.verdict !== "none") throw new Stop(`before ${what}: ${g.reason}; not healing`);
  };
  let failure = null;
  try {
    await checkpoint();
    if (release && autoWasOn) {
      await recheck(cmd(DISABLE_ARGV), { stuckAttempt: true });
      await ranStep("disable-upgrades", DISABLE_ARGV);
    } else steps.push({ name: "disable-upgrades", status: "skipped", detail: release ? "automatic upgrades are already off" : "no stuck upgrade: automatic upgrades left as they are" });
    if (release) {
      await recheck(cmd(RELEASE_ARGV), { stuckAttempt: true });
      await ranStep("release-upgrade", RELEASE_ARGV);
    } else steps.push({ name: "release-upgrade", status: "skipped", detail: `ctx upgrade state ${JSON.stringify(pre.upgrade?.status ?? null)} is not quiescing; nothing to release` });
    await recheck(cmd(HEAL_ARGV), { stuckAttempt: false });
    await ranStep("heal", HEAL_ARGV, HEAL_TIMEOUT_MS, { graceMs: HEAL_GRACE_MS });
    let last = null;
    for (let i = 0; i < VERIFY_TRIES; i++) {
      if (i > 0) {
        await sleep(VERIFY_GAP_MS);
        await checkpoint();
      }
      const r = ctxRun(STATUS_ARGV);
      last = r.error ? { running: null, status: null, supervisor: null, restartRequired: null, error: r.error } : daemonFields(r);
      await checkpoint();
      if (up(last)) break;
    }
    report.verified = last;
    steps.push({ name: "verify", status: up(last) ? "ran" : "failed", detail: JSON.stringify(last) });
    if (!up(last)) throw new Stop(`verification failed: after ${VERIFY_TRIES} checks the daemon reads ${JSON.stringify(last)}`);
  } catch (err) {
    failure = err instanceof Stop ? err : new Stop(`${err?.message ?? err}`);
  } finally {
    if (timer.paused) {
      let r;
      try {
        r = check("launchctl", ["bootstrap", `gui/${uid}`, plistPath(env, LABEL, stateDir)]);
      } catch (err) {
        r = { code: null, output: `${err?.message ?? err}` };
      }
      timer.restored = r.code === 0;
      if (!timer.restored) steps.push({ name: "restore-timer", status: "failed", detail: `launchctl bootstrap exit ${r.code ?? "none"}: ${(r.output ?? "").trim()}` });
    }
    if (signals) for (const s of HANDLED_SIGNALS) process.removeListener(s, onSignal);
  }

  const timerNote = timer.paused ? (timer.restored ? "; ctx-watch timer restored" : "; ctx-watch timer NOT restored: run install's bootstrap line") : "";
  const notRestored = timer.paused && !timer.restored ? `the ctx-watch timer was NOT restored (${steps.at(-1).detail})` : null;
  if (failure?.interrupted) {
    Object.assign(report, { ok: false, reason: notRestored ? `${failure.message}; ${notRestored}` : failure.message });
    return out(128 + (constants.signals[failure.interrupted] ?? 0), `ctx-watch repair: ${failure.message}${timerNote}`);
  }
  if (failure) {
    const reason = notRestored ? `${failure.message}; ${notRestored}` : failure.message;
    if (!report.changed && !notRestored) {
      Object.assign(report, { refused: true, reason });
      return out(3, `ctx-watch repair: refused: ${reason}${timerNote}`);
    }
    Object.assign(report, { ok: false, reason });
    return out(1, `ctx-watch repair: failed: ${reason}${timerNote}`);
  }
  if (notRestored) {
    Object.assign(report, { ok: false, reason: `the ctx daemon is repaired, but ${notRestored}` });
    return out(1, `ctx-watch repair: failed: the ctx daemon is repaired, but ${notRestored}`);
  }
  report.ok = true;
  return out(0, `ctx-watch repair: repaired; the ctx daemon is running, supervisor installed${release ? `; the stuck upgrade was released${autoWasOn ? " and automatic upgrades are now off (`ctx upgrade enable` to turn them back on)" : ""}` : ""}${timerNote}`);
}
