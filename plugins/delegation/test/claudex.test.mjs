// test/claudex.test.mjs — gate 5 (the claudex-loop line on a builder-class brief): the pure
// parser and checker in lib/claudex.mjs, and the spawn gate end-to-end through lib/hook-runner.mjs
// on allow, deny and fail-open inputs.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { box, gitRepo, runHook, setConfig, skippedLog, spawnPayload, HOW_ONLY } from "./helpers.mjs";
import { CLAUDEX_LINES, checkClaudexLine, claudexLines, claudexReason } from "../lib/claudex.mjs";

const SPIRAL = "\n## Spiral bound\n- one retry\n";
const brief = (line) => `# Target\nx\n\n${line}\n\n## How it fails\n- it breaks\n${SPIRAL}`;
const deny = (r) => (r.out?.hookSpecificOutput?.permissionDecision === "deny" ? r.out.hookSpecificOutput.permissionDecisionReason : null);

function repoWithReceipt(env, session = "s-test-1") {
  const repo = gitRepo(join(env.HOME, "repo"), env);
  mkdirSync(join(repo, ".pattern-check"), { recursive: true });
  writeFileSync(join(repo, ".pattern-check", `${session}.md`), "# receipt\n");
  return repo;
}

// ---- lib/claudex.mjs ----

test("claudexLines: reads skip and log lines outside fences, trimmed, with a list marker or backticks dropped", () => {
  const text = "intro\n  - claudex: skip: one-file fix  \n`claudex: log: /a/b.md`\nCLAUDEX:SKIP:prototype\n```\nclaudex: skip: fenced\n```\nsay claudex: skip: in prose\n";
  assert.deepEqual(claudexLines(text), [
    { kind: "skip", value: "one-file fix" },
    { kind: "log", value: "/a/b.md" },
    { kind: "skip", value: "prototype" },
  ]);
  assert.deepEqual(claudexLines("claudex: log: `/a b/c.md`"), [{ kind: "log", value: "`/a b/c.md`" }], "a backtick-quoted path keeps its backticks for unquote");
  assert.deepEqual(claudexLines("`claudex: log: `/a.md``"), [{ kind: "log", value: "`/a.md`" }], "a whole-line pair is dropped, the inner pair kept");
  assert.deepEqual(claudexLines("`CLAUDEX: Skip: prototype`"), [{ kind: "skip", value: "prototype" }], "whole-line backticks with upper-case keywords");
  assert.deepEqual(claudexLines(42), []);
  assert.deepEqual(claudexLines("x\n```\nclaudex: skip: unclosed fence\n"), [], "an unclosed fence runs to the end");
});

test("checkClaudexLine: a skip line with a reason passes; empty, whitespace and placeholder reasons do not", (t) => {
  const { env } = box(t);
  assert.equal(checkClaudexLine({ prompt: "claudex: skip: prototype" }, env).status, "present");
  assert.equal(checkClaudexLine({ prompt: "claudex: skip:" }, env).problem, "empty-reason");
  assert.equal(checkClaudexLine({ prompt: "claudex: skip:    \t" }, env).problem, "empty-reason");
  assert.equal(checkClaudexLine({ prompt: "claudex: skip: <reason>" }, env).problem, "placeholder");
  const none = checkClaudexLine({ prompt: "no line here" }, env);
  assert.equal(none.status, "missing");
  assert.equal(none.problem, "no-line");
  assert.match(none.config, /delegation\/config\.json$/);
});

