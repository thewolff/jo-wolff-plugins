// lib/popup.mjs — the macOS popup the launchd tick shows once per down episode: one
// `/usr/bin/osascript -e 'display dialog …'` call (as2's `alarmPopup` shape, without the sound
// and the wrapper script), detached so the tick returns and the next tick still runs while the
// dialog is up, giving up after GIVE_UP_SECS so a dialog nobody saw does not stay for ever.
//
// showPopup() resolves `{ started, detail }` once the outcome is known, and never throws or
// rejects. Delivered means the child spawned and was still running GRACE_MS later (the dialog
// is up; osascript stays until the button or the give-up). Not delivered means the spawn failed
// (`error`: no osascript, EPERM) or the child ended inside the grace (`exit`: no GUI session,
// "No user interaction allowed", a bad script), with the code or signal in `detail`. A child
// that exits 0 inside the grace is counted as delivered (someone clicked at once).
//
// `spawn` is injectable: tests never open a dialog. It returns the child (an EventEmitter with
// `pid`, emitting `spawn`, `error`, `exit`) or throws.

import { spawn as nodeSpawn } from "node:child_process";

export const OSASCRIPT = "/usr/bin/osascript";
export const GIVE_UP_SECS = 3600;
export const TITLE = "ctx-watch";
/** How long a spawned osascript has to die before the dialog counts as delivered. */
export const GRACE_MS = 1_000;

const str = (s) => `"${String(s).replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** The AppleScript for one dialog. */
export function dialogScript({ title = TITLE, text, giveUpSecs = GIVE_UP_SECS }) {
  return `display dialog ${str(text)} with title ${str(title)} buttons {"OK"} default button "OK" with icon caution giving up after ${giveUpSecs}`;
}

function realSpawn(bin, args) {
  const child = nodeSpawn(bin, args, { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

/** Show the dialog, detached; resolves once the outcome is known (at most `graceMs` later). */
export function showPopup({ text, title = TITLE, giveUpSecs = GIVE_UP_SECS, spawn = realSpawn, bin = OSASCRIPT, graceMs = GRACE_MS } = {}) {
  const args = ["-e", dialogScript({ title, text, giveUpSecs })];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args);
    } catch (err) {
      return resolve({ started: false, detail: `popup not shown: ${err.message}` });
    }
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
      if (code === 0) return finish({ started: true, detail: `popup shown (${bin}${child.pid ? `, pid ${child.pid}` : ""}, answered within ${graceMs} ms)` });
      finish({ started: false, detail: `popup not shown: ${bin} ended ${signal ? `by ${signal}` : `with exit ${code}`} within ${graceMs} ms` });
    });
    timer = setTimeout(() => finish({ started: true, detail: `popup started (${bin}${child.pid ? `, pid ${child.pid}` : ""}, gives up after ${giveUpSecs} s)` }), graceMs);
  });
}
