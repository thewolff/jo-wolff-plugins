#!/usr/bin/env node
// scripts/ctx-watch.mjs — the ctx-watch CLI.
//
//   check [--json]           one probe (heal and re-probe on failure); prints the needs-you line
//                            or nothing; --json prints the whole result. Exit 0 always.
//   tick                     the launchd timer's run: probe, advance the episode state in
//                            <state>/state.json, show the popup on the second failing tick in a
//                            row (once per episode; re-armed by a passing tick). One summary line.
//   install [--interval 300] write <state>/launchd/com.jo-wolff-plugins.ctx-watch.plist, lint it,
//                            print the `launchctl bootstrap` line. Never bootstraps.
//   uninstall                print the `launchctl bootout` line. Removes nothing.
//   status                   the last probe, the episode, and whether launchd has the job.
//   help
//
// <state> is ${XDG_STATE_HOME:-~/.local/state}/ctx-watch. Every ctx spawn has CI removed from
// its environment. `main(argv, deps)` returns { code, text } and is what the tests drive; the
// probes, the popup, plutil and launchctl are injected through `deps`.

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { check as runCheckOnce, needsYouLine } from "../lib/probe.mjs";
import { readState, writeState, statePath, step, timerOverdue } from "../lib/state.mjs";
import { install, uninstall, loaded, plistPath } from "../lib/launchd.mjs";
import { showPopup } from "../lib/popup.mjs";

export const CLI_PATH = fileURLToPath(import.meta.url);

export const HELP = `ctx-watch: notice when the ctx daemon is dead, unsupervised, or stale.

  check [--json]            probe once (heal with \`ctx index mode auto\`, then re-probe, on failure); print the needs-you line or nothing
  tick                      the launchd timer's run: probe, keep the episode state, popup on the second failing tick
  install [--interval 300]  write the launchd plist and print the bootstrap line (never bootstraps)
  uninstall                 print the bootout line
  status                    last probe, episode, whether launchd has the job
  help`;

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

export function main(argv, deps = {}) {
  const { env = process.env, now = Date.now, run, exists, popup = showPopup, check: checkBin, node, uid, cwd = process.cwd(), cliPath = CLI_PATH, timeoutMs } = deps;
  let verb;
  let opts;
  try {
    ({ verb, opts } = parseArgs(argv));
  } catch (err) {
    return { code: 2, text: `ctx-watch: ${err.message}\n${HELP}` };
  }
  const probeDeps = { env, now, run, exists, timeoutMs };
  switch (verb) {
    case "check": {
      const result = runCheckOnce(probeDeps);
      if (opts.json) return { code: 0, text: JSON.stringify(result, null, 2) };
      return { code: 0, text: needsYouLine(result) ?? "" };
    }
    case "tick": {
      const file = statePath(env);
      const result = runCheckOnce(probeDeps);
      const at = now();
      const { state, popup: wantPopup } = step(readState(file), result, at);
      const lines = [`${iso(at)} ${result.ok ? "pass" : "fail"}: ${result.ok ? result.summary : result.reason}${result.healed ? ` | heal: ${result.healed.detail}` : ""} | episode ${state.episode}, strikes ${state.strikes}`];
      if (wantPopup) {
        const p = popup({ text: `${needsYouLine(result)}\n\nThe daemon has failed ${state.strikes} checks in a row (since ${iso(state.downSince)}). Open a Terminal and run the fix; ctx-watch checks again in ${state.intervalS ?? 300} s.` });
        lines.push(p.detail);
      }
      if (!writeState(file, state)) lines.push(`state not written to ${file}: ${writeState.lastError?.message}`);
      return { code: 0, text: lines.join("\n") };
    }
    case "install": {
      const interval = opts.interval === undefined ? 300 : Number(opts.interval);
      const r = install({ env, interval, cliPath, node, uid, check: checkBin, cwd });
      if (r.code === 0) {
        const file = statePath(env);
        const state = readState(file);
        writeState(file, { ...state, intervalS: interval });
      }
      return r;
    }
    case "uninstall":
      return uninstall({ env, uid });
    case "status": {
      const file = statePath(env);
      const state = readState(file);
      const t = timerOverdue(state, now());
      const lines = [
        `state file: ${file}`,
        `last tick: ${iso(state.lastTickAt)}${t.overdue ? ` (overdue: more than ${2 * t.intervalS} s ago)` : ""}`,
        `last probe: ${state.lastProbe ? `${state.lastProbe.ok ? "pass" : `fail: ${state.lastProbe.reason}`} at ${iso(state.lastProbe.at)}${state.lastProbe.healed ? ` | heal: ${state.lastProbe.healed}` : ""}` : "never"}`,
        `episode: ${state.episode} (strikes ${state.strikes}${state.downSince ? `, down since ${iso(state.downSince)}` : ""}${state.popupShown ? `, popup shown ${iso(state.lastPopupAt)}` : ""})`,
        `plist: ${plistPath(env)}${state.intervalS ? ` (every ${state.intervalS} s)` : " (not written by install yet)"}`,
        `launchd: ${loaded({ uid, check: checkBin }).detail}`,
      ];
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
  const { code, text } = main(process.argv.slice(2));
  if (text) (code === 0 ? process.stdout : process.stderr).write(text + "\n");
  process.exitCode = code;
}
