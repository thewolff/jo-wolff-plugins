// test/hooks.test.mjs — each hook run as the host runs it: a child process, JSON on stdin,
// JSON on stdout, exit 0 always, inside the runner's 4 s deadline. One test per hook covers
// parse / allow / warn / unparseable; the last test walks a whole session through all four.
//
// No test here hands a hook a `token_count`: Claude Code's PreCompact payload has none, so the
// pressure check is exercised the way it runs there, from the token usage the transcript's last
// assistant reply recorded.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { box, input, spawnHook } from "./helpers.mjs";
import { handle as preCompact } from "../hooks/pre-compact.mjs";
import { handle as sessionStart } from "../hooks/session-start.mjs";
import { handle as userPrompt } from "../hooks/user-prompt-submit.mjs";
import { handle as stop } from "../hooks/stop.mjs";
import { RESTORE_MAX_CHARS, renderSnapshot } from "../lib/snapshot.mjs";

const HOOKS = ["pre-compact.mjs", "session-start.mjs", "user-prompt-submit.mjs", "stop.mjs"];
// A transcript whose last assistant reply recorded 160,000 tokens of context (2 + 150,000 cache
// read + 9,998 cache creation, in Claude Code's `usage` shape), 80% of the 200,000 default, past
// the 0.65 default threshold. No calibration file anywhere.
const nearlyFull = (b, entries = []) =>
  b.writeTranscript([
    ...entries,
    { type: "user", message: { role: "user", content: "carry on" } },
    { type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 2, cache_creation_input_tokens: 9_998, cache_read_input_tokens: 150_000, output_tokens: 5 } } },
  ]);
const handoff = (b, session, name = "h.md") => {
  mkdirSync(join(b.work, ".ai", "handoffs"), { recursive: true });
  writeFileSync(join(b.work, ".ai", "handoffs", name), `---\nsession_id: ${session}\nlane: l\nstatus: open\n---\n## Where I left off\nmidway\n`);
};

test("every hook: unparseable stdin, empty stdin and the wrong event all exit 0 within the deadline and never block", () => {
  const b = box();
  try {
    for (const file of HOOKS) {
      for (const stdin of ["{not json", "", "[]", "null", JSON.stringify({ hook_event_name: "SomethingElse" })]) {
        const r = spawnHook(b, file, stdin);
        assert.equal(r.status, 0, `${file} with ${JSON.stringify(stdin)}: exit ${r.status} ${r.stderr}`);
        assert.ok(r.ms < 4000, `${file}: ${r.ms}ms`);
        assert.notEqual(r.json?.decision, "block");
        assert.notEqual(r.json?.hookSpecificOutput?.permissionDecision, "deny");
        if (r.json?.systemMessage) assert.match(r.json.systemMessage, /^continuity \S+ failed open: /);
      }
    }
    // The runner's fault log holds the parse failures, one `<iso> <hook> stdin not JSON…` line per bad input.
    const log = readFileSync(join(b.stateDir, "errors.log"), "utf8").trim().split("\n");
    assert.ok(log.length >= HOOKS.length, `errors.log has ${log.length} lines`);
    assert.ok(log.every((l) => /^\S+ \S+ stdin not JSON/.test(l)), log.join("\n"));
  } finally {
    b.release();
  }
});

test("every hook: handle() rejects another event, and a payload that is JSON but not a session is allowed", async () => {
  for (const h of [preCompact, sessionStart, userPrompt, stop]) {
    assert.equal(await h({ hook_event_name: "Nope" }, { env: {} }), null);
    assert.equal(await h(null, { env: {} }), null);
  }
});

