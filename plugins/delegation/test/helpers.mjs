// test/helpers.mjs — one sandbox per test (empty HOME and XDG dirs under a temp root) and the
// spawn of a hook end-to-end through lib/hook-runner.mjs, exactly as the host runs it.

import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BUDGET_MS = 5_000;

/** A fresh sandbox: `t.after` releases it. */
export function box(t, { config } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delegation-test-")));
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    TMPDIR: join(root, "tmp"),
  };
  for (const d of Object.values(env).slice(1)) mkdirSync(d, { recursive: true });
  if (config !== undefined) setConfig(env, config);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, env };
}

/** Write (or overwrite) the plugin's config file in the sandbox; a string is written verbatim. */
export function setConfig(env, config) {
  const dir = join(env.XDG_CONFIG_HOME, "delegation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
}

export function skippedLog(env) {
  try {
    return readFileSync(join(env.XDG_STATE_HOME, "delegation", "skipped.log"), "utf8");
  } catch {
    return "";
  }
}

export function errorsLog(env) {
  try {
    return readFileSync(join(env.XDG_STATE_HOME, "delegation", "errors.log"), "utf8");
  } catch {
    return "";
  }
}

/**
 * Spawn `hooks/<name>.mjs` with `payload` (an object, or a raw string for malformed input) on
 * stdin, under the sandbox env. Returns `{ status, out, stdout, stderr, ms }`; `out` is the parsed
 * JSON answer or null when the hook printed nothing.
 */
export function runHook(name, payload, env, { extraEnv = {}, cwd } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, "hooks", `${name}.mjs`)], {
    cwd: cwd ?? env.HOME,
    env: { ...env, ...extraEnv },
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    timeout: BUDGET_MS,
    killSignal: "SIGKILL",
  });
  const ms = Date.now() - started;
  if (r.error) throw r.error;
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return { status: r.status, out, stdout: r.stdout, stderr: r.stderr, ms };
}

/** A git repository at `dir` with one commit; returns its realpath. */
export function gitRepo(dir, env) {
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: dir, env: { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# t\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  return realpathSync(dir);
}

export const GOOD_BRIEF = "# Target\nx\n\n## How it fails\n- it breaks\n\n## Spiral bound\n- one retry\n";
export const HOW_ONLY = "# Target\nx\n\n## How it fails\n- it breaks\n";

export function spawnPayload({ prompt = GOOD_BRIEF, subagent_type = "builder", cwd, session_id = "s-test-1", tool_name = "Agent", extra = {} } = {}) {
  return { session_id, cwd, hook_event_name: "PreToolUse", tool_name, tool_input: { prompt, subagent_type, description: "d", ...extra } };
}
