// test/consult-history.test.mjs — the `consult-history` Stop check: the switch (flag file, config
// file, default), the resume marker's round trip from the SessionStart hook to the Stop hook,
// the transcript scan (what counts as a ctx history call, which entries are skipped), the two
// triggers, the topic, and the Stop hook's three answers (silent, systemMessage, block). handle()
// is driven in-process; then hooks/stop.mjs is spawned as Claude Code spawns it, on a transcript
// file, and its stdout read back. Entries are shaped as Claude Code 2.1.317 writes them
// (`type`, `message.content`, `timestamp`, `isSidechain`, `isMeta`).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handle as stop } from "../hooks/stop.mjs";
import { handle as sessionStart } from "../hooks/session-start.mjs";
import { readMode, resumeMarkerPath, markResumed, consumeResumeMarker, readTranscript, isCtxCall, isPrompt, finalText, finding, topicOf, shellQuote, flagPath, configPath, CTX_TOOL, CTX_SHELL, DEFAULT_MODE } from "../lib/consult-history.mjs";
import { stateDir } from "../lib/state.mjs";
import { prune } from "../lib/retention.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STOP_HOOK = join(ROOT, "hooks", "stop.mjs");
const HEALTHY = readFileSync(join(ROOT, "test", "fixtures", "ctx-daemon-status.txt"), "utf8");
const MODE_OUT = readFileSync(join(ROOT, "test", "fixtures", "ctx-index-mode.txt"), "utf8");
const NOW = JSON.parse(HEALTHY).daemon.jobs.core_refresh.last_run_at_ms + 60_000;
const healthy = (argv) => ({ code: 0, stdout: argv[1] === "daemon" ? HEALTHY : MODE_OUT, stderr: "" });