test("pre-compact: auto with no handoff warns the person and saves; manual saves silently; snapshot off records skipped; unwritable state fails open", () => {
  const b = box();
  try {
    b.writeTranscript([{ type: "user", message: { role: "user", content: "the first ask" } }, { message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: join(b.work, "a") } }] } }]);
    b.git("checkout", "-q", "-b", "feat");
    writeFileSync(join(b.work, "dirty"), "1");
    // Claude Code's PreCompact payload, as documented: trigger and custom_instructions, no token_count.
    let r = spawnHook(b, "pre-compact.mjs", input("PreCompact", b, { trigger: "auto", custom_instructions: "" }));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.ms < 4000);
    assert.match(r.json.systemMessage, /auto-compaction fired with no handoff written/);
    const snap = JSON.parse(b.readState("s-test.json"));
    assert.equal(snap.branch, "feat");
    assert.deepEqual(snap.status.lines, ["?? dirty"]);
    assert.deepEqual(snap.filesTouched.lines, [join(b.work, "a")]);
    assert.deepEqual(snap.recentIntent.lines, ["the first ask"]);
    const beats = b.readState("heartbeat.ndjson").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(beats.map((x) => x.outcome), ["started", "ok"]);
    assert.equal(beats[0].trigger, "auto");
    assert.equal(existsSync(join(b.stateDir, "calibration.ndjson")), false, "no token_count, so no calibration record");

    r = spawnHook(b, "pre-compact.mjs", input("PreCompact", b, { trigger: "manual" }));
    assert.equal(r.status, 0);
    assert.equal(r.json, null, `manual compaction is silent: ${r.stdout}`);
    assert.equal(b.readState("heartbeat.ndjson").trim().split("\n").length, 4);

    // A handoff present: auto compaction is silent too, and the handoff is in the file.
    handoff(b, "someone");
    r = spawnHook(b, "pre-compact.mjs", input("PreCompact", b, { trigger: "auto" }));
    assert.equal(r.json, null, r.stdout);
    assert.equal(JSON.parse(b.readState("s-test.json")).handoff.present, true);

    b.writeConfig({ snapshot: "off" });
    r = spawnHook(b, "pre-compact.mjs", input("PreCompact", b, { session_id: "off", trigger: "auto" }));
    assert.equal(r.json, null);
    assert.equal(existsSync(join(b.stateDir, "off.json")), false);
    assert.match(b.readState("heartbeat.ndjson"), /"session":"off".*"outcome":"skipped:off"/);

    // A config problem is named once per session, here as everywhere.
    b.writeConfig("{broken");
    r = spawnHook(b, "pre-compact.mjs", input("PreCompact", b, { trigger: "manual" }));
    assert.match(r.json.systemMessage, /^continuity: .*config\.json does not parse/);
    r = spawnHook(b, "pre-compact.mjs", input("PreCompact", b, { trigger: "manual" }));
    assert.equal(r.json, null, `the config problem is not repeated: ${r.stdout}`);

    // A state dir whose parent is a regular file: the heartbeat cannot land either, so the
    // only trace is the systemMessage, and compaction is not blocked.
    writeFileSync(join(b.root, "file"), "");
    r = spawnHook(b, "pre-compact.mjs", input("PreCompact", b, { trigger: "auto" }), { env: { XDG_STATE_HOME: join(b.root, "file"), XDG_CONFIG_HOME: join(b.root, "nocfg") } });
    assert.equal(r.status, 0);
    assert.match(r.json.systemMessage, /snapshot could not be written to .*\(failed:ENOTDIR\); compaction proceeds/);

    const ro = join(b.root, "ro");
    mkdirSync(join(ro, "continuity"), { recursive: true });
    writeFileSync(join(ro, "continuity", "errors.log"), "");
    chmodSync(join(ro, "continuity"), 0o555);
    r = spawnHook(b, "pre-compact.mjs", input("PreCompact", b, { session_id: "ro", trigger: "auto" }), { env: { XDG_STATE_HOME: ro, XDG_CONFIG_HOME: join(b.root, "nocfg") } });
    chmodSync(join(ro, "continuity"), 0o755);
    assert.equal(r.status, 0);
    if (process.getuid?.() !== 0) {
      assert.match(r.json.systemMessage, /heartbeat record could not be written/);
      assert.match(r.json.systemMessage, /snapshot could not be written to .*ro\.json \(failed:EACCES\)/);
      const log = readFileSync(join(ro, "continuity", "errors.log"), "utf8");
      assert.match(log, /PreCompact heartbeat could not be written/);
      assert.match(log, /PreCompact snapshot not written to .*ro\.json \(failed:EACCES\)/);
    }
  } finally {
    b.release();
  }
});

