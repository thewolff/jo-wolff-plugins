// e2e.test.mjs — one story through the real CLI and the real hook scripts, each a separate
// process fed the JSON Claude Code sends: a temp git repository, a temp database, LEDGER_CONFIG
// naming a temp user file. Session A works in a subfolder, session B in the repository root.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, cli, hook, openDb } from "./helpers.mjs";

const A = "s-e2e-a";
const B = "s-e2e-b";

test("end to end: subfolder question → parent answers → delivery; push gate through findings, nits, judge no, waive; doctor; bounce rows", () => {
  const b = sandbox();
  const configPath = join(b.root, "e2e-config.json");
  writeFileSync(configPath, JSON.stringify({ review: { mode: "gate", labs: ["codex"] } }));
  const env = { LEDGER_CONFIG: configPath };
  const pkg = join(b.work, "pkg");
  mkdirSync(pkg);

  const gitEnv = { ...b.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: b.work, env: gitEnv, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const commit = (name, text) => {
    writeFileSync(join(b.work, name), text);
    git("add", name);
    git("commit", "-qm", `change ${name}`);
  };
  const stub = (name, reply) => {
    const path = join(b.root, `stub-${name}`);
    writeFileSync(path, `#!/bin/sh\ncat > /dev/null\ncat <<'EOF'\n${reply}\nEOF\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const judge = (answer) => stub(`judge-${answer}`, answer);
  const run = (sid, args, { cwd = b.work, extra = {} } = {}) => cli(b, args, { cwd, env: { ...env, LEDGER_SESSION_ID: sid, ...extra } });
  const start = (sid, cwd) => hook(b, "session-start", { session_id: sid, cwd, hook_event_name: "SessionStart", source: "startup" }, { env, cwd });
  const prompt = (sid, cwd, text) => hook(b, "user-prompt", { session_id: sid, cwd, hook_event_name: "UserPromptSubmit", prompt: text }, { env, cwd });
  const push = () => hook(b, "pre-tool-use", { session_id: B, cwd: b.work, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin feat" } }, { env });
  const decision = (r) => {
    assert.equal(r.code, 0, r.err);
    return r.json?.hookSpecificOutput?.permissionDecision ?? "allow";
  };
  const bounces = () => {
    const db = openDb(b);
    try {
      return db.prepare("SELECT session_id, rule, outcome FROM cc_bounces ORDER BY id").all().map((r) => [r.session_id, r.rule, r.outcome]);
    } finally {
      db.close();
    }
  };

  git("init", "-q", "-b", "main");
  commit("a.txt", "one\n");
  git("checkout", "-q", "-b", "feat");
  commit("b.txt", "two\n");

  // Session A, in the subfolder, asks.
  assert.equal(start(A, pkg).code, 0);
  const asked = run(A, ["ask", "Which colour for the badge?", "--name", "badge colour", "--options", "green,red"], { cwd: pkg });
  assert.equal(asked.code, 0, asked.err);
  const q = /q-[a-z0-9]+/.exec(asked.out)[0];
  assert.equal(prompt(A, pkg, "carry on").out, "", "the first prompt only sets A's mark");

  // Session B, in the parent folder, sees it at SessionStart and in pending, naming the folder.
  const seen = start(B, b.work);
  assert.equal(seen.code, 0, seen.err);
  assert.match(seen.json.hookSpecificOutput.additionalContext, new RegExp(`${q}  # badge colour .*· in ${pkg}$`, "m"));
  assert.match(run(B, ["pending"]).out, new RegExp(`${q}  # badge colour .*· in ${pkg}$`, "m"));
  assert.equal(run(B, ["answer", q, "red"]).code, 0);

  // A's next prompt is told.
  const told = prompt(A, pkg, "next step");
  assert.equal(told.json?.hookSpecificOutput?.additionalContext, "ledger: answered since your last turn: badge colour → red (via cli)");

  // B pushes: noted, but no review yet → deny, one bounce row.
  assert.equal(run(B, ["note", "shipping the badge"]).code, 0);
  let p = push();
  assert.equal(decision(p), "deny");
  assert.match(p.json.hookSpecificOutput.permissionDecisionReason, /review/);
  assert.deepEqual(bounces(), [[B, "reviewGate", null]]);

  // Review: a blocking finding → deny again, a second row; SessionStart names the finding.
  const codexFindings = stub("codex-1", "1. [blocking] b.txt:1 wrong value");
  let r = run(B, ["review"], { extra: { LEDGER_REVIEW_BIN_CODEX: codexFindings } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /round 1 of 3/);
  assert.equal(decision(push()), "deny");
  assert.equal(bounces().length, 2);
  assert.match(start(B, b.work).json.hookSpecificOutput.additionalContext, /cross-lab review found 1 finding\(s\)/);

  // Fix commit, review again: nits only, the dropped blocking finding judged resolved → allowed
  // with the nits notice; both open rows satisfied, no new row.
  commit("b.txt", "two, fixed\n");
  r = run(B, ["review"], { extra: { LEDGER_REVIEW_BIN_CODEX: stub("codex-2", "1. [nit] b.txt:1 trailing comma"), LEDGER_JUDGE_BIN: judge("yes") } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /round 2 of 3/);
  p = push();
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /nits, optional/);
  assert.deepEqual(bounces(), [
    [B, "reviewGate", "satisfied"],
    [B, "reviewGate", "satisfied"],
  ]);

  // A new finding, a commit, and `addressed` with the judge saying no: refused, gate stays shut.
  commit("c.txt", "three\n");
  assert.equal(run(B, ["review"], { extra: { LEDGER_REVIEW_BIN_CODEX: stub("codex-3", "1. [should] c.txt:1 missing newline handling") } }).code, 0);
  commit("c.txt", "three, maybe\n");
  r = run(B, ["review", "addressed", "handled the newline"], { extra: { LEDGER_JUDGE_BIN: judge("no") } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /judge/);
  assert.equal(decision(push()), "deny");
  assert.deepEqual(bounces().at(-1), [B, "reviewGate", null]);

  // Waive: the next push is allowed and closes the open row.
  assert.equal(run(B, ["review", "waive", "prototype, the human said ship it"]).code, 0);
  assert.equal(decision(push()), "allow");
  assert.deepEqual(bounces().map((x) => x[2]), ["satisfied", "satisfied", "satisfied"]);

  // Doctor is clean.
  const doc = run(B, ["doctor"], { extra: { LEDGER_REVIEW_BIN_CODEX: codexFindings, LEDGER_JUDGE_BIN: judge("yes") } });
  assert.equal(doc.code, 0, doc.out + doc.err);
  assert.ok(!/^(warn|fail) /m.test(doc.out), doc.out);
});
