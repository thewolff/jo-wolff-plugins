#!/usr/bin/env node
// capture-fixtures.mjs — a one-off, run by hand, never by `node --test`. `node --test` runs every
// .mjs under test/, this file included, so it exits at once when NODE_TEST_CONTEXT is set (the
// variable the test runner gives each file it runs). Run by hand, it runs every review adapter once against the real CLI installed on this
// machine, and the real judge once, and saves what each printed under test/fixtures/. The tests
// (fixtures.test.mjs) read the saved files, so the parsers are checked against real replies.
//
//   node test/capture-fixtures.mjs [lab …]      (default: every adapter, then the judge)
//   node test/capture-fixtures.mjs --unavailable [lab …]
//       runs each real CLI with no credentials (an empty HOME and no API variables) and saves
//       only <lab>.unavailable.txt (and judge.unavailable.txt): the real error each prints when
//       it cannot run. <lab>.txt is kept. Every adapter has both files, so its unavailable path
//       is tested against a real failure (the plugin gate's second check asks for the sibling).
//
// Each lab runs through its own adapter (the same arguments, scratch folder and environment a
// review uses); LEDGER_REVIEW_BIN_<LAB> points at a wrapper that runs the real binary and keeps a
// copy of its stdout. Saved per lab:
//   fixtures/<lab>.txt              the CLI's raw stdout, when it ran
//   fixtures/<lab>.unavailable.txt  the error the adapter threw, when it did not
// The judge (LEDGER_JUDGE_BIN, else review.judgeCommand, else the i-have-audhd profile's
// enforcement.judgeCommand) is asked whether FIX resolves FINDING; its stdout is fixtures/judge.txt
// (or judge.unavailable.txt). Stale files for a lab are removed first.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ADAPTERS, REVIEW_TIMEOUT_MS } from "../lib/review.mjs";
import { judgeCommand, passageFor } from "../lib/judge.mjs";

const UNAVAILABLE_TIMEOUT_MS = 60_000;
import { open } from "../lib/db.mjs";
import { ask } from "../lib/judge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

// The change every lab reviews: `add` subtracts. Kept in a file so the tests can name it.
export const DIFF = `diff --git a/math.js b/math.js
index 0000000..1111111 100644
--- a/math.js
+++ b/math.js
@@ -1,3 +1,3 @@
 export function add(a, b) {
-  return a + b;
+  return a - b;
 }
`;
export const FINDING = "[blocking] math.js:2 add() returns a - b, so it subtracts instead of adding";
export const FIX = `diff --git a/math.js b/math.js
--- a/math.js
+++ b/math.js
@@ -1,3 +1,3 @@
 export function add(a, b) {
-  return a - b;
+  return a + b;
 }
`;