test("checkClaudexLine: a log line passes only for an existing non-empty regular file", (t) => {
  const { root, env } = box(t);
  const log = join(root, "PLAN-REVIEW-LOG.md");
  writeFileSync(log, "# log\n");
  writeFileSync(join(root, "empty.md"), "");
  mkdirSync(join(env.HOME, "logs"), { recursive: true });
  writeFileSync(join(env.HOME, "logs", "r.md"), "x");
  assert.deepEqual(checkClaudexLine({ prompt: `claudex: log: ${log}` }, env), { status: "present", path: log });
  assert.equal(checkClaudexLine({ prompt: `claudex: log: "${log}"` }, env).status, "present", "quoted");
  assert.equal(checkClaudexLine({ prompt: `claudex: log: \`${log}\`` }, env).status, "present", "backtick-quoted absolute");
  assert.equal(checkClaudexLine({ prompt: "claudex: log: `PLAN-REVIEW-LOG.md`", cwd: root }, env).status, "present", "backtick-quoted relative");
  mkdirSync(join(root, "a dir"));
  writeFileSync(join(root, "a dir", "log file.md"), "x");
  assert.equal(checkClaudexLine({ prompt: `claudex: log: \`${join(root, "a dir", "log file.md")}\`` }, env).status, "present", "a path with spaces");
  assert.equal(checkClaudexLine({ prompt: "claudex: log: PLAN-REVIEW-LOG.md", cwd: root }, env).status, "present", "relative to cwd");
  assert.equal(checkClaudexLine({ prompt: "claudex: log: ~/logs/r.md" }, env).status, "present", "~/ is HOME");
  const missing = checkClaudexLine({ prompt: `claudex: log: ${join(root, "nope.md")}` }, env);
  assert.equal(missing.status, "missing");
  assert.equal(missing.problem, "log-not-found");
  assert.equal(missing.path, join(root, "nope.md"));
  assert.equal(checkClaudexLine({ prompt: `claudex: log: ${root}` }, env).problem, "log-not-file");
  assert.equal(checkClaudexLine({ prompt: `claudex: log: ${join(root, "empty.md")}` }, env).problem, "log-empty");
  assert.equal(checkClaudexLine({ prompt: `claudex: log: ${log}/below` }, env).problem, "log-not-found", "ENOTDIR is not found");
  assert.equal(checkClaudexLine({ prompt: "claudex: log:" }, env).problem, "empty-path");
  assert.equal(checkClaudexLine({ prompt: "claudex: log: <absolute path to the log>" }, env).problem, "placeholder");
});

test("checkClaudexLine: any one valid line passes; otherwise the first problem in prompt order is named", (t) => {
  const { root, env } = box(t);
  assert.equal(checkClaudexLine({ prompt: `claudex: log: ${join(root, "nope.md")}\nclaudex: skip: docs` }, env).status, "present");
  const r = checkClaudexLine({ prompt: `claudex: log: ${join(root, "nope.md")}\nclaudex: skip:` }, env);
  assert.equal(r.problem, "log-not-found");
});

test("checkClaudexLine: the deny template's own lines never pass", (t) => {
  const { env } = box(t);
  const r = checkClaudexLine({ prompt: CLAUDEX_LINES, cwd: "/" }, env);
  assert.equal(r.status, "missing");
  assert.equal(r.problem, "placeholder");
});

test("checkClaudexLine: fails open on a relative path with no cwd, and on a stat fault that is not not-found", (t) => {
  const { env } = box(t);
  const rel = checkClaudexLine({ prompt: "claudex: log: PLAN-REVIEW-LOG.md" }, env);
  assert.equal(rel.status, "skipped");
  assert.match(rel.why, /relative and the payload has no absolute cwd/);
  let stats = 0;
  const counting = () => {
    stats++;
    throw Object.assign(new Error("nope"), { code: "ENOENT" });
  };
  for (const cwd of ["project", "   ", ""]) {
    assert.equal(checkClaudexLine({ prompt: "claudex: log: PLAN-REVIEW-LOG.md", cwd }, env, undefined, { stat: counting }).status, "skipped", JSON.stringify(cwd));
  }
  assert.equal(stats, 0, "a relative path with no absolute cwd is never stat'd");
  const stat = () => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  };
  const fault = checkClaudexLine({ prompt: "claudex: log: /x/y.md" }, env, undefined, { stat });
  assert.equal(fault.status, "skipped");
  assert.match(fault.why, /\/x\/y\.md could not be read \(EACCES\)/);
  assert.equal(checkClaudexLine({ prompt: "claudex: log: /x/y.md\nclaudex: skip: docs" }, env, undefined, { stat }).status, "present", "a valid skip still passes");
});

