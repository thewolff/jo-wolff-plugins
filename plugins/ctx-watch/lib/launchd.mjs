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
//                       without LANG is `environment_invalid` (2026-11-11). A shell without
//                       LANG (one launchd started, such as Claude Desktop's) gets resolveLang's
//                       fallback: the LANG ctx recorded, else one derived from AppleLocale;
//       and never `CI` or CTX_SEMANTIC_EMBEDDING_TOKEN.
//   uninstall({ env, uid })   prints the bootout line (and removes nothing).
//   loaded({ uid, check })    `{ loaded: true|false|null, detail }` from `launchctl print`.
//   reachProbe({ uid, check, tmp }) `{ ok, missing, detail }`: whether this shell can write to
//       gui/<uid> (bootstrap and bootout a throwaway LaunchAgent running /usr/bin/true and never
//       started, labelled PROBE_LABEL.<pid>.<random> so two runs never share one, its plist in a
//       fresh temp directory removed on every path; first, the probes and temp directories of
//       runs whose pid is dead are cleared, and a live run's are left alone). `launchctl print
//       gui/<uid>` is not that test: a sandboxed shell reads the domain and still gets
//       "Bootstrap failed: 5: Input/output error" (2026-11-11). `repair` runs it before pausing
//       the timer, so it never boots out a timer it could not bootstrap back.
//
// `check(bin, args)` → `{ missing, code, output }` is injectable: tests never run plutil or
// launchctl, and a sandbox that refuses launchctl reports `null` rather than failing.
//
// Printed commands shell-quote every path (`shellQuote`): what install prints is what the
// person pastes into zsh, and a state directory with a space in it is a legal one.

import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { stateDir as defaultStateDir, INTERVAL_BOUNDS, running } from "./state.mjs";

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

/**
 * Whether launchd has the job: `launchctl print gui/<uid>/<label>`. `loaded` true (exit 0),
 * false only on launchctl's 113 ("Could not find service"), null on anything else (not found,
 * did not run, any other exit): a failed query is not an answer.
 */
export function loaded({ uid = process.getuid?.() ?? 501, label = LABEL, check = runCheck } = {}) {
  const r = check("launchctl", ["print", `gui/${uid}/${label}`]);
  if (r.missing) return { loaded: null, detail: "launchctl not found: could not tell whether the job is loaded" };
  if (r.code === 0) {
    const state = /\bstate = (\S+)/.exec(r.output)?.[1];
    const last = /last exit code = ([^\n]+)/.exec(r.output)?.[1]?.trim();
    return { loaded: true, detail: `launchd has ${label}${state ? ` (state = ${state}` : ""}${last ? `, last exit code = ${last})` : state ? ")" : ""}` };
  }
  if (r.code === null) return { loaded: null, detail: `launchctl could not run: ${r.output.trim()}` };
  if (r.code === 113) return { loaded: false, detail: `launchd does not have ${label}` };
  return { loaded: null, detail: `launchctl print gui/${uid}/${label} exit ${r.code}: ${(r.output ?? "").trim().split("\n").at(-1) || "(no output)"}` };
}

/** The reach probes' label prefix: each run's probe is `<PROBE_LABEL>.<pid>.<random>`, never a job that runs anything. */
export const PROBE_LABEL = `${LABEL}.reach-probe`;
const PROBE_DIR = "ctx-watch-reach-";

/** The pid a probe label or temp directory name carries after `prefix`, or null. */
const ownerPid = (name, prefix, sep) => {
  if (!name.startsWith(prefix)) return null;
  const m = new RegExp(`^(\\d+)${sep.replace(".", "\\.")}`).exec(name.slice(prefix.length));
  return m ? Number(m[1]) : null;
};
const deadRun = (pid) => pid !== null && pid !== process.pid && pid > 0 && !running(pid);

/** The probe's plist: a Label and /usr/bin/true, no RunAtLoad, interval or KeepAlive, so it is loaded and never started. */
export function probePlist(label = PROBE_LABEL) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/true</string>
  </array>
