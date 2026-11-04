// test/helpers.mjs — a sandbox per test: an empty HOME, XDG dirs, a git-initialised work
// directory, and `spawnHook(name, input)` running a hook as the host would (a child process,
// JSON on stdin, JSON read back from stdout). Nothing here touches the real machine's state.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BUDGET_MS = 5_000;

export function box() {
  // realpath: macOS gives /var/… for a tmpdir that is really /private/var/…, and git reports the latter.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "continuity-test-")));
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), TMPDIR: join(root, "tmp") };
  const work = join(root, "work");
  for (const d of [...Object.values(env).slice(1), work]) mkdirSync(d, { recursive: true });
  const git = (...args) => spawnSync("git", args, { cwd: work, encoding: "utf8", env: { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q", "-b", "main");
  const stateDir = join(env.XDG_STATE_HOME, "continuity");
  const transcript = join(root, "transcript.jsonl");
  const writeTranscript = (entries) => writeFileSync(transcript, entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
  const writeConfig = (json) => {
    mkdirSync(join(env.XDG_CONFIG_HOME, "continuity"), { recursive: true });
    writeFileSync(join(env.XDG_CONFIG_HOME, "continuity", "config.json"), typeof json === "string" ? json : JSON.stringify(json));
  };
  const readState = (rel) => readFileSync(join(stateDir, rel), "utf8");
  const release = () => rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  return { root, env, work, git, stateDir, transcript, writeTranscript, writeConfig, readState, release };
}

/** Run `hooks/<file>` as a child with `stdin` (a string or an object); `{ status, stdout, stderr, json, ms }`. */
export function spawnHook(b, file, stdin, { env = {}, timeout = BUDGET_MS } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, "hooks", file)], { cwd: b.work, env: { ...b.env, ...env }, input: typeof stdin === "string" ? stdin : JSON.stringify(stdin), encoding: "utf8", timeout, killSignal: "SIGKILL" });
  let json = null;
  if (r.stdout.trim()) {
    try {
      json = JSON.parse(r.stdout);
    } catch {
      json = undefined;
    }
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, ms: Date.now() - started, error: r.error };
}

export const input = (event, b, extra = {}) => ({ hook_event_name: event, session_id: "s-test", cwd: b.work, transcript_path: b.transcript, ...extra });
