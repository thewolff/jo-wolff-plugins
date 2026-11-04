// canary-report-digest.test.mjs — 0.3.3 feedback loop: the nightly canary, the graded report,
// the weekly digest and its dead-man's switch. Process spawns are faked where a real one would
// need `claude` or `gh`; the CLI is spawned for the process-level checks with scripts on PATH.

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, cli, hook, openDb, row, count } from "./helpers.mjs";
import { openStore } from "../lib/store.mjs";
import { runCanary, lineDiff, cut, listPlugins, prune, install as canaryInstall, gradeRun, parseCanaryArgs, plistText } from "../lib/canary.mjs";
import { gather, mechanicalGrade, overlayJudge, render, runReport, parseReportArgs, judgePassage } from "../lib/report.mjs";
import { runDigest, sessionStartLines, body, KEYS, install as digestInstall, parseDigestArgs, doctorCheck } from "../lib/digest.mjs";
import { recordBounce } from "../lib/bounces.mjs";
import { nowIso } from "../lib/time.mjs";

const D = 24 * 3_600_000;

/** A fake plugins checkout: plugins/<name>/hooks/hooks.json, with or without e2e/live-run.sh. */
function repo(b, plugins) {
  const root = join(b.root, "repo");
  for (const [name, script] of Object.entries(plugins)) {
    mkdirSync(join(root, "plugins", name, "hooks"), { recursive: true });
    writeFileSync(join(root, "plugins", name, "hooks", "hooks.json"), "{}");
    if (script !== null) {
      mkdirSync(join(root, "plugins", name, "e2e"), { recursive: true });
      writeFileSync(join(root, "plugins", name, "e2e", "live-run.sh"), script);
      chmodSync(join(root, "plugins", name, "e2e", "live-run.sh"), 0o755);
    }
  }
  mkdirSync(join(root, "plugins", "notaplugin"), { recursive: true });
  return root;
}

function withStore(b, fn) {
  const store = openStore({ env: b.env, cwd: b.work });
  const close = () => store.db.close();
  let r;
  try {
    r = fn(store);
  } catch (err) {
    close();
    throw err;
  }
  if (r && typeof r.then === "function") return r.finally(close);
  close();
  return r;
}

