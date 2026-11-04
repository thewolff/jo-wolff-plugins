// lib/popup.mjs — the macOS popup the launchd tick shows once per down episode: one
// `/usr/bin/osascript -e 'display dialog …'` call (as2's `alarmPopup` shape, without the sound
// and the wrapper script), detached so the tick returns and the next tick still runs while the
// dialog is up, giving up after GIVE_UP_SECS so a dialog nobody saw does not stay for ever.
//
// `spawn` is injectable: tests never open a dialog. `{ started, detail }`; never throws.

import { spawn as nodeSpawn } from "node:child_process";

export const OSASCRIPT = "/usr/bin/osascript";
export const GIVE_UP_SECS = 3600;
export const TITLE = "ctx-watch";

const str = (s) => `"${String(s).replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** The AppleScript for one dialog. */
export function dialogScript({ title = TITLE, text, giveUpSecs = GIVE_UP_SECS }) {
  return `display dialog ${str(text)} with title ${str(title)} buttons {"OK"} default button "OK" with icon caution giving up after ${giveUpSecs}`;
}

function realSpawn(bin, args) {
  const child = nodeSpawn(bin, args, { detached: true, stdio: "ignore" });
  child.unref();
  return { pid: child.pid };
}

/** Show the dialog, detached. */
export function showPopup({ text, title = TITLE, giveUpSecs = GIVE_UP_SECS, spawn = realSpawn } = {}) {
  const args = ["-e", dialogScript({ title, text, giveUpSecs })];
  try {
    const r = spawn(OSASCRIPT, args);
    return { started: true, detail: `popup started (${OSASCRIPT}${r?.pid ? `, pid ${r.pid}` : ""}, gives up after ${giveUpSecs} s)` };
  } catch (err) {
    return { started: false, detail: `popup not shown: ${err.message}` };
  }
}