</dict>
</plist>
`;
}

/**
 * Whether this shell can load and unload a LaunchAgent in gui/<uid>, the two things `repair`
 * does to the ctx-watch timer: `{ ok: true }`, or `{ ok: false, missing, detail }` with
 * launchctl's own last line. First clears what killed runs left: every loaded
 * `<PROBE_LABEL>.<pid>.*` whose pid is not running is booted out, and every
 * `ctx-watch-reach-<pid>-*` directory under `tmp` whose pid is not running is removed (a live
 * run's, another repair in its own probe window, is never touched). Then writes this run's probe
 * plist, `<PROBE_LABEL>.<this pid>.<random>`, into a fresh directory under `tmp`, bootstraps,
 * boots out, and removes the directory whatever happened. A `check` that throws is a failed
 * probe, never a throw; a cleanup that fails is skipped (the label is this run's own).
 */
export function reachProbe({ uid = process.getuid?.() ?? 501, check = runCheck, tmp = tmpdir() } = {}) {
  const run = (args) => {
    try {
      return check("launchctl", args);
    } catch (err) {
      return { missing: false, code: null, output: `${err?.message ?? err}` };
    }
  };
  const last = (r) => (r.output ?? "").trim().split("\n").at(-1) || "(no output)";
  const label = `${PROBE_LABEL}.${process.pid}.${randomBytes(6).toString("hex")}`;
  const target = `gui/${uid}/${label}`;
  let dir = null;
  try {
    const list = run(["list"]);
    if (list.missing) return { ok: false, missing: true, detail: "launchctl not found" };
    if (list.code === 0) {
      for (const line of (list.output ?? "").split("\n")) {
        const left = line.split("\t").at(-1)?.trim() ?? "";
        if (deadRun(ownerPid(left, `${PROBE_LABEL}.`, "."))) run(["bootout", `gui/${uid}/${left}`]);
      }
    }
    try {
      for (const name of readdirSync(tmp)) if (deadRun(ownerPid(name, PROBE_DIR, "-"))) rmSync(join(tmp, name), { recursive: true, force: true });
    } catch {
      /* an unreadable temp directory: nothing of ours to clear there */
    }
    dir = mkdtempSync(join(tmp, `${PROBE_DIR}${process.pid}-`));
    const plist = join(dir, `${label}.plist`);
    writeFileSync(plist, probePlist(label));
    const boot = run(["bootstrap", `gui/${uid}`, plist]);
    if (boot.missing) return { ok: false, missing: true, detail: "launchctl not found" };
    if (boot.code !== 0) {
      // A bootstrap that did not answer may have loaded it anyway.
      if (boot.code === null) run(["bootout", target]);
      return { ok: false, missing: false, detail: `launchctl bootstrap gui/${uid} of a throwaway LaunchAgent failed (exit ${boot.code ?? "none"}: ${last(boot)})` };
    }
    const out = run(["bootout", target]);
    if (out.code !== 0) return { ok: false, missing: false, detail: `launchctl bootout ${target} of the throwaway LaunchAgent failed (exit ${out.code ?? "none"}: ${last(out)}); it may still be loaded (it runs nothing; the next repair boots it out once this process has exited)` };
    return { ok: true, missing: false, detail: null };
  } catch (err) {
    return { ok: false, missing: false, detail: `the launchd reach probe could not be written: ${err?.message ?? err}` };
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a temp directory the OS clears */
      }
    }
  }
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

/** A locale name LANG can hold (`C`, `POSIX`, `en_US`, `en_US.UTF-8`, `sr_RS@latin`); nothing a shell would read twice. */
const LOCALE_NAME = /^(?:C|POSIX|[a-z]{2,3}_[A-Z]{2})(?:\.[A-Za-z0-9-]+)?(?:@[A-Za-z0-9]+)?$/;

/** `<CTX_DATA_ROOT, else ~/.ctx>/daemon/supervisor-environment.json`: where ctx 2.3.0 keeps the launch environment it recorded, values included. */
export function recordedEnvPath(env = process.env) {
  return join(env.CTX_DATA_ROOT || join(env.HOME || homedir(), ".ctx"), "daemon", "supervisor-environment.json");
}

/** LANG from macOS's AppleLocale (`en_GB@rg=dezzzz` → `en_GB.UTF-8`, `zh-Hans_CN` → `zh_CN.UTF-8`), or null when it names no language and region. */
export function langFromAppleLocale(locale) {
  const m = /^([a-z]{2,3})(?:-[A-Z][a-z]{3})?_([A-Z]{2})(?:@[A-Za-z0-9=;-]*)?$/.exec(String(locale ?? "").trim());
  return m ? `${m[1]}_${m[2]}.UTF-8` : null;
}

/**
 * The locales this host has, as `locale -a` lists them, normalised (`en_GB.utf8` and
 * `en_GB.UTF-8` are the same locale), or null when the list cannot be read.
 */
function hostLocales(check) {
  const r = check("locale", ["-a"]);
  if (r.missing || r.code !== 0) return null;
  return new Set(String(r.output).split("\n").map((s) => normLocale(s.trim())).filter(Boolean));
}
const normLocale = (s) => s.replace(/\.utf-?8$/i, ".UTF-8");

/**
 * The LANG to give ctx: `{ value, source, detail, skipped }`, value null when none is found.
 * This shell's LANG first, used as given (source `env`); else the LANG ctx itself recorded for
 * its daemon in supervisor-environment.json (`ctx-recorded`; supervisor.json holds the names
 * only, `values_exposed: false`); else one derived from `defaults read -g AppleLocale`
 * (`AppleLocale`). Each fallback candidate must name a locale `locale -a` lists; one that does
 * not (a value from another machine, an AppleLocale pair like en_DE that macOS has no locale
 * for), or any when the list cannot be read, is not used and goes into `skipped` with why.
 * A process launchd started (Claude Desktop and its tools, this timer) usually has no LANG,
 * and a ctx heal from one records a launch environment ctx then calls `environment_invalid`
 * (2026-11-10 23:29). Read-only: one file, one default, one locale list.
 */
export function resolveLang({ env = process.env, check = runCheck } = {}) {
  if (typeof env.LANG === "string" && env.LANG !== "") return { value: env.LANG, source: "env", detail: "this shell's LANG", skipped: [] };
  const file = recordedEnvPath(env);
  const skipped = [];
  let locales;
  const usable = (c) => {
    if (!LOCALE_NAME.test(c.value)) return skipped.push({ value: c.value, source: c.source, why: "not a locale name" }), false;
    locales ??= hostLocales(check);
    if (locales === null) return skipped.push({ value: c.value, source: c.source, why: "`locale -a` could not be read, so it could not be checked" }), false;
    if (!locales.has(normLocale(c.value))) return skipped.push({ value: c.value, source: c.source, why: "not in `locale -a` on this host" }), false;
    return true;
  };
  let recorded;
  try {
    const entries = JSON.parse(readFileSync(file, "utf8"))?.environment;
    recorded = Array.isArray(entries) ? entries.find((e) => e?.name === "LANG")?.value : undefined;
  } catch {
    // absent or unreadable: no recorded candidate
  }
  if (typeof recorded === "string" && recorded !== "") {
    const c = { value: recorded, source: "ctx-recorded", detail: file };
    if (usable(c)) return { ...c, skipped };
  }
  const r = check("defaults", ["read", "-g", "AppleLocale"]);
  const raw = !r.missing && r.code === 0 ? String(r.output).trim() : null;
  const derived = raw === null ? null : langFromAppleLocale(raw);
  if (derived) {
    const c = { value: derived, source: "AppleLocale", detail: `defaults read -g AppleLocale = ${raw}` };
    if (usable(c)) return { ...c, skipped };
  }
  const tried = skipped.length ? `; skipped ${skipped.map((s) => `${s.value} (${s.source}): ${s.why}`).join(", ")}` : "";
  return { value: null, source: null, detail: `no LANG in this shell, none usable recorded in ${file}, and no usable AppleLocale (\`defaults read -g AppleLocale\`${raw !== null ? ` = ${raw}` : ""})${tried}`, skipped };
}

