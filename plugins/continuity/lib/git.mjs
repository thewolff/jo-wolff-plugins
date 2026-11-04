// lib/git.mjs — one git call with a hard wall-clock limit, for the hooks that read the
// repository inside the runner's 4 s deadline.
//
// Why not `execFileSync(…, { timeout })`: a synchronous call cannot run beside another one, so
// two 800 ms calls cost 1.6 s, and its timeout only signals git itself; a `git` that is a
// wrapper script (a version manager's shim, a slow network filesystem helper) can leave a child
// holding stdout open, and the call then waits for that child past its own timeout. Here the
// limit is a timer that settles the promise whatever the child is doing, and the child runs in
// its own process group so the whole group is killed when the timer fires.
//
// The answer always says whether git answered: `{ ok: true, out }` with stdout trimmed, or
// `{ ok: false, reason }` where reason is "timed out", "exit <code>" or the spawn error's code.
// A caller can therefore never mistake "git did not answer" for "git answered with nothing",
// which is how a timed-out `git status` used to render as a clean tree. Never rejects.

import { spawn } from "node:child_process";

/** Run `git <args>` in `cwd`; settles within `timeoutMs` (a value ≤ 0 settles at once as timed out). */
export function git(args, cwd, timeoutMs) {
  if (!(timeoutMs > 0)) return Promise.resolve({ ok: false, reason: "timed out" });
  return new Promise((resolve) => {
    let settled = false;
    let child;
    let timer;
    const done = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    try {
      child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], detached: true });
    } catch (err) {
      return done({ ok: false, reason: String(err?.code || err?.message || "spawn failed") });
    }
    timer = setTimeout(() => {
      try {
        // pid > 0 only: a failed spawn's pid is not a number, and -0 would be kill(0), this process's own group.
        if (child.pid > 0) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      child.stdout?.destroy();
      child.unref();
      done({ ok: false, reason: "timed out" });
    }, timeoutMs);
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", (err) => done({ ok: false, reason: String(err?.code || err?.message || "spawn failed") }));
    child.on("close", (code) => done(code === 0 ? { ok: true, out: out.trim() } : { ok: false, reason: `exit ${code}` }));
  });
}

/** A wall-clock budget shared by several calls: `left(cap)` is the time remaining, at most `cap`. */
export function budget(totalMs, now = () => Date.now()) {
  const end = now() + totalMs;
  return { left: (cap = Infinity) => Math.max(0, Math.min(cap, end - now())) };
}