function which(bin) {
  const r = spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function clear(name) {
  for (const f of [`${name}.txt`, `${name}.unavailable.txt`]) rmSync(join(FIXTURES, f), { force: true });
}

// An error message as saved: the wrapper's path becomes the lab's binary name, the scratch
// folder `<scratch>`, the home folder `~`, and account or key ids `<redacted>`, so a fixture
// carries nothing about this machine.
function scrub(message, lab, bin, scratch = "\0") {
  // A message cut with `…` may keep only the tail of the scratch path: the longest suffix of
  // the path found right after the `…` goes too.
  const cutTail = (text) =>
    text.replace(/…(\S+)/g, (m, rest) => {
      for (let i = 1; i < scratch.length; i++) {
        const suffix = scratch.slice(i);
        if (suffix.length >= 8 && rest.startsWith(suffix)) return `…<scratch>${rest.slice(suffix.length)}`;
      }
      return m;
    });
  return cutTail(String(message).replace(/\S*\/wrap-[a-z]+/g, bin).split(scratch).join("<scratch>"))
    .split(process.env.HOME || "\0").join("~")
    .replace(/\b(org|ak|sk|acct)-[A-Za-z0-9]{8,}\b/g, "$1-<redacted>");
}

/** An environment with no credentials: PATH and a scratch HOME, nothing else. */
function bareEnv(scratch) {
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  return { PATH: process.env.PATH, HOME: home, TMPDIR: scratch, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"), LANG: process.env.LANG ?? "C" };
}

async function captureLab(lab, adapter, scratch, { unavailable = false } = {}) {
  if (unavailable) rmSync(join(FIXTURES, `${lab}.unavailable.txt`), { force: true });
  else clear(lab);
  const out = join(FIXTURES, `${lab}.txt`);
  const real = which(adapter.defaultBin);
  const env = unavailable ? bareEnv(scratch) : { ...process.env };
  if (real) {
    // The wrapper runs inside the reviewer's allowlisted environment, so every path is literal.
    const wrapper = join(scratch, `wrap-${lab}`);
    writeFileSync(wrapper, `#!/bin/sh\n"${real}" "$@" > "${out}.part"\nc=$?\ncat "${out}.part"\nexit $c\n`);
    chmodSync(wrapper, 0o755);
    env[`LEDGER_REVIEW_BIN_${lab.toUpperCase()}`] = wrapper;
  }
  const started = Date.now();
  try {
    if (!real) throw new Error(`${adapter.defaultBin} not found on PATH`);
    const r = await adapter.run({ diff: DIFF, timeoutMs: unavailable ? UNAVAILABLE_TIMEOUT_MS : REVIEW_TIMEOUT_MS, env, config: {} });
    if (unavailable) throw new Error(`${lab} ran without credentials and replied (verdict ${r.verdict}); no failure to save`);
    writeFileSync(out, readFileSync(`${out}.part`));
    return `${lab}: ran in ${Math.round((Date.now() - started) / 1000)}s, verdict ${r.verdict}, model ${r.model ?? "default"}, ${r.items.length} finding(s): ${r.items.map((i) => `[${i.severity}] ${i.text.slice(0, 80)}`).join(" | ") || "none"}`;
  } catch (err) {
    writeFileSync(join(FIXTURES, `${lab}.unavailable.txt`), `${scrub(err.message, lab, adapter.defaultBin, scratch)}\n`);
    return `${lab}: unavailable after ${Math.round((Date.now() - started) / 1000)}s: ${err.message}`;
  } finally {
    rmSync(`${out}.part`, { force: true });
  }
}

async function captureJudge(scratch, { unavailable = false } = {}) {
  if (unavailable) rmSync(join(FIXTURES, "judge.unavailable.txt"), { force: true });
  else clear("judge");
  const source = judgeCommand({}, process.env);
  const out = join(FIXTURES, unavailable ? "judge.unavailable.part" : "judge.txt");
  if (!source?.command) {
    writeFileSync(join(FIXTURES, "judge.unavailable.txt"), "no judge command configured\n");
    return "judge: unavailable: no judge command configured";
  }
  const store = open(join(scratch, "judge.db"));
  const db = store.db ?? store;
  try {
    // A scratch state folder: a judge failure is logged there, not in the user's errors.log.
    const answer = await ask({
      db,
      dbPath: join(scratch, "judge.db"),
      config: {},
      env: unavailable ? { ...bareEnv(scratch), LEDGER_JUDGE_BIN: `${source.command} 2>&1 | tee '${out}'` } : { ...process.env, XDG_STATE_HOME: scratch, LEDGER_JUDGE_BIN: `${source.command} | tee '${out}'` },
      passage: passageFor(FINDING, FIX),
    });
    if (unavailable) {
      const printed = existsSync(out) ? readFileSync(out, "utf8") : "";
      rmSync(out, { force: true });
      if (answer.verdict !== null && !answer.error) throw new Error(`the judge ran without credentials and answered ${answer.verdict}; no failure to save`);
      writeFileSync(join(FIXTURES, "judge.unavailable.txt"), `${scrub(`${answer.error ?? "no answer"}${printed.trim() ? `\n${printed.trim()}` : ""}`, "judge", "judge", scratch)}\n`);
      return `judge (${source.source}): unavailable without credentials: ${answer.error}`;
    }
    if (!existsSync(out) || !readFileSync(out, "utf8").trim()) {
      rmSync(out, { force: true });
      writeFileSync(join(FIXTURES, "judge.unavailable.txt"), `judge printed nothing (${answer.verdict}: ${answer.error})\n`);
    }
    return `judge (${source.source}): answered ${answer.verdict}${answer.error ? ` (${answer.error})` : ""}`;
  } finally {
    db.close();
  }
}

if (process.env.NODE_TEST_CONTEXT) process.exit(0);
const unavailable = process.argv.includes("--unavailable");
const want = process.argv.slice(2).filter((a) => a !== "--unavailable");
mkdirSync(FIXTURES, { recursive: true });
writeFileSync(join(FIXTURES, "review.diff"), DIFF);
const scratch = mkdtempSync(join(tmpdir(), "ledger-capture-"));
try {
  const labs = Object.entries(ADAPTERS).filter(([lab]) => !want.length || want.includes(lab));
  const lines = await Promise.all(labs.map(([lab, adapter]) => captureLab(lab, adapter, scratch, { unavailable })));
  if (!want.length || want.includes("judge")) lines.push(await captureJudge(scratch, { unavailable }));
  console.log(lines.join("\n"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
