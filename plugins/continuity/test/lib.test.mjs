// test/lib.test.mjs — each lib module's exported behaviour, including its error paths.

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { box } from "./helpers.mjs";
import { calibrationPath, configPath, heartbeatPath, sanitizeSessionId, sessionFlagsPath, snapshotPath, stateDir } from "../lib/paths.mjs";
import { DEFAULTS, readConfig } from "../lib/config.mjs";
import { HEARTBEAT_MAX_LINES, readHeartbeat, recordHeartbeat } from "../lib/heartbeat.mjs";
import { age, renderLiveness } from "../lib/liveness.mjs";
import { CALIBRATION_MAX_LINES, readCalibration, recordCalibration } from "../lib/calibration.mjs";
import { handoffRequest, pressure } from "../lib/pressure.mjs";
import { markFlag, readFlags, sessionKey } from "../lib/session-flags.mjs";
import { ENTRY_LINE_CAP, listHandoffs, parseFrontmatter, renderHandoffs, resolveHandoffRoot } from "../lib/handoffs.mjs";
import { MAX_STATUS_ENTRIES, RESTORE_MAX_CHARS, STATE_MAX_AGE_MS, buildSnapshot, capture, readTranscript, renderSnapshot, restore } from "../lib/snapshot.mjs";
import { prune } from "../scripts/prune.mjs";

const handoffText = (over = {}) => {
  const meta = { session_id: "s-test", lane: "port", author: "jo", branch: "main", created: "2026-11-04T12:00:00Z", status: "open", ...over };
  return `---\n${Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n# Session handoff: ${meta.lane}\n\n## Where I left off\nHalfway.\n\n## Next move\nTests.\n\n## Already ruled out\nTmpdir flags.\n\n## Live uncertainty\nNone.\n\n## Working state\nClean.\n`;
};

test("paths: every file sits under the XDG state dir, HOME is the fallback, ids are narrowed", () => {
  const env = { XDG_STATE_HOME: "/s", XDG_CONFIG_HOME: "/c", HOME: "/h" };
  assert.equal(stateDir(env), "/s/continuity");
  assert.equal(stateDir({ HOME: "/h" }), "/h/.local/state/continuity");
  assert.equal(stateDir({ HOME: "/h", XDG_STATE_HOME: "  " }), "/h/.local/state/continuity");
  assert.equal(configPath(env), "/c/continuity/config.json");
  assert.equal(configPath({ HOME: "/h" }), "/h/.config/continuity/config.json");
  assert.equal(snapshotPath("a/b c", env), "/s/continuity/abc.json");
  assert.equal(snapshotPath(undefined, env), "/s/continuity/unknown.json");
  assert.equal(sessionFlagsPath("x", env), "/s/continuity/sessions/x.json");
  assert.equal(heartbeatPath(env), "/s/continuity/heartbeat.ndjson");
  assert.equal(calibrationPath(env), "/s/continuity/calibration.ndjson");
  assert.equal(sanitizeSessionId("../../etc"), "etc");
  assert.equal(sanitizeSessionId(""), "unknown");
});

test("config: absent is the defaults; malformed, wrong-typed and partial files each name the problem and keep the defaults", () => {
  const b = box();
  try {
    assert.deepEqual(readConfig(b.env), { config: { ...DEFAULTS }, path: configPath(b.env), problem: null });
    b.writeConfig("{nope");
    let r = readConfig(b.env);
    assert.deepEqual(r.config, { ...DEFAULTS });
    assert.match(r.problem, /does not parse/);
    b.writeConfig("[1]");
    assert.match(readConfig(b.env).problem, /not a JSON object/);
    b.writeConfig({ threshold: 0.8, pressure: "off", other: 1 });
    r = readConfig(b.env);
    assert.deepEqual(r.config, { ...DEFAULTS, threshold: 0.8, pressure: "off" });
    assert.equal(r.problem, null);
    b.writeConfig({ threshold: 2, liveness: "maybe", snapshot: "off" });
    r = readConfig(b.env);
    assert.deepEqual(r.config, { ...DEFAULTS, snapshot: "off" });
    assert.match(r.problem, /threshold must be a number between 0 and 1, not 2/);
    assert.match(r.problem, /liveness must be "on" or "off", not "maybe"/);
    chmodSync(configPath(b.env), 0o000);
    r = readConfig(b.env);
    assert.deepEqual(r.config, { ...DEFAULTS });
    if (process.getuid?.() !== 0) assert.match(r.problem, /could not be read/);
    chmodSync(configPath(b.env), 0o644);
  } finally {
    b.release();
  }
});

