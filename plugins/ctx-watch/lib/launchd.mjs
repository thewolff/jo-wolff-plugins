// lib/launchd.mjs — the timer's plist, written and linted, never bootstrapped (ledger's
// `canary install` pattern: the person runs the one `launchctl bootstrap` line it prints, so the
// job is registered from a GUI login session, which is where ctx's own bootstrap failed on
// 2026-10-28 with "Bootstrap failed: 5: Input/output error").
//
//   install({ env, interval, cliPath, node, uid, check, ctx })
//       writes <state>/launchd/com.jo-wolff-plugins.ctx-watch.plist (StartInterval <interval> s,
//       RunAtLoad, `node <cli> tick --state-dir <state> --ctx <ctx>`, logs beside it), runs
//       `plutil -lint`, asks `launchctl print` whether the job is loaded, prints the bootstrap
//       line. Every path in the plist is absolute: launchd runs the job from / with an
//       environment of its own, so the plist carries
//         --state-dir   the state directory this install resolved (XDG_STATE_HOME or HOME), so
//                       the timer and the SessionStart hook read and write one state.json even
//                       when XDG_STATE_HOME was set only in the installing shell;
//         --ctx         the absolute ctx executable found on this shell's PATH (or given as
//                       `--ctx`), so a PATH edited later cannot change which program runs;
//         PATH          this shell's PATH with repeated, empty and relative entries dropped
//                       (`.` and `relative/bin` would mean whatever launchd's working directory
//                       held), for the `node` the plist names and anything ctx itself runs;
//         CARRIED_ENV   LANG, LC_ALL, TMPDIR, XDG_CONFIG_HOME, XDG_DATA_HOME and ctx's own
//                       CTX_* settings, each when set in this shell: a heal the timer runs is
//                       where ctx records its daemon's launch environment, and one recorded
//                       without LANG is `environment_invalid` (2026-11-11);
//       and never `CI` or CTX_SEMANTIC_EMBEDDING_TOKEN.
//   uninstall({ env, uid })   prints the bootout line (and removes nothing).
//   loaded({ uid, check })    `{ loaded: true|false|null, detail }` from `launchctl print`.
//
// `check(bin, args)` → `{ missing, code, output }` is injectable: tests never run plutil or
// launchctl, and a sandbox that refuses launchctl reports `null` rather than failing.
//
// Printed commands shell-quote every path (`shellQuote`): what install prints is what the
// person pastes into zsh, and a state directory with a space in it is a legal one.

import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { stateDir as defaultStateDir, INTERVAL_BOUNDS } from "./state.mjs";

export const LABEL = "com.jo-wolff-plugins.ctx-watch";
export const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export function launchdDir(env = process.env, stateDir = defaultStateDir(env)) {
  return join(stateDir, "launchd");
}

export function plistPath(env = process.env, label = LABEL, stateDir = defaultStateDir(env)) {
  return join(launchdDir(env, stateDir), `${label}.plist`);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** `s` as one POSIX shell word: as is when it needs nothing, else single-quoted. */
export function shellQuote(s) {
  const v = String(s);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`;
}

/**
 * `PATH` with repeated, empty and relative entries dropped, first occurrence kept (an agent
 * shell's PATH repeats itself; a relative entry means a different directory in every job).
 */
export function dedupePath(path) {
  const out = [];
  for (const p of String(path ?? "").split(":")) if (p && isAbsolute(p) && !out.includes(p)) out.push(p);
  return out.join(":") || DEFAULT_PATH;
}

const executable = (p) => {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The absolute `ctx` on `path` (absolute entries only, first match), or null. `exists` is
 * injectable (a path → whether it is an executable file).
 */
export function resolveCtx(path, { name = "ctx", exists = executable } = {}) {
  for (const dir of dedupePath(path).split(":")) {
    const p = join(dir, name);
    if (exists(p)) return p;
  }
  return null;
}

/**
 * The plist text. Throws when a path is not absolute (the one thing launchd will not forgive) or
 * the interval is outside INTERVAL_BOUNDS (the range the state file can hold); install builds the
 * text before it creates a directory or writes a file, so a refusal leaves nothing behind.
 */
export function plistText({ label = LABEL, node, cliPath, interval = 300, logDir, path = DEFAULT_PATH, stateDir, ctx, environment = {} }) {
  for (const [k, v] of Object.entries({ node, cliPath, logDir, stateDir, ctx })) {
    if (typeof v !== "string" || !isAbsolute(v)) throw new Error(`plist ${k} must be an absolute path, got ${JSON.stringify(v)}`);
  }
  if (!Number.isInteger(interval) || interval < INTERVAL_BOUNDS.min || interval > INTERVAL_BOUNDS.max) throw new Error(`interval must be a whole number of seconds, ${INTERVAL_BOUNDS.min}..${INTERVAL_BOUNDS.max}, got ${JSON.stringify(interval)}`);
  const args = [node, cliPath, "tick", "--state-dir", stateDir, "--ctx", ctx];
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
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${esc(join(logDir, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(join(logDir, `${label}.err.log`))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(path)}</string>
${Object.entries(environment)
  .map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>\n`)
  .join("")}  </dict>
