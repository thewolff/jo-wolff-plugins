import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, cli, hook, openDb } from "./helpers.mjs";
import { ask, askWord, judgeCommand, JUDGE_TIMEOUT_MS } from "../lib/ledger-judge.mjs";

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

/** A repo with a commit on main and one on branch `feat`, the user file's review settings, and a note so the note gate passes. */
function repo(review = {}) {
  const b = sandbox();
  git(b, "init", "-q", "-b", "main");
  commit(b, "a.txt", "one\n");
  git(b, "checkout", "-q", "-b", "feat");
  commit(b, "b.txt", "two\n");
  b.writeConfig({ review: { mode: "gate", ...review } });
  cli(b, ["note", "pushing the change"], { env: { LEDGER_SESSION_ID: SID } });
  return b;
}

/** An executable stub that prints `reply` (and its argv to `<path>.args`, env to `<path>.env`, cwd to `<path>.pwd`), exiting `code`. */
function stub(b, name, reply, code = 0) {
  const path = join(b.root, `stub-${name}`);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${path}.args"\nenv > "${path}.env"\npwd -P > "${path}.pwd"\ncat > /dev/null\ncat <<'EOF'\n${reply}\nEOF\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return path;
}

// The first line is verbatim from a live `kimi -p … --output-format stream-json` run (kimi 2.1.1);
// the assistant line has the shape kimi's PromptJsonWriter writes: {"role":"assistant","content":…}.
const KIMI_META = '{"role":"meta","type":"system.version","version":"2.1.1"}';
/** A kimi stub replying in stream-json: the meta line, then `reply` as one assistant message (or a tool call first). */
function kimi(b, reply, { toolCall = false } = {}) {
  const lines = [KIMI_META];
  if (toolCall) lines.push(JSON.stringify({ role: "assistant", tool_calls: [{ type: "function", id: "t1", function: { name: "Bash", arguments: '{"command":"id"}' } }] }), JSON.stringify({ role: "tool", tool_call_id: "t1", content: "uid=1" }));
  lines.push(JSON.stringify({ role: "assistant", content: reply }));
  return stub(b, "kimi", lines.join("\n"));
}

/** A folder holding a `gh` stub that prints `sha` for `gh pr view … --json headRefOid`; its argv goes to `<dir>/gh.args`. */
function ghStub(b, sha) {
  const dir = join(b.root, "ghbin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/gh.args"\n${sha ? `echo ${sha}` : "echo 'no pull requests found' >&2; exit 1"}\n`);
  chmodSync(join(dir, "gh"), 0o755);
  return { PATH: `${dir}:${b.env.PATH}` };
}

/** A judge stub: prints `answer`, appends one line per call to `<path>.calls`, saves its stdin to `<path>.prompt`. */
function judge(b, answer) {
  const path = join(b.root, `judge-${answer}`);
  writeFileSync(path, `#!/bin/sh\ncat > "${path}.prompt"\necho x >> "${path}.calls"\necho ${answer}\n`);
  chmodSync(path, 0o755);
  return path;
}
const calls = (path) => {
  try {
    return readFileSync(`${path}.calls`, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

const review = (b, args = [], env = {}) => cli(b, ["review", ...args], { env: { LEDGER_SESSION_ID: SID, ...env } });
const push = (b, command = "git push origin feat", env = {}) =>
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
  // gh pr merge: the gate asks gh for the pull request's head commit and checks that commit.
  const gh = ghStub(b, git(b, "rev-parse", "HEAD"));
  assert.equal(decision(push(b, "gh pr merge 12 --rebase", gh)), "deny", "gh pr merge is gated too");
  assert.match(readFileSync(join(b.root, "ghbin", "gh.args"), "utf8"), /^pr\nview\n12\n--json\nheadRefOid\n/);
});

test("review (c): addressed needs a reason and an earlier commit's findings; with both and the judge saying yes, the gate allows", () => {
  const b = repo();
  const bare = review(b, ["addressed"]);
  assert.equal(bare.code, 1);
  assert.match(bare.out, /^refused review addressed needs the reason/);
  assert.match(review(b, ["addressed", "fixed"]).out, /^refused no outstanding review findings on an earlier commit/);
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [blocking] c.txt:1 bug") });
  commit(b, "c.txt", "fix\n");
  const r = review(b, ["addressed", "the bug is fixed in c.txt"], { LEDGER_JUDGE_BIN: judge(b, "yes") });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^ {2}judge yes: \[blocking\] c\.txt:1 bug$/m);
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
  const env = { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS"), LEDGER_REVIEW_BIN_KIMI: kimi(b, "1. kimi saw a race") };
  review(b, [], env);
  assert.deepEqual(reviews(b).map((x) => [x.lab, x.verdict]), [["codex", "pass"], ["kimi", "findings"]]);
  const reason = push(b).json.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /kimi:\n1\. kimi saw a race/);
  assert.ok(!reason.includes("codex:"), reason);
  // kimi takes the prompt as its -p argument, with stream-json output and the tool-free agent file.
  const args = readFileSync(`${env.LEDGER_REVIEW_BIN_KIMI}.args`, "utf8");
  assert.match(args, /^-p\n/);
  assert.match(args, /--output-format\nstream-json\n/);
  assert.match(args, /--agent-file\n.*ledger-reviewer\.md\n--skills-dir\n/);
});

test("review (k): two labs, one unavailable one pass → allow, the notice names the unavailable lab", () => {
  const b = repo({ labs: ["codex", "claude"], maxRounds: 9 });
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS"), LEDGER_REVIEW_BIN_CLAUDE: stub(b, "claude", "nope", 1) });
  const p = push(b);
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /review passed for [0-9a-f]{8}; claude unavailable: /);
});

test("review (l): --labs overrides review.labs for one run", () => {
  const b = repo({ labs: ["codex", "kimi"] });
  review(b, ["--labs", "kimi"], { LEDGER_REVIEW_BIN_KIMI: kimi(b, "PASS") });
  assert.deepEqual(reviews(b).map((x) => x.lab), ["kimi"]);
});

// 0.3.1: no built-in profile. A user config with profiles: {glm: ""} is rejected by the config
// loader (a non-empty string is required), and with a built-in default that rejection silently
// ran every GLM review under --profile agent-system-2.
test("review: glm runs through omp with no --profile and zai/glm-5.3; review.profiles.glm and review.models.glm override", () => {
  const b = repo({ labs: ["glm"] });
  const bin = stub(b, "omp", "PASS");
  review(b, [], { LEDGER_REVIEW_BIN_GLM: bin });
  let args = readFileSync(`${bin}.args`, "utf8").split("\n");
  assert.equal(args[0], "-p");
  assert.ok(!args.includes("--profile"), `no --profile by default: ${args.join(" ")}`);
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "zai/glm-5.3"]);
  assert.ok(args.some((a) => /^@.*change\.diff$/.test(a)), "the diff goes in as an @file");
  assert.deepEqual(reviews(b).map((x) => [x.lab, x.verdict, x.model]), [["glm", "pass", "zai/glm-5.3"]]);
  b.writeConfig({ review: { mode: "gate", labs: ["glm"], models: { glm: "zai/glm-5.3-flash" }, profiles: { glm: "work" } } });
  review(b, [], { LEDGER_REVIEW_BIN_GLM: bin });
  args = readFileSync(`${bin}.args`, "utf8").split("\n");
  assert.deepEqual(args.slice(args.indexOf("--profile"), args.indexOf("--profile") + 2), ["--profile", "work"]);
  assert.ok(args.includes("zai/glm-5.3-flash"), args.join(" "));
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
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS"), LEDGER_REVIEW_BIN_KIMI: kimi(b, "1. x") });
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

