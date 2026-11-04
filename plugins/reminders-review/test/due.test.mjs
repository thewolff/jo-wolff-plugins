import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLOCK_NOTE,
  buildBlock,
  checkDue,
  cleanTitle,
  dueCheck,
  faultLine,
  formatDue,
  parseReminders,
  readDue,
  readStamp,
  runRemindctl,
  sessionStampPath,
  THROTTLE_MS,
  TITLE_MAX,
  watchedLists,
  writeStamp,
} from "../lib/due.mjs";
import { FIXTURES, NOW, TZ, sandbox } from "./helpers.mjs";

const fixture = (name) => readFileSync(join(FIXTURES, name), "utf8");
/** A run() answering from the fixtures by bucket; `answers` overrides per bucket. */
const fakeRun = (answers = {}) => async (args) => answers[args[1]] ?? { ok: true, stdout: fixture(`remindctl-show-${args[1]}.json`) };

const EXPECTED_PLUMB =
  "Due (list Plumb): Nov 3 9:00 AM Renew the domain; 10:00 AM Test tonight's plugin ships — guide: /Users/example/agent-scratch/TESTING-GUIDE.md; 11:00 AM Check the evals gate row; manifest + scenarios per plugin; 12:00 PM Build the handed-command check (after gate-rows merges)";

test("the block is built from the captured JSON: overdue first, then today, an item in both once", async () => {
  const { sections, failures } = await readDue(["Plumb"], { run: fakeRun() });
  assert.deepEqual(failures, []);
  assert.equal(buildBlock(sections, { now: NOW, timeZone: TZ }), `${EXPECTED_PLUMB}\n${BLOCK_NOTE}`);
});

test("nothing due in any list → no block", async () => {
  const empty = { ok: true, stdout: fixture("remindctl-show-empty.json") };
  const { sections } = await readDue(["Plumb", "Errands"], { run: fakeRun({ overdue: empty, today: empty }) });
  assert.equal(buildBlock(sections, { now: NOW, timeZone: TZ }), null);
});

test("one line per list with something due, in watch order", async () => {
  const empty = { ok: true, stdout: "[]" };
  const run = async (args) => (args[3] === "Errands" ? empty : { ok: true, stdout: fixture(`remindctl-show-${args[1]}.json`) });
  const { sections } = await readDue(["Errands", "Plumb", "Work"], { run });
  const block = buildBlock(sections, { now: NOW, timeZone: TZ });
  assert.deepEqual(
    block.split("\n").slice(0, -1).map((l) => l.slice(0, l.indexOf(":"))),
    ["Due (list Plumb)", "Due (list Work)"],
  );
});

test("completed reminders are dropped; an entry with no title is a parse problem", () => {
  assert.deepEqual(parseReminders(JSON.stringify([{ title: "a", isCompleted: true }, { title: "b", dueDate: null }])).items.map((i) => i.title), ["b"]);
  assert.match(parseReminders(JSON.stringify([{ notes: "x" }])).problem, /no title/);
  assert.match(parseReminders("{}").problem, /not a JSON array/);
  assert.match(parseReminders("nope").problem, /not JSON/);
});

test("times are local: today shows the time, another day the date too, all-day the word or the date", () => {
  const o = { now: NOW, timeZone: TZ };
  assert.equal(formatDue({ dueDate: "2026-11-04T18:00:00Z" }, o), "10:00 AM");
  assert.equal(formatDue({ dueDate: "2026-11-03T17:00:00Z" }, o), "Nov 3 9:00 AM");
  assert.equal(formatDue({ dueDate: "2026-11-04T08:00:00Z", allDay: true }, o), "today");
  assert.equal(formatDue({ dueDate: "2026-11-02T08:00:00Z", allDay: true }, o), "Nov 2");
  assert.equal(formatDue({ dueDate: null }, o), "");
  assert.equal(formatDue({ dueDate: "garbage" }, o), "");
});

test("titles are one line and cut at TITLE_MAX", () => {
  assert.equal(cleanTitle("a\n  b\tc"), "a b c");
  const long = cleanTitle("x".repeat(500));
  assert.equal(long.length, TITLE_MAX);
  assert.ok(long.endsWith("…"));
});

