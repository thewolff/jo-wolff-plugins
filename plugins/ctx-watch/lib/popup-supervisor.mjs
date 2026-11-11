#!/usr/bin/env node
// lib/popup-supervisor.mjs — `node popup-supervisor.mjs <outcomeFile> <token> <bin> [args…]`:
// run `bin args` (osascript and its dialog) as this process's child, wait for it however long
// the dialog stays up, then record how it ended in <outcomeFile>, which is its token's own file
// (`<state>/popups/<token>.json`, lib/popup.mjs outcomePath and recordOutcome; no other
// supervisor writes it), and exit with its status (0 for a delivery, else its code, else 1).
// showPopup starts this detached, so it outlives the tick that asked for the dialog; the next
// tick reads the outcome.
// It prints nothing and never throws: a failure to record leaves the tick's pending popup to
// expire (state.mjs PENDING_STALE_MS), which reopens the episode.

import { spawn } from "node:child_process";
import { recordOutcome, delivered } from "./popup.mjs";

/** osascript's "User canceled." (error -128): the person dismissed the dialog. */
const CANCELED = /\(-128\)/;
/** `display dialog … giving up after` prints `button returned:OK, gave up:false` (clicked) or `…, gave up:true` (timed out unread). */
const GAVE_UP = /gave up:(true|false)/;

const [outcomeFile, token, bin, ...args] = process.argv.slice(2);
let stderr = "";
let stdout = "";
let done = false;

function finish({ code = null, signal = null, error = null }) {
  if (done) return;
  done = true;
  const answer = GAVE_UP.exec(stdout)?.[1];
  const outcome = { token, at: Date.now(), bin, code, signal, error, acknowledged: code !== 0 && CANCELED.test(stderr), gaveUp: answer === undefined ? null : answer === "true" };
  recordOutcome(outcomeFile, outcome);
  process.exit(delivered(outcome) ? 0 : Number.isInteger(code) && code > 0 && code < 256 ? code : 1);
}

if (!outcomeFile || !token || !bin) {
  process.exit(2);
} else {
  try {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      if (stdout.length < 1_000) stdout += d;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      if (stderr.length < 1_000) stderr += d;
    });
    child.on("error", (err) => finish({ error: err.message }));
    child.on("close", (code, signal) => finish({ code, signal }));
  } catch (err) {
    finish({ error: err.message });
  }
}