test("severity parsing: tagged, untagged and mixed items; nits only is pass-with-nits", async () => {
  const { parseReply } = await import("../lib/review/common.mjs");
  const tagged = parseReply("1. [blocking] a.js:3 null deref\n2. **[nit]** b.js:9 name\n3. [Should] c.js:1 missing test\n   it would catch the regression");
  assert.equal(tagged.verdict, "findings");
  assert.deepEqual(tagged.items.map((i) => i.severity), ["blocking", "nit", "should"]);
  assert.equal(tagged.items[2].text, "c.js:1 missing test\nit would catch the regression");
  assert.deepEqual(parseReply("1. something off\n2. [nit] style").items.map((i) => i.severity), ["should", "nit"]);
  assert.deepEqual(parseReply("just a paragraph of worry").items, [{ severity: "should", text: "just a paragraph of worry" }]);
  assert.equal(parseReply("1. [nit] a\n2. [nit] b").verdict, "pass-with-nits");
  assert.equal(parseReply("**PASS**").verdict, "pass");
});

test("review loop: pass-with-nits allows with a notice listing the nits", () => {
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [nit] a.txt:1 trailing space") });
  assert.equal(reviews(b)[0].verdict, "pass-with-nits");
  const p = push(b);
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /review passed for [0-9a-f]{8}; nits, optional:[\s\S]*\[nit\] a\.txt:1 trailing space/);
});

test("review loop: findings → fix → pass over two shas; status shows rounds 1 and 2", () => {
  const b = repo();
  const first = review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [blocking] a.txt:1 wrong value\n2. [nit] b.txt:1 style") });
  assert.match(first.out, /round 1 of 3:/);
  assert.match(first.out, /^codex: findings: 1 blocking, 0 should, 1 nit$/m);
  assert.match(first.out, /^next: fix the blocking and should findings, commit, and run `.*review` again \(round 2 of 3\)\.$/m);
  commit(b, "a.txt", "fixed\n");
  const second = review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS"), LEDGER_JUDGE_BIN: judge(b, "yes") });
  assert.match(second.out, /round 2 of 3:/);
  assert.match(second.out, /^ {2}judge yes: \[blocking\] a\.txt:1 wrong value \(round 1\)$/m);
  assert.equal(push(b).out, "");
  const status = review(b, ["status"]).out;
  assert.match(status, /^round  sha       lab      blocking  should  nit  verdict$/m);
  assert.match(status, /^ {4}1  [0-9a-f]{8}  codex +1 +0 +1  findings$/m);
  assert.match(status, /^ {4}2  [0-9a-f]{8}  codex +0 +0 +0  pass$/m);
});

test("review loop: at review.maxRounds the next round stops and says to ask the human; --force-round continues", () => {
  const b = repo({ maxRounds: 1 });
  const bin = stub(b, "codex", "1. [should] a.txt:1 x");
  const one = review(b, [], { LEDGER_REVIEW_BIN_CODEX: bin });
  assert.match(one.out, /^round 1 of 1 reached: ask the human whether to waive \(`.*review waive "<why>"`\) or continue with `.*review --force-round`\.$/m);
  commit(b, "e.txt", "e\n");
  const stopped = review(b, [], { LEDGER_REVIEW_BIN_CODEX: bin });
  assert.equal(stopped.code, 1);
  assert.match(stopped.out, /^stopped: this would be review round 2 for this branch, and review\.maxRounds is 1\. Ask the human/);
  assert.equal(reviews(b).length, 1, "no row for the stopped round");
  assert.match(review(b, ["--force-round"], { LEDGER_REVIEW_BIN_CODEX: bin }).out, /round 2 of 1 \(forced\):/);
});

test("judge: no on an addressed claim keeps the gate closed and names the finding", () => {
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [blocking] a.txt:1 wrong value") });
  commit(b, "z.txt", "unrelated\n");
  const no = judge(b, "no");
  const r = review(b, ["addressed", "it is fine"], { LEDGER_JUDGE_BIN: no });
  assert.equal(r.code, 1);
  assert.match(r.out, /^refused the judge says these findings on [0-9a-f]{8} are not resolved by [0-9a-f]{8}; the gate stays closed:\ncodex: \[blocking\] a\.txt:1 wrong value\n$/);
  assert.match(readFileSync(`${no}.prompt`, "utf8"), /Does this change resolve the finding\? Answer yes or no\./);
  const p = push(b);
  assert.equal(decision(p), "deny");
  assert.match(p.json.hookSpecificOutput.permissionDecisionReason, /a\.txt:1 wrong value/);
  const db = openDb(b);
  const items = JSON.parse(db.prepare("SELECT findings_json FROM cc_reviews ORDER BY id DESC LIMIT 1").get().findings_json);
  db.close();
  assert.deepEqual(items, [{ severity: "blocking", text: "a.txt:1 wrong value", resolved: false, judge: "no" }]);
});

test("judge: no on a finding a later round dropped keeps it open in that round", () => {
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [should] a.txt:1 missing check") });
  commit(b, "a.txt", "still wrong\n");
  const r = review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS"), LEDGER_JUDGE_BIN: judge(b, "no") });
  assert.match(r.out, /^codex: findings: 0 blocking, 1 should, 0 nit$/m);
  assert.match(r.out, /\[should\] a\.txt:1 missing check \(from round 1; the judge says it is not resolved\)/);
  assert.equal(decision(push(b)), "deny");
});

test("judge: missing → unverified, counted as resolved, and the gate allows with a notice saying so", () => {
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [blocking] a.txt:1 wrong value") });
  commit(b, "a.txt", "fixed\n");
  const r = review(b, ["addressed", "fixed it"], { LEDGER_JUDGE_BIN: join(b.root, "no-such-judge") });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^ {2}judge unverified: \[blocking\] a\.txt:1 wrong value$/m);
  const p = push(b);
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /review addressed for [0-9a-f]{8}; 1 finding\(s\) counted as resolved but unverified by the judge: \[blocking\] a\.txt:1 wrong value/);
});

test("judge: a cached answer does not run the judge again", async () => {
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [blocking] a.txt:1 wrong value") });
  commit(b, "a.txt", "fixed\n");
  const yes = judge(b, "yes");
  assert.equal(review(b, ["addressed", "fixed"], { LEDGER_JUDGE_BIN: yes }).code, 0);
  assert.equal(calls(yes), 1);
  const again = review(b, ["addressed", "fixed, again"], { LEDGER_JUDGE_BIN: yes });
  assert.match(again.out, /^refused no outstanding review findings/, "the first claim already covers those findings");
  assert.equal(calls(yes), 1);
  const db = openDb(b);
  const env = { ...b.env, LEDGER_JUDGE_BIN: yes };
  const first = await ask({ db, config: {}, env, passage: "Finding:\nx\n\nChange (unified diff):\ny" });
  const second = await ask({ db, config: {}, env, passage: "Finding:\nx\n\nChange (unified diff):\ny" });
  assert.deepEqual([first.cached, second.cached, second.verdict], [false, true, "yes"]);
  assert.equal(calls(yes), 2, "the second ask is answered from cc_judge_cache");
  // 0.3.3: the cache keeps the passage and the question, not just the word.
  const rows = db.prepare("SELECT key, question, passage, answer, at FROM cc_judge_cache ORDER BY at").all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.answer === "yes" && r.question && r.passage && r.at), JSON.stringify(rows));
  assert.ok(rows.some((r) => r.passage === "Finding:\nx\n\nChange (unified diff):\ny"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM cc_meta WHERE key LIKE 'judge:%'").get().n, 0);
  db.close();
});