test("checkClaudexLine: a skip reason is unquoted first and needs a letter or digit; `<…>` with trailing punctuation is a placeholder", (t) => {
  const { env } = box(t);
  const cases = [
    ['claudex: skip: ""', "empty-reason"],
    ["claudex: skip: ``", "empty-reason"],
    ["claudex: skip: -", "empty-reason"],
    ["claudex: skip: \u200B", "empty-reason"],
    ["claudex: skip: `<why claudex-loop does not apply>`", "placeholder"],
    ['claudex: skip: "<why>"', "placeholder"],
    ["claudex: skip: <why claudex-loop does not apply>.", "placeholder"],
    ["claudex: log: <path>.", "placeholder"],
  ];
  for (const [prompt, problem] of cases) {
    const r = checkClaudexLine({ prompt, cwd: "/" }, env);
    assert.equal(r.status, "missing", prompt);
    assert.equal(r.problem, problem, prompt);
  }
  assert.equal(checkClaudexLine({ prompt: 'claudex: skip: "one-file fix"' }, env).status, "present", "a quoted real reason passes");
  assert.equal(checkClaudexLine({ prompt: "claudex: skip: <b>docs</b> only" }, env).status, "present", "angle brackets inside a real reason are not a placeholder");
});

test("claudexLines: list, number and blockquote markers are dropped before the backtick pair", () => {
  for (const line of ["- `claudex: skip: one-file fix`", "1. claudex: skip: one-file fix", "2) claudex: skip: one-file fix", "+ claudex: skip: one-file fix", "> claudex: skip: one-file fix", "> - `claudex: skip: one-file fix`"]) {
    assert.deepEqual(claudexLines(line), [{ kind: "skip", value: "one-file fix" }], line);
  }
});

test("checkClaudexLine: a log path that is too long, loops, or holds a NUL is denied as unusable, not failed open", (t) => {
  const { root, env } = box(t);
  const long = checkClaudexLine({ prompt: `claudex: log: /${"a".repeat(5000)}` }, env);
  assert.equal(long.status, "missing");
  assert.equal(long.problem, "log-unusable");
  assert.equal(long.code, "ENAMETOOLONG");
  assert.match(claudexReason("builder", long), /cannot be used \(ENAMETOOLONG\): \/a{116}\.\.\.\./, "the long path is shortened in the deny");
  symlinkSync(join(root, "loop"), join(root, "loop"));
  assert.equal(checkClaudexLine({ prompt: `claudex: log: ${join(root, "loop")}` }, env).code, "ELOOP");
  assert.equal(checkClaudexLine({ prompt: "claudex: log: /tmp/a\u0000b.md" }, env).code, "ERR_INVALID_ARG_VALUE");
  for (const cwd of [undefined, "", "relative"]) {
    const rel = checkClaudexLine({ prompt: "claudex: log: a\u0000b.md", cwd }, env);
    assert.equal(rel.status, "missing", `relative NUL path, cwd ${JSON.stringify(cwd)}`);
    assert.equal(rel.problem, "log-unusable");
    assert.equal(rel.code, "ERR_INVALID_ARG_VALUE");
  }
  const viaHook = runHook("spawn-gate", spawnPayload({ prompt: brief("claudex: log: a\u0000b.md") }), env);
  assert.match(deny(viaHook) ?? "", /cannot be used \(ERR_INVALID_ARG_VALUE\)/, "the spawn gate denies it with no cwd in the payload");
});

test("claudexReason: names the problem, both lines, and the config switch", () => {
  const r = claudexReason("builder", { problem: "log-not-found", path: "/a/log.md", config: "/c/delegation/config.json" });
  assert.match(r, /^Spawn refused: builder-class "builder" needs a claudex-loop line, and the plan-review log it names does not exist at \/a\/log\.md\. /);
  assert.ok(r.includes(`\n\n${CLAUDEX_LINES}\n\n`), r);
  assert.ok(r.endsWith('To turn this gate off instead, set `"requireClaudexLoop": false` in /c/delegation/config.json.'), r);
  assert.match(claudexReason(undefined, { problem: "no-line" }), /^Spawn refused: builder-class "general-purpose" needs a claudex-loop line, and the prompt has none\./);
  assert.match(claudexReason("b", { problem: "empty-reason" }), /its "claudex: skip:" line gives no reason/);
});