test("pre-compact: with every git call slower than the whole deadline, the snapshot is still written inside it, git fields unknown", () => {
  const b = box();
  try {
    b.writeTranscript([{ type: "user", message: { role: "user", content: "slow checkout" } }]);
    writeFileSync(join(b.work, "dirty"), "1");
    const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { env: b.env, encoding: "utf8" }).stdout.trim();
    assert.ok(realGit, "git on PATH");
    const bin = join(b.root, "slowbin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 5\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const r = spawnHook(b, "pre-compact.mjs", input("PreCompact", b, { trigger: "auto" }), { env: { PATH: `${bin}:${b.env.PATH}` } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.ms < 4000, `took ${r.ms} ms`);
    assert.match(r.json.systemMessage, /auto-compaction fired with no handoff written/, "the save's own message, not the runner's deadline");
    const snap = JSON.parse(b.readState("s-test.json"));
    assert.equal(snap.branch, null);
    assert.equal(snap.branchUnknown, "timed out");
    assert.equal(snap.status.unknown, "timed out");
    assert.deepEqual(snap.recentIntent.lines, ["slow checkout"]);
    assert.match(snap.handoff.note, /git did not answer in time/);
    assert.deepEqual(b.readState("heartbeat.ndjson").trim().split("\n").map((l) => JSON.parse(l).outcome), ["started", "ok"]);
    const restored = spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: "s-test", cwd: b.work, source: "compact" });
    assert.match(restored.json.hookSpecificOutput.additionalContext, /## Uncommitted changes\n\(unknown: timed out; run `git status --short` before assuming the tree is clean\)/);
  } finally {
    b.release();
  }
});

test("session-start: startup gives the liveness line and marks it; compact restores this session's snapshot and removes it; a missing one is said; liveness off is silent", () => {
  const b = box();
  try {
    let r = spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: "s-test", cwd: b.work, source: "startup" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.ms < 4000);
    assert.equal(r.json.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(r.json.hookSpecificOutput.additionalContext, /^continuity, pre-compaction save liveness: \*\*no pre-compaction save has ever been recorded/);
    assert.match(b.readState("sessions/s-test.json"), /livenessSaid/);

    b.writeTranscript([{ type: "user", message: { role: "user", content: "resume me" } }]);
    spawnHook(b, "pre-compact.mjs", input("PreCompact", b, { trigger: "auto" }));
    r = spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: "other", cwd: b.work, source: "compact" });
    assert.doesNotMatch(r.json.hookSpecificOutput.additionalContext, /Restored session state/, "another session's snapshot is not injected");
    assert.match(r.json.hookSpecificOutput.additionalContext, /\*\*this compaction's state was not restored\*\*: no pre-compaction save was recorded for this session/);
    assert.ok(existsSync(join(b.stateDir, "s-test.json")));
    r = spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: "s-test", cwd: b.work, source: "compact" });
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /^## Restored session state \(post-compaction\)/);
    assert.match(ctx, /- resume me\n/);
    assert.match(ctx, /last successful save less than a minute ago .*; the snapshot path is alive\./);
    assert.equal(existsSync(join(b.stateDir, "s-test.json")), false);

    // A save that failed after the earlier success: the restore finds nothing and says why, and
    // the liveness line leads with the failure, not the old success.
    const at = new Date().toISOString();
    writeFileSync(join(b.stateDir, "heartbeat.ndjson"), `${b.readState("heartbeat.ndjson")}${JSON.stringify({ at, event: "PreCompact", trigger: "auto", session: "lost", cwd: b.work, outcome: "started" })}\n${JSON.stringify({ at, event: "PreCompact", trigger: "auto", session: "lost", cwd: b.work, outcome: "failed:EACCES" })}\n`);
    r = spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: "lost", cwd: b.work, source: "compact" });
    const lost = r.json.hookSpecificOutput.additionalContext;
    assert.match(lost, /\*\*this compaction's state was not restored\*\*: the save recorded `failed:EACCES` at /);
    assert.match(lost, /\*\*the last save failed\*\* less than a minute ago \(`failed:EACCES`/);
    assert.doesNotMatch(lost, /alive/);

    // The state dir read-only with a writable errors.log inside (the gate's unwritable input):
    // the line is still given, the failed once-mark is one errors.log line and a systemMessage.
    const ro = join(b.root, "ro");
    mkdirSync(join(ro, "continuity"), { recursive: true });
    writeFileSync(join(ro, "continuity", "errors.log"), "");
    chmodSync(join(ro, "continuity"), 0o555);
    r = spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: "ro", cwd: b.work, source: "startup" }, { env: { XDG_STATE_HOME: ro } });
    chmodSync(join(ro, "continuity"), 0o755);
    assert.equal(r.status, 0);
    if (process.getuid?.() !== 0) {
      assert.match(r.json.hookSpecificOutput.additionalContext, /pre-compaction save liveness/);
      assert.match(r.json.systemMessage, /^continuity: the session mark could not be written to .*sessions\/ro\.json/);
      assert.match(readFileSync(join(ro, "continuity", "errors.log"), "utf8"), /SessionStart once-mark not written/);
    }

    // A config problem: named at the start, and not again at the first prompt (once per session).
    b.writeConfig({ threshold: "lots" });
    r = spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: "cfg", cwd: b.work, source: "startup" });
    assert.match(r.json.hookSpecificOutput.additionalContext, /continuity: .*threshold must be a number between 0 and 1, not "lots"/);
    b.writeTranscript([{ type: "user", message: { role: "user", content: "x" } }]);
    r = spawnHook(b, "user-prompt-submit.mjs", input("UserPromptSubmit", b, { session_id: "cfg", prompt: "x" }));
    assert.equal(r.json, null, `the prompt does not repeat the config problem: ${r.stdout}`);

    b.writeConfig({ liveness: "off" });
    r = spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: "s-test", cwd: b.work, source: "resume" });
    assert.equal(r.json, null, r.stdout);
  } finally {
    b.release();
  }
});