test("judge: doctor warns when no judge is configured, and names the i-have-audhd fallback when it is used", () => {
  const b = repo();
  openDb(b).close();
  const r = cli(b, ["doctor"], { env: { LEDGER_REVIEW_BIN_CODEX: process.execPath } });
  assert.match(r.out, /^warn judge: .*addressed claims unverified$/m);
  const profile = join(b.root, "audhd-profile.json");
  writeFileSync(profile, JSON.stringify({ enforcement: { judgeCommand: "echo yes" } }));
  const fallback = cli(b, ["doctor"], { env: { LEDGER_REVIEW_BIN_CODEX: process.execPath, I_HAVE_AUDHD_PROFILE: profile } });
  assert.match(fallback.out, /^ok {3}judge: from enforcement\.judgeCommand in .*audhd-profile\.json \(legacy\)$/m);
});

// 0.3.7: lib/judge.mjs is plugin-kit's shared copy. Ledger's own settings still come first, then
// the shared file, then the i-have-audhd profile.
test("judge: LEDGER_JUDGE_BIN, then review.judgeCommand, then the shared judge file, then the i-have-audhd profile", () => {
  const b = sandbox();
  const profile = join(b.root, "audhd-profile.json");
  writeFileSync(profile, JSON.stringify({ enforcement: { judgeCommand: "legacy-judge" } }));
  const env = { ...b.env, I_HAVE_AUDHD_PROFILE: profile };
  assert.deepEqual(judgeCommand({}, env), { command: "legacy-judge", timeoutMs: JUDGE_TIMEOUT_MS, source: `enforcement.judgeCommand in ${profile} (legacy)`, malformed: null });
  const shared = join(b.env.XDG_CONFIG_HOME, "judge", "config.json");
  mkdirSync(join(b.env.XDG_CONFIG_HOME, "judge"), { recursive: true });
  writeFileSync(shared, JSON.stringify({ command: "shared-judge" }));
  assert.deepEqual(judgeCommand({}, env), { command: "shared-judge", timeoutMs: JUDGE_TIMEOUT_MS, source: shared, malformed: null });
  writeFileSync(shared, JSON.stringify({ command: "shared-judge", timeoutMs: 90000 }));
  assert.equal(judgeCommand({}, env).timeoutMs, 90000, "a shared timeoutMs longer than ledger's 60 s is honoured");
  writeFileSync(shared, JSON.stringify({ command: "shared-judge", timeoutMs: 30000 }));
  assert.equal(judgeCommand({}, env).timeoutMs, JUDGE_TIMEOUT_MS, "ledger's diff judge never runs shorter than 60 s");
  writeFileSync(shared, JSON.stringify({ command: "shared-judge", timeoutMs: 0.5 }));
  assert.equal(judgeCommand({}, env).timeoutMs, JUDGE_TIMEOUT_MS, "a fractional timeoutMs under 1 is no timeout");
  const own = judgeCommand({ review: { judgeCommand: "own-judge" } }, env);
  assert.deepEqual([own.command, own.source], ["own-judge", "review.judgeCommand"]);
  const bin = judgeCommand({ review: { judgeCommand: "own-judge" } }, { ...env, LEDGER_JUDGE_BIN: "env-judge" });
  assert.deepEqual([bin.command, bin.source], ["env-judge", "env LEDGER_JUDGE_BIN"]);
  writeFileSync(shared, "{ not json");
  const broken = judgeCommand({}, env);
  assert.equal(broken.command, null, "a malformed shared file does not fall through to the legacy profile");
  assert.match(broken.malformed, /judge\/config\.json/);
  assert.equal(judgeCommand({ review: { judgeCommand: "own-judge" } }, env).command, "own-judge", "ledger's own setting still wins");
});

// Codex review round 1 of 0.3.7: one regression per finding fixed.

test("0.3.7 S1: the shared timeoutMs reaches dispatch, floored at 60 s, for ask and askWord", async () => {
  const b = sandbox();
  const dir = join(b.env.XDG_CONFIG_HOME, "judge");
  mkdirSync(dir, { recursive: true });
  const seen = [];
  const run = async (_prompt, { command, timeoutMs }) => {
    seen.push([command, timeoutMs]);
    return { ok: true, stdout: "yes\n", stderr: "" };
  };
  const db = openDb(b);
  for (const [timeoutMs, expected] of [[30000, 60000], [90000, 90000]]) {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ command: "shared-judge", timeoutMs }));
    const r = await ask({ db, config: {}, env: b.env, passage: `Finding:\nt${timeoutMs}`, run });
    assert.equal(r.verdict, "yes");
    const w = await askWord({ config: {}, env: b.env, passage: "p", question: "q", words: ["fine"], run: async (p, o) => (await run(p, o), { ok: true, stdout: "fine\n", stderr: "" }) });
    assert.equal(w.answer, "fine");
    assert.deepEqual(seen.splice(0), [["shared-judge", expected], ["shared-judge", expected]], `shared timeoutMs ${timeoutMs}`);
  }
  db.close();
});

test("0.3.7 S2: a judge printing a claude -p --output-format json envelope is read through it", async () => {
  const b = sandbox();
  const envelope = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "yes" });
  const db = openDb(b);
  const env = { ...b.env, LEDGER_JUDGE_BIN: `cat > /dev/null; printf '%s\\n' '${envelope}'` };
  assert.deepEqual(await ask({ db, config: {}, env, passage: "Finding:\nenvelope" }), { verdict: "yes", cached: false, error: null });
  const bold = { ...b.env, LEDGER_JUDGE_BIN: `cat > /dev/null; printf '%s\\n' '${JSON.stringify({ type: "result", result: "**biting**" })}'` };
  assert.deepEqual(await askWord({ config: {}, env: bold, passage: "p", question: "q", words: ["biting", "silent", "fine"] }), { answer: "biting", error: null });
  db.close();
});