// ---- hooks/spawn-gate.mjs, gate 5 ----

test("spawn-gate gate 5: a builder brief with a skip line or an existing log is allowed in silence", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(env);
  writeFileSync(join(repo, "PLAN-REVIEW-LOG.md"), "# log\n");
  for (const line of ["claudex: skip: prototype", "claudex: skip: one-file fix", "- claudex: skip: docs", `claudex: log: ${join(repo, "PLAN-REVIEW-LOG.md")}`, "claudex: log: PLAN-REVIEW-LOG.md"]) {
    const r = runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: brief(line) }), env);
    assert.equal(r.out, null, `${line}: ${r.stdout}`);
  }
  assert.equal(skippedLog(env), "");
});

test("spawn-gate gate 5: non-builder and read-only spawns need no claudex line", (t) => {
  const { env } = box(t);
  const repo = gitRepo(join(env.HOME, "repo"), env);
  for (const type of ["scout", "reader", "reviewer-codex", "plugin:research"]) {
    assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: HOW_ONLY, subagent_type: type }), env).out, null, type);
  }
  setConfig(env, { builderClass: ["builder", "reader"] });
  assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: HOW_ONLY, subagent_type: "reader" }), env).out, null, "read-only wins over builderClass");
});

test("spawn-gate gate 5: denies no line, an empty reason, a placeholder, a fenced line, and a log that is missing, a directory or empty", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(env);
  writeFileSync(join(repo, "empty.md"), "");
  const cases = [
    ["", /and the prompt has none\./],
    ["claudex: skip:", /gives no reason/],
    ["claudex: skip:   ", /gives no reason/],
    ["claudex: skip: <reason>", /still the template placeholder/],
    ["```\nclaudex: skip: prototype\n```", /and the prompt has none\./],
    [`claudex: log: ${join(repo, "nope.md")}`, new RegExp(`does not exist at ${join(repo, "nope.md").replace(/[.]/g, "\\.")}`)],
    ["claudex: log: nope.md", /does not exist at .*\/repo\/nope\.md/],
    [`claudex: log: ${repo}`, /is not a file/],
    ["claudex: log: empty.md", /is empty/],
  ];
  for (const [line, re] of cases) {
    const reason = deny(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: brief(line) }), env));
    assert.ok(reason, line);
    assert.match(reason, /^Spawn refused: builder-class "builder" needs a claudex-loop line, and /, line);
    assert.match(reason, re, line);
    assert.match(reason, /set `"requireClaudexLoop": false` in .*delegation\/config\.json\.$/, line);
  }
});

test("spawn-gate gate 5: runs after the heading gates and before the receipt gate", (t) => {
  const { env } = box(t);
  const repo = gitRepo(join(env.HOME, "repo"), env); // no receipt
  assert.match(deny(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: HOW_ONLY }), env)), /needs a "## Spiral bound" heading too/);
  assert.match(deny(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: brief("") }), env)), /needs a claudex-loop line/);
  assert.match(deny(runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: brief("claudex: skip: docs") }), env)), /needs a pattern-check receipt/);
});

test("spawn-gate gate 5: a relative log path with no cwd allows, with one skipped.log line", (t) => {
  const { env } = box(t);
  const r = runHook("spawn-gate", spawnPayload({ prompt: brief("claudex: log: PLAN-REVIEW-LOG.md") }), env);
  assert.equal(r.status, 0);
  assert.equal(deny(r), null, r.stdout);
  assert.match(skippedLog(env), /^\S+ spawn-gate claudex line not checked: the log path "PLAN-REVIEW-LOG\.md" is relative and the payload has no absolute cwd; spawn allowed\n/);
});

test("spawn-gate gate 5: a non-boolean requireClaudexLoop is a config fault: defaults (gate on) plus a systemMessage", (t) => {
  const { env } = box(t, { config: { requireClaudexLoop: "false" } });
  const repo = repoWithReceipt(env);
  const r = runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: brief("") }), env);
  assert.match(deny(r), /needs a claudex-loop line/);
  assert.match(r.out.systemMessage, /requireClaudexLoop must be true or false; using defaults/);
});