test("session-start: after a compaction the block carries the re-inlined rules and the durable notes, inside the restore guard; never on a fresh start; each switched off by config", () => {
  const b = box();
  try {
    mkdirSync(join(b.work, "pkg", "deep"), { recursive: true });
    writeFileSync(join(b.work, "CLAUDE.md"), "# root rules\n");
    writeFileSync(join(b.work, "pkg", "AGENTS.md"), "# pkg rules\n");
    mkdirSync(join(b.work, ".ai", "decision-log"), { recursive: true });
    writeFileSync(join(b.work, ".ai", "decision-log", "2026-01-01--one.md"), "one");
    writeFileSync(join(b.work, ".ai", "decision-log", "2026-01-02--two.md"), "two");
    const compact = (extra = {}, env = {}) => spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: "s-test", cwd: join(b.work, "pkg", "deep"), source: "compact", ...extra }, { env }).json.hookSpecificOutput.additionalContext;

    // A fresh start, a resume and a clear: neither section.
    for (const source of ["startup", "resume", "clear"]) {
      const r = spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: "s-test", cwd: join(b.work, "pkg", "deep"), source });
      assert.doesNotMatch(r.json.hookSpecificOutput.additionalContext, /Repo rules re-inlined|Durable notes/, source);
    }

    // After a compaction with a snapshot: restore, then rules root-first, then the notes, then liveness.
    b.writeTranscript([{ type: "user", message: { role: "user", content: "resume me" } }]);
    spawnHook(b, "pre-compact.mjs", input("PreCompact", b, { trigger: "auto" }));
    let ctx = compact();
    const at = (re) => {
      const i = ctx.search(re);
      assert.ok(i >= 0, `${re} in ${ctx.slice(0, 200)}`);
      return i;
    };
    assert.ok(at(/^## Restored session state/) < at(/\n## Repo rules re-inlined\n/) && at(/# root rules/) < at(/# pkg rules/) && at(/# pkg rules/) < at(/\n## Durable notes \(/) && at(/- 2026-01-02--two\.md\n- 2026-01-01--one\.md\n/) < at(/pre-compaction save liveness/));
    assert.match(ctx, /The notes directory and the rules files are the source of truth; the restored snapshot is only the safety net/);
    assert.match(ctx, /The newest 2 of 2 entries/);

    // After a compaction with nothing to restore: the not-restored line, and still both sections.
    ctx = compact();
    assert.match(ctx, /\*\*this compaction's state was not restored\*\*/);
    assert.match(ctx, /## Repo rules re-inlined[\s\S]*# root rules[\s\S]*# pkg rules[\s\S]*## Durable notes/);

    // A level at or above CLAUDE_PROJECT_DIR is the host's: named as skipped, its text not inlined.
    ctx = compact({}, { CLAUDE_PROJECT_DIR: b.work });
    assert.doesNotMatch(ctx, /# root rules/);
    assert.match(ctx, /- skipped `.*\/CLAUDE\.md`: loaded by the host at launch/);
    assert.match(ctx, /# pkg rules/);

    // The whole restore block stays inside the guard. With liveness off the context is the block
    // alone. A mid-size snapshot leaves room for the notes and part of the rules: the notes land
    // whole, the large root file is cut, and the block is at most RESTORE_MAX_CHARS characters.
    writeFileSync(join(b.work, "CLAUDE.md"), `# root rules\n${"r".repeat(6000)}\n`);
    b.writeConfig({ liveness: "off" });
    spawnHook(b, "pre-compact.mjs", input("PreCompact", b, { trigger: "auto", file_operations: "w".repeat(8000), agent_judgment: ["j".repeat(6000)] }));
    ctx = compact();
    assert.ok(ctx.length <= RESTORE_MAX_CHARS, `the block is within the guard: ${ctx.length}`);
    assert.ok(ctx.length > RESTORE_MAX_CHARS - 400, `the rules used what the snapshot left: ${ctx.length}`);
    assert.match(ctx, /^## Restored session state/);
    assert.doesNotMatch(ctx, /\*\*TRUNCATED: this snapshot is/);
    assert.match(ctx, /# root rules\nr+\n\n\(truncated at \d+ bytes; the file is 6014 bytes, read it for the rest\)/);
    assert.match(ctx, /The newest 2 of 2 entries/);
    assert.ok(ctx.endsWith("Read the newest note before continuing a thread it covers.\n"), "the notes close the block");

    // A snapshot at the guard leaves no room: both sections are left out of the context and named
    // in the systemMessage, and the block is the snapshot alone.
    mkdirSync(join(b.work, ".ai", "handoffs"), { recursive: true });
    writeFileSync(join(b.work, ".ai", "handoffs", "long.md"), `---\nsession_id: s-test\nlane: l\nstatus: open\n---\n## Where I left off\n${`${"h".repeat(100)}\n`.repeat(100)}`);
    spawnHook(b, "pre-compact.mjs", input("PreCompact", b, { trigger: "auto", file_operations: "w".repeat(9000), agent_judgment: ["j".repeat(9000)] }));
    let r = spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: "s-test", cwd: join(b.work, "pkg", "deep"), source: "compact" });
    ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /\*\*TRUNCATED: this snapshot is \d+ characters/);
    assert.doesNotMatch(ctx, /Repo rules re-inlined|Durable notes|rrrrrrrr/);
    assert.equal(r.json.systemMessage, "continuity: the re-inlined repo rules and the durable notes list left out of the post-compaction restore: the block before them reached the 20,000-character restore guard; read the rules files and the notes directory directly.");
    rmSync(join(b.stateDir, "s-test.json"));
    rmSync(join(b.work, ".ai", "handoffs"), { recursive: true });

    // A snapshot body one under the guard, at it, one over it and far over it, with the rules,
    // the notes and (second pass) the liveness line all wanting room: the whole context, heading,
    // notices and truncation marker included, is within the guard; the snapshot is cut, the cut
    // said in-band, and the file kept; the sections it crowds out are named in the systemMessage.
    spawnHook(b, "pre-compact.mjs", input("PreCompact", b, { trigger: "auto" }));
    const snap = join(b.stateDir, "s-test.json");
    const json = JSON.parse(readFileSync(snap, "utf8"));
    for (const liveness of ["off", "on"]) {
      b.writeConfig({ liveness });
      for (const n of [RESTORE_MAX_CHARS - 1, RESTORE_MAX_CHARS, RESTORE_MAX_CHARS + 1, 60_000]) {
        json.hostFileOperations = "w";
        json.hostFileOperations = "w".repeat(n - (renderSnapshot(json).length - 1));
        writeFileSync(snap, JSON.stringify(json));
        assert.equal(renderSnapshot(json).length, n);
        r = spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: "s-test", cwd: join(b.work, "pkg", "deep"), source: "compact" });
        ctx = r.json.hookSpecificOutput.additionalContext;
        const what = `liveness ${liveness}, body ${n}: context ${ctx.length}`;
        assert.ok(ctx.length <= RESTORE_MAX_CHARS && ctx.length >= RESTORE_MAX_CHARS - 1, what);
        assert.match(ctx, new RegExp(`\\*\\*TRUNCATED: this snapshot is ${n} characters and only the first \\d+ are shown\\.\\*\\*`), what);
        assert.ok(existsSync(snap), `${what}: the snapshot is kept`);
        assert.equal(r.json.systemMessage, "continuity: the re-inlined repo rules and the durable notes list left out of the post-compaction restore: the block before them reached the 20,000-character restore guard; read the rules files and the notes directory directly.", what);
        if (liveness === "on") assert.ok(ctx.search(/pre-compaction save liveness/) > ctx.indexOf("**TRUNCATED"), `${what}: the liveness line closes the context`);
      }
    }
    b.writeConfig({ liveness: "off" });
    rmSync(snap);

    // No snapshot and a walk past the section cap: the rules section is at most 9,000 bytes whole.
    writeFileSync(join(b.work, "pkg", "AGENTS.md"), `# pkg rules\n${"p".repeat(7000)}\n`);
    ctx = compact();
    const rules = ctx.slice(ctx.indexOf("## Repo rules re-inlined"), ctx.indexOf("\n\n## Durable notes"));
    assert.ok(rules.endsWith("\n"));
    assert.ok(Buffer.byteLength(rules) <= 9000 && Buffer.byteLength(rules) > 8600, `the rules section: ${Buffer.byteLength(rules)} bytes`);
    assert.ok(ctx.length <= RESTORE_MAX_CHARS);
    writeFileSync(join(b.work, "pkg", "AGENTS.md"), "# pkg rules\n");
    rmSync(join(b.env.XDG_CONFIG_HOME, "continuity", "config.json"));

    // Config: rules off drops the section; notesCount 0 drops the probe; notesDir moves it; an absent dir is one line.
    b.writeConfig({ rules: "off", notesDir: "docs/log" });
    ctx = compact();
    assert.doesNotMatch(ctx, /Repo rules re-inlined/);
    assert.match(ctx, /## Durable notes \(`.*\/docs\/log`\)\n\n\(no notes directory at /);
    b.writeConfig({ notesCount: 0 });
    ctx = compact();
    assert.match(ctx, /Repo rules re-inlined/);
    assert.doesNotMatch(ctx, /Durable notes/);
    // snapshot off skips the restore and not the rules.
    b.writeConfig({ snapshot: "off", notesCount: 1 });
    ctx = compact();
    assert.doesNotMatch(ctx, /not restored|Restored session state/);
    assert.match(ctx, /Repo rules re-inlined[\s\S]*The newest 1 of 2 entries/);

    // A cwd reached through a symlink into a nested directory: the notes hang off the real git
    // root, the same root the rules walk finds, with the rules on and with them off.
    const link = join(b.root, "link-to-deep");
    symlinkSync(join(b.work, "pkg", "deep"), link);
    const viaLink = () => spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: "s-test", cwd: link, source: "compact" }).json.hookSpecificOutput.additionalContext;
    const notesHere = `## Durable notes (\`${join(b.work, ".ai", "decision-log")}\`)\n\nThe newest 2 of 2 entries`;
    b.writeConfig({ snapshot: "off" });
    ctx = viaLink();
    assert.ok(ctx.includes(notesHere), ctx);
    assert.match(ctx, /# root rules[\s\S]*# pkg rules/);
    b.writeConfig({ snapshot: "off", rules: "off" });
    ctx = viaLink();
    assert.ok(ctx.includes(notesHere), ctx);
  } finally {
    b.release();
  }
});