test("0.3.7 S3: a malformed shared judge file is named by doctor and by ask's error", async () => {
  const b = repo();
  openDb(b).close();
  mkdirSync(join(b.env.XDG_CONFIG_HOME, "judge"), { recursive: true });
  writeFileSync(join(b.env.XDG_CONFIG_HOME, "judge", "config.json"), "{ nope");
  const r = cli(b, ["doctor"], { env: { LEDGER_REVIEW_BIN_CODEX: process.execPath } });
  assert.match(r.out, /^warn judge: malformed shared judge file .*judge\/config\.json: .*addressed claims unverified$/m);
  const db = openDb(b);
  const a = await ask({ db, config: {}, env: b.env, passage: "Finding:\nmalformed" });
  assert.equal(a.verdict, "unverified");
  assert.match(a.error, /^no judge configured \(malformed .*judge\/config\.json: /);
  db.close();
  const w = await askWord({ config: {}, env: b.env, passage: "p", question: "q", words: ["fine"] });
  assert.deepEqual([w.answer, /^no judge configured \(malformed /.test(w.error)], [null, true]);
});

// Codex review round 1 of 0.3.0: one regression per finding fixed.

test("B1: a review deny becomes an allow with a notice while the store cannot take a write", () => {
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [blocking] a.txt:1 bug") });
  assert.equal(decision(push(b)), "deny");
  const db = openDb(b);
  db.exec("BEGIN IMMEDIATE");
  const p = push(b);
  db.exec("ROLLBACK");
  db.close();
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /ledger/);
  assert.deepEqual(reviewBounces(b), [null], "only the first, writable deny left a row");
});

test("B2: the gate checks the commit the command publishes: another repository, a refspec source, a PR head", () => {
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS") });
  assert.equal(push(b).out, "", "HEAD is reviewed");
  // Another repository through git -C (quoted, with a space): its HEAD has no review.
  const other = join(b.sibling, "my repo");
  mkdirSync(other);
  const g = (...args) => assert.equal(spawnSync("git", args, { cwd: other, env: { ...b.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).status, 0);
  g("init", "-q");
  writeFileSync(join(other, "x.txt"), "x\n");
  g("add", "x.txt");
  g("commit", "-qm", "x");
  assert.equal(decision(push(b, `git -C "${other}" push origin HEAD`)), "deny");
  // A refspec whose source is an unreviewed branch.
  git(b, "checkout", "-q", "-b", "other");
  commit(b, "o.txt", "o\n");
  git(b, "checkout", "-q", "feat");
  assert.equal(decision(push(b, "git push origin other:main")), "deny");
  assert.equal(push(b, "git push origin +HEAD:main").out, "");
  assert.equal(push(b, "git push origin --delete old").out, "", "a deletion publishes no commit");
  // A command that does not say which commit: allowed, with a notice saying so.
  let p = push(b, "git push --all origin");
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /could not tell which commit this command publishes \(git push --all publishes more than one ref\)/);
  // gh pr merge: --match-head-commit names the commit outright (gh is not asked); gh failing → notice.
  const head = git(b, "rev-parse", "HEAD");
  const gh = ghStub(b, null);
  assert.equal(push(b, `gh pr merge 5 --rebase --match-head-commit ${head}`, gh).out, "");
  p = push(b, "gh pr merge 5 --rebase", gh);
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /gh pr view did not name the pull request's head commit \(no pull requests found\)/);
});

test("B3 and round base: rows record the base and the branch as resolved shas; a branch with no main keeps its first base", () => {
  const b = sandbox();
  git(b, "init", "-q", "-b", "work");
  commit(b, "a.txt", "one\n");
  commit(b, "b.txt", "two\n");
  b.writeConfig({ review: { mode: "gate" } });
  const bin = stub(b, "codex", "1. [should] b.txt:1 nit-picky");
  assert.match(review(b, [], { LEDGER_REVIEW_BIN_CODEX: bin }).out, /round 1 of 3:/);
  commit(b, "c.txt", "three\n");
  assert.match(review(b, [], { LEDGER_REVIEW_BIN_CODEX: bin, LEDGER_JUDGE_BIN: judge(b, "yes") }).out, /round 2 of 3:/, "not round 1 again: the base is the first review's");
  const db = openDb(b);
  try {
    const rows = db.prepare("SELECT base_ref, branch FROM cc_reviews ORDER BY id").all();
    assert.equal(new Set(rows.map((r) => r.base_ref)).size, 1);
    assert.match(rows[0].base_ref, /^[0-9a-f]{40}$/);
    assert.deepEqual([...new Set(rows.map((r) => r.branch))], ["work"]);
  } finally {
    db.close();
  }
});

test("B4: reviewers run tool-free, in an empty scratch folder, with an allowlisted environment", () => {
  const b = repo({ labs: ["claude"] });
  const bin = stub(b, "claude", "PASS");
  review(b, [], { LEDGER_REVIEW_BIN_CLAUDE: bin, ANTHROPIC_API_KEY: "k-anthropic", SECRET_TOKEN: "do-not-pass", GH_TOKEN: "gh-secret" });
  const args = readFileSync(`${bin}.args`, "utf8").split("\n");
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.ok(args.includes("--strict-mcp-config") && args.includes("--disable-slash-commands"), args.join(" "));
  const env = readFileSync(`${bin}.env`, "utf8");
  assert.match(env, /^ANTHROPIC_API_KEY=k-anthropic$/m);
  assert.match(env, /^LEDGER_ENABLED=0$/m);
  assert.ok(!/SECRET_TOKEN|GH_TOKEN|LEDGER_DB/.test(env), env);
  const pwd = readFileSync(`${bin}.pwd`, "utf8").trim();
  assert.ok(!pwd.startsWith(b.work), `the reviewer ran in ${pwd}, inside the repository`);
  assert.match(pwd, /ledger-review-/);
});

test("B5: kimi's stream-json reply is read from its final assistant message; a tool call makes the review unavailable", () => {
  const b = repo({ labs: ["kimi"] });
  review(b, [], { LEDGER_REVIEW_BIN_KIMI: kimi(b, "PASS") });
  review(b, ["--force-round"], { LEDGER_REVIEW_BIN_KIMI: kimi(b, "PASS", { toolCall: true }) });
  assert.deepEqual(reviews(b).map((x) => [x.lab, x.verdict]), [["kimi", "pass"], ["kimi", "unavailable"]]);
  assert.match(reviews(b)[1].reason, /kimi tried to call a tool/);
});

test("S3: a review timeout kills the CLI's whole process group", async () => {
  const { runProcess } = await import("../lib/review/common.mjs");
  const b = sandbox();
  const pidFile = join(b.root, "child.pid");
  await assert.rejects(runProcess("/bin/sh", ["-c", `sleep 30 & echo $! > "${pidFile}"; wait`], { cwd: b.root, timeoutMs: 300, env: b.env }), /timed out/);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  await new Promise((r) => setTimeout(r, 100));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the grandchild sleep outlived the timeout");
});

test("note (i): only a deny writes a reviewGate bounce; an allow with a notice writes none and satisfies an open one", () => {
  const b = repo({ mode: "advise" });
  const p = push(b);
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /no cross-lab review/);
  assert.deepEqual(reviewBounces(b), []);
  b.writeConfig({ review: { mode: "gate" } });
  assert.equal(decision(push(b)), "deny");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [nit] a.txt:1 spacing") });
  assert.match(push(b).json.systemMessage, /nits, optional/);
  assert.deepEqual(reviewBounces(b), ["satisfied"]);
});

test("S1: the push matcher reads shell quoting, comments and here-documents", async () => {
  const { isPushCommand, pushOperations } = await import("../lib/gate.mjs");
  const merge = ["create", "merge"];
  assert.equal(isPushCommand('echo "git push origin main"', merge), false, "a quoted string is an argument, not a push");
  assert.equal(isPushCommand("git commit -m 'then git push' && ls", merge), false);
  assert.equal(isPushCommand("ls # git push later", merge), false, "a comment is not a command");
  assert.equal(isPushCommand("cat <<EOF\ngit push origin main\nEOF\nls", merge), false, "a here-document body is not a command");
  assert.equal(isPushCommand("cat <<'EOF' > notes.md\ngh pr merge 3\nEOF", merge), false);
  assert.equal(isPushCommand("cd x && GIT_TRACE=1 git push", merge), true);
  assert.equal(isPushCommand("cat <<EOF\nbody\nEOF\ngit push", merge), true, "a push after the here-document still counts");
  assert.deepEqual(pushOperations('git -C "my repo" -c user.name=x push origin "feat:main"', merge), [{ tool: "git", cds: [], dirs: ["my repo"], unsupported: null, after: null, args: ["origin", "feat:main"] }]);
  assert.deepEqual(pushOperations('gh pr create --title "git push fix" --head feat', merge), [{ tool: "gh", sub: "create", cds: [], unsupported: null, after: null, args: ["--title", "git push fix", "--head", "feat"] }]);
});

test("live run finding 5: a push with no note and no review is denied once, naming both, and writes both bounce rows", () => {
  const b = sandbox();
  git(b, "init", "-q", "-b", "main");
  commit(b, "a.txt", "one\n");
  git(b, "checkout", "-q", "-b", "feat");
  commit(b, "b.txt", "two\n");
  b.writeConfig({ review: { mode: "gate" } });
  const p = push(b);
  assert.equal(decision(p), "deny");
  const reason = p.json.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /^ledger: this push needs two things first, and both are missing:\n1\. record what this push is before pushing: .*\n2\. .*review/s);
  const db = openDb(b);
  try {
    assert.deepEqual(db.prepare("SELECT rule FROM cc_bounces ORDER BY id").all().map((r) => r.rule), ["pushNeedsNote", "reviewGate"]);
  } finally {
    db.close();
  }
  // With the note recorded, the deny is the review gate's alone, unchanged in form.
  cli(b, ["note", "pushing the change"], { env: { LEDGER_SESSION_ID: SID } });
  assert.doesNotMatch(push(b).json.hookSpecificOutput.permissionDecisionReason, /two things/);
});

