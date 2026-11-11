#!/usr/bin/env node
// lib/bounded-run.mjs — `node bounded-run.mjs <timeoutMs> <graceMs> <cmd> [args…]`: run `cmd` in
// its own process group with this process's stdio, and at `timeoutMs` send the group SIGTERM;
// whatever of the group is still running `graceMs` later gets SIGKILL. probe.mjs runCtx spawns
// this (synchronously, under spawnSync) for the one ctx command that changes state, `ctx index
// mode auto`, so a slow repair is asked to stop and given time to leave its files whole instead
// of being killed mid-write: spawnSync alone can only send one signal, and a child that ignores
// SIGTERM would then hold it for ever.
//
// The group is ended when the leader exits as well: anything the command left in its group
// gets SIGTERM, and SIGKILL `graceMs` later if still there, before this process exits. ctx's
// daemon is not in it: ctx starts its persistent daemon with setsid() (ctx-daemon-runtime
// launch.rs spawn_detached) and its finite workers with setpgid(0, 0) (spawn_attached), each in
// a group of its own; what this reaps is a stray the command did not detach.
//
// Exit: the command's own status (or 128 + its signal number); 124 after a timeout, with
// TIMEOUT_MARK on stderr; 127 when the command could not start, with SPAWN_MARK<code> on stderr.

import { spawn } from "node:child_process";
import { constants } from "node:os";

export const TIMEOUT_MARK = "ctx-watch-bounded-run: timed out";
export const SPAWN_MARK = "ctx-watch-bounded-run: spawn ";
const POLL_MS = 50;

const [timeoutArg, graceArg, cmd, ...args] = process.argv.slice(2);
const timeoutMs = Number(timeoutArg);
const graceMs = Number(graceArg);

if (!(timeoutMs > 0) || !(graceMs >= 0) || !cmd) {
  process.stderr.write("usage: bounded-run.mjs <timeoutMs> <graceMs> <cmd> [args…]\n");
  process.exit(2);
}

const child = spawn(cmd, args, { stdio: "inherit", detached: true });
let timedOut = false;
let leaderGone = false;
const signalGroup = (sig) => {
  try {
    process.kill(-child.pid, sig);
    return true;
  } catch {
    return false;
  }
};
const groupAlive = () => signalGroup(0);
const finishTimedOut = () => {
  signalGroup("SIGKILL");
  process.stderr.write(`\n${TIMEOUT_MARK}\n`);
  process.exit(124);
};

let killTimer;
const termTimer = setTimeout(() => {
  timedOut = true;
  signalGroup("SIGTERM");
  killTimer = setTimeout(finishTimedOut, graceMs);
  // The group may leave before the grace is out: then there is nothing left to kill.
  const poll = setInterval(() => {
    if (leaderGone && !groupAlive()) {
      clearInterval(poll);
      clearTimeout(killTimer);
      process.stderr.write(`\n${TIMEOUT_MARK}\n`);
      process.exit(124);
    }
  }, POLL_MS);
}, timeoutMs);

child.on("error", (err) => {
  clearTimeout(termTimer);
  process.stderr.write(`${SPAWN_MARK}${err.code ?? err.message}\n`);
  process.exit(127);
});
/** End whatever is left of the group (SIGTERM, then SIGKILL after the grace), then exit `code`. */
const reapThenExit = (code) => {
  if (!groupAlive()) process.exit(code);
  signalGroup("SIGTERM");
  const until = Date.now() + graceMs;
  const poll = setInterval(() => {
    if (!groupAlive()) {
      clearInterval(poll);
      process.exit(code);
    }
    if (Date.now() >= until) {
      clearInterval(poll);
      signalGroup("SIGKILL");
      process.exit(code);
    }
  }, POLL_MS);
};

child.on("exit", (code, signal) => {
  leaderGone = true;
  if (timedOut) return; // the poll above or the grace timer ends this run
  clearTimeout(termTimer);
  reapThenExit(code ?? 128 + (constants.signals[signal] ?? 0));
});