test("user-prompt-submit: liveness once if unsaid; pressure warning once from a plain transcript of known size; quiet when small; pressure off", () => {
  const b = box();
  try {
    b.writeTranscript([{ type: "user", message: { role: "user", content: "x" } }]);
    let r = spawnHook(b, "user-prompt-submit.mjs", input("UserPromptSubmit", b, { prompt: "hi" }));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.ms < 4000);
    assert.match(r.json.hookSpecificOutput.additionalContext, /pre-compaction save liveness/);
    assert.doesNotMatch(r.json.hookSpecificOutput.additionalContext, /handoff/);
    r = spawnHook(b, "user-prompt-submit.mjs", input("UserPromptSubmit", b, { prompt: "hi again" }));
    assert.equal(r.json, null, `second prompt is silent: ${r.stdout}`);

    nearlyFull(b);
    r = spawnHook(b, "user-prompt-submit.mjs", input("UserPromptSubmit", b, { prompt: "more" }));
    assert.equal(r.json.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(r.json.hookSpecificOutput.additionalContext, /^continuity: this session's context is 80% full \(from the token usage the last reply recorded\)\..*`\/continuity:handoff`/);
    assert.equal(existsSync(join(b.stateDir, "calibration.ndjson")), false, "no calibration was needed");
    r = spawnHook(b, "user-prompt-submit.mjs", input("UserPromptSubmit", b, { prompt: "more" }));
    assert.equal(r.json, null, "warned once");

    b.writeConfig({ threshold: 0.99 });
    r = spawnHook(b, "user-prompt-submit.mjs", input("UserPromptSubmit", b, { session_id: "s2", prompt: "x" }));
    assert.doesNotMatch(r.json.hookSpecificOutput.additionalContext, /% full/, "a higher threshold is honoured");
    b.writeConfig({ contextTokens: 1000000 });
    r = spawnHook(b, "user-prompt-submit.mjs", input("UserPromptSubmit", b, { session_id: "s2b", prompt: "x" }));
    assert.doesNotMatch(r.json.hookSpecificOutput.additionalContext, /% full/, "a larger context window is honoured");
    b.writeConfig({ pressure: "off", liveness: "off" });
    r = spawnHook(b, "user-prompt-submit.mjs", input("UserPromptSubmit", b, { session_id: "s3", prompt: "x" }));
    assert.equal(r.json, null);
    b.writeConfig({ threshold: "lots" });
    r = spawnHook(b, "user-prompt-submit.mjs", input("UserPromptSubmit", b, { session_id: "s4", prompt: "x" }));
    assert.match(r.json.hookSpecificOutput.additionalContext, / 80% full \(from the token usage/, "a bad threshold falls back to the default");
    assert.match(r.json.hookSpecificOutput.additionalContext, /continuity: .*threshold must be a number between 0 and 1, not "lots"/);
    r = spawnHook(b, "user-prompt-submit.mjs", input("UserPromptSubmit", b, { session_id: "s4", prompt: "x" }));
    assert.equal(r.json, null, "the config complaint is also once per session");

    const ro = join(b.root, "ro");
    mkdirSync(join(ro, "continuity"), { recursive: true });
    writeFileSync(join(ro, "continuity", "errors.log"), "");
    chmodSync(join(ro, "continuity"), 0o555);
    r = spawnHook(b, "user-prompt-submit.mjs", input("UserPromptSubmit", b, { session_id: "ro", prompt: "x" }), { env: { XDG_STATE_HOME: ro, XDG_CONFIG_HOME: join(b.root, "nocfg") } });
    chmodSync(join(ro, "continuity"), 0o755);
    assert.equal(r.status, 0);
    if (process.getuid?.() !== 0) {
      assert.match(r.json.hookSpecificOutput.additionalContext, /pre-compaction save liveness/);
      assert.match(r.json.systemMessage, /session mark could not be written/);
      assert.match(readFileSync(join(ro, "continuity", "errors.log"), "utf8"), /UserPromptSubmit once-mark not written/);
    }
  } finally {
    b.release();
  }
});

test("stop: quiet when small; blocks once near full with the handoff request; not after this session wrote a handoff; stop_hook_active passes; unwritable mark means no block", () => {
  const b = box();
  try {
    b.writeTranscript([{ type: "user", message: { role: "user", content: "x" } }]);
    let r = spawnHook(b, "stop.mjs", input("Stop", b, { stop_hook_active: false }));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.ms < 4000);
    assert.equal(r.json, null, r.stdout);

    nearlyFull(b);
    r = spawnHook(b, "stop.mjs", input("Stop", b, { stop_hook_active: false }));
    assert.equal(r.status, 0);
    assert.equal(r.json.decision, "block");
    assert.match(r.json.reason, / 80% full \(from the token usage.*`\/continuity:handoff`/);
    assert.match(b.readState("sessions/s-test.json"), /stopBlocked/);
    r = spawnHook(b, "stop.mjs", input("Stop", b, { stop_hook_active: false }));
    assert.equal(r.json, null, "once per session");
    r = spawnHook(b, "stop.mjs", input("Stop", b, { session_id: "s2", stop_hook_active: true }));
    assert.equal(r.json, null, "a stop already continued by a hook is never blocked again");

    // The prompt warned, the model wrote the handoff in that turn: the stop at the end of it passes.
    r = spawnHook(b, "user-prompt-submit.mjs", input("UserPromptSubmit", b, { session_id: "wrote", prompt: "go" }));
    assert.match(r.json.hookSpecificOutput.additionalContext, / 80% full \(from the token usage/);
    handoff(b, "wrote");
    r = spawnHook(b, "stop.mjs", input("Stop", b, { session_id: "wrote", stop_hook_active: false }));
    assert.equal(r.json, null, `a handoff from this session is already open: ${r.stdout}`);
    // Another session's handoff does not count for this one.
    r = spawnHook(b, "stop.mjs", input("Stop", b, { session_id: "not-wrote", stop_hook_active: false }));
    assert.equal(r.json.decision, "block");

    writeFileSync(join(b.root, "file"), "");
    r = spawnHook(b, "stop.mjs", input("Stop", b, { session_id: "s3", stop_hook_active: false }), { env: { XDG_STATE_HOME: join(b.root, "file") } });
    assert.equal(r.status, 0);
    assert.equal(r.json, null, "the once-mark cannot be written there, so no block");

    b.writeConfig({ pressure: "off" });
    r = spawnHook(b, "stop.mjs", input("Stop", b, { session_id: "s4", stop_hook_active: false }));
    assert.equal(r.json, null);
  } finally {
    b.release();
  }
});

test("end to end: a session starts, works, compacts, resumes with its own state, fills up, is nudged once, and hands off", () => {
  const b = box();
  try {
    const sid = "e2e-session";
    const ev = (event, extra) => input(event, b, { session_id: sid, ...extra });
    // 1. Fresh machine: the start says no save has ever been recorded.
    let r = spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: sid, cwd: b.work, source: "startup" });
    assert.match(r.json.hookSpecificOutput.additionalContext, /has ever been recorded/);
    // 2. The first prompt adds nothing (liveness said, the transcript is small).
    b.writeTranscript([{ type: "user", message: { role: "user", content: "build the thing" } }]);
    r = spawnHook(b, "user-prompt-submit.mjs", ev("UserPromptSubmit", { prompt: "build the thing" }));
    assert.equal(r.json, null);
    // 3. Work happens; a stop passes.
    b.git("checkout", "-q", "-b", "thing");
    writeFileSync(join(b.work, "thing.txt"), "wip");
    const worked = [{ type: "user", message: { role: "user", content: "build the thing" } }, { message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: join(b.work, "thing.txt") } }] } }];
    b.writeTranscript(worked);
    r = spawnHook(b, "stop.mjs", ev("Stop", { stop_hook_active: false }));
    assert.equal(r.json, null);
    // 4. A compaction (Claude Code's payload: no token_count) saves; the person is told no handoff existed.
    r = spawnHook(b, "pre-compact.mjs", ev("PreCompact", { trigger: "auto", custom_instructions: "" }));
    assert.match(r.json.systemMessage, /no handoff written/);
    // 5. The restore after it carries the branch, the file and the ask, and says the save worked.
    r = spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: sid, cwd: b.work, source: "compact" });
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /## Branch\nthing\n/);
    assert.match(ctx, /thing\.txt/);
    assert.match(ctx, /- build the thing/);
    assert.match(ctx, /last successful save less than a minute ago/);
    // 6. The session grows to about 80% of the window: the next stop is blocked, once.
    nearlyFull(b, worked);
    r = spawnHook(b, "stop.mjs", ev("Stop", { stop_hook_active: false }));
    assert.equal(r.json.decision, "block");
    r = spawnHook(b, "stop.mjs", ev("Stop", { stop_hook_active: false }));
    assert.equal(r.json, null);
    // 7. The handoff gets written; the next compaction inlines it and says nothing to the person.
    mkdirSync(join(b.work, ".ai", "handoffs"), { recursive: true });
    writeFileSync(join(b.work, ".ai", "handoffs", "now--jo--thing.md"), `---\nsession_id: ${sid}\nlane: thing\nauthor: jo\nbranch: thing\ncreated: ${new Date().toISOString()}\nstatus: open\n---\n\n## Where I left off\nthing.txt is a stub.\n\n## Next move\nFill it in.\n\n## Already ruled out\nGenerating it.\n\n## Live uncertainty\nNone.\n\n## Working state\nBranch thing, one uncommitted file.\n`);
    r = spawnHook(b, "pre-compact.mjs", ev("PreCompact", { trigger: "auto" }));
    assert.equal(r.json, null, r.stdout);
    r = spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: sid, cwd: b.work, source: "compact" });
    assert.match(r.json.hookSpecificOutput.additionalContext, /This snapshot includes an agent-authored handoff section[\s\S]*Generating it\./);
    // 8. A second session on the same machine hears the healthy liveness line, not the alarm.
    r = spawnHook(b, "session-start.mjs", { hook_event_name: "SessionStart", session_id: "second", cwd: b.work, source: "startup" });
    assert.match(r.json.hookSpecificOutput.additionalContext, /^continuity, pre-compaction save liveness: last successful save/);
    assert.equal(existsSync(join(b.stateDir, "errors.log")), false, "no hook faulted");
  } finally {
    b.release();
  }
});