// Codex review round 2 of 0.3.0: one regression per finding fixed.

test("R2-B1: a matching push, a configured push refspec and push.default matching are not taken for HEAD", () => {
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS") });
  assert.equal(push(b, "git push origin").out, "", "push.default simple publishes HEAD, which is reviewed");
  for (const cmd of ["git push origin :", "git push origin +:"]) {
    const p = push(b, cmd);
    assert.equal(decision(p), "allow");
    assert.match(p.json.systemMessage, /could not tell which commit this command publishes \(refspec \+?: pushes every matching branch\)/);
  }
  git(b, "config", "remote.origin.push", "refs/heads/other:refs/heads/main");
  assert.match(push(b, "git push origin").json.systemMessage, /remote\.origin\.push is configured/);
  git(b, "config", "--unset", "remote.origin.push");
  git(b, "config", "push.default", "matching");
  assert.match(push(b, "git push").json.systemMessage, /push\.default is matching/);
  git(b, "config", "push.default", "nothing");
  assert.equal(push(b, "git push").out, "", "push.default nothing publishes nothing");
});

test("R2-B2 and R3-B4: gh pr create --head checks the branch on the remote as it is now, never a tracking ref; an unbound merge names the commit checked", () => {
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS") });
  const reviewed = git(b, "rev-parse", "HEAD");
  git(b, "checkout", "-q", "-b", "elsewhere");
  const unreviewed = commit(b, "r.txt", "remote\n");
  git(b, "checkout", "-q", "feat");
  const remote = join(b.sibling, "remote.git");
  assert.equal(spawnSync("git", ["init", "-q", "--bare", remote]).status, 0);
  git(b, "remote", "add", "origin", remote);
  git(b, "push", "-q", "origin", "elsewhere:feat");
  // The tracking ref says the reviewed commit; the remote has moved on to an unreviewed one.
  git(b, "update-ref", "refs/remotes/origin/feat", reviewed);
  assert.equal(decision(push(b, "gh pr create --head feat --title t")), "deny", "the remote's feat is the pull request's head, and it is unreviewed");
  git(b, "push", "-qf", "origin", "feat:feat");
  git(b, "update-ref", "refs/remotes/origin/feat", unreviewed);
  assert.equal(push(b, "gh pr create --head feat --title t").out, "", "the remote's feat is reviewed, whatever the tracking ref says");
  assert.match(push(b, "gh pr create --head someone:feat --title t").json.systemMessage, /names another owner's branch/);
  assert.match(push(b, "gh pr create --head nowhere --title t").json.systemMessage, /origin has no refs\/heads\/nowhere; a local remote-tracking ref may be stale, so it was not used/);
  git(b, "remote", "set-url", "origin", join(b.sibling, "gone.git"));
  const gone = push(b, "gh pr create --head feat --title t");
  assert.equal(decision(gone), "allow");
  assert.match(gone.json.systemMessage, /git ls-remote origin could not read it \(exit \d+\); a local remote-tracking ref may be stale/);
  const p = push(b, "gh pr merge 7 --rebase", ghStub(b, reviewed));
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, new RegExp(`checked ${reviewed.slice(0, 8)}, the pull request's head as gh reports it now.*--match-head-commit ${reviewed}`));
});

