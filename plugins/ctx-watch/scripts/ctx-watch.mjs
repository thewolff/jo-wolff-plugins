#!/usr/bin/env node
// scripts/ctx-watch.mjs — the ctx-watch CLI.
//
//   check [--json]           one probe (heal and re-probe on failure); prints the needs-you line
//                            or nothing; --json prints the whole result. Exit 0 always.
//   tick                     the launchd timer's run: rotate the logs over their bound, probe,
//                            then, holding <state>/state.lock: settle a popup an earlier tick left
//                            pending (from its token's <state>/popups/<token>.json), advance the
//                            episode state in <state>/state.json, and on the second failing tick
//                            in a row record the popup's claim (pending under a fresh token).
//                            Only once that claim is on disk does the dialog start; its result is
//                            then applied, under the lock again, to the state as it is by then.
//                            Once per episode, once its delivery is confirmed; a popup that could
//                            not be shown, or that failed after the grace, is tried again next
//                            failing tick; re-armed by a passing tick. A claim that cannot be
//                            recorded (no lock, a failed write) starts no popup. One summary line.
//   install [--interval 300] write <state>/launchd/com.jo-wolff-plugins.ctx-watch.plist, lint it,
//                            print the `launchctl bootstrap` line. Never bootstraps. The plist
//                            pins this script, the state directory and the ctx executable.
//   uninstall                print the `launchctl bootout` line. Removes nothing.
//   status                   the last probe, the episode, and whether launchd has the job.
//   prune [--days 30]        rotate the logs, remove rotated logs older than --days and stray
//                            state temp files; `pruned: <n> file(s), <bytes> bytes freed` last.
//   help
//
// Every verb takes `--state-dir <dir>` (default ${XDG_STATE_HOME:-~/.local/state}/ctx-watch)
// and `--ctx <executable>` (default `ctx` on PATH); the plist `install` writes passes both, so
// the timer and the SessionStart hook share one state file and one ctx whatever launchd's
// environment holds. Every ctx spawn has CI removed from its environment. `main(argv, deps)`
// resolves { code, text } and is what the tests drive; the probes, the popup, plutil and
// launchctl are injected through `deps`.

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { check as runCheckOnce, needsYouLine, CTX } from "../lib/probe.mjs";
import { readState, writeState, statePath, stateDir as defaultStateDir, step, popupDelivered, popupSettled, timerOverdue, withStateLock, LOCK_WAIT_MS } from "../lib/state.mjs";
import { install, uninstall, loaded, plistPath } from "../lib/launchd.mjs";
import { showPopup, readOutcome, outcomePath } from "../lib/popup.mjs";
import { rotateLogs, prune, DEFAULT_RETENTION_DAYS } from "../lib/retention.mjs";

export const CLI_PATH = fileURLToPath(import.meta.url);

export const HELP = `ctx-watch: notice when the ctx daemon is dead, unsupervised, or stale, or its semantic index is not ready.

  check [--json]            probe once (heal with \`ctx index mode auto\`, then re-probe, on a daemon failure); print the needs-you line or nothing
  tick                      the launchd timer's run: probe, keep the episode state, popup on the second failing tick
  install [--interval 300]  write the launchd plist and print the bootstrap line (never bootstraps)
  uninstall                 print the bootout line
  status                    last probe, episode, whether launchd has the job
  prune [--days 30]         rotate the logs; remove rotated logs older than --days
  help

  every verb: --state-dir <dir> (default \${XDG_STATE_HOME:-~/.local/state}/ctx-watch), --ctx <executable> (default ctx on PATH)`;

const iso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : "never");