test("heartbeat: records carry every field, trim to the cap, and an unwritable or missing file is an empty history", () => {
  const b = box();
  try {
    assert.deepEqual(readHeartbeat(b.env), []);
    assert.equal(recordHeartbeat({ event: "PreCompact", trigger: "auto", session: "s 1", cwd: "/w", outcome: "started" }, b.env, new Date("2026-11-04T10:00:00Z")), true);
    assert.deepEqual(readHeartbeat(b.env), [{ at: "2026-11-04T10:00:00.000Z", event: "PreCompact", trigger: "auto", session: "s1", cwd: "/w", outcome: "started" }]);
    assert.equal(recordHeartbeat({}, b.env), true);
    assert.deepEqual(readHeartbeat(b.env)[1], { ...readHeartbeat(b.env)[1], event: "(none)", trigger: "", session: "unknown", cwd: "", outcome: "unknown" });
    for (let i = 0; i < HEARTBEAT_MAX_LINES + 10; i++) recordHeartbeat({ event: "PreCompact", outcome: `n${i}` }, b.env);
    const all = readHeartbeat(b.env);
    assert.equal(all.length, HEARTBEAT_MAX_LINES);
    assert.equal(all[all.length - 1].outcome, `n${HEARTBEAT_MAX_LINES + 9}`);
    writeFileSync(heartbeatPath(b.env), '{"event":"PreCompact","outcome":"ok","at":"x"}\nnot json\n');
    assert.equal(readHeartbeat(b.env).length, 1);
    // A state dir that cannot exist (its parent is a regular file): the write fails quietly.
    writeFileSync(join(b.root, "notadir"), "");
    assert.equal(recordHeartbeat({ outcome: "ok" }, { ...b.env, XDG_STATE_HOME: join(b.root, "notadir") }), false);
  } finally {
    b.release();
  }
});

test("liveness: the three cases, and age() is coarse", () => {
  assert.equal(age(10_000), "less than a minute ago");
  assert.equal(age(60_000), "1 minute ago");
  assert.equal(age(25 * 60_000), "25 minutes ago");
  assert.equal(age(3 * 3_600_000), "3 hours ago");
  assert.equal(age(72 * 3_600_000), "3 days ago");
  const env = { XDG_STATE_HOME: "/s", HOME: "/h" };
  assert.match(renderLiveness({ env, records: [] }), /\*\*no pre-compaction save has ever been recorded on this machine\.\*\*/);
  assert.match(renderLiveness({ env, records: [] }), /\/s\/continuity\/heartbeat\.ndjson/);
  const now = Date.parse("2026-11-04T12:00:00Z");
  const ok = renderLiveness({ env, now, records: [{ at: "2026-11-04T11:30:00Z", event: "PreCompact", outcome: "started" }, { at: "2026-11-04T11:30:00Z", event: "PreCompact", outcome: "ok" }, { at: "2026-11-04T11:50:00Z", event: "PreCompact", outcome: "started" }, { at: "2026-11-04T11:50:00Z", event: "PreCompact", outcome: "failed:EACCES" }] });
  assert.equal(ok, "continuity, pre-compaction save liveness: last successful save 30 minutes ago (2026-11-04T11:30:00Z); the snapshot path is alive.");
  const failed = renderLiveness({ env, now, records: [{ at: "2026-11-04T11:50:00Z", event: "PreCompact", outcome: "started" }, { at: "2026-11-04T11:50:00Z", event: "PreCompact", outcome: "failed:EACCES" }] });
  assert.match(failed, /\*\*no pre-compaction save has ever succeeded on this machine\.\*\*/);
  assert.match(failed, /invoked 2 times and the most recent outcome was `failed:EACCES`/);
  assert.match(renderLiveness({ env, now, records: [{ at: "x", event: "SessionStart", outcome: "ok" }] }), /ever succeeded.*invoked 1 time and/s);
});

