// test/lib.test.mjs — each lib module's exported behaviour, including its error paths.

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { box, PLUGIN_ROOT } from "./helpers.mjs";
import { calibrationPath, configPath, heartbeatPath, sanitizeSessionId, sessionFlagsPath, snapshotPath, stateDir } from "../lib/paths.mjs";
import { DEFAULTS, readConfig } from "../lib/config.mjs";
import { HEARTBEAT_MAX_LINES, readHeartbeat, recordHeartbeat } from "../lib/heartbeat.mjs";
import { age, lastSaveFor, renderLiveness } from "../lib/liveness.mjs";
import { CALIBRATION_MAX_LINES, measureTranscript, readCalibration, recordCalibration } from "../lib/calibration.mjs";
import { BYTES_PER_TOKEN_ESTIMATE, estimateContext, handoffRequest, pressure } from "../lib/pressure.mjs";
import { markFlag, readFlags, sessionKey } from "../lib/session-flags.mjs";
import { ENTRY_LINE_CAP, handoffWrittenBy, listHandoffs, parseFrontmatter, renderHandoffs, resolveHandoffRoot } from "../lib/handoffs.mjs";
import { MAX_STATUS_ENTRIES, RESTORE_MAX_CHARS, STATE_MAX_AGE_MS, buildSnapshot, capture, readTranscript, renderSnapshot, restore } from "../lib/snapshot.mjs";
import { ERRORS_MAX_LINES, logError } from "../lib/errors.mjs";
import { git } from "../lib/git.mjs";
import { appendBounded } from "../lib/bounded-log.mjs";
import { prune } from "../scripts/prune.mjs";
import { NOTES_MAX_COUNT, RULES_FILE_MAX_BYTES, RULES_MIN_BYTES, RULES_TOTAL_MAX_BYTES, findGitRoot, fitRules, notesRoot, renderNotes, renderRules, truncateBytes, walkRules } from "../lib/repo-rules.mjs";

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
    // A threshold must be a JSON number: strings and arrays that Number() would coerce are problems.
    for (const t of ["0.5", [0.5], " 0.5 ", "0x0", null, true]) {
      r = readConfig((b.writeConfig({ threshold: t }), b.env));
      assert.equal(r.config.threshold, DEFAULTS.threshold, JSON.stringify(t));
      assert.match(r.problem, /threshold must be a number between 0 and 1/, JSON.stringify(t));
    }
    b.writeConfig({ contextTokens: 100000 });
    assert.deepEqual(readConfig(b.env), { config: { ...DEFAULTS, contextTokens: 100000 }, path: configPath(b.env), problem: null });
    for (const n of [0, -5, 1.5, "200000", [1]]) {
      r = readConfig((b.writeConfig({ contextTokens: n }), b.env));
      assert.equal(r.config.contextTokens, DEFAULTS.contextTokens, JSON.stringify(n));
      assert.match(r.problem, /contextTokens must be a positive whole number/, JSON.stringify(n));
    }
    b.writeConfig({ rules: "off", notesDir: "docs/notes", notesCount: 0 });
    assert.deepEqual(readConfig(b.env), { config: { ...DEFAULTS, rules: "off", notesDir: "docs/notes", notesCount: 0 }, path: configPath(b.env), problem: null });
    for (const d of ["", "  ", 5, null, ["x"]]) {
      r = readConfig((b.writeConfig({ notesDir: d }), b.env));
      assert.equal(r.config.notesDir, DEFAULTS.notesDir, JSON.stringify(d));
      assert.match(r.problem, /notesDir must be a non-empty string/, JSON.stringify(d));
    }
    for (const n of [-1, 1.5, "5", 101, null]) {
      r = readConfig((b.writeConfig({ notesCount: n }), b.env));
      assert.equal(r.config.notesCount, DEFAULTS.notesCount, JSON.stringify(n));
      assert.match(r.problem, /notesCount must be a whole number from 0 to 100/, JSON.stringify(n));
    }
    assert.match(readConfig((b.writeConfig({ rules: 1 }), b.env)).problem, /rules must be "on" or "off", not 1/);
    chmodSync(configPath(b.env), 0o000);
    r = readConfig(b.env);
    assert.deepEqual(r.config, { ...DEFAULTS });
    if (process.getuid?.() !== 0) assert.match(r.problem, /could not be read/);
    chmodSync(configPath(b.env), 0o644);
  } finally {
    b.release();
  }
});