/** Parse `--key value` and `--flag` pairs after the verb. */
export function parseArgs(argv) {
  const [verb = "help", ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${JSON.stringify(a)}`);
    const k = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      opts[k] = next;
      i++;
    } else opts[k] = true;
  }
  return { verb, opts };
}

export async function main(argv, deps = {}) {
  const { env = process.env, now = Date.now, run, exists, popup = showPopup, check: checkBin, node, uid, cwd = process.cwd(), cliPath = CLI_PATH, timeoutMs, ctxExists, lockWaitMs = LOCK_WAIT_MS } = deps;
  let verb;
  let opts;
  try {
    ({ verb, opts } = parseArgs(argv));
  } catch (err) {
    return { code: 2, text: `ctx-watch: ${err.message}\n${HELP}` };
  }
  // An option that takes a value but got none parses as `true`, and Number(true) is 1: refuse it
  // here, before `--days` becomes a one-day prune or `--interval` a one-second timer.
  const valueless = ["state-dir", "ctx", "days", "interval"].find((k) => opts[k] === true);
  if (valueless) return { code: 2, text: `ctx-watch: --${valueless} needs a value\n${HELP}` };
  const dir = opts["state-dir"] ? resolve(cwd, opts["state-dir"]) : defaultStateDir(env);
  const ctx = opts.ctx ? resolve(cwd, opts.ctx) : CTX;
  const file = statePath(env, dir);
  const probeDeps = { env, now, run, exists, timeoutMs, ctx };
  switch (verb) {
    case "check": {
      const result = runCheckOnce(probeDeps);
      if (opts.json) return { code: 0, text: JSON.stringify(result, null, 2) };
      return { code: 0, text: needsYouLine(result) ?? "" };
    }
    case "tick": {
      const lines = [];
      const rot = rotateLogs(dir);
      for (const p of rot.rotated) lines.push(`rotated ${p} to ${p}.1`);
      lines.push(...rot.problems);
      const result = runCheckOnce(probeDeps);
      const at = now();
      const token = `${at}-${process.pid}`;
      const probeLine = `${iso(at)} ${result.ok ? "pass" : "fail"}: ${result.ok ? result.summary : result.reason}${result.healed ? ` | heal: ${result.healed.detail}` : ""}`;
      const notWritten = (err) => `state not written to ${file}: ${err?.message}`;
      // Settle, step and claim in one locked read-modify-write: a second tick sees the claim.
      const claim = withStateLock(
        dir,
        () => {
          const prev = readState(file);
          const settled = popupSettled(prev, prev.popupPending ? readOutcome(outcomePath(dir, prev.popupPending.token)) : null, at);
          const { state, popup: wantPopup } = step(settled.state, result, at);
          const next = wantPopup ? { ...state, popupPending: { token, since: at } } : state;
          const written = writeState(file, next);
          return { settled, state: next, wantPopup, written, error: written ? null : writeState.lastError };
        },
        { waitMs: lockWaitMs },
      );
      if (!claim.ok) {
        lines.push(`${probeLine} | episode not updated`, notWritten(claim.error));
        return { code: 0, text: lines.join("\n") };
      }
      const { settled, state, wantPopup, written, error } = claim.value;
      if (settled.line) lines.push(settled.line);
      lines.push(`${probeLine} | episode ${state.episode}, strikes ${state.strikes}`);
      if (!written) {
        lines.push(`${notWritten(error)}${wantPopup ? "; popup not started: its claim could not be recorded" : ""}`);
        return { code: 0, text: lines.join("\n") };
      }
      if (wantPopup) {
        const outcome = await popup({ text: `${needsYouLine(result)}\n\nctx has failed ${state.strikes} checks in a row (since ${iso(state.downSince)}). Open a Terminal and run the fix; ctx-watch checks again in ${state.intervalS ?? 300} s.`, outcomeFile: outcomePath(dir, token), token });
        lines.push(outcome.started ? outcome.detail : `${outcome.detail}; will try again on the next failing tick`);
        // Apply the result to the state as it is now (another tick may have written since), and only while the claim is still this popup's.
        const done = withStateLock(
          dir,
          () => {
            const cur = readState(file);
            if (cur.popupPending?.token !== token) return { ok: true, skipped: true };
            return { ok: writeState(file, popupDelivered(cur, outcome, at)), error: writeState.lastError };
          },
          { waitMs: lockWaitMs },
        );
        const r = done.ok ? done.value : { ok: false, error: done.error };
        if (!r.ok) lines.push(`${notWritten(r.error)}; the popup stays pending until its outcome file or the stale bound settles it`);
      }
      return { code: 0, text: lines.join("\n") };
    }
    case "install": {
      const interval = opts.interval === undefined ? 300 : Number(opts.interval);
      const r = install({ env, interval, cliPath, node, uid, check: checkBin, cwd, stateDir: dir, ctx: opts.ctx, exists: ctxExists });
      if (r.code === 0) {
        const rec = withStateLock(dir, () => writeState(file, { ...readState(file), intervalS: interval }) || writeState.lastError, { waitMs: lockWaitMs });
        const err = !rec.ok ? rec.error : rec.value === true ? null : rec.value;
        if (err) r.text += `\nstate not written to ${file}: ${err.message} (the SessionStart hook will assume 300 s)`;
      }
      return r;
    }
    case "uninstall":
      return uninstall({ env, uid, stateDir: dir });
    case "status": {
      const read = readState(file);
      const state = popupSettled(read, read.popupPending ? readOutcome(outcomePath(dir, read.popupPending.token)) : null, now()).state;
      const t = timerOverdue(state, now());
      const popupLine = state.popupShown
        ? `, popup shown ${iso(state.lastPopupAt)}`
        : state.popupPending
          ? `, popup up since ${iso(state.popupPending.since)}, not confirmed yet`
          : state.popupFailedAt
            ? `, popup not shown ${iso(state.popupFailedAt)}: ${state.popupFailReason}`
            : "";
      const lines = [
        `state file: ${file}`,
        `ctx: ${ctx}`,
        `last tick: ${iso(state.lastTickAt)}${t.overdue ? ` (overdue: more than ${2 * t.intervalS} s ago)` : ""}`,
        `last probe: ${state.lastProbe ? `${state.lastProbe.ok ? "pass" : `fail: ${state.lastProbe.reason}`} at ${iso(state.lastProbe.at)}${state.lastProbe.healed ? ` | heal: ${state.lastProbe.healed}` : ""}` : "never"}`,
        `episode: ${state.episode} (strikes ${state.strikes}${state.downSince ? `, down since ${iso(state.downSince)}` : ""}${popupLine})`,
        `plist: ${plistPath(env, undefined, dir)}${state.intervalS ? ` (every ${state.intervalS} s)` : " (not written by install yet)"}`,
        `launchd: ${loaded({ uid, check: checkBin }).detail}`,
      ];
      return { code: 0, text: lines.join("\n") };
    }
    case "prune": {
      const days = opts.days === undefined ? DEFAULT_RETENTION_DAYS : Number(opts.days);
      if (!Number.isInteger(days) || days < 0) return { code: 2, text: `ctx-watch: --days must be a whole number of days, got ${JSON.stringify(opts.days)}\n${HELP}` };
      const dryRun = opts["dry-run"] === true;
      const r = prune(dir, { days, now: now(), dryRun });
      const lines = [...r.rotated.map((p) => `${dryRun ? "would rotate" : "rotated"} ${p} to ${p}.1`), ...r.problems, `pruned: ${r.removed} file(s), ${r.bytes} bytes freed${dryRun ? " (dry run)" : ""}; kept ${r.kept}`];
      return { code: 0, text: lines.join("\n") };
    }
    case "help":
    case "--help":
    case "-h":
      return { code: 0, text: HELP };
    default:
      return { code: 2, text: `ctx-watch: unknown verb ${JSON.stringify(verb)}\n${HELP}` };
  }
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(CLI_PATH);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  let code = 1;
  let text;
  try {
    ({ code, text } = await main(process.argv.slice(2)));
  } catch (err) {
    // Nothing above is meant to throw; a throw here is a bug, and the launchd log is where it shows.
    text = `ctx-watch: ${process.argv[2] ?? "help"} failed: ${err?.stack ?? err}`;
  }
  if (text) (code === 0 ? process.stdout : process.stderr).write(text + "\n");
  process.exitCode = code;
}