</dict>
</plist>
`;
}

/** Run `bin args` for 10 s; `{ missing, code, output }`. */
export function runCheck(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
  if (r.error?.code === "ENOENT") return { missing: true, code: null, output: "" };
  if (r.error) return { missing: false, code: null, output: r.error.message };
  return { missing: false, code: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Whether launchd has the job: `launchctl print gui/<uid>/<label>`. */
export function loaded({ uid = process.getuid?.() ?? 501, label = LABEL, check = runCheck } = {}) {
  const r = check("launchctl", ["print", `gui/${uid}/${label}`]);
  if (r.missing) return { loaded: null, detail: "launchctl not found: could not tell whether the job is loaded" };
  if (r.code === 0) {
    const state = /\bstate = (\S+)/.exec(r.output)?.[1];
    const last = /last exit code = ([^\n]+)/.exec(r.output)?.[1]?.trim();
    return { loaded: true, detail: `launchd has ${label}${state ? ` (state = ${state}` : ""}${last ? `, last exit code = ${last})` : state ? ")" : ""}` };
  }
  if (r.code === null) return { loaded: null, detail: `launchctl could not run: ${r.output.trim()}` };
  return { loaded: false, detail: `launchd does not have ${label}` };
}

/**
 * The names `install` carries from the installing shell into the plist, when set: the ones in
 * ctx 2.3.0's supervisor environment-snapshot allowlist (`ctx daemon status --format json`
 * .daemon.supervisor.environment_snapshot.allowlist) that decide how ctx runs, rather than
 * which agent's history it reads. A heal the timer runs is where ctx records its launch
 * environment; a heal without LANG recorded one ctx then called `environment_invalid`, with
 * `restart_required` (2026-11-10 23:29 → 2026-11-11). Never CTX_SEMANTIC_EMBEDDING_TOKEN (a
 * credential, and the plist is a plain file) and never CI. HOME is launchd's own.
 */
export const CARRIED_ENV = Object.freeze([
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "CTX_ANALYTICS_ENABLED",
  "CTX_DAEMON_ENABLED",
  "CTX_DAEMON_MODE",
  "CTX_DATA_ROOT",
  "CTX_LOCAL_USAGE_ENABLED",
  "CTX_SEARCH_SEMANTIC",
  "CTX_SEMANTIC_EMBEDDING_TOKEN_ENDPOINT",
  "CTX_UPGRADE_AUTO",
  "CTX_UPGRADE_CHANNEL",
  "CTX_UPGRADE_INTERVAL_SECONDS",
]);

/** The CARRIED_ENV names set (non-empty) in `env`, in CARRIED_ENV order. */
export function carriedEnv(env = process.env) {
  return Object.fromEntries(CARRIED_ENV.filter((k) => typeof env[k] === "string" && env[k] !== "").map((k) => [k, env[k]]));
}

/**
 * Write, lint, report. `{ code, text, file, ctx }`. `ctx` (optional) is the executable to pin;
 * otherwise the first `ctx` on this shell's PATH, and no ctx at all is exit 1: a timer that
 * can never find ctx would only ever pop up. The plist's environment is PATH plus carriedEnv(env).
 */
export function install({ env = process.env, interval = 300, cliPath, node = process.execPath, uid = process.getuid?.() ?? 501, check = runCheck, label = LABEL, cwd = process.cwd(), stateDir = defaultStateDir(env), ctx, exists } = {}) {
  const dir = launchdDir(env, stateDir);
  const file = plistPath(env, label, stateDir);
  const path = dedupePath(env.PATH);
  const environment = carriedEnv(env);
  let text;
  let pinned;
  try {
    pinned = ctx === undefined ? resolveCtx(path, exists ? { exists } : {}) : resolve(cwd, ctx);
    if (pinned === null) throw new Error(`no executable \`ctx\` on PATH (${path}); install ctx first (\`ctx docs show getting-started\`), or pass --ctx <absolute path>`);
    if (exists ? !exists(pinned) : !executable(pinned)) throw new Error(`--ctx ${pinned} is not an executable file`);
    text = plistText({ label, node, cliPath: resolve(cwd, cliPath), interval, logDir: dir, path, stateDir: resolve(cwd, stateDir), ctx: pinned, environment });
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
  } catch (err) {
    return { code: 1, text: `ctx-watch install: ${err.message}` };
  }
  const lines = [`wrote ${file} (${label}, every ${interval} s, \`tick\`; ctx pinned at ${pinned}, state in ${resolve(cwd, stateDir)})`];
  const names = Object.keys(environment);
  lines.push(`environment: PATH${names.length ? `, ${names.join(", ")}` : ""}`);
  if (!("LANG" in environment)) lines.push("LANG is not set in this shell, so the plist carries none: a heal the timer runs would have ctx record a launch environment without LANG, which it reports as supervisor `environment_invalid` with `restart_required`. Run install again from a shell with LANG set (a Terminal login shell has it).");
  const lint = check("plutil", ["-lint", file]);
  if (lint.missing) lines.push("plutil not found: the plist was not checked (not macOS?)");
  else if (lint.code !== 0) return { code: 1, text: `${lines.join("\n")}\nplutil -lint failed: ${lint.output.trim()}` };
  else lines.push("plutil -lint: OK");
  const l = loaded({ uid, label, check });
  if (l.loaded === true) lines.push(`${l.detail}; to pick up this plist:\n  launchctl bootout gui/${uid}/${label} && launchctl bootstrap gui/${uid} ${shellQuote(file)}`);
  else lines.push(`${l.detail}. To install it, run from your own Terminal (a GUI login, not an agent shell):\n  launchctl bootstrap gui/${uid} ${shellQuote(file)}\nthen check with:\n  node ${shellQuote(resolve(cwd, cliPath))} status`);
  return { code: 0, text: lines.join("\n"), file, ctx: pinned };
}

/** The bootout line. Removes nothing. */
export function uninstall({ env = process.env, uid = process.getuid?.() ?? 501, label = LABEL, stateDir = defaultStateDir(env) } = {}) {
  const file = plistPath(env, label, stateDir);
  return { code: 0, text: `To stop the timer, run:\n  launchctl bootout gui/${uid}/${label}\nThe plist stays at ${file}; delete it yourself if you are done with it.`, file };
}