test("watched lists: the env override wins, even empty; else config `watch`; unconfigured is none", () => {
  const box = sandbox({ withStub: false });
  try {
    assert.deepEqual(watchedLists(box.env), { lists: [], source: join(box.configDir, "config.json") });
    mkdirSync(box.configDir, { recursive: true });
    writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ lists: ["Errands"] }));
    assert.deepEqual(watchedLists(box.env).lists, [], "the review skill's `lists` is not `watch`");
    writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ lists: ["Errands"], watch: ["Plumb", " Plumb ", "Work"] }));
    assert.deepEqual(watchedLists(box.env).lists, ["Plumb", "Work"]);
    assert.deepEqual(watchedLists({ ...box.env, REMINDERS_REVIEW_WATCH: "A, B,,A" }).lists, ["A", "B"]);
    assert.deepEqual(watchedLists({ ...box.env, REMINDERS_REVIEW_WATCH: "" }).lists, []);
    writeFileSync(join(box.configDir, "config.json"), "{ nope");
    assert.match(watchedLists(box.env).problem, /is not JSON/);
    writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ watch: "Plumb" }));
    assert.match(watchedLists(box.env).problem, /not a list of list names/);
  } finally {
    box.release();
  }
});

test("the fault line names the fix for each kind, on one line", () => {
  assert.match(faultLine({ failures: [{ list: "Plumb", kind: "unauthorized", detail: "x" }] }), /fix: `remindctl authorize`/);
  assert.match(faultLine({ failures: [{ list: "Plumb", kind: "missing", detail: "remindctl not found" }] }), /brew install steipete\/tap\/remindctl/);
  assert.match(faultLine({ failures: [{ list: "Nope", kind: "list", detail: "x" }] }), /`remindctl list`/);
  assert.match(faultLine({ failures: [{ list: "P", kind: "timeout", detail: "x" }] }), /`remindctl doctor`/);
  const two = faultLine({ failures: [{ list: "A", kind: "unauthorized", detail: "x" }, { list: "B", kind: "unauthorized", detail: "x" }] });
  assert.match(two, /^reminders-review: due reminders not checked: list A, B \(x\); fix: /);
  assert.ok(!two.includes("\n"));
  assert.equal(faultLine({}), null);
});

test("throttle: missing or an hour old checks; within the hour does not; a stamp from the future checks", () => {
  assert.equal(checkDue(null, NOW), true);
  assert.equal(checkDue(NOW - THROTTLE_MS + 1, NOW), false);
  assert.equal(checkDue(NOW - THROTTLE_MS, NOW), true);
  assert.equal(checkDue(NOW + 60_000, NOW), true);
});

test("stamp round trip, and session ids become safe file names", () => {
  const box = sandbox({ withStub: false });
  try {
    const p = sessionStampPath("../../etc/passwd", box.env);
    assert.equal(p, join(box.stateDir, "sessions", ".._.._etc_passwd.json"));
    assert.equal(readStamp(p), null);
    assert.equal(writeStamp(p, NOW), null);
    assert.equal(readStamp(p), NOW);
    assert.equal(sessionStampPath("", box.env), join(box.stateDir, "sessions", "no-session.json"));
  } finally {
    box.release();
  }
});

// dueCheck with injected time and run: the throttle and silence rules, without spawning.
test("dueCheck: unconfigured is silent and writes nothing", async () => {
  const box = sandbox({ withStub: false });
  try {
    let ran = 0;
    const run = async () => (ran++, { ok: true, stdout: "[]" });
    assert.equal(await dueCheck("SessionStart", { session_id: "s1" }, { env: box.env, run, now: () => NOW }), null);
    assert.equal(await dueCheck("UserPromptSubmit", { session_id: "s1" }, { env: box.env, run, now: () => NOW }), null);
    assert.equal(ran, 0);
    assert.throws(() => readFileSync(join(box.stateDir, "errors.log")), /ENOENT/);
    assert.throws(() => readFileSync(sessionStampPath("s1", box.env)), /ENOENT/);
  } finally {
    box.release();
  }
});