test("calibration: records only with the fields and a measurable transcript, trims, and reads back the median ratio and newest target", () => {
  const b = box();
  try {
    assert.equal(readCalibration(b.env), null);
    assert.equal(recordCalibration({ token_count: 100, transcript_path: "/nowhere" }, b.env), false);
    assert.equal(recordCalibration({ token_count: 0, transcript_path: b.transcript }, b.env), false);
    b.writeTranscript(["x".repeat(99)]);
    assert.equal(recordCalibration({ token_count: 1000, compaction_target: 200000, transcript_path: b.transcript }, b.env), true);
    assert.deepEqual(readCalibration(b.env), { ratio: 10, target: 200000 });
    assert.equal(recordCalibration({ token_count: 3000, transcript_path: b.transcript }, b.env), true);
    assert.equal(recordCalibration({ token_count: 2000, compaction_target: "bad", transcript_path: b.transcript }, b.env), true);
    assert.deepEqual(readCalibration(b.env), { ratio: 20, target: 200000 });
    writeFileSync(calibrationPath(b.env), "garbage\n{\"bytes\":0,\"tokens\":5}\n");
    assert.equal(readCalibration(b.env), null);
    for (let i = 0; i < CALIBRATION_MAX_LINES + 5; i++) recordCalibration({ token_count: 100, compaction_target: 7, transcript_path: b.transcript }, b.env);
    assert.equal(readFileSync(calibrationPath(b.env), "utf8").split("\n").filter(Boolean).length, CALIBRATION_MAX_LINES);
  } finally {
    b.release();
  }
});

test("pressure: silent when uncalibrated, unmeasurable or under the threshold; the percentage past it; the request names the command", () => {
  const b = box();
  try {
    b.writeTranscript(["x".repeat(3999)]);
    const input = { transcript_path: b.transcript };
    assert.equal(pressure(input, { threshold: 0.65, env: b.env }), null);
    mkdirSync(stateDir(b.env), { recursive: true });
    writeFileSync(calibrationPath(b.env), '{"bytes":4000,"tokens":160000,"target":200000}\n');
    assert.deepEqual(pressure(input, { threshold: 0.65, env: b.env }), { pct: 80, estimated: 160000, target: 200000 });
    assert.equal(pressure(input, { threshold: 0.9, env: b.env }), null);
    assert.equal(pressure({ transcript_path: "/nowhere" }, { threshold: 0.1, env: b.env }), null);
    assert.equal(pressure({}, { threshold: 0.1, env: b.env }), null);
    assert.match(handoffRequest(80), /roughly 80% of the way to auto-compaction.*`\/continuity:handoff`/);
  } finally {
    b.release();
  }
});

test("session flags: keyed by session, then transcript, then nosess; marks accumulate; an unwritable dir returns false", () => {
  const b = box();
  try {
    assert.equal(sessionKey({ session_id: "abc" }), "abc");
    assert.equal(sessionKey({ transcript_path: "/t/x.jsonl" }), `t-${Buffer.from("/t/x.jsonl").toString("base64url")}`);
    assert.equal(sessionKey({}), "nosess");
    assert.deepEqual(readFlags("k", b.env), {});
    assert.equal(markFlag("k", "livenessSaid", b.env, new Date("2026-11-04T10:00:00Z")), true);
    assert.equal(markFlag("k", "stopBlocked", b.env, new Date("2026-11-04T10:01:00Z")), true);
    assert.deepEqual(readFlags("k", b.env), { livenessSaid: "2026-11-04T10:00:00.000Z", stopBlocked: "2026-11-04T10:01:00.000Z" });
    writeFileSync(sessionFlagsPath("bad", b.env), "[1,2]");
    assert.deepEqual(readFlags("bad", b.env), {});
    chmodSync(join(stateDir(b.env), "sessions"), 0o555);
    if (process.getuid?.() !== 0) assert.equal(markFlag("new", "x", b.env), false);
    chmodSync(join(stateDir(b.env), "sessions"), 0o755);
  } finally {
    b.release();
  }
});