/**
 * Write, lint, report. `{ code, text, file, ctx }`. `ctx` (optional) is the executable to pin;
 * otherwise the first `ctx` on this shell's PATH, and no ctx at all is exit 1: a timer that
 * can never find ctx would only ever pop up. The plist's environment is PATH plus carriedEnv(env),
 * with resolveLang's fallback LANG when this shell has none.
 */
export function install({ env = process.env, interval = 300, cliPath, node = process.execPath, uid = process.getuid?.() ?? 501, check = runCheck, label = LABEL, cwd = process.cwd(), stateDir = defaultStateDir(env), ctx, exists } = {}) {
  const dir = launchdDir(env, stateDir);
  const file = plistPath(env, label, stateDir);
  const path = dedupePath(env.PATH);
  let text;
  let pinned;
  let lang;
  let environment;
  try {
    pinned = ctx === undefined ? resolveCtx(path, exists ? { exists } : {}) : resolve(cwd, ctx);
    if (pinned === null) throw new Error(`no executable \`ctx\` on PATH (${path}); install ctx first (\`ctx docs show getting-started\`), or pass --ctx <absolute path>`);
    if (exists ? !exists(pinned) : !executable(pinned)) throw new Error(`--ctx ${pinned} is not an executable file`);
    lang = resolveLang({ env, check });
    environment = lang.value && lang.source !== "env" ? { LANG: lang.value, ...carriedEnv(env) } : carriedEnv(env);
    text = plistText({ label, node, cliPath: resolve(cwd, cliPath), interval, logDir: dir, path, stateDir: resolve(cwd, stateDir), ctx: pinned, environment });
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
  } catch (err) {
    return { code: 1, text: `ctx-watch install: ${err.message}` };
  }
  const lines = [`wrote ${file} (${label}, every ${interval} s, \`tick\`; ctx pinned at ${pinned}, state in ${resolve(cwd, stateDir)})`];
  const names = Object.keys(environment);
  lines.push(`environment: PATH${names.length ? `, ${names.join(", ")}` : ""}`);
  if (lang.value === null) lines.push(`LANG is not set in this shell, so the plist carries none (${lang.detail}): a heal the timer runs would have ctx record a launch environment without LANG, which it reports as supervisor \`environment_invalid\` with \`restart_required\`. Run install again from a shell with LANG set (a Terminal login shell has it).`);
  else if (lang.source !== "env") lines.push(`LANG is not set in this shell; the plist carries LANG=${lang.value} from ${lang.source === "AppleLocale" ? "AppleLocale" : lang.detail} instead, so a heal the timer runs records a launch environment with LANG.`);
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
