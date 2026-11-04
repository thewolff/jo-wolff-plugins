// lib/popup.mjs — the macOS popup the launchd tick shows once per down episode: one
// `/usr/bin/osascript -e 'display dialog …'` call (as2's `alarmPopup` shape, without the sound
// and the wrapper script), giving up after GIVE_UP_SECS so a dialog nobody saw does not stay for
// ever, run under a detached supervisor (lib/popup-supervisor.mjs) so the tick returns and the
// next tick still runs while the dialog is up.
//
// Delivery is confirmed, not assumed. The supervisor is osascript's parent for its whole life:
// when osascript ends it writes `{ token, at, bin, code, signal, error, acknowledged }` to its
// token's own outcome file (`<state>/popups/<token>.json`, atomically) and exits with
// osascript's status. One file per token: a supervisor from an earlier episode that ends late
// writes its own file and cannot replace the current popup's outcome. Exit 0 (OK clicked, or
// the give-up) is delivered; so is "User canceled" (-128): a person dismissed it. Anything else
// (no GUI session, "No user interaction allowed", a crash) is not delivered, whenever it happens.
//
// showPopup() resolves `{ started, pending?, token?, detail }` and never throws or rejects:
//   started: false            the supervisor could not start, or it ended inside the grace with
//                             anything but a delivery (the reason from its outcome when it wrote
//                             one, else its exit code or signal);
//   started: true             it ended inside the grace with a delivery (answered at once);
//   started: true, pending    it was still running GRACE_MS later: the dialog may be up, and
//                             the caller keeps its claim on `token` pending. A later tick reads
//                             that token's outcome file (readOutcome) and settles it: delivered
//                             latches the episode, anything else reopens it (state.mjs popupSettled).
//
// `spawn` is injectable: tests never open a dialog. It is called as spawn(node, [SUPERVISOR,
// outcomeFile, token, bin, ...osascriptArgs]) and returns the child (an EventEmitter with `pid`,
// emitting `error`, `exit`) or throws.

import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const OSASCRIPT = "/usr/bin/osascript";
export const GIVE_UP_SECS = 3600;
export const TITLE = "ctx-watch";
/** How long a spawned popup has to die before it counts as pending (possibly up) rather than failed. */
export const GRACE_MS = 1_000;
/** The script that runs osascript and records how it ended. */
export const SUPERVISOR = fileURLToPath(new URL("./popup-supervisor.mjs", import.meta.url));

const str = (s) => `"${String(s).replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** The AppleScript for one dialog. */
export function dialogScript({ title = TITLE, text, giveUpSecs = GIVE_UP_SECS }) {
  return `display dialog ${str(text)} with title ${str(title)} buttons {"OK"} default button "OK" with icon caution giving up after ${giveUpSecs}`;
}

/** A popup token: what a tick makes (`<ms>-<pid>`) and anything else safe as a file name. */
export const TOKEN = /^[A-Za-z0-9_-]{1,100}$/;

/** `<state>/popups/<token>.json`: that popup's supervisor's outcome; null for a token that is not a safe file name. */
export function outcomePath(dir, token) {
  return typeof token === "string" && TOKEN.test(token) ? join(dir, "popups", `${token}.json`) : null;
}

const validMs = (v) => Number.isInteger(v) && v >= 0 && v <= 8.64e15;
const nullOr = (f) => (v) => v === null || f(v);
const isStr = (v) => typeof v === "string";

/** The outcome at `file`, or null when missing, unreadable, not JSON, or any field out of shape. */
export function readOutcome(file) {
  let j;
  try {
    j = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const { token, at, bin, code, signal, error, acknowledged } = j;
  const ok =
    isStr(token) && token.length > 0 && token.length <= 100 && validMs(at) && isStr(bin) && nullOr(Number.isInteger)(code) && nullOr(isStr)(signal) && nullOr(isStr)(error) && typeof acknowledged === "boolean";
  return ok ? { token, at, bin, code, signal, error, acknowledged } : null;
}

/** Write `outcome` to `file` atomically (temp file + rename). Never throws; false when it could not. */
export function recordOutcome(file, outcome) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(outcome) + "\n");
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing was left */
    }
    return false;
  }
}

/** Whether an outcome is a delivery: exit 0, or the person dismissed the dialog. */
export function delivered(outcome) {
  return outcome.code === 0 || outcome.acknowledged === true;
}

/** `spawn <bin> ENOENT`, `<bin> ended by SIGKILL`, `<bin> ended with exit 7`. */
export function describeExit({ bin, code, signal, error }) {
  if (error) return error;
  return `${bin} ended ${signal ? `by ${signal}` : `with exit ${code}`}`;
}

function realSpawn(cmd, args) {
  const child = nodeSpawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

/** Show the dialog under the supervisor; resolves once the outcome is known or pending (at most `graceMs` later). */
export function showPopup({ text, title = TITLE, giveUpSecs = GIVE_UP_SECS, spawn = realSpawn, bin = OSASCRIPT, graceMs = GRACE_MS, outcomeFile, token = `${Date.now()}-${process.pid}` } = {}) {
  if (typeof outcomeFile !== "string" || !outcomeFile) return Promise.resolve({ started: false, detail: "popup not shown: no outcome file to confirm delivery in" });
  const args = [SUPERVISOR, outcomeFile, token, bin, "-e", dialogScript({ title, text, giveUpSecs })];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, args);
    } catch (err) {
      return resolve({ started: false, detail: `popup not shown: ${err.message}` });
    }
    const who = `${bin}${child.pid ? ` under supervisor pid ${child.pid}` : ""}`;
    let settled = false;
    let timer;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.on("error", (err) => finish({ started: false, detail: `popup not shown: ${err.message}` }));
    child.on("exit", (code, signal) => {
      // The supervisor wrote how osascript ended before it exited; without that, its own status.
      const o = readOutcome(outcomeFile);
      const outcome = o?.token === token ? o : { bin, code, signal, error: null, acknowledged: false };
      if (delivered(outcome)) return finish({ started: true, detail: `popup shown (${who}, answered within ${graceMs} ms)` });
      finish({ started: false, detail: `popup not shown: ${describeExit(outcome)}${outcome.error ? "" : ` within ${graceMs} ms`}` });
    });
    timer = setTimeout(() => finish({ started: true, pending: true, token, detail: `popup started (${who}, gives up after ${giveUpSecs} s); delivered once it exits 0` }), graceMs);
  });
}
