// `node ls-remote.mjs <remote> <ref> <timeoutMs>`, run by lib/review.mjs lsRemote in the
// repository folder with an environment that already rules out every prompt. Runs
// `git ls-remote` as the leader of its own process group so a timeout kills git together with
// its transport helpers (`git remote-…`, ssh, an `ext::` command), then prints one JSON line:
//   { status, stdout }              git exited (status is its exit code)
//   { timedOut: true, group }       the deadline passed; `group` false when only git itself could
//                                   be killed (no process groups here), so its helpers may live on
//   { error }                       git could not start
// This file runs as a separate process because the PreToolUse hook is synchronous: spawnSync
// cannot give its child a process group of its own.

import { spawn } from "node:child_process";

const [remote, ref, timeout] = process.argv.slice(2);
const timeoutMs = Number(timeout) || 5000;
const groups = process.platform !== "win32";

const done = (result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
};

let child;
try {
  child = spawn("git", ["-c", "core.askPass=", "-c", "credential.helper=", "-c", "credential.interactive=false", "ls-remote", "--", remote, ref], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: groups,
  });
} catch (err) {
  done({ error: err.message });
}
if (child) {
  let stdout = "";
  let finished = false;
  child.stdout.on("data", (d) => (stdout += d));
  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    let group = false;
    if (groups) {
      try {
        process.kill(-child.pid, "SIGKILL");
        group = true;
      } catch {
        /* no group to signal: fall back to git itself */
      }
    }
    if (!group) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    child.stdout.destroy();
    done({ timedOut: true, group });
  }, timeoutMs);
  child.on("error", (err) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done({ error: err.message });
  });
  child.on("close", (status) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done({ status, stdout });
  });
}