test("handoffs: root resolution order, frontmatter, the open-and-fresh filter, the render caps", () => {
  const b = box();
  try {
    assert.equal(resolveHandoffRoot(b.work, { CLAUDE_PROJECT_DIR: b.root }), b.root);
    assert.equal(resolveHandoffRoot(b.work, { CLAUDE_PROJECT_DIR: "/nowhere/x" }), b.work);
    const sub = join(b.work, "deep", "er");
    mkdirSync(sub, { recursive: true });
    assert.equal(resolveHandoffRoot(sub, {}), b.work);
    const bare = join(b.root, "bare");
    mkdirSync(bare);
    assert.equal(resolveHandoffRoot(bare, {}), bare);
    // A linked worktree resolves to the main worktree, so every worktree shares one pool.
    writeFileSync(join(b.work, "f"), "1");
    b.git("add", "f");
    b.git("commit", "-q", "-m", "one");
    const wt = join(b.root, "wt");
    b.git("worktree", "add", "-q", wt, "-b", "side");
    assert.equal(resolveHandoffRoot(wt, {}), b.work);

    assert.equal(parseFrontmatter("no frontmatter"), null);
    assert.deepEqual(parseFrontmatter("---\na: 1\nb-c: two words\n---\nbody\n"), { meta: { a: "1", "b-c": "two words" }, body: "body" });

    assert.deepEqual(listHandoffs(b.work), []);
    const dir = join(b.work, ".ai", "handoffs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a--open.md"), handoffText({ lane: "open-lane" }));
    writeFileSync(join(dir, "b--consumed.md"), handoffText({ lane: "done", status: "consumed" }));
    writeFileSync(join(dir, "c--malformed.md"), "just text");
    writeFileSync(join(dir, "d--empty.md"), "---\nlane: e\n---\n");
    writeFileSync(join(dir, "e--stale.md"), handoffText({ lane: "stale" }));
    const old = (Date.now() - 8 * 24 * 3_600_000) / 1000;
    utimesSync(join(dir, "e--stale.md"), old, old);
    writeFileSync(join(dir, "f.txt"), handoffText({ lane: "not-md" }));
    const list = listHandoffs(b.work);
    assert.deepEqual(list.map((e) => e.lane), ["open-lane"]);
    assert.equal(list[0].date, "2026-11-04");
    assert.equal(list[0].author, "jo");

    for (let i = 0; i < 4; i++) writeFileSync(join(dir, `m${i}.md`), handoffText({ lane: `lane-${i}`, created: `2026-11-0${i + 1}T00:00:00Z` }));
    writeFileSync(join(dir, "long.md"), handoffText({ lane: "long" }).replace("Clean.\n", `${"line\n".repeat(ENTRY_LINE_CAP + 40)}## Tail\nend\n`));
    const out = renderHandoffs(b.work);
    assert.match(out, /^## Open handoffs \(6\)\n/);
    assert.equal((out.match(/^### /gm) ?? []).length, 3);
    assert.match(out, /\(3 more suppressed; see \.ai\/handoffs\/\)/);
    assert.match(out, /_\(truncated at \d+ of \d+ lines; full note: .*long\.md\)_/);
    assert.equal(renderHandoffs("/nowhere"), "");
  } finally {
    b.release();
  }
});

test("snapshot: transcript reading, the capture's sources and caps, the render, and capture() on an unwritable state", () => {
  const b = box();
  try {
    assert.deepEqual(readTranscript("/nowhere"), { read: false, prompts: [], touched: [] });
    b.writeTranscript([
      { type: "user", message: { role: "user", content: "<local-command-stdout>ignored</local-command-stdout>" } },
      { type: "user", message: { role: "user", content: "first ask" } },
      "not json",
      { message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "/a.txt" } }, { type: "tool_use", name: "NotebookEditor", input: { file_path: "/no.ipynb" } }, { type: "tool_use", name: "Write", input: { path: "/b.txt" } }] } },
      { message: { role: "user", content: [{ type: "text", text: "second   ask\nwith newline" }] } },
    ]);
    assert.deepEqual(readTranscript(b.transcript), { read: true, prompts: ["<local-command-stdout>ignored</local-command-stdout>", "first ask", "second   ask\nwith newline"], touched: ["/a.txt", "/b.txt"] });

    b.git("checkout", "-q", "-b", "feature/x");
    for (let i = 0; i < MAX_STATUS_ENTRIES + 3; i++) writeFileSync(join(b.work, `dirty-${String(i).padStart(2, "0")}.txt`), "x");
    const now = new Date("2026-11-04T12:00:00Z");
    const s = buildSnapshot({ session_id: "s-test", cwd: b.work, transcript_path: b.transcript, trigger: "auto" }, { env: b.env, now });
    assert.equal(s.version, 1);
    assert.equal(s.at, "2026-11-04T12:00:00.000Z");
    assert.equal(s.branch, "feature/x");
    assert.equal(s.captureSource, "session transcript");
    assert.equal(s.status.total, MAX_STATUS_ENTRIES + 3);
    assert.equal(s.status.lines.length, MAX_STATUS_ENTRIES);
    assert.deepEqual(s.filesTouched.lines, ["/a.txt", "/b.txt"]);
    assert.deepEqual(s.recentIntent, { source: "session transcript", lines: ["first ask", "second ask with newline"] });
    assert.equal(s.handoff.present, false);
    assert.equal(s.reconstruction, null);
    const md = renderSnapshot(s);
    assert.match(md, /## Branch\nfeature\/x\n/);
    assert.match(md, new RegExp(`… TRUNCATED: 3 more changed paths not shown \\(${MAX_STATUS_ENTRIES + 3} total\\)\\. Run \`git status --short\``));
    assert.match(md, /- first ask\n- second ask with newline/);
    assert.match(md, /\*\*No agent-authored handoff was written before this compaction\.\*\* Everything above is mechanical/);

    // No transcript, host-supplied fields: their sections, their sources, no reconstruction.
    const h = buildSnapshot({ cwd: b.work, intents: ["from host", 3, " "], file_operations: " read x\nwrote y ", agent_judgment: ["I think\n so"] }, { env: b.env, now });
    assert.equal(h.captureSource, "host-supplied payload fields");
    assert.deepEqual(h.recentIntent, { source: "host-supplied `intents` (no readable transcript on this payload)", lines: ["from host"] });
    assert.equal(h.hostFileOperations, "read x\nwrote y");
    assert.equal(h.hostJudgment, "- I think so");
    assert.match(h.filesTouched.source, /^nothing derived: no readable transcript on this payload; see the host-supplied file operations/);
    assert.equal(h.reconstruction, null);
    const hmd = renderSnapshot(h);
    assert.match(hmd, /## Host-supplied file operations\n/);
    assert.match(hmd, /## Host-supplied agent judgment\n/);
    assert.match(hmd, /The judgment layer is not absent/);

    // Nothing at all: a reconstruction from the repository, named as such.
    writeFileSync(join(b.work, "c"), "1");
    b.git("add", "c");
    b.git("commit", "-q", "-m", "a commit");
    const d = buildSnapshot({ cwd: b.work, trigger: "manual" }, { env: b.env, now });
    assert.match(d.captureSource, /^repository only/);
    assert.equal(d.reconstruction.missing.length, 4);
    assert.deepEqual(d.reconstruction.recentCommits.lines.map((l) => l.replace(/^\w+ /, "")), ["a commit"]);
    assert.deepEqual(d.reconstruction.unpushed, { lines: [], total: 0 });
    const dmd = renderSnapshot(d);
    assert.match(dmd, /## Capture was degraded: this is a reconstruction, not a record/);
    assert.match(dmd, /### Committed but not pushed\n\n\(none, or no upstream to compare against\)/);

    // With a handoff: inlined under its heading, and the warning is replaced.
    mkdirSync(join(b.work, ".ai", "handoffs"), { recursive: true });
    writeFileSync(join(b.work, ".ai", "handoffs", "h.md"), handoffText());
    const w = buildSnapshot({ cwd: b.work }, { env: b.env, now });
    assert.equal(w.handoff.present, true);
    assert.equal(w.handoff.root, b.work);
    const wmd = renderSnapshot(w);
    assert.match(wmd, /## Agent-authored handoff \(from `.*\/\.ai\/handoffs\/`\)\n[\s\S]*Tmpdir flags\./);
    assert.doesNotMatch(wmd, /No agent-authored handoff was written/);

    // A cwd that is not a repository: no branch, a clean status, still a file.
    const nowhere = join(b.root, "plain");
    mkdirSync(nowhere);
    const p = capture({ session_id: "p", cwd: nowhere }, { env: b.env, now });
    assert.equal(p.outcome, "ok");
    assert.equal(p.snapshot.branch, null);
    assert.ok(existsSync(snapshotPath("p", b.env)));

    chmodSync(stateDir(b.env), 0o555);
    if (process.getuid?.() !== 0) {
      const f = capture({ session_id: "q", cwd: b.work }, { env: b.env });
      assert.match(f.outcome, /^failed:EACCES/);
      assert.ok(f.snapshot, "the snapshot was still built");
    }
    chmodSync(stateDir(b.env), 0o755);
  } finally {
    b.release();
  }
});

test("snapshot: restore() injects and unlinks its own fresh snapshot, keeps an over-budget one, ignores a stale, foreign or broken one", () => {
  const b = box();
  try {
    b.writeTranscript([{ message: { role: "user", content: "the ask" } }]);
    assert.equal(restore({ session_id: "s-test" }, { env: b.env }), null);
    capture({ session_id: "s-test", cwd: b.work, transcript_path: b.transcript, trigger: "auto" }, { env: b.env });
    assert.equal(restore({ session_id: "other" }, { env: b.env }), null, "another session's id sees nothing");
    const text = restore({ session_id: "s-test" }, { env: b.env });
    assert.match(text, /^## Restored session state \(post-compaction\)\n/);
    assert.match(text, /restate what the thread is and what is pending on it/);
    assert.match(text, /\*\*No handoff was written before compaction\.\*\*/);
    assert.match(text, /- the ask\n/);
    assert.equal(existsSync(snapshotPath("s-test", b.env)), false, "consumed");
    assert.equal(restore({ session_id: "s-test" }, { env: b.env }), null, "one-shot");

    capture({ session_id: "s-test", cwd: b.work, transcript_path: b.transcript }, { env: b.env });
    const old = (Date.now() - STATE_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(snapshotPath("s-test", b.env), old, old);
    assert.equal(restore({ session_id: "s-test" }, { env: b.env }), null, "stale is invisible");
    assert.ok(existsSync(snapshotPath("s-test", b.env)), "and left for prune");

    writeFileSync(snapshotPath("s-test", b.env), "{broken");
    assert.equal(restore({ session_id: "s-test" }, { env: b.env }), null);

    mkdirSync(join(b.work, ".ai", "handoffs"), { recursive: true });
    writeFileSync(join(b.work, ".ai", "handoffs", "h.md"), handoffText().replace("Clean.\n", `${"x".repeat(100)}\n`.repeat(100)));
    writeFileSync(join(b.work, ".ai", "handoffs", "h2.md"), handoffText({ lane: "two" }).replace("Clean.\n", `${"y".repeat(100)}\n`.repeat(100)));
    writeFileSync(join(b.work, ".ai", "handoffs", "h3.md"), handoffText({ lane: "three" }).replace("Clean.\n", `${"z".repeat(100)}\n`.repeat(100)));
    capture({ session_id: "s-test", cwd: b.work, transcript_path: b.transcript, file_operations: "w".repeat(7000), agent_judgment: ["j".repeat(7000)] }, { env: b.env });
    const big = restore({ session_id: "s-test" }, { env: b.env });
    assert.match(big, new RegExp(`\\*\\*TRUNCATED: this snapshot is \\d+ characters and only the first ${RESTORE_MAX_CHARS} are shown\\.\\*\\*`));
    assert.match(big, /This snapshot includes an agent-authored handoff section/);
    assert.ok(existsSync(snapshotPath("s-test", b.env)), "an over-budget restore keeps its file");
  } finally {
    b.release();
  }
});

test("prune: removes old snapshots and marks, keeps errors.log, heartbeat and calibration whatever their age, and empty dirs go", () => {
  const b = box();
  try {
    const dir = stateDir(b.env);
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const old = (Date.now() - 31 * 24 * 3_600_000) / 1000;
    for (const f of ["old.json", "sessions/old.json", "errors.log", "heartbeat.ndjson", "calibration.ndjson"]) {
      writeFileSync(join(dir, f), "1234");
      utimesSync(join(dir, f), old, old);
    }
    writeFileSync(join(dir, "fresh.json"), "12");
    const dry = prune(dir, { days: 30, dryRun: true });
    assert.deepEqual(dry, { removed: 2, bytes: 8, kept: 4 });
    assert.ok(existsSync(join(dir, "old.json")));
    assert.deepEqual(prune(dir, { days: 30 }), { removed: 2, bytes: 8, kept: 4 });
    assert.equal(existsSync(join(dir, "old.json")), false);
    assert.equal(existsSync(join(dir, "sessions")), false);
    for (const f of ["errors.log", "heartbeat.ndjson", "calibration.ndjson", "fresh.json"]) assert.ok(existsSync(join(dir, f)), f);
    assert.deepEqual(prune(join(b.root, "nowhere")), { removed: 0, bytes: 0, kept: 0 });
  } finally {
    b.release();
  }
});