test("dueCheck: the prompt throttle — first prompt fires, a second within the hour is silent, one an hour later fires", async () => {
  const box = sandbox({ withStub: false, extra: { REMINDERS_REVIEW_WATCH: "Plumb" } });
  try {
    let t = NOW;
    const deps = { env: box.env, run: fakeRun(), now: () => t, timeZone: TZ };
    const first = await dueCheck("UserPromptSubmit", { session_id: "s1" }, deps);
    assert.equal(first.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.ok(first.hookSpecificOutput.additionalContext.startsWith("Due (list Plumb): "));
    t = NOW + THROTTLE_MS - 1;
    assert.equal(await dueCheck("UserPromptSubmit", { session_id: "s1" }, deps), null);
    assert.ok((await dueCheck("UserPromptSubmit", { session_id: "other" }, deps))?.hookSpecificOutput, "the throttle is per session");
    t = NOW + THROTTLE_MS;
    assert.ok((await dueCheck("UserPromptSubmit", { session_id: "s1" }, deps))?.hookSpecificOutput);
  } finally {
    box.release();
  }
});

test("dueCheck: SessionStart always checks and stamps, so the next prompt within the hour is silent", async () => {
  const box = sandbox({ withStub: false, extra: { REMINDERS_REVIEW_WATCH: "Plumb" } });
  try {
    const deps = { env: box.env, run: fakeRun(), now: () => NOW, timeZone: TZ };
    assert.ok((await dueCheck("SessionStart", { session_id: "s1" }, deps)).hookSpecificOutput);
    assert.ok((await dueCheck("SessionStart", { session_id: "s1" }, deps)).hookSpecificOutput, "SessionStart is not throttled");
    assert.equal(await dueCheck("UserPromptSubmit", { session_id: "s1" }, deps), null);
  } finally {
    box.release();
  }
});

test("dueCheck: a failing list is logged and named at SessionStart; a working list still injects", async () => {
  const box = sandbox({ withStub: false, extra: { REMINDERS_REVIEW_WATCH: "Plumb,Gone" } });
  try {
    const run = async (args) => (args[3] === "Gone" ? { ok: false, kind: "list", detail: 'List not found: "Gone".' } : { ok: true, stdout: fixture(`remindctl-show-${args[1]}.json`) });
    const out = await dueCheck("SessionStart", { session_id: "s1" }, { env: box.env, run, now: () => NOW, timeZone: TZ });
    assert.match(out.systemMessage, /^reminders-review: due reminders not checked: list Gone \(.*\); fix: `remindctl list`/);
    assert.ok(out.hookSpecificOutput.additionalContext.startsWith(EXPECTED_PLUMB));
    assert.match(readFileSync(join(box.stateDir, "errors.log"), "utf8"), /SessionStart list Gone: list: List not found/);
  } finally {
    box.release();
  }
});

test("dueCheck: a broken config is named at SessionStart and silent on prompts", async () => {
  const box = sandbox({ withStub: false });
  try {
    mkdirSync(box.configDir, { recursive: true });
    writeFileSync(join(box.configDir, "config.json"), "{ nope");
    const deps = { env: box.env, run: fakeRun(), now: () => NOW };
    const out = await dueCheck("SessionStart", { session_id: "s1" }, deps);
    assert.match(out.systemMessage, /config\.json is not JSON.*fix: write `\{"watch": \["<list>"\]\}` there/);
    assert.equal(out.hookSpecificOutput, undefined);
    assert.equal(await dueCheck("UserPromptSubmit", { session_id: "s2" }, deps), null);
    assert.equal(readFileSync(join(box.stateDir, "errors.log"), "utf8").trim().split("\n").length, 2);
  } finally {
    box.release();
  }
});

// runRemindctl against the stub: the adapter's unavailable paths.
test("runRemindctl: stub output, exit 1, a slow child, and remindctl off PATH", async () => {
  const box = sandbox();
  try {
    const ok = await runRemindctl(["show", "today", "--list", "Plumb", "--json"], { env: box.env });
    assert.equal(ok.ok, true);
    assert.equal(parseReminders(ok.stdout).items.length, 3);
    const denied = await runRemindctl(["show", "today", "--list", "Plumb", "--json"], { env: { ...box.env, STUB_REMINDCTL: "fail" } });
    assert.equal(denied.kind, "unauthorized");
    const started = Date.now();
    const slow = await runRemindctl(["show", "today", "--list", "Plumb", "--json"], { env: { ...box.env, STUB_REMINDCTL: "slow" }, timeoutMs: 300 });
    assert.equal(slow.kind, "timeout");
    assert.ok(Date.now() - started < 2_000);
    const gone = await runRemindctl(["show", "today"], { env: { ...box.env, PATH: "/usr/bin:/bin" } });
    assert.equal(gone.kind, "missing");
    const explicit = await runRemindctl(["show", "today"], { env: { ...box.env, REMINDERS_REVIEW_REMINDCTL: join(box.root, "nope") } });
    assert.equal(explicit.kind, "missing");
  } finally {
    box.release();
  }
});

test("runRemindctl: the captured unknown-list answer maps to kind list", async () => {
  const box = sandbox();
  try {
    const stub = join(box.root, "bin", "remindctl");
    writeFileSync(stub, `#!/bin/sh\ncat "${join(FIXTURES, "remindctl-list-not-found.unavailable.txt")}" >&2\nexit 1\n`);
    const r = await runRemindctl(["show", "today", "--list", "NoSuchList", "--json"], { env: box.env });
    assert.equal(r.kind, "list");
    assert.match(r.detail, /List not found/);
  } finally {
    box.release();
  }
});
