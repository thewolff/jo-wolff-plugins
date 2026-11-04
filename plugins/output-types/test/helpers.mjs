// helpers.mjs — a temp tree per test, a copy of the plugin to break on purpose, and hook runners.
// Every spawned process has a 5-second budget: a hang is a failure, never a skip.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";

export const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const HOOK_REL = join("hooks", "output-types-inject.mjs");
export const CONTRACT_REL = join("skills", "output-types", "reference.md");
export const BUDGET_MS = 5000;

/** A fresh temp tree: HOME, a work folder, a state dir, and an env with nothing inherited from the user. */
export function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "output-types-test-")));
  const home = join(root, "home");
  const work = join(root, "work");
  for (const d of [home, work]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(root, "state"), TZ: "UTC" };
  const box = {
    root,
    home,
    work,
    env,
    errorsLog: join(root, "state", "output-types", "errors.log"),
    /** Copy the plugin into the sandbox so a test can break its files without touching the real ones. */
    copyPlugin() {
      const dest = join(root, "plugin");
      const testDir = join(PLUGIN_ROOT, "test");
      cpSync(PLUGIN_ROOT, dest, { recursive: true, filter: (src) => src !== testDir && !src.startsWith(testDir + sep) });
      return dest;
    },
    readErrors() {
      return existsSync(box.errorsLog) ? readFileSync(box.errorsLog, "utf8") : "";
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  after(() => box.cleanup());
  return box;
}

/** The SessionStart payload Claude Code sends on stdin. */
export function sessionStartPayload(box, source = "startup") {
  return JSON.stringify({
    session_id: "11111111-2222-3333-4444-555555555555",
    transcript_path: join(box.home, ".claude", "projects", "x", "s.jsonl"),
    cwd: box.work,
    hook_event_name: "SessionStart",
    source,
  });
}

/** Run the hook with `input` on stdin (closed after), under the 5-second budget. */
export function runHook(box, { input = sessionStartPayload(box), env = {}, pluginRoot = PLUGIN_ROOT } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(pluginRoot, HOOK_REL)], {
    cwd: box.work,
    env: { ...box.env, ...env },
    input,
    encoding: "utf8",
    timeout: BUDGET_MS,
    killSignal: "SIGKILL",
  });
  return { ...r, ms: Date.now() - started, json: parseJson(r.stdout) };
}

/** Run the hook with a stdin pipe that is never closed, under the 5-second budget. */
export function runHookStdinOpen(box, { env = {}, pluginRoot = PLUGIN_ROOT } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(pluginRoot, HOOK_REL)], { cwd: box.work, env: { ...box.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.on("error", () => {});
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, BUDGET_MS);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut, ms: Date.now() - started, json: parseJson(stdout) });
    });
  });
}

export function parseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** The span between the marker lines, computed by lines rather than by the hook's indexOf, plus nothing else. */
export function spanByLines(md) {
  const lines = md.split("\n");
  const a = lines.indexOf("<!-- inject:start -->");
  const b = lines.indexOf("<!-- inject:end -->", a + 1);
  return lines.slice(a + 1, b).join("\n").trim();
}
