// decision-log.test.mjs — the SessionEnd decision-log entry and the SessionStart reader (README
// "The decision-log entry"): the newdle /wrap-up filename and frontmatter, the four sections with
// each decision's body and option, nothing written without a decision, without the directory,
// with `decisionLog.enabled` false, or when a wrap-up entry already falls inside the session; the
// file lands at the git toplevel, not the cwd. Reader: the newest entries plus open or durable
// ones within the budget; nothing when newdle's hooks are on, or when disabled.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, cli, hook, askQuestion } from "./helpers.mjs";
import { parseEntry, readDecisionLog, READ_BUDGET, ENGINEER } from "../lib/decision-log.mjs";

const SID = "s-dlog";
const LOG = join(".ai", "decision-log");

function git(b, ...args) {
  const r = spawnSync("git", args, { cwd: b.work, encoding: "utf8", env: { ...b.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
/** A repository at b.work with `.ai/decision-log/`, on branch `feat-cache`, with a SessionStart row for SID. */
function repo(b = sandbox(), { log = true } = {}) {
  git(b, "init", "-q", "-b", "main");
  writeFileSync(join(b.work, "a.txt"), "a\n");
  git(b, "add", "a.txt");
  git(b, "commit", "-qm", "a");
  git(b, "checkout", "-q", "-b", "feat-cache");
  if (log) mkdirSync(join(b.work, LOG), { recursive: true });
  hook(b, "session-start", { session_id: SID, cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  return b;
}
const end = (b, cwd = b.work) => hook(b, "session-end", { session_id: SID, cwd, hook_event_name: "SessionEnd", reason: "exit" }, { cwd });
const entries = (b) => {
  try {
    return readdirSync(join(b.work, LOG)).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }
};
const errorLines = (b) => {
  try {
    return readFileSync(b.errorsLog, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const session = { env: { LEDGER_SESSION_ID: SID } };
const asked = { sessionId: SID };
/** The sandbox's hooks run in UTC: the stamp as the hook computes it. */
function utcStamp(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, "0");
  return { day: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, hhmm: `${p(d.getUTCHours())}${p(d.getUTCMinutes())}` };
}

test("one answer → one entry at <toplevel>/.ai/decision-log/ in the wrap-up shape: filename, frontmatter, the question's body and the chosen option", () => {
  const b = repo();
  const q = askQuestion(b, { name: "cache-kind", body: "Keep the small cache or rewrite the loader?", options: "cache,rewrite", ...asked });
  cli(b, ["answer", q, "cache"], session);
  cli(b, ["note", "the loader stays; the cache gets a size cap"], session);
  const before = Date.now();
  const r = end(b);
  assert.equal(r.code, 0, r.err);
  const files = entries(b);
  assert.equal(files.length, 1, files.join(", "));
  const stamp = utcStamp(before);
  assert.match(files[0], new RegExp(`^${stamp.day}--\\d{4}--${ENGINEER}--feat-cache\\.md$`));
  const text = readFileSync(join(b.work, LOG, files[0]), "utf8");
  const fm = parseEntry(text);
  assert.equal(fm.status, "resolved");
  assert.equal(fm.durable, false);
  assert.equal(fm.engineer, ENGINEER);
  assert.match(fm.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.match(text, /^---\ndate: .*\nengineer: claude-desktop\nsession: ledger session s-dlog: 1 answer\(s\), 1 note\(s\), 0 withdrawn, 0 open\nstatus: resolved\ndurable: false\n---\n\n## What changed\n\n- the loader stays; the cache gets a size cap\n\n## Decisions made \(and why\)\n\n- Keep the small cache or rewrite the loader\? → \*\*cache\*\* \(question `cache-kind`; options: cache, rewrite; answered by .* via cli\)\n\n## Dead ends — don't retry these\n\nNone\n\n## Heads-up for whoever touches this next\n\nNone\n$/);
  assert.ok(!text.includes(q), "the id alone never stands for the decision");
  assert.deepEqual(errorLines(b), []);
});

test("withdrawn and still-open questions: dead ends and heads-up, status open; a second session end in the window writes nothing more", () => {
  const b = repo();
  const q1 = askQuestion(b, { name: "first", body: "Retry on 500?", options: "yes,no", ...asked });
  const q2 = askQuestion(b, { name: "second", body: "Which region first?", options: "eu,us", ...asked });
  const q3 = askQuestion(b, { name: "third", body: "Ship behind a flag?", options: "flag,plain", ...asked });
  cli(b, ["answer", q1, "yes"], session);
  cli(b, ["withdraw", q2], session);
  end(b);
  const files = entries(b);
  assert.equal(files.length, 1);
  const text = readFileSync(join(b.work, LOG, files[0]), "utf8");
  assert.equal(parseEntry(text).status, "open");
  assert.match(text, /## Dead ends — don't retry these\n\n- Which region first\? \(question `second`, withdrawn\)\n/);
  assert.ok(!text.includes(q2), "the withdraw note's id-only line is left out");
  assert.ok(!/Which region first\? →/.test(text), "a withdrawn question is not a decision");
  assert.match(text, /## Heads-up for whoever touches this next\n\n- Still open: Ship behind a flag\? \(question `third`; options: flag, plain\)\n/);
  assert.ok(!text.includes(q3));
  end(b);
  assert.equal(entries(b).length, 1, "the entry just written falls inside the window");
});

test("nothing is written: no answer and no note; enabled false; no .ai/decision-log; a wrap-up entry already inside the session", () => {
  // No decision.
  const none = repo();
  askQuestion(none, { name: "idle", ...asked });
  end(none);
  assert.deepEqual(entries(none), []);
  // Disabled.
  const off = repo();
  off.writeConfig({ decisionLog: { enabled: false } });
  cli(off, ["note", "decided something"], session);
  end(off);
  assert.deepEqual(entries(off), []);
  assert.match(cli(off, ["doctor"], { env: { LEDGER_REVIEW_BIN_CODEX: process.execPath, LEDGER_JUDGE_BIN: "echo yes" } }).out, /ok   decision log: off \(decisionLog\.enabled is false\)/);
  // No directory: never created.
  const noDir = repo(sandbox(), { log: false });
  cli(noDir, ["note", "decided something"], session);
  end(noDir);
  assert.deepEqual(entries(noDir), []);
  // A manual wrap-up already ran during the session.
  const wrapped = repo();
  cli(wrapped, ["note", "decided something"], session);
  const stamp = utcStamp(Date.now());
  writeFileSync(join(wrapped.work, LOG, `${stamp.day}--${stamp.hhmm}--jo-wolff--manual-wrap-up.md`), "---\nstatus: resolved\n---\n\n## What changed\n\n- by hand\n");
  end(wrapped);
  assert.deepEqual(entries(wrapped), [`${stamp.day}--${stamp.hhmm}--jo-wolff--manual-wrap-up.md`]);
  // An old entry does not count.
  const old = repo();
  cli(old, ["note", "decided something"], session);
  writeFileSync(join(old.work, LOG, "2020-01-01--0900--jo-wolff--long-ago.md"), "---\nstatus: resolved\n---\n");
  end(old);
  assert.equal(entries(old).length, 2);
});

test("the entry lands at the git toplevel when the session ran in a subdirectory, and the stamp survives a directory that cannot be written", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, () => {
  const b = repo();
  const sub = join(b.work, "packages", "api");
  mkdirSync(sub, { recursive: true });
  mkdirSync(join(sub, LOG), { recursive: true });
  cli(b, ["note", "decided in the subdirectory"], { ...session, cwd: sub });
  end(b, sub);
  assert.equal(entries(b).length, 1, "written at the toplevel");
  assert.deepEqual(readdirSync(join(sub, LOG)), [], "not at the cwd");
  // Unwritable directory: one errors.log line, the session row still stamped.
  const ro = repo();
  cli(ro, ["note", "decided"], session);
  spawnSync("chmod", ["555", join(ro.work, LOG)]);
  try {
    const r = end(ro);
    assert.equal(r.code, 0);
    const lines = errorLines(ro);
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0], / SessionEnd decision log not written: /);
  } finally {
    spawnSync("chmod", ["755", join(ro.work, LOG)]);
  }
  assert.match(cli(ro, ["doctor"], { env: { LEDGER_REVIEW_BIN_CODEX: process.execPath, LEDGER_JUDGE_BIN: "echo yes" } }).out, /ok   decision log: on/);
});

/** `n` entries, newest last by name; `flag` marks some open/durable. */
function seed(dir, n, { flag = () => "", lines = 2 } = {}) {
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= n; i++) {
    const day = `2026-01-${String(i).padStart(2, "0")}`;
    const body = Array.from({ length: lines }, (_, k) => `Line ${k + 1} of entry ${i}.`).join("\n");
    writeFileSync(join(dir, `${day}--1200--jo-wolff--topic-${i}.md`), `---\ndate: ${day}T12:00-08:00\nengineer: jo-wolff\nsession: s\nstatus: ${flag(i) === "open" ? "open" : "resolved"}\ndurable: ${flag(i) === "durable"}\n---\n\n## What changed\n\n${body}\n`);
  }
}

test("reader: the 5 newest entries, then older open or durable ones, each with its date, engineer, title and two lines; a SessionStart injects it", () => {
  const b = sandbox();
  const dir = join(b.work, LOG);
  seed(dir, 12, { flag: (i) => (i === 2 ? "open" : i === 4 ? "durable" : i === 9 ? "durable" : "") });
  const text = readDecisionLog(b.work, {});
  const lines = text.split("\n");
  assert.equal(lines[0], "ledger: decision log (.ai/decision-log, 12 entries; newest 5, then 2 open or durable):");
  assert.equal(lines[1], "- 2026-01-12T12:00-08:00 jo-wolff — topic-12");
  assert.equal(lines[2], "    Line 1 of entry 12.");
  assert.equal(lines[3], "    Line 2 of entry 12.");
  const heads = lines.filter((l) => l.startsWith("- "));
  assert.deepEqual(
    heads.map((l) => /topic-(\d+)/.exec(l)[1]),
    ["12", "11", "10", "9", "8", "4", "2"],
  );
  assert.match(heads[5], /topic-4 \[durable\]$/);
  assert.match(heads[6], /topic-2 \[open\]$/);
  assert.equal(lines.at(-1), "5 more not shown");
  const r = hook(b, "session-start", { session_id: SID, cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  assert.ok(r.json.hookSpecificOutput.additionalContext.endsWith(text), r.out);
});

test("reader: the budget holds (≤ 3000 characters, 'N more not shown'); flagged entries cap at 10", () => {
  const b = sandbox();
  seed(join(b.work, LOG), 40, { flag: () => "open", lines: 6 });
  const text = readDecisionLog(b.work, {});
  assert.ok(text.length <= READ_BUDGET, `${text.length}`);
  assert.match(text, /\n\d+ more not shown$/);
  assert.match(text.split("\n")[0], /newest 5, then 10 open or durable/);
});

test("reader: nothing when newdle's hooks are declared on at the root or above, when disabled, or with no directory or no entry", () => {
  const b = sandbox();
  seed(join(b.work, LOG), 3);
  assert.notEqual(readDecisionLog(b.work, {}), "");
  assert.equal(readDecisionLog(b.work, { decisionLog: { enabled: false } }), "");
  writeFileSync(join(b.root, "newdle-hooks.json"), JSON.stringify({ version: 1, hooks: "on" }));
  assert.equal(readDecisionLog(b.work, {}), "", "declared on above the root");
  writeFileSync(join(b.work, "newdle-hooks.json"), JSON.stringify({ version: 1, hooks: "off" }));
  assert.notEqual(readDecisionLog(b.work, {}), "", "the nearest declaration wins");
  writeFileSync(join(b.work, "newdle-hooks.json"), "{not json");
  assert.equal(readDecisionLog(b.work, {}), "", "a broken file is walked past to the on above");
  const r = hook(b, "session-start", { session_id: SID, cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  assert.ok(!(r.json?.hookSpecificOutput?.additionalContext ?? "").includes("decision log"), r.out);
  const empty = sandbox();
  assert.equal(readDecisionLog(empty.work, {}), "");
  mkdirSync(join(empty.work, LOG), { recursive: true });
  assert.equal(readDecisionLog(empty.work, {}), "");
});