test("repo rules: the walk collects every level cwd to root, CLAUDE.md beats AGENTS.md, the local file follows it, and the root is the git root, the workspace above it, or the cwd alone", () => {
  const b = box();
  try {
    // b.work is the git root. A workspace above it holds one AGENTS.md; a directory between holds none.
    const ws = join(b.root, "ws");
    const repo = join(ws, "checkouts", "repo");
    mkdirSync(join(repo, "pkg", "deep"), { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    writeFileSync(join(ws, "AGENTS.md"), "# workspace\n");
    writeFileSync(join(repo, "CLAUDE.md"), "# repo claude\n");
    writeFileSync(join(repo, "AGENTS.md"), "# repo agents (shadowed)\n");
    writeFileSync(join(repo, "CLAUDE.local.md"), "# repo local\n");
    writeFileSync(join(repo, "pkg", "AGENTS.md"), "# pkg agents\n");
    writeFileSync(join(repo, "pkg", "deep", "CLAUDE.md"), "   \n");
    // A rules file in the directory between the git root and the workspace must not exist for the
    // workspace to be the one found; one above the workspace is never read: it is past the root.
    writeFileSync(join(b.root, "AGENTS.md"), "# above the workspace: never read\n");
    const w = walkRules(join(repo, "pkg", "deep"), b.env);
    assert.equal(w.gitRoot, repo);
    assert.equal(w.root, ws);
    assert.equal(w.rootKind, "workspace");
    assert.deepEqual(w.files.map((f) => f.path), [join(ws, "AGENTS.md"), join(repo, "CLAUDE.md"), join(repo, "CLAUDE.local.md"), join(repo, "pkg", "AGENTS.md")], "root first, CLAUDE.md then CLAUDE.local.md, AGENTS.md only where there is no CLAUDE.md");
    assert.deepEqual(w.skipped, [{ path: join(repo, "pkg", "deep", "CLAUDE.md"), why: "empty" }]);
    assert.equal(w.files[0].bytes, 12);
    const text = renderRules(w);
    assert.match(text, /^## Repo rules re-inlined\n/);
    assert.match(text, /root first, nearest last/);
    assert.ok(text.indexOf("# workspace") < text.indexOf("# repo claude") && text.indexOf("# repo claude") < text.indexOf("# repo local") && text.indexOf("# repo local") < text.indexOf("# pkg agents"));
    assert.doesNotMatch(text, /shadowed|never read/);
    assert.match(text, /- skipped `.*deep\/CLAUDE\.md`: empty\n/);

    // The workspace search stops at HOME: a rules file in HOME is not a workspace, and the root
    // is the git root.
    const underHome = join(b.env.HOME, "code", "p");
    mkdirSync(underHome, { recursive: true });
    spawnSync("git", ["init", "-q", underHome]);
    writeFileSync(join(b.env.HOME, "CLAUDE.md"), "# home\n");
    writeFileSync(join(underHome, "AGENTS.md"), "# p\n");
    const h = walkRules(underHome, b.env);
    assert.deepEqual([h.root, h.rootKind, h.files.map((f) => f.path)], [underHome, "git", [join(underHome, "AGENTS.md")]]);

    // No git root: the cwd alone, nothing above it.
    const lone = join(b.root, "lone", "sub");
    mkdirSync(lone, { recursive: true });
    writeFileSync(join(b.root, "lone", "AGENTS.md"), "# lone parent\n");
    writeFileSync(join(lone, "AGENTS.md"), "# lone sub\n");
    const l = walkRules(lone, b.env);
    assert.deepEqual([l.root, l.rootKind, l.gitRoot, l.files.map((f) => f.content)], [lone, "cwd", null, ["# lone sub\n"]]);
    assert.match(renderRules(l), /the cwd itself, with no git root above it/);

    // A level that is CLAUDE_PROJECT_DIR or above it is the host's: skipped and named.
    const launched = walkRules(join(repo, "pkg", "deep"), { ...b.env, CLAUDE_PROJECT_DIR: repo });
    assert.deepEqual(launched.files.map((f) => f.path), [join(repo, "pkg", "AGENTS.md")]);
    assert.equal(launched.skipped.filter((s) => /loaded by the host at launch/.test(s.why)).length, 3);

    // Nothing on the walk, a missing cwd, no cwd: each a section that says so.
    const bare = join(b.root, "bare");
    mkdirSync(bare);
    assert.match(renderRules(walkRules(bare, b.env)), /\(no CLAUDE\.md, CLAUDE\.local\.md or AGENTS\.md on that walk\)/);
    assert.match(renderRules(walkRules(join(b.root, "nope"), b.env)), /is not a directory that exists, so nothing was walked/);
    assert.match(renderRules(walkRules(undefined, b.env)), /no working directory/);
    assert.equal(findGitRoot(join(repo, "pkg", "deep")), repo);
    assert.equal(findGitRoot(lone), null);
  } finally {
    b.release();
  }
});

test("repo rules: a symlinked rules file is read only when its target is inside the walk root, and one file reached twice is inlined once", () => {
  const b = box();
  try {
    const outside = join(b.root, "outside.md");
    writeFileSync(outside, "# outside the tree\n");
    mkdirSync(join(b.work, "a", "b"), { recursive: true });
    writeFileSync(join(b.work, "CLAUDE.md"), "# root rules\n");
    symlinkSync(outside, join(b.work, "a", "AGENTS.md"));
    symlinkSync(join(b.work, "CLAUDE.md"), join(b.work, "a", "b", "CLAUDE.md"));
    const w = walkRules(join(b.work, "a", "b"), b.env);
    assert.deepEqual(w.files.map((f) => f.path), [join(b.work, "CLAUDE.md")]);
    assert.deepEqual(w.skipped.map((s) => s.path), [join(b.work, "a", "AGENTS.md"), join(b.work, "a", "b", "CLAUDE.md")]);
    assert.match(w.skipped[0].why, /a symlink to `.*outside\.md`, outside the walk root/);
    assert.match(w.skipped[1].why, /the same file as `.*CLAUDE\.md`, already inlined/);
    const text = renderRules(w);
    assert.doesNotMatch(text, /outside the tree/);
    assert.equal((text.match(/# root rules/g) || []).length, 1);
    // A symlink inside the root is followed; a cwd reached through a symlink walks the real tree.
    const link = join(b.root, "link-to-work");
    symlinkSync(b.work, link);
    assert.equal(walkRules(join(link, "a", "b"), b.env).root, b.work);
    // A dangling symlink is named as unreadable, never thrown.
    symlinkSync(join(b.root, "gone.md"), join(b.work, "a", "CLAUDE.md"));
    assert.doesNotThrow(() => walkRules(join(b.work, "a"), b.env));
  } finally {
    b.release();
  }
});

test("repo rules: caps in bytes, the largest files cut first with the marker, a share under the floor skipped and named, the budget the caller passes honoured", () => {
  assert.equal(RULES_FILE_MAX_BYTES, 8000);
  assert.equal(RULES_TOTAL_MAX_BYTES, 9000);
  assert.equal(RULES_MIN_BYTES, 200);
  const file = (path, bytes) => ({ path, bytes, content: "x".repeat(bytes) });
  // Small files whole, the two largest cut to the same allowance that fills the total.
  let r = fitRules([file("/r/a", 500), file("/r/b", 6000), file("/r/c", 7000)], RULES_TOTAL_MAX_BYTES);
  assert.deepEqual(r.shown.map((f) => [f.path, f.shownBytes]), [["/r/a", 500], ["/r/b", 4250], ["/r/c", 4250]]);
  assert.deepEqual(r.skipped, []);
  // The per-file cap applies before the total: one 20,000-byte file shows 8,000.
  r = fitRules([file("/r/big", 20000)], RULES_TOTAL_MAX_BYTES);
  assert.deepEqual(r.shown.map((f) => f.shownBytes), [8000]);
  // The caller's budget wins over the total cap, and a share under the floor is a skip with a reason.
  r = fitRules([file("/r/a", 300), file("/r/b", 300)], 350);
  assert.deepEqual(r.shown, []);
  assert.equal(r.skipped.length, 2);
  assert.match(r.skipped[0].why, /^no room: the rules on this walk total 600 bytes against 350 bytes left for rules text, and this file's share would be under 200$/);
  r = fitRules([file("/r/a", 300)], 0, RULES_FILE_MAX_BYTES, " (why)");
  assert.equal(r.skipped[0].why, "no room: 0 bytes left for rules text (why)");
  // A budget above the total cap is the total cap.
  r = fitRules([file("/r/a", 9500)], 50000);
  assert.deepEqual(r.shown.map((f) => f.shownBytes), [8000]);

  // Bytes, not characters: a cut lands on a character boundary and the marker names bytes.
  const euro = "€".repeat(100); // 300 bytes
  assert.equal(Buffer.byteLength(truncateBytes(euro, 7)), 6);
  assert.equal(truncateBytes(euro, 7), "€€");
  const walk = { start: "/r/sub", root: "/r", rootKind: "git", gitRoot: "/r", files: [{ path: "/r/AGENTS.md", bytes: 300, content: euro }, { path: "/r/sub/AGENTS.md", bytes: 10, content: "0123456789" }], skipped: [], note: null };
  const head = renderRules({ ...walk, files: [] }).replace(/\n\n\(no CLAUDE[^\n]*\n$/, "\n");
  // With room, both files whole. One byte less and the larger is cut on a character boundary, the
  // marker naming the bytes actually shown.
  let text = renderRules(walk, 1000);
  assert.equal(text, `${head}\n### \`/r/AGENTS.md\` (300 bytes)\n\n${euro}\n\n### \`/r/sub/AGENTS.md\` (10 bytes)\n\n0123456789\n`);
  const whole = Buffer.byteLength(text);
  text = renderRules(walk, whole - 1);
  assert.ok(Buffer.byteLength(text) <= whole - 1, `${Buffer.byteLength(text)} > ${whole - 1}`);
  const cut = text.match(/### `\/r\/AGENTS\.md` \(300 bytes\)\n\n(€+)\n\n\(truncated at (\d+) bytes; the file is 300 bytes, read it for the rest\)\n/);
  assert.ok(cut, text);
  assert.equal(Buffer.byteLength(cut[1]), Number(cut[2]), "the marker names the bytes shown");
  assert.match(text, /### `\/r\/sub\/AGENTS\.md` \(10 bytes\)\n\n0123456789\n/);

  // The whole rendered section, headings, paths, markers and skip lines included, is at most the
  // budget at every budget, and at most the 9,000-byte section cap whatever the caller passes.
  const long = `/r/${"deep-directory-name/".repeat(12)}`;
  const wide = {
    ...walk,
    start: `${long}x`,
    files: Array.from({ length: 30 }, (_, i) => ({ path: `${long}${i}/AGENTS.md`, bytes: 2000 + i * 100, content: `€${"r".repeat(1997 + i * 100)}` })),
    skipped: Array.from({ length: 40 }, (_, i) => ({ path: `${long}s${i}/CLAUDE.md`, why: "empty" })),
  };
  for (const w of [walk, wide]) {
    for (let budget = 0; budget <= RULES_TOTAL_MAX_BYTES + 500; budget += 37) {
      const out = renderRules(w, budget);
      assert.ok(Buffer.byteLength(out) <= budget, `budget ${budget}: ${Buffer.byteLength(out)} bytes`);
      assert.ok(!out.includes("\uFFFD"), "no broken character");
    }
    assert.ok(Buffer.byteLength(renderRules(w, 50000)) <= RULES_TOTAL_MAX_BYTES);
  }
  // The wide walk's skip lines alone overrun the full cap: as many as fit are listed, the rest counted.
  text = renderRules(wide);
  assert.ok(Buffer.byteLength(text) > RULES_TOTAL_MAX_BYTES - 400, `the cap is used: ${Buffer.byteLength(text)}`);
  assert.match(text, /^- \d+ more rules files? not inlined and not listed: no room in the section\n$/m);
  // A budget too small for the heading and the count line renders nothing; the caller names it.
  assert.equal(renderRules(wide, 30), "");
  // Everything skipped is still a section naming every file.
  const none = renderRules({ ...walk, skipped: [{ path: "/r/CLAUDE.local.md", why: "empty" }] }, 400);
  assert.ok(Buffer.byteLength(none) <= 400);
  assert.match(none, /- skipped `\/r\/CLAUDE\.local\.md`: empty\n- skipped `\/r\/AGENTS\.md`: no room: /);
  assert.doesNotMatch(none, /€/);
});

test("durable notes: the newest N files by mtime, dot-files and directories left out, the count capped, a missing or empty directory said in one line", () => {
  const b = box();
  try {
    const dir = join(b.work, ".ai", "decision-log");
    assert.match(renderNotes(".ai/decision-log", b.work, 5), new RegExp(`^## Durable notes \\(\`${dir}\`\\)\n\n\\(no notes directory at \`${dir}\`\\)\n`));
    mkdirSync(dir, { recursive: true });
    assert.match(renderNotes(".ai/decision-log", b.work, 5), /\(the notes directory is empty\)/);
    const t0 = Date.now() / 1000 - 1000;
    for (const [i, name] of ["c.md", "a.md", "b.md", "d.md", "e.md", "f.md", ".hidden.md"].entries()) {
      writeFileSync(join(dir, name), name);
      utimesSync(join(dir, name), t0 + i * 10, t0 + i * 10);
    }
    mkdirSync(join(dir, "sub"));
    utimesSync(join(dir, "sub"), t0 + 1000, t0 + 1000);
    const text = renderNotes(".ai/decision-log", b.work, 5);
    assert.match(text, /The newest 5 of 6 entries by modification time:\n\n- f\.md\n- e\.md\n- d\.md\n- b\.md\n- a\.md\n\n> The notes directory and the rules files are the source of truth; the restored snapshot is only the safety net\./);
    assert.doesNotMatch(text, /c\.md|hidden|sub/);
    assert.match(renderNotes(".ai/decision-log", b.work, 2), /The newest 2 of 6 entries by modification time:\n\n- f\.md\n- e\.md\n\n/);
    assert.match(renderNotes(dir, "/elsewhere", 1000), /The newest 6 of 6 entries/, "an absolute dir ignores the base; the count is capped");
    assert.equal(NOTES_MAX_COUNT, 100);
    writeFileSync(join(b.work, "file"), "x");
    assert.match(renderNotes("file", b.work, 5), /\(no notes directory at /, "a file where a directory should be");
    // The whole rendered section is at most the budget: the list gives way first, then the section.
    const full = Buffer.byteLength(text);
    for (let budget = 0; budget <= full; budget++) {
      const out = renderNotes(".ai/decision-log", b.work, 5, budget);
      assert.ok(Buffer.byteLength(out) <= budget, `budget ${budget}: ${Buffer.byteLength(out)}`);
    }
    assert.equal(renderNotes(".ai/decision-log", b.work, 5, full), text);
    assert.match(renderNotes(".ai/decision-log", b.work, 5, full - 1), /The newest 4 of 6 entries by modification time:\n\n- f\.md\n- e\.md\n- d\.md\n- b\.md\n\n> /);
    assert.equal(renderNotes(".ai/decision-log", b.work, 5, 20), "");
    // An equal modification time (Linux file times are coarse, so a burst of writes shares one) is
    // broken by name descending, whatever order the files were created in or readdir returns them.
    const tie = join(b.work, "tie");
    mkdirSync(tie);
    for (const name of ["2026-01-02--two.md", "2026-01-01--one.md", "2026-01-03--three.md"]) {
      writeFileSync(join(tie, name), name);
      utimesSync(join(tie, name), t0, t0);
    }
    assert.match(renderNotes("tie", b.work, 5), /The newest 3 of 3 entries by modification time:\n\n- 2026-01-03--three\.md\n- 2026-01-02--two\.md\n- 2026-01-01--one\.md\n\n> /);
    // notesRoot: the git root above the real cwd, so a cwd reached through a symlink into a nested
    // directory finds the repository's root, not the symlink's lexical parents.
    mkdirSync(join(b.work, "pkg", "deep"), { recursive: true });
    const link = join(b.root, "link-to-deep");
    symlinkSync(join(b.work, "pkg", "deep"), link);
    assert.equal(notesRoot(link), b.work);
    assert.equal(notesRoot(join(b.root, "no-such-dir")), join(b.root, "no-such-dir"));
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
    for (let i = 0; i < 2 * HEARTBEAT_MAX_LINES + 10; i++) recordHeartbeat({ event: "PreCompact", outcome: `n${i}` }, b.env);
    const all = readHeartbeat(b.env);
    // 2 + 2 × max + 10 writes: trimmed to max once it passed 2 × max, then 11 more appended.
    assert.equal(all.length, HEARTBEAT_MAX_LINES + 11);
    assert.equal(all[all.length - 1].outcome, `n${2 * HEARTBEAT_MAX_LINES + 9}`);
    writeFileSync(heartbeatPath(b.env), '{"event":"PreCompact","outcome":"ok","at":"x"}\nnot json\n');
    assert.equal(readHeartbeat(b.env).length, 1);
    // The trim is a rename-swap: no temp file is left beside the log.
    assert.deepEqual(readdirSync(stateDir(b.env)).filter((f) => f.endsWith(".tmp")), []);
    // A state dir that cannot exist (its parent is a regular file): the write fails quietly.
    writeFileSync(join(b.root, "notadir"), "");
    assert.equal(recordHeartbeat({ outcome: "ok" }, { ...b.env, XDG_STATE_HOME: join(b.root, "notadir") }), false);
  } finally {
    b.release();
  }
});

test("errors log: the hooks' own lines keep the runner's format and trim to the cap by rename-swap", () => {
  const b = box();
  try {
    for (let i = 0; i < 2 * ERRORS_MAX_LINES + 15; i++) logError("continuity", "Stop", `fault  ${i}`, b.env);
    const lines = readFileSync(join(stateDir(b.env), "errors.log"), "utf8").trim().split("\n");
    assert.equal(lines.length, ERRORS_MAX_LINES + 14, "trimmed to the cap once past twice the cap, then appended to");
    assert.match(lines.at(-1), new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+ Stop fault ${2 * ERRORS_MAX_LINES + 14}$`));
    assert.deepEqual(readdirSync(stateDir(b.env)).filter((f) => f.endsWith(".tmp")), []);
  } finally {
    b.release();
  }
});

test("bounded log: a plain append below twice the cap, a rename-swap trim past it, and concurrent appends below the cap all land", async () => {
  const b = box();
  try {
    const log = join(b.root, "logs", "x.log");
    appendBounded(log, "first", 3);
    const ino = statSync(log).ino;
    for (let i = 0; i < 5; i++) appendBounded(log, `l${i}`, 3);
    assert.equal(statSync(log).ino, ino, "six lines of a cap of 3: appended in place, never swapped");
    assert.equal(readFileSync(log, "utf8"), "first\nl0\nl1\nl2\nl3\nl4\n");
    appendBounded(log, "l5", 3);
    assert.equal(readFileSync(log, "utf8"), "l3\nl4\nl5\n", "the seventh line passes 2 × 3: trimmed to the newest 3");
    assert.deepEqual(readdirSync(join(b.root, "logs")).filter((f) => f.endsWith(".tmp")), []);

    // 8 processes × 40 lines at a cap of 10,000: nothing is trimmed, so nothing may be lost.
    const shared = join(b.root, "logs", "shared.log");
    const mod = pathToFileURL(join(PLUGIN_ROOT, "lib", "bounded-log.mjs")).href;
    const script = `const { appendBounded } = await import(${JSON.stringify(mod)}); for (let i = 0; i < 40; i++) appendBounded(process.argv[1], process.pid + " " + i, 10000);`;
    await Promise.all(
      Array.from({ length: 8 }, () => new Promise((resolve, reject) => spawn(process.execPath, ["--input-type=module", "-e", script, shared], { stdio: "ignore" }).on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer exit ${code}`)))))),
    );
    assert.equal(readFileSync(shared, "utf8").split("\n").filter(Boolean).length, 320);
  } finally {
    b.release();
  }
});

test("liveness: the four cases, invocations not records, the newest result per session, and age() is coarse", () => {
  assert.equal(age(10_000), "less than a minute ago");
  assert.equal(age(60_000), "1 minute ago");
  assert.equal(age(25 * 60_000), "25 minutes ago");
  assert.equal(age(3 * 3_600_000), "3 hours ago");
  assert.equal(age(72 * 3_600_000), "3 days ago");
  const env = { XDG_STATE_HOME: "/s", HOME: "/h" };
  assert.match(renderLiveness({ env, records: [] }), /\*\*no pre-compaction save has ever been recorded on this machine\.\*\*/);
  assert.match(renderLiveness({ env, records: [] }), /\/s\/continuity\/heartbeat\.ndjson/);
  const now = Date.parse("2026-11-04T12:00:00Z");
  const save = (at, outcome, session = "a") => [{ at, event: "PreCompact", session, outcome: "started" }, { at, event: "PreCompact", session, outcome }];
  const ok = renderLiveness({ env, now, records: [...save("2026-11-04T11:00:00Z", "failed:EACCES"), ...save("2026-11-04T11:30:00Z", "ok")] });
  assert.equal(ok, "continuity, pre-compaction save liveness: last successful save 30 minutes ago (2026-11-04T11:30:00Z); the snapshot path is alive.");
  // A failure after a success is the newest result, and it is what the line leads with.
  const broke = renderLiveness({ env, now, records: [...save("2026-11-04T11:30:00Z", "ok"), ...save("2026-11-04T11:50:00Z", "failed:EACCES")] });
  assert.match(broke, /^continuity, pre-compaction save liveness: \*\*the last save failed\*\* 10 minutes ago \(`failed:EACCES`, 2026-11-04T11:50:00Z\); the last success was 30 minutes ago \(2026-11-04T11:30:00Z\)\./);
  assert.doesNotMatch(broke, /alive/);
  // A save that recorded `started` and nothing after it did not finish; a skip is not a result.
  const unfinished = renderLiveness({ env, now, records: [...save("2026-11-04T11:30:00Z", "ok"), { at: "2026-11-04T11:55:00Z", event: "PreCompact", session: "b", outcome: "started" }, { at: "2026-11-04T11:58:00Z", event: "PreCompact", session: "c", outcome: "skipped:off" }] });
  assert.match(unfinished, /\*\*the last save failed\*\* 5 minutes ago \(`started` with no result recorded: the save did not finish/);
  // A `started` younger than the runner's 4 s deadline may be another session's save still running: not a failure.
  const running = renderLiveness({ env, now, records: [...save("2026-11-04T11:30:00Z", "ok"), { at: "2026-11-04T11:59:58Z", event: "PreCompact", session: "b", outcome: "started" }] });
  assert.match(running, /^continuity, pre-compaction save liveness: last successful save 30 minutes ago/);
  const stale = renderLiveness({ env, now, records: [...save("2026-11-04T11:30:00Z", "ok"), { at: "2026-11-04T11:59:55Z", event: "PreCompact", session: "b", outcome: "started" }] });
  assert.match(stale, /\*\*the last save failed\*\* less than a minute ago \(`started` with no result recorded/, "5 s old is past the deadline");
  const failed = renderLiveness({ env, now, records: [...save("2026-11-04T11:40:00Z", "failed:EACCES"), ...save("2026-11-04T11:50:00Z", "failed:EACCES")] });
  assert.match(failed, /\*\*no pre-compaction save has ever succeeded on this machine\.\*\*/);
  assert.match(failed, /invoked 2 times and the most recent outcome was `failed:EACCES`/, "four records, two invocations");
  assert.match(renderLiveness({ env, now, records: [{ at: "x", event: "SessionStart", outcome: "ok" }] }), /ever succeeded.*invoked 0 times and/s);
  const records = [...save("2026-11-04T11:00:00Z", "ok", "a"), ...save("2026-11-04T11:10:00Z", "failed:ENOSPC", "a"), ...save("2026-11-04T11:20:00Z", "ok", "b")];
  assert.equal(lastSaveFor("a", { records }).outcome, "failed:ENOSPC");
  assert.equal(lastSaveFor("z", { records }), null);
});

test("calibration: measures bytes after the last compaction marker or the whole file; records only a real token_count; median ratio", () => {
  const b = box();
  try {
    assert.equal(measureTranscript("/nowhere"), null);
    b.writeTranscript(["x".repeat(99)]);
    assert.deepEqual(measureTranscript(b.transcript), { bytes: 100, sinceMarker: false, usageTokens: null });
    b.writeTranscript(["a".repeat(500), { type: "system", subtype: "compact_boundary" }, "y".repeat(49)]);
    assert.deepEqual(measureTranscript(b.transcript), { bytes: 50, sinceMarker: true, usageTokens: null }, "only what follows the marker line counts");

    assert.equal(readCalibration(b.env), null);
    assert.equal(recordCalibration({ token_count: 100, transcript_path: "/nowhere" }, b.env), false);
    assert.equal(recordCalibration({ token_count: 0, transcript_path: b.transcript }, b.env), false);
    assert.equal(recordCalibration({ token_count: "1000", transcript_path: b.transcript }, b.env), false, "a string is not a token count");
    // Claude Code's own PreCompact payload: no token_count, so nothing is recorded.
    assert.equal(recordCalibration({ trigger: "auto", custom_instructions: "", transcript_path: b.transcript }, b.env), false);
    assert.equal(existsSync(calibrationPath(b.env)), false);
    b.writeTranscript(["x".repeat(99)]);
    assert.equal(recordCalibration({ token_count: 1000, transcript_path: b.transcript }, b.env), true);
    assert.deepEqual(readCalibration(b.env), { ratio: 10 });
    assert.equal(recordCalibration({ token_count: 3000, transcript_path: b.transcript }, b.env), true);
    assert.equal(recordCalibration({ token_count: 2000, transcript_path: b.transcript }, b.env), true);
    assert.deepEqual(readCalibration(b.env), { ratio: 20 });
    writeFileSync(calibrationPath(b.env), "garbage\n{\"bytes\":0,\"tokens\":5}\n");
    assert.equal(readCalibration(b.env), null);
    for (let i = 0; i < 2 * CALIBRATION_MAX_LINES + 5; i++) recordCalibration({ token_count: 100, transcript_path: b.transcript }, b.env);
    assert.equal(readFileSync(calibrationPath(b.env), "utf8").split("\n").filter(Boolean).length, CALIBRATION_MAX_LINES + 6, "2 old + 2 × max + 5 writes: trimmed to max past 2 × max, then 6 more");
  } finally {
    b.release();
  }
});

test("pressure: the last main-thread reply's recorded usage is the context size; sidechain and zero-usage replies are passed over; a compaction marker resets it", () => {
  const b = box();
  try {
    const reply = (usage, extra = {}) => ({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage }, ...extra });
    const input = { transcript_path: b.transcript };
    // Claude Code's shape: 2 + 150,000 cache read + 9,998 cache creation = 160,000 = 80% of 200,000.
    const full = { input_tokens: 2, cache_creation_input_tokens: 9_998, cache_read_input_tokens: 150_000, output_tokens: 5 };
    b.writeTranscript([reply({ input_tokens: 10 }), { type: "user", message: { role: "user", content: "go" } }, reply(full), { type: "user", message: { role: "user", content: "next" } }]);
    assert.equal(measureTranscript(b.transcript).usageTokens, 160000);
    const bytes = measureTranscript(b.transcript).bytes;
    assert.deepEqual(estimateContext(b.transcript, b.env), { tokens: 160000, bytes, basis: "usage", sinceMarker: false });
    assert.deepEqual(pressure(input, { threshold: 0.65, contextTokens: 200000, env: b.env }), { pct: 80, estimated: 160000, target: 200000, basis: "usage" });
    assert.equal(pressure(input, { threshold: 0.9, contextTokens: 200000, env: b.env }), null);
    assert.equal(pressure(input, { threshold: 0.65, contextTokens: 400000, env: b.env }), null, "a larger window is honoured");
    // No cache fields: input_tokens alone.
    b.writeTranscript([reply({ input_tokens: 140_000, output_tokens: 3 })]);
    assert.equal(measureTranscript(b.transcript).usageTokens, 140000);
    // A newer sidechain (subagent) reply and a newer synthetic zero-usage reply do not replace the main thread's.
    b.writeTranscript([reply(full), reply({ input_tokens: 5, cache_read_input_tokens: 1 }, { isSidechain: true }), reply({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
    assert.equal(measureTranscript(b.transcript).usageTokens, 160000);
    // A usage record before the compaction marker does not count after it.
    b.writeTranscript([reply(full), { type: "system", subtype: "compact_boundary" }, reply({ input_tokens: 3, cache_read_input_tokens: 20_000 })]);
    assert.deepEqual(measureTranscript(b.transcript), { bytes: measureTranscript(b.transcript).bytes, sinceMarker: true, usageTokens: 20003 });
    assert.equal(pressure(input, { threshold: 0.65, contextTokens: 200000, env: b.env }), null);
    // Usage beats a calibration record.
    b.writeTranscript([reply(full)]);
    mkdirSync(stateDir(b.env), { recursive: true });
    writeFileSync(calibrationPath(b.env), '{"bytes":1,"tokens":1}\n');
    assert.equal(pressure(input, { threshold: 0.65, contextTokens: 200000, env: b.env }).basis, "usage");
    assert.match(handoffRequest(80, "usage"), /^continuity: this session's context is 80% full \(from the token usage the last reply recorded\)\. .*`\/continuity:handoff`/);
  } finally {
    b.release();
  }
});

test("pressure: with no recorded usage, the transcript's bytes / 8 is the estimate and the warning says (estimate); a calibration record replaces the constant", () => {
  const b = box();
  try {
    assert.equal(BYTES_PER_TOKEN_ESTIMATE, 8);
    // 1,280,000 bytes / 8 = 160,000 tokens = 80% of the 200,000 default.
    b.writeTranscript(["x".repeat(1_279_999)]);
    const input = { transcript_path: b.transcript };
    assert.deepEqual(estimateContext(b.transcript, b.env), { tokens: 160000, bytes: 1280000, basis: "estimate", sinceMarker: false });
    assert.deepEqual(pressure(input, { threshold: 0.65, contextTokens: 200000, env: b.env }), { pct: 80, estimated: 160000, target: 200000, basis: "estimate" });
    assert.equal(pressure({ transcript_path: "/nowhere" }, { threshold: 0.1, contextTokens: 200000, env: b.env }), null);
    assert.equal(pressure({}, { threshold: 0.1, contextTokens: 200000, env: b.env }), null);
    // A usage record only before the marker: the fallback applies to the bytes after it.
    b.writeTranscript([{ type: "assistant", message: { usage: { input_tokens: 190_000 } } }, { type: "system", subtype: "compact_boundary" }, "y".repeat(3)]);
    assert.equal(pressure(input, { threshold: 0.65, contextTokens: 200000, env: b.env }), null);
    // A real token count ever recorded (an adapter that passes one) replaces the constant.
    b.writeTranscript(["x".repeat(3999)]);
    mkdirSync(stateDir(b.env), { recursive: true });
    writeFileSync(calibrationPath(b.env), '{"bytes":4000,"tokens":160000}\n');
    assert.deepEqual(pressure(input, { threshold: 0.65, contextTokens: 200000, env: b.env }), { pct: 80, estimated: 160000, target: 200000, basis: "calibrated" });
    assert.match(handoffRequest(80), /context is roughly 80% full \(estimate\), judged from the transcript's size.*`\/continuity:handoff`/);
    assert.match(handoffRequest(80, "calibrated"), /roughly 80% full \(calibrated from this machine's compactions\)/);
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

test("handoffs: root resolution order, frontmatter, the open-and-fresh filter, the render caps", async () => {
  const b = box();
  try {
    const rootOf = async (cwd, env) => (await resolveHandoffRoot(cwd, env)).root;
    assert.equal(await rootOf(b.work, { CLAUDE_PROJECT_DIR: b.root }), b.root);
    assert.equal(await rootOf(b.work, { CLAUDE_PROJECT_DIR: "/nowhere/x" }), b.work);
    const sub = join(b.work, "deep", "er");
    mkdirSync(sub, { recursive: true });
    assert.equal(await rootOf(sub, {}), b.work);
    const bare = join(b.root, "bare");
    mkdirSync(bare);
    assert.deepEqual(await resolveHandoffRoot(bare, {}), { root: bare, note: null }, "not a repository is an answer, not a timeout");
    // A linked worktree resolves to the main worktree, so every worktree shares one pool.
    writeFileSync(join(b.work, "f"), "1");
    b.git("add", "f");
    b.git("commit", "-q", "-m", "one");
    const wt = join(b.root, "wt");
    b.git("worktree", "add", "-q", wt, "-b", "side");
    assert.equal(await rootOf(wt, {}), b.work);

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
    assert.equal(list[0].session, "s-test");
    assert.equal(handoffWrittenBy(b.work, "s-test"), true);
    assert.equal(handoffWrittenBy(b.work, "someone-else"), false);
    assert.equal(handoffWrittenBy(b.work, undefined), false);

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

test("snapshot: transcript reading, the capture's sources and caps, the render, and capture() on an unwritable state", async () => {
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
    const s = await buildSnapshot({ session_id: "s-test", cwd: b.work, transcript_path: b.transcript, trigger: "auto" }, { env: b.env, now });
    assert.equal(s.version, 2);
    assert.equal(s.at, "2026-11-04T12:00:00.000Z");
    assert.equal(s.branch, "feature/x");
    assert.equal(s.branchUnknown, null);
    assert.equal(s.status.unknown, null);
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
    const h = await buildSnapshot({ cwd: b.work, intents: ["from host", 3, " "], file_operations: " read x\nwrote y ", agent_judgment: ["I think\n so"] }, { env: b.env, now });
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
    const d = await buildSnapshot({ cwd: b.work, trigger: "manual" }, { env: b.env, now });
    assert.match(d.captureSource, /^repository only/);
    assert.equal(d.reconstruction.missing.length, 4);
    assert.deepEqual(d.reconstruction.recentCommits.lines.map((l) => l.replace(/^\w+ /, "")), ["a commit"]);
    assert.deepEqual(d.reconstruction.unpushed, { lines: [], total: 0, unknown: null });
    const dmd = renderSnapshot(d);
    assert.match(dmd, /## Capture was degraded: this is a reconstruction, not a record/);
    assert.match(dmd, /### Committed but not pushed\n\n\(none, or no upstream to compare against\)/);

    // With a handoff: inlined under its heading, and the warning is replaced.
    mkdirSync(join(b.work, ".ai", "handoffs"), { recursive: true });
    writeFileSync(join(b.work, ".ai", "handoffs", "h.md"), handoffText());
    const w = await buildSnapshot({ cwd: b.work }, { env: b.env, now });
    assert.equal(w.handoff.present, true);
    assert.equal(w.handoff.root, b.work);
    const wmd = renderSnapshot(w);
    assert.match(wmd, /## Agent-authored handoff \(from `.*\/\.ai\/handoffs\/`\)\n[\s\S]*Tmpdir flags\./);
    assert.doesNotMatch(wmd, /No agent-authored handoff was written/);

    // A cwd that is not a repository: no branch and no status, each said to be unknown, never
    // "(clean)"; the file is still written.
    const nowhere = join(b.root, "plain");
    mkdirSync(nowhere);
    const p = await capture({ session_id: "p", cwd: nowhere }, { env: b.env, now });
    assert.equal(p.outcome, "ok");
    assert.equal(p.snapshot.branch, null);
    assert.match(p.snapshot.branchUnknown, /^git branch failed \(exit \d+\)$/);
    assert.match(p.snapshot.status.unknown, /^git status failed \(exit \d+\)$/);
    const pmd = renderSnapshot(p.snapshot);
    assert.match(pmd, /## Branch\n\(unknown: git branch failed \(exit \d+\)\)\n/);
    assert.match(pmd, /## Uncommitted changes\n\(unknown: git status failed \(exit \d+\); run `git status --short` before assuming the tree is clean\)\n/);
    assert.doesNotMatch(pmd, /\(clean\)/);
    assert.ok(existsSync(snapshotPath("p", b.env)));

    // A git budget already spent: every git field is `(unknown: timed out)` and the snapshot is still built.
    const t = await buildSnapshot({ session_id: "t", cwd: b.work, transcript_path: b.transcript }, { env: b.env, now, gitBudgetMs: 0 });
    assert.equal(t.branchUnknown, "timed out");
    assert.equal(t.status.unknown, "timed out");
    assert.match(renderSnapshot(t), /## Branch\n\(unknown: timed out\)\n\n## Uncommitted changes\n\(unknown: timed out;/);
    assert.deepEqual(await git(["status"], b.work, 0), { ok: false, reason: "timed out" });

    chmodSync(stateDir(b.env), 0o555);
    if (process.getuid?.() !== 0) {
      const f = await capture({ session_id: "q", cwd: b.work }, { env: b.env });
      assert.match(f.outcome, /^failed:EACCES/);
      assert.ok(f.snapshot, "the snapshot was still built");
    }
    chmodSync(stateDir(b.env), 0o755);
  } finally {
    b.release();
  }
});

test("snapshot: restore() injects and unlinks its own fresh snapshot, keeps an over-budget one, ignores a stale, foreign or broken one", async () => {
  const b = box();
  try {
    b.writeTranscript([{ message: { role: "user", content: "the ask" } }]);
    assert.equal(restore({ session_id: "s-test" }, { env: b.env }), null);
    await capture({ session_id: "s-test", cwd: b.work, transcript_path: b.transcript, trigger: "auto" }, { env: b.env });
    assert.equal(restore({ session_id: "other" }, { env: b.env }), null, "another session's id sees nothing");
    const text = restore({ session_id: "s-test" }, { env: b.env });
    assert.match(text, /^## Restored session state \(post-compaction\)\n/);
    assert.match(text, /restate what the thread is and what is pending on it/);
    assert.match(text, /\*\*No handoff was written before compaction\.\*\*/);
    assert.match(text, /- the ask\n/);
    assert.equal(existsSync(snapshotPath("s-test", b.env)), false, "consumed");
    assert.equal(restore({ session_id: "s-test" }, { env: b.env }), null, "one-shot");

    await capture({ session_id: "s-test", cwd: b.work, transcript_path: b.transcript }, { env: b.env });
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
    await capture({ session_id: "s-test", cwd: b.work, transcript_path: b.transcript, file_operations: "w".repeat(7000), agent_judgment: ["j".repeat(7000)] }, { env: b.env });
    const big = restore({ session_id: "s-test" }, { env: b.env });
    assert.match(big, /\*\*TRUNCATED: this snapshot is \d+ characters and only the first \d+ are shown\.\*\*/);
    assert.ok(big.length <= RESTORE_MAX_CHARS, `heading, notices and cut snapshot within the cap: ${big.length}`);
    assert.match(big, /This snapshot includes an agent-authored handoff section/);
    assert.ok(existsSync(snapshotPath("s-test", b.env)), "an over-budget restore keeps its file");
  } finally {
    b.release();
  }
});

test("snapshot: restore() keeps its whole text (heading, notices, truncation marker, snapshot) within its cap at and around the boundary, cut on a character boundary", async () => {
  const b = box();
  try {
    b.writeTranscript([{ message: { role: "user", content: "the ask" } }]);
    const path = snapshotPath("s-test", b.env);
    await capture({ session_id: "s-test", cwd: b.work, transcript_path: b.transcript, trigger: "auto" }, { env: b.env });
    const json = JSON.parse(readFileSync(path, "utf8"));
    // A snapshot whose rendered body is exactly n characters: the host-supplied section padded.
    const withBody = (n) => {
      json.hostFileOperations = "w";
      json.hostFileOperations = "w".repeat(n - (renderSnapshot(json).length - 1));
      writeFileSync(path, JSON.stringify(json));
      assert.equal(renderSnapshot(json).length, n);
      return renderSnapshot(json);
    };
    const TRUNC = /\*\*TRUNCATED: this snapshot is (\d+) characters and only the first (\d+) are shown\.\*\*/;

    // A body at, just under and just over the cap, and far over it: the frame no longer rides on
    // top. Each is cut, says so with the true count shown, uses the cap, and keeps its file.
    for (const n of [RESTORE_MAX_CHARS - 1, RESTORE_MAX_CHARS, RESTORE_MAX_CHARS + 1, 60_000]) {
      const body = withBody(n);
      const t = restore({ session_id: "s-test" }, { env: b.env });
      assert.ok(t.length <= RESTORE_MAX_CHARS && t.length >= RESTORE_MAX_CHARS - 1, `body ${n}: the restore is ${t.length}`);
      const m = t.match(TRUNC);
      assert.ok(m, `body ${n}: the cut is announced`);
      assert.equal(Number(m[1]), n);
      assert.ok(t.endsWith(body.slice(0, Number(m[2]))), `body ${n}: the shown count is the head actually shown`);
      assert.ok(existsSync(path), `body ${n}: the file is kept`);
    }

    // The exact fit: a body that with its frame is the cap lands whole and is consumed; one
    // character more is cut, within the cap, and kept.
    const frame = (withBody(5000), restore({ session_id: "s-test" }, { env: b.env }).length - 5000);
    withBody(RESTORE_MAX_CHARS - frame);
    let t = restore({ session_id: "s-test" }, { env: b.env });
    assert.equal(t.length, RESTORE_MAX_CHARS);
    assert.doesNotMatch(t, TRUNC);
    assert.equal(existsSync(path), false, "a whole restore is consumed");
    withBody(RESTORE_MAX_CHARS - frame + 1);
    t = restore({ session_id: "s-test" }, { env: b.env });
    assert.ok(t.length <= RESTORE_MAX_CHARS, `${t.length}`);
    assert.match(t, TRUNC);
    assert.ok(existsSync(path));

    // The caller's smaller share is honoured, and a cut never splits a surrogate pair.
    json.hostFileOperations = "😀".repeat(9000);
    writeFileSync(path, JSON.stringify(json));
    for (const max of [5000, 5001, 120]) {
      t = restore({ session_id: "s-test" }, { env: b.env, max });
      assert.ok(t.length <= max && t.length >= max - 1, `max ${max}: ${t.length}`);
      assert.equal(Buffer.from(t, "utf8").toString("utf8"), t, `max ${max}: valid UTF-8, no half character`);
    }
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
    assert.deepEqual(dry, { removed: 2, bytes: 8, kept: 4, rotated: [] });
    assert.ok(existsSync(join(dir, "old.json")));
    assert.deepEqual(prune(dir, { days: 30 }), { removed: 2, bytes: 8, kept: 4, rotated: [] });
    assert.equal(existsSync(join(dir, "old.json")), false);
    assert.equal(existsSync(join(dir, "sessions")), false);
    for (const f of ["errors.log", "heartbeat.ndjson", "calibration.ndjson", "fresh.json"]) assert.ok(existsSync(join(dir, f)), f);
    assert.deepEqual(prune(join(b.root, "nowhere")), { removed: 0, bytes: 0, kept: 0, rotated: [] });
  } finally {
    b.release();
  }
});

test("prune: run as a script from a directory with a space in its name, and through a symlink, it still runs", () => {
  const b = box();
  try {
    const spaced = join(b.root, "plugin dir");
    for (const d of ["scripts", "lib"]) cpSync(join(PLUGIN_ROOT, d), join(spaced, d), { recursive: true });
    symlinkSync(spaced, join(b.root, "linked"));
    const dir = stateDir(b.env);
    for (const via of [spaced, join(b.root, "linked")]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "old.json"), "{}");
      const old = (Date.now() - 40 * 24 * 3_600_000) / 1000;
      utimesSync(join(dir, "old.json"), old, old);
      const r = spawnSync(process.execPath, [join(via, "scripts", "prune.mjs"), "--days", "30"], { env: b.env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^pruned: 1 file\(s\), 2 bytes freed; kept 0\n$/, `via ${via}`);
      assert.equal(existsSync(join(dir, "old.json")), false, `via ${via}`);
    }
  } finally {
    b.release();
  }
});