test("R2-B3: a same-commit retry, a downgrade to nit and a skipped or unavailable lab do not clear a finding without the judge", () => {
  const b = repo({ labs: ["codex", "claude"], maxRounds: 9 });
  const find = "1. [blocking] a.txt:1 wrong value";
  review(b, ["--labs", "codex"], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", find) });
  const no = judge(b, "no");
  // The same commit again, now passing: the judge is asked, says no, and the finding stays.
  let r = review(b, ["--labs", "codex"], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS"), LEDGER_JUDGE_BIN: no });
  assert.match(r.out, /^ {2}judge no: \[blocking\] a\.txt:1 wrong value \(round 1\)$/m);
  assert.equal(decision(push(b)), "deny");
  // Listed again only as a nit on a new commit: still a removal, so judged.
  commit(b, "z.txt", "unrelated\n");
  r = review(b, ["--labs", "codex"], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [nit] a.txt:1 wrong value"), LEDGER_JUDGE_BIN: no });
  assert.match(r.out, /^codex: findings/m);
  assert.equal(decision(push(b)), "deny");
  // codex not run this time: its findings are carried onto the new commit.
  commit(b, "y.txt", "unrelated\n");
  r = review(b, ["--labs", "claude"], { LEDGER_REVIEW_BIN_CLAUDE: stub(b, "claude", "PASS") });
  assert.match(r.out, /^codex: findings: 1 blocking, 0 should, 0 nit · not run this time; its findings from round \d stay open$/m);
  assert.equal(decision(push(b)), "deny");
  // codex unavailable: the same.
  commit(b, "x.txt", "unrelated\n");
  r = review(b, ["--labs", "codex"], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "boom", 1) });
  assert.match(r.out, /^codex: findings: 1 blocking, 0 should, 0 nit · unavailable \(.*\); its findings from round \d stay open$/m);
  assert.equal(decision(push(b)), "deny");
});

test("R2-B4 and R2-S2: a finding a later review passed is not outstanding; addressed is refused while HEAD has findings", () => {
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [blocking] a.txt:1 wrong value") });
  const yes = judge(b, "yes");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS"), LEDGER_JUDGE_BIN: yes });
  assert.equal(calls(yes), 1);
  commit(b, "z.txt", "unrelated\n");
  const no = judge(b, "no");
  const r = review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS"), LEDGER_JUDGE_BIN: no });
  assert.match(r.out, /^codex: pass$/m, "the earlier pass superseded the old findings");
  assert.equal(calls(no), 0);
  assert.match(review(b, ["addressed", "old issue"], { LEDGER_JUDGE_BIN: no }).out, /^refused no outstanding review findings/);
  commit(b, "y.txt", "unrelated\n");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [blocking] y.txt:1 new bug") });
  const a = review(b, ["addressed", "fixed old issue"], { LEDGER_JUDGE_BIN: yes });
  assert.equal(a.code, 1);
  assert.match(a.out, /^refused [0-9a-f]{8} has review findings of its own/);
  assert.equal(decision(push(b)), "deny");
});

test("R2-S1: pushes inside command substitutions count; cd and -C directories are followed", async () => {
  const { pushOperations } = await import("../lib/gate.mjs");
  const merge = ["create", "merge"];
  assert.equal(pushOperations('echo "$(git push origin HEAD)"', merge).length, 1, "a substitution inside double quotes runs");
  assert.equal(pushOperations("x=`git push origin HEAD`", merge).length, 1);
  assert.equal(pushOperations("cat <<EOF\n$(git push origin HEAD)\nEOF", merge).length, 1, "an unquoted here-document expands substitutions");
  assert.equal(pushOperations("cat <<'EOF'\n$(git push origin HEAD)\nEOF", merge).length, 0, "a quoted one does not");
  assert.equal(pushOperations("echo '$(git push origin HEAD)'", merge).length, 0);
  const [op] = pushOperations("cd /other && git -C nested push origin HEAD", merge);
  assert.deepEqual([op.cds, op.dirs, op.unsupported], [["/other"], ["nested"], null]);
  assert.ok(pushOperations("cd $REPO && git push", merge)[0].unsupported, "a computed directory is not resolved");
  // End to end: a cd into another repository checks that repository's HEAD.
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS") });
  const other = join(b.sibling, "other repo");
  mkdirSync(other);
  const g = (...args) => assert.equal(spawnSync("git", args, { cwd: other, env: { ...b.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).status, 0);
  g("init", "-q");
  writeFileSync(join(other, "x.txt"), "x\n");
  g("add", "x.txt");
  g("commit", "-qm", "x");
  assert.equal(decision(push(b, `cd "${other}" && git push origin HEAD`)), "deny");
  assert.equal(push(b, `git -C "${other}" status && git push origin HEAD`).out, "", "git -C does not change the shell's folder");
});

test("R2-S3: a branch reviewed from its root commit keeps counting from the root", () => {
  const b = sandbox();
  git(b, "init", "-q", "-b", "work");
  commit(b, "a.txt", "one\n");
  b.writeConfig({ review: { mode: "gate" } });
  const bin = stub(b, "codex", "PASS");
  assert.match(review(b, [], { LEDGER_REVIEW_BIN_CODEX: bin }).out, /\(root\.\.[0-9a-f]{8}\) .*round 1 of 3:/);
  commit(b, "b.txt", "two\n");
  assert.match(review(b, [], { LEDGER_REVIEW_BIN_CODEX: bin }).out, /\(root\.\.[0-9a-f]{8}\) .*round 2 of 3:/);
});

test("R2-S5: the judge passage is capped whole, marks the cut, and names the whole input's digest", async () => {
  const { passageFor, PASSAGE_CAP_BYTES } = await import("../lib/ledger-judge.mjs");
  const long = "x".repeat(9000);
  const fixed = passageFor(long, `${"d".repeat(9000)}\n+FIXED`);
  const broken = passageFor(long, `${"d".repeat(9000)}\n+BROKEN`);
  assert.ok(Buffer.byteLength(fixed) <= PASSAGE_CAP_BYTES, `${Buffer.byteLength(fixed)} bytes`);
  assert.match(fixed, /\[cut: the finding and change are \d+ bytes; .* sha256 of the whole: [0-9a-f]{64}\]$/);
  assert.notEqual(fixed, broken, "inputs that differ only past the cut are told apart");
  assert.equal(passageFor("short", "diff"), "Finding:\nshort\n\nChange (unified diff):\ndiff");
});

// Codex review round 3 of 0.3.0: one regression per finding fixed.

test("R3-B1: --base changes only the diff the labs read; it cannot drop a finding without the judge", () => {
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [blocking] b.txt:1 wrong value") });
  const no = judge(b, "no");
  let r = review(b, ["--base", "HEAD"], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS"), LEDGER_JUDGE_BIN: no });
  assert.match(r.out, /^ {2}judge no: \[blocking\] b\.txt:1 wrong value \(round 1\)$/m, "an empty diff is not a pass over an open finding");
  assert.equal(decision(push(b)), "deny");
  commit(b, "z.txt", "unrelated\n");
  r = review(b, ["--base", "HEAD~1"], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS"), LEDGER_JUDGE_BIN: no });
  assert.match(r.out, /round 2 of 3:/, "rounds count from the branch's base, not --base");
  assert.match(r.out, /^ {2}judge no: \[blocking\] b\.txt:1 wrong value \(round 1\)$/m, "a base moved past the finding's commit still reconciles it");
  assert.equal(decision(push(b)), "deny");
  const db = openDb(b);
  try {
    assert.equal(new Set(db.prepare("SELECT base_ref FROM cc_reviews WHERE lab = 'codex'").all().map((x) => x.base_ref)).size, 1, "every row records the branch's base");
  } finally {
    db.close();
  }
});

test("R3-B2: a later review of an ancestor does not clear a descendant's finding", () => {
  const b = repo();
  commit(b, "c.txt", "bug\n");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "1. [blocking] c.txt:1 bug") });
  git(b, "checkout", "-q", "HEAD~1");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS") });
  git(b, "checkout", "-q", "feat");
  const r = review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS"), LEDGER_JUDGE_BIN: judge(b, "no") });
  assert.match(r.out, /^ {2}judge no: \[blocking\] c\.txt:1 bug \(round 1\)$/m);
  assert.equal(decision(push(b)), "deny");
});

test("R3-B3: command-local git config or environment that steers a push is not followed: gate denies it, advise says so", async () => {
  const { pushOperations } = await import("../lib/gate.mjs");
  for (const cmd of [
    "git -c push.default=matching push origin",
    "git -c remote.origin.push=other:main push origin",
    "git -c branch.feat.pushRemote=fork push",
    "git --config-env=push.default=PD push",
    "git --config-env push.default=PD push",
    "GIT_CONFIG_PARAMETERS=\"'push.default'='matching'\" git push origin",
    "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.default GIT_CONFIG_VALUE_0=matching; git push origin",
    "env GIT_DIR=/x git push",
  ]) {
    assert.ok(pushOperations(cmd)[0].unsupported, cmd);
  }
  assert.equal(pushOperations("git -c user.name=x push origin HEAD")[0].unsupported, null, "config that does not steer a push is fine");
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS") });
  let p = push(b, "git -c push.default=matching push origin");
  assert.equal(decision(p), "deny");
  assert.match(p.json.hookSpecificOutput.permissionDecisionReason, /cannot follow where this `git push` runs \(-c push\.default\)/);
  b.writeConfig({ review: { mode: "advise" } });
  p = push(b, "git -c push.default=matching push origin");
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /could not tell which commit this command publishes \(-c push\.default is not followed\)/);
});

/** A second repository in a folder whose name has hyphens, with one commit; returns its path. */
function hyphenRepo(b) {
  const dir = join(b.sibling, "story-charts-step1");
  mkdirSync(dir);
  const env = { ...b.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  writeFileSync(join(dir, "a.txt"), "one\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "a.txt"], ["commit", "-q", "-m", "one"]]) assert.equal(spawnSync("git", args, { cwd: dir, env }).status, 0);
  return dir;
}

test("0.3.11 hole one: under gate a push from a folder the gate cannot follow is denied, with the literal form as the way out", () => {
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS") });
  assert.equal(push(b).out, "", "HEAD is reviewed, so only the folder is in question");
  for (const [cmd, why] of [
    [`W=${b.work}; cd $W; git push origin feat; gh pr create --fill`, "cd $W"],
    [`W=${b.work}; cd "$W" && git push`, "cd $W"],
    ["cd $(git rev-parse --show-toplevel) && git push origin feat", "cd $(git rev-parse --show-toplevel)"],
    ["cd `pwd` && git push origin feat", "cd `pwd`"],
    ["cd ~/code/repo && git push origin feat", "cd ~/code/repo"],
    ["cd ../wor* && git push origin feat", "cd ../wor*"],
    ["cd - && git push origin feat", "cd -"],
    ["cd && git push origin feat", "cd (home)"],
    ["git -C $REPO push origin feat", "-C $REPO"],
    [`git --git-dir ${b.work}/.git push origin feat`, "--git-dir"],
    [`cd $W && gh pr create --fill`, "cd $W"],
  ]) {
    const p = push(b, cmd);
    assert.equal(decision(p), "deny", cmd);
    const reason = p.json.hookSpecificOutput.permissionDecisionReason;
    assert.ok(reason.includes(`(${why})`), `${cmd}: ${reason}`);
    assert.match(reason, /Re-issue it as its own command with a literal folder: `cd \/absolute\/path && git push <remote> <branch>`/, cmd);
  }
  assert.ok(reviewBounces(b).length >= 11, "each deny left a reviewGate bounce row");
  assert.equal(push(b, `cd ${b.work} && git push origin feat`).out, "", "the literal form the reason names passes");
  assert.equal(reviewBounces(b).at(-1), "satisfied");
});

test("0.3.11 hole one: advise keeps the notice, off says nothing, and a locked store turns the deny into an allow", () => {
  const b = repo({ mode: "advise" });
  let p = push(b, "cd $W && git push origin feat");
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /could not tell which commit this command publishes \(cd \$W is not followed\); allowed without a review check/);
  b.writeConfig({ review: { mode: "off" } });
  assert.equal(push(b, "cd $W && git push origin feat").out, "");
  b.writeConfig({ review: { mode: "gate" } });
  const db = openDb(b);
  db.exec("BEGIN IMMEDIATE");
  p = push(b, "cd $W && git push origin feat");
  db.exec("ROLLBACK");
  db.close();
  assert.equal(decision(p), "allow", "a deny is only given while the store can record it");
});

test("0.3.11: a literal absolute cd with hyphens resolves: reviewed HEAD allows, unreviewed denies for the review, waived allows", async () => {
  const { pushOperations } = await import("../lib/gate.mjs");
  const [op] = pushOperations("cd /Users/x/agent-scratch/kitchen/story-charts-step1-plumbing && git push -u origin feat-a-b");
  assert.deepEqual([op.cds, op.unsupported, op.after], [["/Users/x/agent-scratch/kitchen/story-charts-step1-plumbing"], null, null]);
  assert.equal(pushOperations("git -C /a/story-charts-step1 push")[0].unsupported, null);
  const b = repo();
  const dir = hyphenRepo(b);
  const cmd = `cd ${dir} && git push origin HEAD`;
  let p = push(b, cmd);
  assert.equal(decision(p), "deny", "unreviewed HEAD");
  assert.match(p.json.hookSpecificOutput.permissionDecisionReason, /no cross-lab review for/);
  assert.doesNotMatch(p.json.hookSpecificOutput.permissionDecisionReason, /cannot follow/);
  const reviewed = cli(b, ["review"], { cwd: dir, env: { LEDGER_SESSION_ID: SID, LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS") } });
  assert.match(reviewed.out, /^codex: pass$/m, reviewed.out + reviewed.err);
  assert.equal(push(b, cmd).out, "", "reviewed HEAD");
  assert.equal(push(b, `git -C ${dir} push origin HEAD`).out, "");
  const env = { ...b.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  assert.equal(spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "two"], { cwd: dir, env }).status, 0);
  assert.equal(decision(push(b, cmd)), "deny", "a new HEAD has no review");
  assert.equal(cli(b, ["review", "waive", "prototype, Jo said push it"], { cwd: dir, env: { LEDGER_SESSION_ID: SID } }).code, 0);
  assert.equal(push(b, cmd).out, "", "waived HEAD");
});

test("0.3.11 hole two: under gate a push chained after a HEAD-moving command is denied, even on a reviewed HEAD", async () => {
  const { pushOperations } = await import("../lib/gate.mjs");
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS") });
  for (const [cmd, mover] of [
    [`cd ${b.work} && git rebase origin/main && git push origin feat`, "git rebase"],
    ['git add -A && git commit -m "fix" && git push origin feat', "git commit"],
    ["git commit -am fix; git push", "git commit"],
    [`git -C ${b.work} commit -am fix && git -C ${b.work} push origin feat`, "git commit"],
    ["git merge main && git push origin feat", "git merge"],
    ["git cherry-pick abc123 && git push origin feat", "git cherry-pick"],
    ["git revert HEAD --no-edit && git push origin feat", "git revert"],
    ["git reset --hard origin/feat && git push origin feat", "git reset"],
    ["git pull --rebase && git push origin feat", "git pull"],
    ["git checkout other && git push origin HEAD", "git checkout"],
    ["git switch other && git push origin HEAD", "git switch"],
    ["git am fix.patch && git push origin feat", "git am"],
    ["(git commit -m x) && git push origin feat", "git commit"],
    ["gh pr checkout 5 && git push", "gh pr checkout"],
  ]) {
    assert.equal(pushOperations(cmd)[0].after, mover, cmd);
    const p = push(b, cmd);
    assert.equal(decision(p), "deny", cmd);
    const reason = p.json.hookSpecificOutput.permissionDecisionReason;
    assert.ok(reason.includes(`\`${mover}\` runs before this \`git push\` on the same command line and can move HEAD`), `${cmd}: ${reason}`);
    assert.match(reason, /review the new HEAD \(`.*review`\), then run `git push` as its own command/, cmd);
  }
  let p = push(b, 'git commit -m "x" && gh pr create --fill');
  assert.equal(decision(p), "deny", "gh pr create pushes the current branch");
  assert.match(p.json.hookSpecificOutput.permissionDecisionReason, /`git commit` runs before this `gh pr create`/);
  // What stays allowed: the push on its own, a push before the mover, commands that do not move HEAD.
  for (const cmd of ["git push origin feat", "git push origin feat && git checkout main", "git status && git fetch origin && git log -1 --oneline && git push origin feat", 'echo "git commit" && git push origin feat', "git push -u origin feat && gh pr create --fill"]) {
    assert.equal(pushOperations(cmd)[0].after, null, cmd);
    assert.equal(push(b, cmd).out, "", cmd);
  }
  // gh pr merge publishes the remote's commit, not HEAD: a mover before it does not refuse it.
  const head = git(b, "rev-parse", "HEAD");
  assert.equal(push(b, `git checkout main && gh pr merge 5 --rebase --match-head-commit ${head}`).out, "");
  // advise: the push is checked against HEAD as it is, and a notice says what that misses.
  b.writeConfig({ review: { mode: "advise" } });
  p = push(b, "git commit -am fix && git push origin feat");
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /^ledger: review gate \(advise\): `git commit` runs before this `git push`/m);
});

/** True while `pid` exists; null when this process may not ask (EPERM), so the caller can skip. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM" ? null : false;
  }
}

test("R3-B4 and R4-S1: a remote that hangs is cut off with its helpers, and the push is allowed with a notice, not denied", async (t) => {
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS") });
  const pids = join(b.root, "ext.pids");
  git(b, "config", "protocol.ext.allow", "always");
  // `git remote-ext` runs `sh`, which records its pid and its parent's (remote-ext), then becomes `sleep 30`.
  git(b, "remote", "add", "origin", `ext::sh -c echo% $$% $PPID% >% ${pids};% exec% sleep% 30`);
  const started = Date.now();
  const p = push(b, "gh pr create --head feat --title t");
  assert.ok(Date.now() - started < 9000, `${Date.now() - started} ms`);
  assert.equal(decision(p), "allow");
  assert.match(p.json.systemMessage, /git ls-remote origin timed out after 5s; a local remote-tracking ref may be stale/);
  const [sleeper, helper] = readFileSync(pids, "utf8").trim().split(/\s+/).map(Number);
  assert.ok(sleeper > 1 && helper > 1, `pids ${sleeper} ${helper}`);
  let left = [sleeper, helper].map(alive);
  for (let i = 0; i < 40 && left.some(Boolean); i++) {
    await new Promise((r) => setTimeout(r, 50));
    left = [sleeper, helper].map(alive);
  }
  if (left.includes(null)) return t.skip("this sandbox does not let the test signal those pids");
  assert.deepEqual(left, [false, false], "sleep and git remote-ext were killed with git");
});

test("R4-B1: the remote lookup runs no askpass program and no credential helper", async () => {
  const b = repo();
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: stub(b, "codex", "PASS") });
  const marker = join(b.root, "prompted");
  const prompt = join(b.root, "askpass");
  writeFileSync(prompt, `#!/bin/sh\necho "$0 $*" >> "${marker}"\necho secret\n`);
  chmodSync(prompt, 0o755);
  // A server in its own process (the hook runs synchronously) that answers every request with a Basic-auth challenge.
  const server = spawn(process.execPath, ["-e", "const s=require('http').createServer((q,r)=>{r.writeHead(401,{'WWW-Authenticate':'Basic realm=\"x\"'});r.end();});s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise((resolve, reject) => {
      server.stdout.once("data", (d) => resolve(String(d).trim()));
      server.once("error", reject);
    });
    git(b, "remote", "add", "origin", `http://127.0.0.1:${port}/repo.git`);
    git(b, "config", "core.askPass", prompt);
    git(b, "config", "credential.helper", `!${prompt}`);
    const p = push(b, "gh pr create --head feat --title t", { GIT_ASKPASS: prompt, SSH_ASKPASS: prompt, SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":0" });
    assert.equal(decision(p), "allow");
    assert.match(p.json.systemMessage, /git ls-remote origin could not read it \(exit \d+\)/);
    assert.equal(readFileSafe(marker), "", "no askpass program or credential helper ran");
  } finally {
    server.kill("SIGKILL");
  }
});

function readFileSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

test("R4-B1: the quiet environment drops every prompt and keeps the repository's ssh command", async () => {
  const { quietRemoteEnv } = await import("../lib/review.mjs");
  const b = repo();
  const env = quietRemoteEnv(b.work, { PATH: process.env.PATH, GIT_ASKPASS: "/x", SSH_ASKPASS: "/y", GIT_SSH_COMMAND: "ssh -i key" });
  assert.deepEqual([env.GIT_ASKPASS, env.GIT_TERMINAL_PROMPT, env.SSH_ASKPASS, env.SSH_ASKPASS_REQUIRE, env.GIT_SSH_COMMAND], ["", "0", undefined, "never", "ssh -o BatchMode=yes -i key"]);
  git(b, "config", "core.sshCommand", "ssh -F cfg");
  assert.equal(quietRemoteEnv(b.work, { PATH: process.env.PATH }).GIT_SSH_COMMAND, "ssh -o BatchMode=yes -F cfg");
});

test("R5-S1: BatchMode=yes goes right after the ssh executable, so a BatchMode=no in the command does not win", async (t) => {
  const { quietRemoteEnv } = await import("../lib/review.mjs");
  const b = repo();
  git(b, "config", "core.sshCommand", "ssh -o BatchMode=no");
  const cmd = quietRemoteEnv(b.work, { PATH: process.env.PATH }).GIT_SSH_COMMAND;
  assert.equal(cmd, "ssh -o BatchMode=yes -o BatchMode=no");
  for (const [given, built] of [
    ["'/opt/my ssh' -o BatchMode=no", "'/opt/my ssh' -o BatchMode=yes -o BatchMode=no"],
    ['"/opt/my ssh" -p 22', '"/opt/my ssh" -o BatchMode=yes -p 22'],
    ["/opt/my\\ ssh", "/opt/my\\ ssh -o BatchMode=yes"],
    ["ssh-wrapper --flag", "ssh-wrapper -o BatchMode=yes --flag"],
  ]) {
    assert.equal(quietRemoteEnv(b.work, { PATH: process.env.PATH, GIT_SSH_COMMAND: given }).GIT_SSH_COMMAND, built, given);
  }
  // ssh itself: `-G` prints the options it would use, without connecting.
  const r = spawnSync("sh", ["-c", `${cmd} -G example.invalid`], { encoding: "utf8" });
  if (r.error || r.status !== 0) return t.skip(`ssh -G is not available here (${r.error?.message ?? `exit ${r.status}`})`);
  assert.match(r.stdout, /^batchmode yes$/m);
});

test("R3-S1: a cd inside a subshell or command substitution does not move a later push", async () => {
  const { pushOperations } = await import("../lib/gate.mjs");
  for (const cmd of ['echo "$(cd /tmp)"; git push origin HEAD', "(cd /tmp); git push origin HEAD", "(cd /tmp && true) && git push origin HEAD", "x=`cd /tmp`; git push origin HEAD", "(cd $X); git push origin HEAD"]) {
    const [op] = pushOperations(cmd);
    assert.deepEqual([op.cds, op.unsupported], [[], null], cmd);
  }
  assert.deepEqual(pushOperations("(cd /tmp && git push origin HEAD)")[0].cds, ["/tmp"], "inside the subshell the cd holds");
  assert.deepEqual(pushOperations("cd /a; (cd b; git push); git push")[0].cds, ["/a", "b"]);
  assert.deepEqual(pushOperations("cd /a; (cd b; git push); git push")[1].cds, ["/a"]);
});
