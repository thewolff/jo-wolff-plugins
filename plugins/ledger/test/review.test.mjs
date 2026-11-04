import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, cli, hook, openDb } from "./helpers.mjs";

const SID = "s-review";

function git(b, ...args) {
  const r = spawnSync("git", args, { cwd: b.work, encoding: "utf8", env: { ...b.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function commit(b, name, text) {
  writeFileSync(join(b.work, name), text);
  git(b, "add", name);
  git(b, "commit", "-qm", `add ${name}`);
  return git(b, "rev-parse", "HEAD");
}

/** A repo with two commits, the user file's review settings, and a note so the note gate passes. */
function repo(review = {}) {
  const b = sandbox();
  git(b, "init", "-q", "-b", "main");
  commit(b, "a.txt", "one\n");
  commit(b, "b.txt", "two\n");
  b.writeConfig({ review: { mode: "gate", ...review } });
  cli(b, ["note", "pushing the change"], { env: { LEDGER_SESSION_ID: SID } });
  return b;
}

/** An executable stub that prints `reply` (and its argv to `<path>.args`), exiting `code`. */
function stub(b, name, reply, code = 0) {
  const path = join(b.root, `stub-${name}`);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${path}.args"\ncat > /dev/null\ncat <<'EOF'\n${reply}\nEOF\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return path;
}

const review = (b, args = [], env = {}) => cli(b, ["review", ...args], { env: { LEDGER_SESSION_ID: SID, ...env } });
const push = (b, command = "git push origin main", env = {}) =>
  hook(b, "pre-tool-use", { session_id: SID, cwd: b.work, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, { env });
const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? "allow";
const reviews = (b) => {
  const db = openDb(b);
  try {
    return db.prepare("SELECT lab, verdict, findings, reason, model FROM cc_reviews ORDER BY id").all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const reviewBounces = (b) => {
  const db = openDb(b);
  try {
    return db.prepare("SELECT outcome FROM cc_bounces WHERE rule = 'reviewGate' ORDER BY id").all().map((r) => r.outcome);
  } finally {
    db.close();
  }
};

test("review (a): PASS from the lab → a pass row and the gate allows silently", () => {
  const b = repo();
  const env = { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS") };
  const r = review(b, [], env);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^codex: pass$/m);
  assert.deepEqual(reviews(b).map((x) => [x.lab, x.verdict]), [["codex", "pass"]]);
  const p = push(b);
  assert.equal(p.out, "");
  // codex reads its prompt from stdin: the last argument is `-`, in a read-only sandbox.
  const args = readFileSync(`${env.LEDGER_REVIEW_BIN_CODEX}.args`, "utf8").trim().split("\n");
  assert.equal(args[0], "exec");
  assert.equal(args.at(-1), "-");
  assert.ok(args.includes("read-only"));
});

test("review (b): findings → a findings row; the gate denies with them; SessionStart names the count; a reviewGate bounce", () => {
  const b = repo();
  const env = { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. a.txt:1 off by one\n2. b.txt:1 missing check") };
  review(b, [], env);
  assert.equal(reviews(b)[0].verdict, "findings");
  const p = push(b);
  assert.equal(decision(p), "deny");
  assert.match(p.json.hookSpecificOutput.permissionDecisionReason, /codex:\n1\. a\.txt:1 off by one/);
  assert.match(p.json.hookSpecificOutput.permissionDecisionReason, /review waive/);
  const ctx = hook(b, "session-start", { session_id: SID, cwd: b.work, source: "startup" }).json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /ledger: cross-lab review found 2 finding\(s\) on [0-9a-f]{8}; run `.*review status`/);
  assert.deepEqual(reviewBounces(b), [null]);
  assert.equal(decision(push(b, "gh pr merge 12")), "deny", "gh pr merge is gated too");
});

test("review (c): addressed on a new commit after findings → allows; addressed with no earlier findings is refused", () => {
  const b = repo();
  assert.match(review(b, ["addressed"]).out, /^refused no review findings on an earlier commit/);
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. bug") });
  commit(b, "c.txt", "fix\n");
  const r = review(b, ["addressed"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(push(b).out, "");
  assert.deepEqual(reviewBounces(b), [], "no bounce: the push was never denied");
});

test("review (d): a failing or missing lab → unavailable row with the error; the gate allows with a notice", () => {
  const b = repo();
  const r = review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "boom", 3) });
  assert.equal(r.code, 0);
  assert.match(r.out, /^codex: unavailable: .* exited 3: boom$/m);
  let p = push(b);
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /review gate open for [0-9a-f]{8}: every lab was unavailable \(codex unavailable: /);
  const b2 = repo();
  review(b2, [], { LEDGER_REVIEW_BIN_CODEX: join(b2.root, "no-such-codex") });
  assert.equal(reviews(b2)[0].verdict, "unavailable");
  assert.match(reviews(b2)[0].reason, /not found/);
  p = push(b2);
  assert.equal(decision(p), "allow");
});

test("review (e): waive needs a reason; with one, the gate allows and the reason is recorded", () => {
  const b = repo();
  const bare = review(b, ["waive"]);
  assert.equal(bare.code, 1);
  assert.match(bare.out, /^refused review waive needs the reason/);
  assert.equal(decision(push(b)), "deny", "no row yet");
  assert.equal(review(b, ["waive", "prototyping, Jo said push it"]).code, 0);
  assert.equal(push(b).out, "");
  assert.deepEqual(reviews(b).map((x) => [x.lab, x.verdict, x.reason]), [["ledger", "waived", "prototyping, Jo said push it"]]);
  assert.deepEqual(reviewBounces(b), ["satisfied"], "the earlier deny is satisfied by the allowed push");
});

test("review (f): mode advise never denies; it says so when HEAD has no review", () => {
  const b = repo({ mode: "advise" });
  const p = push(b);
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /no cross-lab review for [0-9a-f]{8}; run `.*review`/);
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. bug") });
  const q = push(b);
  assert.equal(decision(q), "allow");
  assert.match(q.json.systemMessage, /found problems/);
});

test("review (g): mode off → no rows from review, no notices from the gate", () => {
  const b = repo({ mode: "off" });
  const r = review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS") });
  assert.match(r.out, /review\.mode is off/);
  assert.equal(push(b).out, "");
  assert.deepEqual(reviews(b), []);
  assert.deepEqual(reviewBounces(b), []);
});

test("review (h): a new commit after a pass is unreviewed: the gate denies again", () => {
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS") });
  assert.equal(push(b).out, "");
  commit(b, "d.txt", "more\n");
  const p = push(b);
  assert.equal(decision(p), "deny");
  assert.match(p.json.hookSpecificOutput.permissionDecisionReason, /no cross-lab review for/);
});

test("review (i): the store unreachable → the push is allowed with a notice", () => {
  const b = repo();
  const p = push(b, "git push", { LEDGER_DB: b.work });
  assert.equal(p.code, 0);
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /ledger/);
});

test("review (j): two labs, one pass one findings → deny naming the findings lab", () => {
  const b = repo({ labs: ["codex", "kimi"] });
  const env = { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS"), LEDGER_REVIEW_BIN_KIMI: stub(b, "kimi", "1. kimi saw a race") };
  review(b, [], env);
  assert.deepEqual(reviews(b).map((x) => [x.lab, x.verdict]), [["codex", "pass"], ["kimi", "findings"]]);
  const reason = push(b).json.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /kimi:\n1\. kimi saw a race/);
  assert.ok(!reason.includes("codex:"), reason);
  // kimi takes the prompt as its -p argument, with text output.
  const args = readFileSync(`${env.LEDGER_REVIEW_BIN_KIMI}.args`, "utf8");
  assert.match(args, /^-p\n/);
  assert.match(args, /--output-format\ntext/);
});

test("review (k): two labs, one unavailable one pass → allow, the notice names the unavailable lab", () => {
  const b = repo({ labs: ["codex", "claude"] });
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS"), LEDGER_REVIEW_BIN_CLAUDE: stub(b, "claude", "nope", 1) });
  const p = push(b);
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /review passed for [0-9a-f]{8}; claude unavailable: /);
});

test("review (l): --labs overrides review.labs for one run", () => {
  const b = repo({ labs: ["codex", "kimi"] });
  review(b, ["--labs", "kimi"], { LEDGER_REVIEW_BIN_KIMI: stub(b, "kimi", "PASS") });
  assert.deepEqual(reviews(b).map((x) => x.lab), ["kimi"]);
});

test("review: glm runs through omp with the agent-system-2 profile and zai/glm-5.3, both overridable", () => {
  const b = repo({ labs: ["glm"] });
  const bin = stub(b, "omp", "PASS");
  review(b, [], { LEDGER_REVIEW_BIN_GLM: bin });
  let args = readFileSync(`${bin}.args`, "utf8").split("\n");
  assert.equal(args[0], "-p");
  assert.deepEqual(args.slice(args.indexOf("--profile"), args.indexOf("--profile") + 2), ["--profile", "agent-system-2"]);
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "zai/glm-5.3"]);
  assert.ok(args.some((a) => /^@.*change\.diff$/.test(a)), "the diff goes in as an @file");
  assert.deepEqual(reviews(b).map((x) => [x.lab, x.verdict, x.model]), [["glm", "pass", "zai/glm-5.3"]]);
  b.writeConfig({ review: { mode: "gate", labs: ["glm"], models: { glm: "zai/glm-5.3-flash" }, profiles: { glm: "work" } } });
  review(b, [], { LEDGER_REVIEW_BIN_GLM: bin });
  args = readFileSync(`${bin}.args`, "utf8").split("\n");
  assert.ok(args.includes("work") && args.includes("zai/glm-5.3-flash"), args.join(" "));
});

test("review: a project file's review key is ignored with a notice; the user file decides", () => {
  const b = repo({ mode: "gate" });
  writeFileSync(join(b.work, ".ledger.json"), JSON.stringify({ review: { mode: "off" } }));
  const p = push(b);
  assert.equal(decision(p), "deny");
  assert.match(p.json.systemMessage, /review is read from the user file only/);
});

test("review: status lists the rows for HEAD and the gate's state", () => {
  const b = repo({ labs: ["codex", "kimi"] });
  assert.match(review(b, ["status"]).out, /: none; review\.mode gate would deny a push/);
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS"), LEDGER_REVIEW_BIN_KIMI: stub(b, "kimi", "1. x") });
  const out = review(b, ["status"]).out;
  assert.match(out, /: findings; review\.mode gate would deny a push/);
  assert.match(out, /codex\s+pass/);
  assert.match(out, /kimi\s+findings\n {2}1\. x/);
});

test("review: doctor warns per configured lab whose binary is missing, and not when mode is off", () => {
  const b = repo({ labs: ["codex", "glm"] });
  openDb(b).close();
  const r = cli(b, ["doctor"], { env: { LEDGER_REVIEW_BIN_CODEX: process.execPath, LEDGER_REVIEW_BIN_GLM: join(b.root, "no-omp") } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^ok {3}review codex: /m);
  assert.match(r.out, /^warn review glm: .*no-omp not found on PATH/m);
  b.writeConfig({ review: { mode: "off", labs: ["glm"] } });
  assert.ok(!cli(b, ["doctor"]).out.includes("review glm"));
});