test("canary run: pass, fail, exit 75, timeout, no script, not a plugin; rows, the script's transcript kept byte for byte, the output beside it, and the diff against the last pass", async () => {
  const b = sandbox();
  const TRANSCRIPT = '{"type":"assistant","text":"evidence"}\n';
  const root = repo(b, {
    alpha: `#!/bin/bash\nmkdir -p "$(dirname "$CANARY_TRANSCRIPT")" && printf '%s' '${TRANSCRIPT}' > "$CANARY_TRANSCRIPT"\necho line one\necho line two\nexit 0\n`,
    beta: "#!/bin/bash\necho boom >&2\nexit 3\n",
    gamma: "#!/bin/bash\necho 'no claude credentials here'\nexit 75\n",
    delta: "#!/bin/bash\nsleep 5\n",
    epsilon: null,
  });
  assert.deepEqual(listPlugins(root).map((p) => p.name), ["alpha", "beta", "delta", "epsilon", "gamma"]);
  const r = await withStore(b, (s) => runCanary({ db: s.db, dbPath: s.dbPath, env: b.env, repo: root, plugins: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"], timeoutS: 1, claudePresent: true }));
  assert.equal(r.code, 1, r.text);
  const by = Object.fromEntries(r.rows.map((x) => [x.plugin, x]));
  assert.equal(by.alpha.status, "pass");
  assert.equal(by.alpha.exit_code, 0);
  assert.match(by.alpha.summary, /^line one\nline two\n$/);
  assert.ok(by.alpha.transcript_path.startsWith(join(b.env.XDG_STATE_HOME, "ledger", "canary", "alpha")));
  assert.equal(readFileSync(by.alpha.transcript_path, "utf8"), TRANSCRIPT, "the script's stream-json, not the canary's summary");
  assert.equal(by.alpha.output_path, by.alpha.transcript_path.replace(/\.jsonl$/, ".out.txt"));
  assert.equal(readFileSync(by.alpha.output_path, "utf8"), "line one\nline two\n");
  assert.equal(by.alpha.note, null);
  assert.equal(by.alpha.diff, null, "first run has nothing to diff against");
  assert.equal(by.beta.status, "fail");
  assert.equal(by.beta.note, "exit 3; no transcript from the script");
  assert.equal(by.beta.transcript_path, null);
  assert.match(readFileSync(by.beta.output_path, "utf8"), /\[stderr\]\nboom/);
  assert.match(by.beta.summary, /\[stderr\]\nboom/);
  assert.equal(by.gamma.status, "unavailable");
  assert.equal(by.gamma.note, "no claude credentials here");
  assert.equal(by.delta.status, "fail");
  assert.equal(by.delta.note, "timeout after 1s; no transcript from the script");
  assert.ok(by.delta.duration_ms >= 900 && by.delta.duration_ms < 4000, String(by.delta.duration_ms));
  assert.equal(by.epsilon.status, "unavailable");
  assert.equal(by.epsilon.note, "no e2e/live-run.sh");
  assert.equal(by.epsilon.transcript_path, null);
  assert.match(r.text, /^alpha\s+pass\s+\d+\.\ds\s+#\d+\s+transcript \S+\.jsonl; output \S+\.out\.txt$/m);
  assert.match(r.text, /^beta\s+fail\s+\d+\.\ds\s+#\d+\s+exit 3; no transcript from the script; output /m);
  assert.match(r.text, /^zeta\s+unavailable\s+not a plugin under /m);
  const db = openDb(b);
  assert.equal(count(db, "cc_canary_runs"), 5);
  assert.equal(row(db, "SELECT status, note FROM cc_canary_runs WHERE plugin = 'delta'").note, "timeout after 1s; no transcript from the script");
  db.close();

  // Second run of alpha with different output: diff against the last pass.
  writeFileSync(join(root, "plugins", "alpha", "e2e", "live-run.sh"), "#!/bin/bash\nprintf 'again' > \"$CANARY_TRANSCRIPT\"\necho line one\necho line changed\nexit 0\n");
  const r2 = await withStore(b, (s) => runCanary({ db: s.db, dbPath: s.dbPath, env: b.env, repo: root, plugins: ["alpha"], claudePresent: true }));
  assert.equal(r2.code, 0);
  assert.equal(r2.rows[0].diff, " line one\n-line two\n+line changed\n ");
  assert.equal(readFileSync(r2.rows[0].transcript_path, "utf8"), "again");
  assert.notEqual(r2.rows[0].transcript_path, by.alpha.transcript_path, "a new file per run; the first run's bytes stay");
  assert.equal(readFileSync(by.alpha.transcript_path, "utf8"), TRANSCRIPT);
  assert.match(r2.text, /diff vs last pass: 2 line\(s\)/);

  // No claude: every scripted plugin unavailable with the reason; the no-script one keeps its own.
  const r3 = await withStore(b, (s) => runCanary({ db: s.db, dbPath: s.dbPath, env: b.env, repo: root, plugins: ["alpha", "epsilon"], claudePresent: false }));
  assert.equal(r3.code, 0);
  assert.deepEqual(r3.rows.map((x) => [x.plugin, x.status, x.note]), [["alpha", "unavailable", "claude not found on PATH"], ["epsilon", "unavailable", "no e2e/live-run.sh"]]);
  // No repo.
  const r4 = await withStore(b, (s) => runCanary({ db: s.db, dbPath: s.dbPath, env: b.env, repo: join(b.root, "nowhere"), claudePresent: true }));
  assert.equal(r4.code, 2);
  assert.match(r4.text, /no plugins\/ directory under/);
});

test("canary: the canary directory unwritable → row inserted with transcript_path and output_path NULL and the errors in note; a read-only db → exit 2 naming the files", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, async () => {
  const b = sandbox();
  const root = repo(b, { alpha: "#!/bin/bash\necho ok\n" });
  const cdir = join(b.env.XDG_STATE_HOME, "ledger", "canary");
  mkdirSync(cdir, { recursive: true });
  chmodSync(cdir, 0o500);
  const r = await withStore(b, (s) => runCanary({ db: s.db, dbPath: s.dbPath, env: b.env, repo: root, claudePresent: true }));
  chmodSync(cdir, 0o700);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.rows[0].status, "pass");
  assert.equal(r.rows[0].transcript_path, null);
  assert.equal(r.rows[0].output_path, null);
  assert.match(r.rows[0].note, /^no transcript from the script; output not written: /);
  const db = openDb(b);
  assert.equal(row(db, "SELECT transcript_path, output_path FROM cc_canary_runs").output_path, null);
  db.close();
  chmodSync(b.dbPath, 0o444);
  const r2 = await withStore(b, (s) => runCanary({ db: s.db, dbPath: s.dbPath, env: b.env, repo: root, claudePresent: true }));
  chmodSync(b.dbPath, 0o644);
  assert.equal(r2.code, 2);
  assert.match(r2.text, /could not record the alpha run .*; its transcript is at \(none\), its output at \S+\.out\.txt/);
});

test("canary grade, runs, prune: a grade needs a known id and one of three words; prune removes only files older than N days and leaves rows", async () => {
  const b = sandbox();
  const root = repo(b, { alpha: "#!/bin/bash\necho ok\n" });
  const r = await withStore(b, (s) => runCanary({ db: s.db, dbPath: s.dbPath, env: b.env, repo: root, claudePresent: true }));
  const id = r.rows[0].id;
  const g = withStore(b, (s) => gradeRun({ db: s.db, dbPath: s.dbPath, id, grade: "biting", note: "the flow was fine", by: "jo" }));
  assert.equal(g.code, 0);
  assert.match(g.text, new RegExp(`^#${id} alpha pass graded biting by jo at `));
  assert.equal(withStore(b, (s) => gradeRun({ db: s.db, dbPath: s.dbPath, id: 999, grade: "fine" })).code, 1);
  assert.match(withStore(b, (s) => gradeRun({ db: s.db, dbPath: s.dbPath, id, grade: "meh" })).text, /^usage: canary grade/);
  const runs = cli(b, ["canary", "runs"]);
  assert.equal(runs.code, 0, runs.err);
  assert.match(runs.out, new RegExp(`^#${id}\\s+\\S+  alpha\\s+pass .*the flow was fine.*graded biting by jo`, "m"));
  // prune: an old file goes, a new one stays, the row stays.
  const old = join(b.env.XDG_STATE_HOME, "ledger", "canary", "alpha", "old.jsonl");
  writeFileSync(old, "x");
  const past = new Date(Date.now() - 40 * D);
  utimesSync(old, past, past);
  const p = prune({ env: b.env, days: 30 });
  assert.deepEqual(p, { removed: 1, kept: 1 });
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(r.rows[0].output_path), true);
  const db = openDb(b);
  assert.equal(count(db, "cc_canary_runs"), 1);
  db.close();
  const viaCli = cli(b, ["canary", "prune", "--days", "0"]);
  assert.match(viaCli.out, /removed 1 file\(s\) older than 0 day\(s\), kept 0; rows untouched/);
  assert.match(cli(b, ["canary", "prune", "--days", "x"]).out, /^usage: canary/);
});

test("canary install: writes the plist under <state>/launchd, lints it, prints the bootstrap line, never runs bootstrap; the plist has the nightly interval and the repo", () => {
  const b = sandbox();
  const root = repo(b, { alpha: "#!/bin/bash\n" });
  const calls = [];
  const check = (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === "plutil") return { missing: false, code: 0, output: "OK\n" };
    return { missing: false, code: 113, output: "Could not find service" };
  };
  const r = canaryInstall({ env: b.env, cliPath: "/Users/example/plugins/ledger/scripts/ledger.mjs", repo: root, hour: 3, minute: 30, uid: 501, check });
  assert.equal(r.code, 0, r.text);
  const file = join(b.env.XDG_STATE_HOME, "ledger", "launchd", "com.jo-wolff-plugins.ledger-canary.plist");
  assert.equal(r.file, file);
  assert.ok(existsSync(file));
  const text = readFileSync(file, "utf8");
  assert.match(text, /<key>Hour<\/key>\s*<integer>3<\/integer>\s*<key>Minute<\/key>\s*<integer>30<\/integer>/);
  assert.ok(text.includes(`<string>${root}</string>`));
  assert.ok(text.includes("<string>canary</string>\n    <string>run</string>"));
  assert.deepEqual(calls, [["plutil", "-lint", file], ["launchctl", "print", "gui/501/com.jo-wolff-plugins.ledger-canary"]]);
  assert.match(r.text, /plutil -lint: OK/);
  assert.match(r.text, new RegExp(`launchctl bootstrap gui/501 ${file}`));
  assert.ok(!calls.some((c) => c.includes("bootstrap")), "install never bootstraps");
  // Already loaded: say so and give the bootout+bootstrap pair.
  const r2 = canaryInstall({ env: b.env, cliPath: "/x", repo: root, uid: 501, check: () => ({ missing: false, code: 0, output: "" }) });
  assert.match(r2.text, /launchd already has com.jo-wolff-plugins.ledger-canary; to pick up this plist: launchctl bootout/);
  // No plutil: said, not fatal. Lint failing: exit 1 with the output.
  assert.match(canaryInstall({ env: b.env, cliPath: "/x", repo: root, check: () => ({ missing: true }) }).text, /plutil not found/);
  const bad = canaryInstall({ env: b.env, cliPath: "/x", repo: root, check: (bin) => (bin === "plutil" ? { missing: false, code: 1, output: "bad plist" } : { missing: true }) });
  assert.equal(bad.code, 1);
  assert.match(bad.text, /plutil -lint failed: bad plist/);
  // Real plutil on this machine, when present.
  const real = canaryInstall({ env: b.env, cliPath: "/x", repo: root, uid: 501, check: (bin, args) => (bin === "plutil" ? (() => { const { spawnSync } = process.getBuiltinModule("node:child_process"); const x = spawnSync("plutil", args, { encoding: "utf8" }); return x.error ? { missing: true } : { missing: false, code: x.status, output: x.stdout + x.stderr }; })() : { missing: true }) });
  assert.equal(real.code, 0, real.text);
  // Usage.
  assert.match(parseCanaryArgs(["install", "--hour", "25"]).error, /^usage: canary/);
  assert.deepEqual(parseCanaryArgs(["run", "--plugins", "a,b", "--timeout", "30"]), { action: "run", repo: null, plugins: ["a", "b"], timeoutS: 30 });
  assert.match(parseCanaryArgs(["run", "--timeout", "0"]).error, /^usage/);
  assert.match(parseCanaryArgs(["bogus"]).error, /^usage/);
  assert.match(plistText({ cliPath: "/c", repo: "/r", logDir: "/l" }), /<string>\/r<\/string>/);
});

test("lineDiff and cut: changed lines with one line of context, '…' between stretches, '' when equal; cut keeps the tail with a marker", () => {
  assert.equal(lineDiff("a\nb\nc", "a\nb\nc"), "");
  assert.equal(lineDiff("a\nb\nc\nd\ne\nf\ng", "a\nb\nX\nd\ne\nf\nY"), " b\n-c\n+X\n d\n…\n f\n-g\n+Y");
  assert.equal(lineDiff("", "a"), "-\n+a");
  const big = "x".repeat(20_000);
  assert.ok(cut(big).startsWith("…[cut to the last 16384 bytes]\n"));
  assert.ok(Buffer.byteLength(cut(big)) <= 16384 + 64);
});

/** A bounce row backdated `agoMs`, with `text` and an outcome. */
function bounce(b, { rule, outcome = null, text = "the reply", agoMs = 0, sessionId = "s-1", tool = null }) {
  const db = openDb(b);
  recordBounce({ db, dbPath: b.dbPath }, { sessionId, rule, promptId: null, tool, text, env: b.env, hook: "Stop" });
  const id = row(db, "SELECT max(id) AS id FROM cc_bounces").id;
  db.prepare("UPDATE cc_bounces SET at = ?, outcome = ?, satisfied_at = ? WHERE id = ?").run(nowIso(Date.now() - agoMs), outcome, outcome ? nowIso(Date.now() - agoMs + 1000) : null, id);
  db.close();
  return id;
}

function session(b, id, agoMs = 0) {
  const db = openDb(b);
  db.prepare("INSERT INTO cc_sessions (id, cwd, started_at) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING").run(id, b.work, nowIso(Date.now() - agoMs));
  db.close();
}

test("report: mechanical grades (biting on bypassed ≥3 or > half; silent when sessions ran and the rule never fired; fine otherwise), canary, waived reviews and judge answers in the window; the judge overlay with its bounds", async () => {
  assert.equal(mechanicalGrade({ fired: 4, bypassed: 3, sessions: 1 }), "biting");
  assert.equal(mechanicalGrade({ fired: 3, bypassed: 2, sessions: 1 }), "biting");
  assert.equal(mechanicalGrade({ fired: 4, bypassed: 2, sessions: 1 }), "fine");
  assert.equal(mechanicalGrade({ fired: 0, bypassed: 0, sessions: 2 }), "silent");
  assert.equal(mechanicalGrade({ fired: 0, bypassed: 0, sessions: 0 }), "fine");

  const b = sandbox();
  session(b, "s-1", D);
  for (let i = 0; i < 3; i++) bounce(b, { rule: "pushNeedsNote", outcome: "bypassed", text: `push ${i}`, agoMs: D, tool: "Bash" });
  bounce(b, { rule: "pushNeedsNote", outcome: "satisfied", text: "push ok", agoMs: D, tool: "Bash" });
  bounce(b, { rule: "stopAskRule", outcome: "satisfied", text: "Which one?", agoMs: 2 * D });
  bounce(b, { rule: "stopAskRule", outcome: "satisfied", text: "old", agoMs: 10 * D });
  const b1 = bounce(b, { rule: "stopDecisionRule", outcome: null, text: null, agoMs: D });
  // A canary row, a waived review, a judge answer.
  const db = openDb(b);
  db.prepare("INSERT INTO cc_canary_runs (plugin, at, status, exit_code, duration_ms, note, grade, graded_by) VALUES ('alpha', ?, 'fail', 3, 1200, 'exit 3', 'biting', 'jo')").run(nowIso(Date.now() - D));
  db.prepare("INSERT INTO cc_canary_runs (plugin, at, status, exit_code, duration_ms) VALUES ('alpha', ?, 'pass', 0, 1000)").run(nowIso(Date.now() - 2 * D));
  db.prepare("INSERT INTO cc_reviews (cwd, head_sha, branch, lab, verdict, reason, at) VALUES (?, 'abcdef1234567', 'feat', 'codex', 'waived', 'prototyping', ?)").run(b.work, nowIso(Date.now() - D));
  db.prepare("INSERT INTO cc_judge_cache (key, question, passage, answer, at) VALUES ('judge:aaa', 'q', 'p', 'yes', ?), ('judge:bbb', 'q', 'p', 'no', ?)").run(nowIso(Date.now() - D), nowIso(Date.now() - 9 * D));
  db.close();

  const data = withStore(b, (s) => gather(s.db, { since: "7d" }));
  assert.equal(data.sessions, 1);
  const rule = (n) => data.rules.find((r) => r.rule === n);
  assert.deepEqual([rule("pushNeedsNote").fired, rule("pushNeedsNote").bypassed, rule("pushNeedsNote").mechanical], [4, 3, "biting"]);
  assert.deepEqual([rule("stopAskRule").fired, rule("stopAskRule").mechanical], [1, "fine"]);
  assert.deepEqual([rule("stopAnswerRule").fired, rule("stopAnswerRule").mechanical], [0, "silent"]);
  assert.equal(rule("stopDecisionRule").open, 1);
  assert.equal(data.canary.length, 2);
  assert.equal(data.waived.length, 1);
  assert.deepEqual(data.judgements.map((j) => j.key), ["judge:aaa"]);

  // Judge overlay: asked once per rule that fired and has texts; passage bounded; answers kept, errors named.
  const asked = [];
  const judge = async ({ passage, question, words }) => {
    asked.push({ passage, question, words });
    if (passage.startsWith("Rule: pushNeedsNote")) return { answer: "fine", error: null };
    if (passage.startsWith("Rule: stopAskRule")) return { answer: null, error: "unparsed: judge answered none of biting|silent|fine" };
    return { answer: null, error: "no judge configured" };
  };
  await overlayJudge(data, { config: {}, env: b.env, judge });
  assert.deepEqual(asked.map((a) => a.passage.split("\n")[0]), ["Rule: stopAskRule. Fired 1, satisfied 1, bypassed 0, open 0.", "Rule: pushNeedsNote. Fired 4, satisfied 1, bypassed 3, open 0."]);
  assert.deepEqual(asked[0].words, ["biting", "silent", "fine"]);
  assert.match(asked[1].passage, /--- bounce 1 \(satisfied, Bash, \S+\) ---\npush ok\n--- bounce 2 \(bypassed, Bash, \S+\) ---\npush 2/);
  assert.equal(rule("pushNeedsNote").judge, "fine");
  assert.equal(rule("stopAskRule").judgeError, "unparsed: judge answered none of biting|silent|fine");
  assert.equal(rule("stopDecisionRule").judgeError, "no bounce texts kept (rows from before 0.3.3)");
  const text = render(data);
  assert.match(text, /^ledger report since \S+ \(7d\) · 1 session\(s\)$/m);
  assert.match(text, /^pushNeedsNote\s+4\s+1\s+3\s+0\s+biting \(judge: fine\)$/m);
  assert.match(text, /^stopAskRule\s+1\s+1\s+0\s+0\s+fine \(judge unavailable: unparsed: judge answered none of biting\|silent\|fine\)$/m);
  assert.match(text, /^stopAnswerRule\s+0\s+0\s+0\s+0\s+silent$/m);
  assert.match(text, /^canary: 2 run\(s\): pass 1, fail 1, unavailable 0$/m);
  assert.match(text, /^  alpha\s+last fail #\d+ \S+ \(exit 3\) · 2 run\(s\), graded: #\d+ biting$/m);
  assert.match(text, /^reviews waived: 1\n  \S+ abcdef1 feat · prototyping · /m);
  assert.match(text, /^judge answers: 1 \(1 yes, 0 no\)\n  \S+ yes judge:aaa$/m);
  // The judge passage is bounded to 20 texts.
  for (let i = 0; i < 25; i++) bounce(b, { rule: "stopAskRule", outcome: "satisfied", text: `q${i}`, agoMs: D });
  const again = withStore(b, (s) => gather(s.db, { since: "7d" }));
  assert.equal(again.rules.find((r) => r.rule === "stopAskRule").texts.length, 20);
  assert.ok(judgePassage(again.rules.find((r) => r.rule === "stopAskRule")).split("--- bounce").length === 21);
  // Through the CLI, with a judge on PATH that says biting, and without one.
  const withJudge = cli(b, ["report", "--since", "3d"], { env: { LEDGER_JUDGE_BIN: "echo biting" } });
  assert.equal(withJudge.code, 0, withJudge.err);
  assert.match(withJudge.out, /^pushNeedsNote\s+4\s+1\s+3\s+0\s+biting \(judge: biting\)$/m);
  const noJudge = cli(b, ["report", "--no-judge"]);
  assert.match(noJudge.out, /^pushNeedsNote\s+4\s+1\s+3\s+0\s+biting \(judge: not asked\)$/m);
  assert.match(cli(b, ["report", "--since", "soon"]).out, /^usage: report/);
  assert.match(cli(b, ["report", "--since", "1h"]).out, /^stopAskRule\s+0\s+0\s+0\s+0\s+/m);
  assert.deepEqual(parseReportArgs([]), { since: "7d", judge: true });
  void b1;
});

test("digest: writes the attempt before posting, the post on success, the error on failure (body printed), refuses a repost within 24h unless --force, --dry-run records nothing, an empty week posts", async () => {
  const b = sandbox();
  const posts = [];
  const ok = async (issue, text) => {
    posts.push({ issue, text });
    return { ok: true, error: null, url: "https://github.com/thewolff/jo-issues/issues/325#issuecomment-1" };
  };
  const fail = async () => ({ ok: false, error: "gh exited 1: HTTP 401 bad credentials" });
  const now = Date.now();
  // Empty week, dry run: body printed, no keys.
  const dry = await withStore(b, (s) => runDigest({ db: s.db, dbPath: s.dbPath, config: s.config, env: b.env, now, dryRun: true, post: ok }));
  assert.equal(dry.code, 0);
  assert.match(dry.text, /^digest --dry-run: would post to thewolff\/jo-issues#325 \(\d+ bytes\); nothing recorded\n\n## ledger weekly digest\n\nweek of \S+ to \S+: 0 bounces, 0 canary runs \(0 failed\), nothing graded\n/);
  let db = openDb(b);
  assert.equal(count(db, "cc_meta", "key LIKE 'digest_%'"), 0);
  db.close();
  assert.equal(posts.length, 0);
  // Empty week posts.
  const first = await withStore(b, (s) => runDigest({ db: s.db, dbPath: s.dbPath, config: s.config, env: b.env, now, post: ok, version: "0.3.3" }));
  assert.equal(first.code, 0, first.text);
  assert.match(first.text, /^digest: posted to thewolff\/jo-issues#325 \(https:\/\/github.com\/.*#issuecomment-1\) at /);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].issue, "thewolff/jo-issues#325");
  assert.match(posts[0].text, /^## ledger weekly digest \(ledger 0\.3\.3\)\n\nweek of /);
  assert.match(posts[0].text, /```\nledger report since /);
  db = openDb(b);
  const metaOf = (k) => row(db, "SELECT value FROM cc_meta WHERE key = ?", k)?.value ?? null;
  assert.equal(metaOf(KEYS.attempt), nowIso(now));
  assert.equal(metaOf(KEYS.posted), nowIso(now));
  assert.equal(metaOf(KEYS.error), null);
  db.close();
  // Repost within 24h refused; --force posts.
  const again = await withStore(b, (s) => runDigest({ db: s.db, dbPath: s.dbPath, config: s.config, env: b.env, now: now + 3_600_000, post: ok }));
  assert.equal(again.code, 1);
  assert.match(again.text, /less than 24h ago; pass --force to post again$/);
  assert.equal(posts.length, 1);
  const forced = await withStore(b, (s) => runDigest({ db: s.db, dbPath: s.dbPath, config: s.config, env: b.env, now: now + 3_600_000, force: true, post: ok }));
  assert.equal(forced.code, 0);
  assert.equal(posts.length, 2);
  // Failure a week later: attempt stamped, error stored, posted unchanged, body in the output.
  const later = now + 7 * D;
  const failed = await withStore(b, (s) => runDigest({ db: s.db, dbPath: s.dbPath, config: s.config, env: b.env, now: later, post: fail }));
  assert.equal(failed.code, 1);
  assert.match(failed.text, /^digest: post to thewolff\/jo-issues#325 failed: gh exited 1: HTTP 401 bad credentials; the body follows so nothing is lost\n\n## ledger weekly digest/);
  db = openDb(b);
  assert.equal(metaOf(KEYS.attempt), nowIso(later));
  assert.equal(metaOf(KEYS.posted), nowIso(now + 3_600_000));
  assert.equal(metaOf(KEYS.error), "gh exited 1: HTTP 401 bad credentials");
  db.close();
  // The next SessionStart says so; after a successful post the line is gone.
  const lines = withStore(b, (s) => sessionStartLines(s.db, { config: s.config, now: later + 3_600_000, cli: "L" }));
  assert.deepEqual(lines, [`ledger: weekly digest attempted ${nowIso(later).slice(0, 10)}, post failed: gh exited 1: HTTP 401 bad credentials`]);
  const recovered = await withStore(b, (s) => runDigest({ db: s.db, dbPath: s.dbPath, config: s.config, env: b.env, now: later + 7_200_000, post: ok }));
  assert.equal(recovered.code, 0);
  assert.deepEqual(withStore(b, (s) => sessionStartLines(s.db, { config: s.config, now: later + 8_000_000 })), []);
  // Body bound.
  const long = body("x".repeat(70 * 1024), { from: nowIso(now), rules: [], canary: [] }, { now });
  assert.ok(Buffer.byteLength(long) <= 60 * 1024, String(Buffer.byteLength(long)));
  assert.match(long, /…\[cut to 60 KiB; the full report is `ledger report`\]\n```\n$/);
  // Off.
  const off = await withStore(b, (s) => runDigest({ db: s.db, dbPath: s.dbPath, config: { ...s.config, digest: { enabled: false, issue: "x#1" } }, env: b.env, now, post: ok }));
  assert.equal(off.code, 1);
  assert.match(off.text, /digest.enabled is false/);
  assert.deepEqual(parseDigestArgs(["--dry-run", "--force"]), { action: "run", dryRun: true, force: true });
  assert.deepEqual(parseDigestArgs(["install"]), { action: "install" });
  assert.match(parseDigestArgs(["--bogus"]).error, /^usage: digest/);
});

test("dead-man's switch: SessionStart stamps digest_first_seen; the overdue line appears at day 9 and not at day 7, from the last post or from first seen; digest.enabled false turns the lines off and doctor says so", () => {
  const b = sandbox();
  const start = (now) => hook(b, "session-start", { session_id: `s-${now}`, cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  const r = start(1);
  assert.equal(r.code, 0, r.err);
  assert.ok(!(r.json.systemMessage ?? "").includes("digest"), r.out);
  let db = openDb(b);
  const first = row(db, "SELECT value FROM cc_meta WHERE key = 'digest_first_seen'").value;
  assert.ok(first, "first seen stamped");
  db.close();
  const t0 = Date.parse(first);
  const linesAt = (now, cfg = null) => withStore(b, (s) => sessionStartLines(s.db, { config: cfg ?? s.config, now, cli: "L" }));
  assert.deepEqual(linesAt(t0 + 7 * D), []);
  assert.deepEqual(linesAt(t0 + 9 * D), [`ledger: weekly digest overdue (last: never; first seen ${first.slice(0, 10)}); run \`L digest\` or check launchd`]);
  // A post resets the anchor.
  db = openDb(b);
  const postedAt = nowIso(t0 + 9 * D);
  db.prepare("INSERT INTO cc_meta (key, value) VALUES ('digest_last_posted', ?), ('digest_last_attempt', ?)").run(postedAt, postedAt);
  db.close();
  assert.deepEqual(linesAt(t0 + 16 * D), []);
  assert.deepEqual(linesAt(t0 + 18 * D), [`ledger: weekly digest overdue (last: ${postedAt.slice(0, 10)}); run \`L digest\` or check launchd`]);
  // Through the real hook with a backdated post: the line is in systemMessage.
  db = openDb(b);
  db.prepare("UPDATE cc_meta SET value = ? WHERE key = 'digest_last_posted'").run(nowIso(Date.now() - 9 * D));
  db.close();
  const r2 = start(2);
  assert.match(r2.json.systemMessage, /ledger: weekly digest overdue \(last: \d{4}-\d{2}-\d{2}\); run `node \S+ledger\.mjs digest` or check launchd/);
  // Doctor: warn with the same words; ok after a fresh post; warn when off.
  const doc = cli(b, ["doctor"], { env: { LEDGER_REVIEW_BIN_CODEX: process.execPath, LEDGER_JUDGE_BIN: "echo yes" } });
  assert.match(doc.out, /^warn digest: weekly digest overdue \(last: /m);
  db = openDb(b);
  db.prepare("UPDATE cc_meta SET value = ? WHERE key = 'digest_last_posted'").run(nowIso(Date.now()));
  db.close();
  assert.match(cli(b, ["doctor"], { env: { LEDGER_REVIEW_BIN_CODEX: process.execPath, LEDGER_JUDGE_BIN: "echo yes" } }).out, /^ok   digest: last posted /m);
  const offCfg = { digest: { enabled: false, issue: "thewolff/jo-issues#325" } };
  assert.deepEqual(linesAt(t0 + 30 * D, offCfg), []);
  assert.deepEqual(withStore(b, (s) => doctorCheck(s.db, { config: offCfg })), { status: "warn", detail: "digest.enabled is false: no weekly digest, no overdue line" });
  mkdirSync(join(b.env.XDG_CONFIG_HOME, "ledger"), { recursive: true });
  writeFileSync(join(b.env.XDG_CONFIG_HOME, "ledger", "config.json"), JSON.stringify({ digest: { enabled: false } }));
  db = openDb(b);
  db.prepare("UPDATE cc_meta SET value = ? WHERE key = 'digest_last_posted'").run(nowIso(Date.now() - 30 * D));
  db.close();
  const r3 = start(3);
  assert.ok(!(r3.json.systemMessage ?? "").includes("digest"), r3.out);
  assert.match(cli(b, ["doctor"], { env: { LEDGER_REVIEW_BIN_CODEX: process.execPath, LEDGER_JUDGE_BIN: "echo yes" } }).out, /^warn digest: digest.enabled is false/m);
});

test("digest install and the CLI: the Monday 09:00 plist, the bootstrap line; `digest` with a stub gh on PATH posts and records; without gh the failure is recorded and the body printed", async () => {
  const b = sandbox();
  const r = digestInstall({ env: b.env, cliPath: "/Users/example/ledger.mjs", config: { digest: { enabled: true, issue: "o/r#1" } }, uid: 501, check: (bin) => (bin === "plutil" ? { missing: false, code: 0, output: "OK" } : { missing: false, code: 113, output: "" }) });
  assert.equal(r.code, 0, r.text);
  const file = join(b.env.XDG_STATE_HOME, "ledger", "launchd", "com.jo-wolff-plugins.ledger-digest.plist");
  const text = readFileSync(file, "utf8");
  assert.match(text, /<key>Weekday<\/key>\s*<integer>1<\/integer>\s*<key>Hour<\/key>\s*<integer>9<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.match(r.text, /posts to o\/r#1/);
  assert.match(r.text, new RegExp(`launchctl bootstrap gui/501 ${file}`));
  // Stub gh: records the body it got.
  const bin = join(b.root, "bin");
  mkdirSync(bin, { recursive: true });
  const got = join(b.root, "gh-got.txt");
  writeFileSync(join(bin, "gh"), `#!/bin/bash\nprintf '%s\\n' "$*" > "${got}.args"\ncat > "${got}"\necho https://github.com/o/r/issues/1#issuecomment-9\n`);
  chmodSync(join(bin, "gh"), 0o755);
  mkdirSync(join(b.env.XDG_CONFIG_HOME, "ledger"), { recursive: true });
  writeFileSync(join(b.env.XDG_CONFIG_HOME, "ledger", "config.json"), JSON.stringify({ digest: { issue: "o/r#1" } }));
  const posted = cli(b, ["digest"], { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(posted.code, 0, posted.out + posted.err);
  assert.match(posted.out, /^digest: posted to o\/r#1 \(https:\/\/github.com\/o\/r\/issues\/1#issuecomment-9\) at /);
  assert.equal(readFileSync(`${got}.args`, "utf8").trim(), "issue comment 1 --body-file - --repo o/r");
  assert.match(readFileSync(got, "utf8"), /^## ledger weekly digest \(ledger 0\.3\.\d+\)\n/);
  // No gh at all.
  const b2 = sandbox();
  const none = cli(b2, ["digest"], { env: { PATH: join(b2.root, "empty") } });
  assert.equal(none.code, 1);
  assert.match(none.out, /^digest: post to thewolff\/jo-issues#325 failed: gh not found on PATH; the body follows so nothing is lost\n\n## ledger weekly digest/);
  const db = openDb(b2);
  assert.equal(row(db, "SELECT value FROM cc_meta WHERE key = 'digest_last_error'").value, "gh not found on PATH");
  db.close();
  // Own-line verbs refuse a batch.
  const batch = cli(b, [], { input: "digest\n" });
  assert.match(batch.out, /digest runs on its own line/);
});