function box() {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-consult-"));
  const env = { XDG_STATE_HOME: join(root, "state"), HOME: join(root, "home"), PATH: "/usr/bin:/bin" };
  mkdirSync(join(env.HOME, ".claude"), { recursive: true });
  const transcript = join(root, "transcript.jsonl");
  const write = (entries) => writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { root, env, dir: stateDir(env), transcript, write, release: () => rmSync(root, { recursive: true, force: true }) };
}

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
/** Entries as Claude Code writes them; `at` is ms. */
const user = (text, at, extra = {}) => ({ type: "user", timestamp: iso(at), message: { role: "user", content: text }, ...extra });
const toolResult = (id, at) => ({ type: "user", timestamp: iso(at), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const assistantText = (text, at, extra = {}) => ({ type: "assistant", timestamp: iso(at), message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });
const toolUse = (name, input, at, extra = {}) => ({ type: "assistant", timestamp: iso(at), message: { role: "assistant", content: [{ type: "tool_use", id: `t-${at}`, name, input }] }, ...extra });
const ctxSearch = (at, extra = {}) => toolUse("mcp__ctx__search", { query: "the thing", limit: 5 }, at, extra);

/** A transcript: an earlier thread, then (after `resumedAt`) a resumed prompt and a reply. */
function resumed({ resumedAt = T0 + 3_600_000, withCtx = false, reply = "Picking the migration back up: the next step is the index.", prompt = "ok continue the migration plan from before please" } = {}) {
  const before = [user("start the migration plan", T0), toolUse("Read", { file_path: "/x" }, T0 + 1000), toolResult("t-1", T0 + 2000), assistantText("Started.", T0 + 3000)];
  const after = [user(prompt, resumedAt + 60_000)];
  if (withCtx) after.push(ctxSearch(resumedAt + 61_000), toolResult(`t-${resumedAt + 61_000}`, resumedAt + 62_000));
  after.push(assistantText(reply, resumedAt + 70_000));
  return [...before, ...after];
}

const stopInput = (b, extra = {}) => ({ session_id: "s-1", transcript_path: b.transcript, cwd: "/Users/example/repo", hook_event_name: "Stop", stop_hook_active: false, ...extra });
const startInput = (source) => ({ session_id: "s-1", cwd: "/Users/example/repo", hook_event_name: "SessionStart", source });

test("readMode: default warn; the config file's mode; the flag file wins; a bad file is a fault and the default", () => {
  const b = box();
  try {
    assert.deepEqual(readMode(b.env), { mode: "warn", fault: null, source: "default" });
    assert.equal(DEFAULT_MODE, "warn");
    writeFileSync(configPath(b.env), JSON.stringify({ checks: { "consult-history": "block" } }));
    assert.deepEqual(readMode(b.env), { mode: "block", fault: null, source: "config" });
    writeFileSync(configPath(b.env), JSON.stringify({ checks: { "consult-history": "off" } }));
    assert.equal(readMode(b.env).mode, "off");
    writeFileSync(configPath(b.env), JSON.stringify({ checks: {} }));
    assert.equal(readMode(b.env).mode, "warn");
    writeFileSync(configPath(b.env), JSON.stringify({ checks: { "consult-history": "loud" } }));
    const bad = readMode(b.env);
    assert.equal(bad.mode, "warn");
    assert.match(bad.fault, /checks\.consult-history is "loud", not one of off, warn, block; it runs as warn$/);
    writeFileSync(configPath(b.env), "{ not json");
    assert.match(readMode(b.env).fault, /is not JSON/);
    writeFileSync(configPath(b.env), JSON.stringify({ checks: ["consult-history"] }));
    assert.match(readMode(b.env).fault, /"checks" is not an object/);
    writeFileSync(configPath(b.env), JSON.stringify({ checks: { "consult-history": "block" } }));
    writeFileSync(flagPath(b.env), "");
    assert.deepEqual(readMode(b.env), { mode: "off", fault: null, source: "flag" });
  } finally {
    b.release();
  }
});

test("the marker: SessionStart leaves it on resume, compact and fork, not on startup or clear; the Stop hook consumes it once", () => {
  const b = box();
  try {
    for (const source of ["startup", "clear"]) {
      sessionStart(startInput(source), { env: b.env, now: () => NOW, run: healthy });
      assert.equal(existsSync(resumeMarkerPath(b.dir, "s-1")), false, source);
    }
    for (const source of ["resume", "compact", "fork"]) {
      sessionStart(startInput(source), { env: b.env, now: () => NOW, run: healthy });
      assert.equal(readFileSync(resumeMarkerPath(b.dir, "s-1"), "utf8"), iso(NOW) + "\n", source);
      const got = consumeResumeMarker(b.dir, "s-1");
      assert.deepEqual(got, { at: NOW, error: null });
      assert.equal(existsSync(resumeMarkerPath(b.dir, "s-1")), false, "consumed");
      assert.deepEqual(consumeResumeMarker(b.dir, "s-1"), { at: null, error: null }, "once");
    }
    assert.equal(resumeMarkerPath(b.dir, "../x/../../etc"), join(b.dir, "resume", ".._x_.._.._etc"), "the id is a file name, never a path");
    assert.equal(markResumed(b.dir, "s-2", NOW), null);
    assert.deepEqual(consumeResumeMarker(b.dir, "s-2"), { at: NOW, error: null });
  } finally {
    b.release();
  }
});

test("the marker holds the time the SessionStart hook started, before its probe: a prompt sent while the probe ran is inside the window", () => {
  const b = box();
  try {
    let clock = NOW;
    // Each ctx spawn takes 1.2 s of the hook's clock; the probe fails, so the heal runs too.
    const slow = (argv) => ((clock += 1_200), { code: 0, stdout: argv[1] === "daemon" ? "{}" : MODE_OUT, stderr: "" });
    sessionStart(startInput("resume"), { env: b.env, now: () => clock, run: slow, exists: () => true });
    assert.ok(clock > NOW + 1_200, "the probe advanced the clock");
    assert.deepEqual(consumeResumeMarker(b.dir, "s-1"), { at: NOW, error: null });
  } finally {
    b.release();
  }
});

test("a resume marker the SessionStart hook cannot write is one errors.log line, no message line", () => {
  const b = box();
  try {
    mkdirSync(b.dir, { recursive: true });
    writeFileSync(join(b.dir, "resume"), "a file where the directory goes");
    const out = sessionStart(startInput("resume"), { env: b.env, now: () => NOW, run: healthy });
    assert.equal(out, null);
    assert.match(readFileSync(join(b.dir, "errors.log"), "utf8"), /SessionStart resume marker for s-1 not written \(.*\); consult-history will not check this resume/);
  } finally {
    b.release();
  }
});

test("what counts as a ctx history call: the MCP tool names as Claude Code writes them, the single-underscore shape, and the CLI through Bash", () => {
  for (const name of ["mcp__ctx__search", "mcp__ctx__show_session", "mcp__ctx__show_event", "mcp__ctx_search", "mcp__ctx_show_session", "mcp__ctx_show_event"]) assert.ok(CTX_TOOL.test(name), name);
  for (const name of ["mcp__ctx__status", "mcp__ctx__graph_query", "mcp__ctx__blame", "mcp__ctxx__search", "search", "Bash"]) assert.ok(!CTX_TOOL.test(name), name);
  for (const cmd of ["ctx search --limit 5 -- 'migration'", "cd /x && ctx show session 45ef22ed", "ctx show event abc | head", "(ctx search foo)"]) assert.ok(CTX_SHELL.test(cmd), cmd);
  for (const cmd of ["ctx status", "ctx daemon status --format json", "myctx search x", "echo ctxsearch", "ctx show"]) assert.ok(!CTX_SHELL.test(cmd), cmd);
  assert.equal(isCtxCall(ctxSearch(T0)), true);
  assert.equal(isCtxCall(toolUse("Bash", { command: "ctx search foo" }, T0)), true);
  assert.equal(isCtxCall(toolUse("mcp__ctx__status", {}, T0)), false);
  assert.equal(isCtxCall(ctxSearch(T0, { isSidechain: true })), false, "a subagent's call in the same file is not this session's");
  assert.equal(isCtxCall({ ...ctxSearch(T0), type: "user" }), false);
  assert.equal(isCtxCall({ type: "assistant", message: { content: [{ type: "tool_use" }] } }), false, "no name: not a call");
});

test("what counts as a prompt: user text, not tool results, not isMeta, not a sidechain", () => {
  assert.equal(isPrompt(user("hi", T0)), true);
  assert.equal(isPrompt(user([{ type: "text", text: "hi" }], T0)), true);
  assert.equal(isPrompt(toolResult("t", T0)), false);
  assert.equal(isPrompt(user("<local-command-stdout>x</local-command-stdout>", T0, { isMeta: true })), false);
  assert.equal(isPrompt(user("hi", T0, { isSidechain: true })), false);
  assert.equal(isPrompt(user("   ", T0)), false);
  assert.equal(isPrompt(assistantText("hi", T0)), false);
});

test("readTranscript skips torn lines and non-objects; finalText prefers the payload's last_assistant_message", () => {
  const b = box();
  try {
    writeFileSync(b.transcript, `${JSON.stringify(user("a", T0))}\n{"type":"assistant","mess\n42\n[1]\n${JSON.stringify(assistantText("final words", T0 + 1))}\n\n`);
    const entries = readTranscript(b.transcript);
    assert.equal(entries.length, 2);
    assert.equal(finalText({}, entries), "final words");
    assert.equal(finalText({ last_assistant_message: "from the payload" }, entries), "from the payload");
    assert.equal(finalText({ last_assistant_message: "  " }, [toolUse("Read", {}, T0)]), "", "a tool-only entry is not the message");
    assert.deepEqual(readTranscript(join(b.root, "missing.jsonl")), []);
  } finally {
    b.release();
  }
});

test("topicOf: the first six words, tags dropped, quoted for the shell", () => {
  assert.equal(topicOf("ok continue the migration plan from before please"), "ok continue the migration plan from");
  assert.equal(topicOf("  one\ntwo   three "), "one two three");
  assert.equal(topicOf("<command-name>/wrap-up</command-name> and then some"), "/wrap-up and then some");
  assert.equal(shellQuote("it's a 'thing'"), "'it'\\''s a '\\''thing'\\'''");
  assert.equal(topicOf(""), "");
});

test("finding: the resume trigger fires when nothing since the marker consulted ctx, with the resumed prompt's words; a ctx call since the marker silences it; a call before the marker does not count", () => {
  const resumedAt = T0 + 3_600_000;
  const f = finding({ entries: resumed({ resumedAt }), resumedAt, text: "Picking the migration back up." });
  assert.deepEqual(f, { trigger: "resume", topic: "ok continue the migration plan from", head: "resumed without consulting history", command: "ctx search 'ok continue the migration plan from'", message: "resumed without consulting history — `ctx search 'ok continue the migration plan from'`" });
  assert.equal(finding({ entries: resumed({ resumedAt, withCtx: true }), resumedAt, text: "Picking the migration back up." }), null);
  const earlier = [ctxSearch(T0 + 500), ...resumed({ resumedAt })];
  assert.equal(finding({ entries: earlier, resumedAt, text: "x" })?.trigger, "resume", "a search before the resume is the old thread's");
  const bash = resumed({ resumedAt });
  bash.splice(bash.length - 1, 0, toolUse("Bash", { command: "ctx search --limit 5 -- 'migration plan'" }, resumedAt + 65_000));
  assert.equal(finding({ entries: bash, resumedAt, text: "x" }), null, "the CLI through Bash counts");
  assert.equal(finding({ entries: resumed({ resumedAt }), resumedAt: null, text: "Picking the migration back up." }), null, "no marker: a fresh start");
  const untimed = resumed({ resumedAt }).map(({ timestamp, ...e }) => e);
  assert.equal(finding({ entries: untimed, resumedAt, text: "x" })?.trigger, "resume", "entries without timestamps are inside the window");
  assert.equal(finding({ entries: untimed.filter((e) => !isPrompt(e) || true).concat([ctxSearch(resumedAt)]).map(({ timestamp, ...e }) => e), resumedAt, text: "x" }), null);
  // The resumed prompt landed before the marker (no prompt in the window): the last prompt before it is the topic, never a placeholder.
  const early = [...resumed({ resumedAt }).slice(0, 4), user("continue the index migration", resumedAt - 1000), assistantText("Continuing.", resumedAt + 5000)];
  const e = finding({ entries: early, resumedAt, text: "Continuing." });
  assert.deepEqual({ topic: e.topic, command: e.command, message: e.message }, { topic: "continue the index migration", command: "ctx search 'continue the index migration'", message: "resumed without consulting history — `ctx search 'continue the index migration'`" });
  // No prompt anywhere: a bare `ctx search`, and the sentence says why.
  const none = finding({ entries: [assistantText("Resumed.", resumedAt + 1)], resumedAt, text: "Resumed." });
  assert.deepEqual({ topic: none.topic, command: none.command, message: none.message }, { topic: null, command: "ctx search", message: "resumed without consulting history — `ctx search` (the transcript has no prompt to take a topic from: add one)" });
});

test("finding: the phrase trigger fires on the final message alone, scoped to this turn, with this turn's prompt; a ctx call in the turn silences it; a call in an earlier turn does not", () => {
  const turnAt = T0 + 10_000;
  const entries = [user("what did we decide about retries", T0), ctxSearch(T0 + 1000), toolResult("t", T0 + 2000), assistantText("We decided on three.", T0 + 3000), user("and the backoff for the retry queue", turnAt), assistantText("As discussed, exponential.", turnAt + 1000)];
  const f = finding({ entries, resumedAt: null, text: "As discussed, exponential." });
  assert.equal(f.trigger, "phrase");
  assert.equal(f.message, 'said "as discussed" without consulting history — `ctx search \'and the backoff for the retry\'`');
  for (const text of ["We spoke previously about this.", "Earlier you said no.", "as   discussed\nabove"]) assert.equal(finding({ entries, resumedAt: null, text })?.trigger, "phrase", text);
  for (const text of ["The last timestamp is wrong.", "The cron job ran fine; the last time it failed was 03:00.", "Last time it broke.", "This is discussed below.", "Previously we spoke.", ""]) assert.equal(finding({ entries, resumedAt: null, text }), null, JSON.stringify(text));
  const withCall = [...entries.slice(0, -1), ctxSearch(turnAt + 500), toolResult("t2", turnAt + 600), assistantText("As discussed, exponential.", turnAt + 1000)];
  assert.equal(finding({ entries: withCall, resumedAt: null, text: "As discussed, exponential." }), null);
  assert.equal(finding({ entries, resumedAt: T0 + 5000, text: "As discussed, exponential." })?.trigger, "resume", "both pending: the resume trigger is reported first");
});

test("the Stop hook in-process: silent on a fresh start; warn on a resume without a ctx call (one systemMessage line, one checks.log line); silent when ctx was called; silent on the second Stop", () => {
  const b = box();
  try {
    b.write(resumed());
    assert.equal(stop(stopInput(b), { env: b.env, now: () => NOW }), null, "fresh start: no marker");
    sessionStart(startInput("resume"), { env: b.env, now: () => T0 + 3_600_000, run: healthy });
    const out = stop(stopInput(b), { env: b.env, now: () => NOW });
    assert.deepEqual(out, { systemMessage: "ctx-watch: resumed without consulting history — `ctx search 'ok continue the migration plan from'`" });
    assert.equal(out.systemMessage.split("\n").length, 1);
    assert.match(readFileSync(join(b.dir, "checks.log"), "utf8"), /^\d{4}-.*Z warn s-1 resume resumed without consulting history — `ctx search 'ok continue the migration plan from'`\n$/);
    assert.equal(stop(stopInput(b), { env: b.env, now: () => NOW }), null, "the marker was consumed: the next Stop is silent");
    assert.equal(existsSync(join(b.dir, "errors.log")), false);

    sessionStart(startInput("compact"), { env: b.env, now: () => T0 + 3_600_000, run: healthy });
    b.write(resumed({ withCtx: true }));
    assert.equal(stop(stopInput(b), { env: b.env, now: () => NOW }), null, "ctx was consulted");
    assert.equal(existsSync(resumeMarkerPath(b.dir, "s-1")), false, "consumed even when silent");
  } finally {
    b.release();
  }
});

test("the Stop hook in-process: block mode blocks with the command and the way out; a Stop with stop_hook_active warns instead; off and the flag file are silent and still consume the marker; the phrase trigger", () => {
  const b = box();
  try {
    writeFileSync(configPath(b.env), JSON.stringify({ checks: { "consult-history": "block" } }));
    b.write(resumed());
    sessionStart(startInput("resume"), { env: b.env, now: () => T0 + 3_600_000, run: healthy });
    const out = stop(stopInput(b), { env: b.env, now: () => NOW });
    assert.equal(out.decision, "block");
    assert.equal(out.reason, "ctx-watch (consult-history): resumed without consulting history. Run `ctx search 'ok continue the migration plan from'` (or the ctx MCP search) and read what it finds before going on. Way out: `touch ~/.claude/.ctx-watch-off`, or {\"checks\": {\"consult-history\": \"warn\"}} in ~/.claude/ctx-watch.json.");
    assert.match(readFileSync(join(b.dir, "checks.log"), "utf8"), /Z block s-1 resume /);

    // The phrase trigger, in block mode, on a Stop that follows a block: warn, never a second block.
    b.write([user("the retry queue again", T0), assistantText("As discussed, exponential.", T0 + 1000)]);
    const again = stop(stopInput(b, { stop_hook_active: true }), { env: b.env, now: () => NOW });
    assert.deepEqual(again, { systemMessage: "ctx-watch: said \"as discussed\" without consulting history — `ctx search 'the retry queue again'`" });
    const phrase = stop(stopInput(b), { env: b.env, now: () => NOW });
    assert.equal(phrase.decision, "block");
    assert.match(phrase.reason, /^ctx-watch \(consult-history\): said "as discussed" without consulting history\. Run `ctx search 'the retry queue again'` /);

    // A resume whose transcript holds no prompt: the reason names a bare `ctx search` and says the subject is missing.
    sessionStart(startInput("resume"), { env: b.env, now: () => T0 + 3_600_000, run: healthy });
    b.write([assistantText("Resumed.", T0 + 3_600_001)]);
    assert.match(stop(stopInput(b), { env: b.env, now: () => NOW }).reason, /^ctx-watch \(consult-history\): resumed without consulting history\. Run `ctx search` with the thread's subject added \(the transcript has no prompt to take one from\) \(or the ctx MCP search\) /);

    writeFileSync(configPath(b.env), JSON.stringify({ checks: { "consult-history": "off" } }));
    sessionStart(startInput("resume"), { env: b.env, now: () => T0 + 3_600_000, run: healthy });
    b.write(resumed());
    assert.equal(stop(stopInput(b), { env: b.env, now: () => NOW }), null, "off");
    assert.equal(existsSync(resumeMarkerPath(b.dir, "s-1")), false, "off still consumes the marker");

    writeFileSync(configPath(b.env), JSON.stringify({ checks: { "consult-history": "block" } }));
    writeFileSync(flagPath(b.env), "");
    sessionStart(startInput("resume"), { env: b.env, now: () => T0 + 3_600_000, run: healthy });
    assert.equal(stop(stopInput(b), { env: b.env, now: () => NOW }), null, "the flag file");
    assert.equal(existsSync(resumeMarkerPath(b.dir, "s-1")), false);
    // The flag file is the Stop check's switch only: SessionStart still says a failing probe.
    const broken = (argv) => ({ code: 0, stdout: argv[1] === "daemon" ? "{}" : MODE_OUT, stderr: "" });
    assert.match(sessionStart(startInput("startup"), { env: b.env, now: () => NOW, run: broken, exists: () => false }).systemMessage, /^ctx-watch: `ctx daemon status --format json` has no \.daemon/);
    assert.equal(existsSync(join(b.dir, "errors.log")), false);
  } finally {
    b.release();
  }
});

test("the Stop hook in-process: a bad config file is an errors.log line and warn; no transcript is silent (and logged when a resume was pending); a payload without session_id scans the transcript for the phrase only", () => {
  const b = box();
  try {
    writeFileSync(configPath(b.env), "nope");
    b.write(resumed());
    sessionStart(startInput("resume"), { env: b.env, now: () => T0 + 3_600_000, run: healthy });
    const out = stop(stopInput(b), { env: b.env, now: () => NOW });
    assert.match(out.systemMessage, /^ctx-watch: resumed without consulting history/);
    assert.match(readFileSync(join(b.dir, "errors.log"), "utf8"), /Stop .*ctx-watch\.json is not JSON .*; consult-history runs as warn/);
    rmSync(configPath(b.env));

    sessionStart(startInput("resume"), { env: b.env, now: () => T0 + 3_600_000, run: healthy });
    assert.equal(stop(stopInput(b, { transcript_path: join(b.root, "gone.jsonl") }), { env: b.env, now: () => NOW }), null);
    assert.match(readFileSync(join(b.dir, "errors.log"), "utf8"), /consult-history: no transcript to scan \(.*gone\.jsonl\); the resume of s-1 was not checked/);
    assert.equal(stop(stopInput(b, { transcript_path: undefined }), { env: b.env, now: () => NOW }), null, "no path, no marker: nothing");

    b.write([user("the retry queue again", T0), assistantText("As discussed, exponential.", T0 + 1000)]);
    assert.equal(stop(stopInput(b, { session_id: undefined }), { env: b.env, now: () => NOW }).systemMessage, "ctx-watch: said \"as discussed\" without consulting history — `ctx search 'the retry queue again'`");
    assert.equal(stop(stopInput(b, { last_assistant_message: "Done; nothing was discussed." }), { env: b.env, now: () => NOW }), null, "the payload's text wins over the transcript's");
  } finally {
    b.release();
  }
});

test("prune removes a resume marker older than --days and keeps a fresh one", () => {
  const b = box();
  try {
    markResumed(b.dir, "old", T0);
    markResumed(b.dir, "fresh", T0);
    const old = resumeMarkerPath(b.dir, "old");
    const past = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(old, past, past);
    const r = prune(b.dir, { days: 30 });
    assert.deepEqual(r.removedPaths, [old]);
    assert.equal(existsSync(resumeMarkerPath(b.dir, "fresh")), true);
  } finally {
    b.release();
  }
});

test("hooks/stop.mjs spawned as Claude Code spawns it: a resume without a ctx call prints the warn line; block mode prints the block; a fresh start prints nothing; exit 0 each time", () => {
  const b = box();
  try {
    b.write(resumed());
    const run = (input) => spawnSync("node", [STOP_HOOK], { env: { ...b.env, PATH: process.env.PATH }, input: JSON.stringify(input), encoding: "utf8", timeout: 10_000 });
    const fresh = run(stopInput(b));
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(fresh.stdout, "");
    markResumed(b.dir, "s-1", T0 + 3_600_000);
    const warn = run(stopInput(b));
    assert.equal(warn.status, 0, warn.stderr);
    assert.deepEqual(JSON.parse(warn.stdout), { systemMessage: "ctx-watch: resumed without consulting history — `ctx search 'ok continue the migration plan from'`" });
    writeFileSync(configPath(b.env), JSON.stringify({ checks: { "consult-history": "block" } }));
    markResumed(b.dir, "s-1", T0 + 3_600_000);
    const block = run(stopInput(b));
    assert.equal(block.status, 0, block.stderr);
    const j = JSON.parse(block.stdout);
    assert.equal(j.decision, "block");
    assert.match(j.reason, /Run `ctx search 'ok continue the migration plan from'` /);
    assert.equal(existsSync(join(b.dir, "errors.log")), false);
  } finally {
    b.release();
  }
});
