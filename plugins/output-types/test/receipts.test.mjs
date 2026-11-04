// receipts.test.mjs — lib/receipts.mjs: which labels count (bold, at a line's start after any
// list or quote marker, or followed by a colon or the line's end; never mid-sentence, never casual
// prose, never inside a fence), where a statement ends, which receipt shapes satisfy each label,
// the warning's cap, the config read, and the judge stage with a fake runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NEEDS,
  WARNING_CAP,
  configPath,
  extractStatements,
  judgeEnabled,
  judgeFor,
  judgePrompt,
  judgeStage,
  logSkipped,
  maskFences,
  missingReceipt,
  nameOf,
  readConfig,
  renderWarning,
  skippedLogPath,
} from "../lib/receipts.mjs";
import { sandbox } from "./helpers.mjs";

const labels = (md) => extractStatements(md).map((s) => [s.line, s.label, s.text]);

// ─── labels ─────────────────────────────────────────────────────────────────────────────

test("labels: bold CLAIM/CITE at a line's start (after list or quote markers) or followed by a colon or the line's end, with a qualifier or a colon; mid-sentence bold, casual prose, unbolded, other words, and fenced text never count", () => {
  const md = [
    "# Report", // 1
    "", // 2
    "**CLAIM**", // 3
    "First, block-leading.", // 4
    "", // 5
    "Inline **CLAIM** mid-sentence is a mention, not a label.", // 6
    "- **CITE (partial)**: third, qualified.", // 7
    "- **CLAIM:** fourth, with a colon.", // 8
    "", // 9
    "This paragraph mentions CLAIM and CITE casually, and **GUESS** is not a label.", // 10
    "| CLAIM | an unbolded table cell | is not a label |", // 11
    "```", // 12
    "**CLAIM** inside a fence is a quoted example, not a label", // 13
    "```", // 14
    "~~~md", // 15
    "**CITE** inside a tilde fence either", // 16
    "~~~", // 17
    "**CITE** fifth, after the fences.", // 18
    "> **CLAIM** sixth, in a quote.", // 19
    "", // 20
    "Result **CLAIM**: seventh, a lead-in then a colon.", // 21
    "", // 22
    "Under the contract, **CLAIM** and **CITE** are the only two labels.", // 23
    "", // 24
    "- a list item", // 25
    "  ```", // 26
    "  **CLAIM** inside an indented fence", // 27
    "  ```", // 28
  ].join("\n");
  assert.deepEqual(labels(md), [
    [3, "CLAIM", "First, block-leading."],
    [7, "CITE", "third, qualified."],
    [8, "CLAIM", "fourth, with a colon."],
    [18, "CITE", "fifth, after the fences."],
    [19, "CLAIM", "sixth, in a quote."],
    [21, "CLAIM", "seventh, a lead-in then a colon."],
  ]);
});

test("statement end: the next label, a heading, a rule, an HTML comment, or a bold-only line; a following fence belongs to the statement; CRLF is fine", () => {
  assert.deepEqual(labels("**CLAIM** a\n## Heading\nnot part"), [[1, "CLAIM", "a"]]);
  assert.deepEqual(labels("**CLAIM** a\n---\nnot part"), [[1, "CLAIM", "a"]]);
  assert.deepEqual(labels("**CLAIM** a\n<!-- c -->\nnot part"), [[1, "CLAIM", "a"]]);
  assert.deepEqual(labels("**CLAIM** a\n**Needs you**\nnot part"), [[1, "CLAIM", "a"]]);
  assert.deepEqual(labels("**CLAIM** a\n\nnot part, a new paragraph"), [[1, "CLAIM", "a"]]);
  assert.deepEqual(labels("**CLAIM** a\nreceipt on the next line /x/y.ts:1"), [[1, "CLAIM", "a\nreceipt on the next line /x/y.ts:1"]]);
  assert.deepEqual(labels("1. **CLAIM** a\n2. lead-in **CITE**: b"), [
    [1, "CLAIM", "a"],
    [2, "CITE", "b"],
  ]);
  assert.deepEqual(labels("**CLAIM** the build is clean:\n\n```\n$ npm run build\n\n> built in 2s\n```\n\nnot part"), [[1, "CLAIM", "the build is clean:\n\n```\n$ npm run build\n\n> built in 2s\n```"]], "a blank line inside a fence does not end the statement");
  assert.deepEqual(labels("- **CLAIM** the suite:\n\n  ```\n  $ node --test\n\n  ℹ pass 12\n  ```"), [[1, "CLAIM", "the suite:\n\n  ```\n  $ node --test\n\n  ℹ pass 12\n  ```"]], "an indented fence under a list item belongs to the statement");
  assert.deepEqual(labels("**CLAIM** a\n\n```\ncmd\nout\n```\n"), [[1, "CLAIM", "a\n\n```\ncmd\nout\n```"]]);
  assert.deepEqual(labels("**CLAIM** a\r\n\r\n**CITE** b\r\n"), [
    [1, "CLAIM", "a"],
    [3, "CITE", "b"],
  ]);
  assert.deepEqual(labels("**CLAIM**\n\n**CITE** only the second has text"), [[3, "CITE", "only the second has text"]]);
  assert.deepEqual(labels(""), []);
  assert.deepEqual(labels(null), []);
  assert.deepEqual(labels("no labels at all, just CLAIM in prose"), []);
});

test("maskFences blanks the inside of a fence, keeps every newline, the fence lines and the text's length; an unterminated fence runs to the end", () => {
  const md = "a\n```js\nx\n```\nb\n```\nopen";
  const masked = maskFences(md);
  assert.equal(masked.length, md.length);
  assert.equal(masked.split("\n").length, md.split("\n").length);
  assert.equal(masked, "a\n```js\nx\n```\nb\n```\nxxxx");
});

// ─── receipt shapes ─────────────────────────────────────────────────────────────────────

const claim = (text) => missingReceipt({ label: "CLAIM", text });
const cite = (text) => missingReceipt({ label: "CITE", text });

test("CLAIM: an absolute /-rooted file:line or range passes; a relative path, a bare path, or ~/ does not", () => {
  assert.equal(claim("the route is in /Users/me/repo/src/routes/feeds.ts:41"), null);
  assert.equal(claim("see `/srv/app/lib/x.mjs:12-30`"), null);
  assert.equal(claim("see /srv/app/lib/x.mjs:12–30 (en dash)"), null);
  assert.equal(claim("the route is in src/routes/feeds.ts:41"), NEEDS.CLAIM);
  assert.equal(claim("the route is in /Users/me/repo/src/routes/feeds.ts"), NEEDS.CLAIM);
  assert.equal(claim("the route is in ~/repo/src/routes/feeds.ts:41"), NEEDS.CLAIM);
  assert.equal(claim("a time like 12:30 is not a receipt"), NEEDS.CLAIM);
  assert.equal(claim("nothing checked here"), NEEDS.CLAIM);
});

test("CLAIM: a fence with the command and its output, a fenced command plus a result phrase, or a command (`$ cmd`, or code with a space in it) with `→ output` on its line or the next passes; inline code next to a result word, or a symbol before an arrow, does not", () => {
  assert.equal(claim("ran it:\n```\nnode x.mjs\nhello\n```"), null);
  assert.equal(claim("ran it:\n```sh\nnode x.mjs\n```"), NEEDS.CLAIM, "a one-line fence is a command with no output and no result word");
  assert.equal(claim("ran it:\n```sh\nnode x.mjs\n```\nand it passed"), null);
  assert.equal(claim("the build is clean:\n\n```\n$ npm run build\n\n> built in 2s\n```"), null, "probe case D: a blank line inside the fence");
  assert.equal(claim("the suite:\n\n  ```\n  $ node --test\n  ℹ pass 12\n  ```"), null, "probe case I: an indented fence");
  assert.equal(claim("`$ npm test` → exit 0, 12 passing"), null);
  assert.equal(claim("$ git status --porcelain -> (nothing)"), null);
  assert.equal(claim("clean tree:\n- `$ git status --porcelain`\n- → nothing printed"), null);
  assert.equal(claim("`resolveJudgeCommand` returns null when nothing is configured."), NEEDS.CLAIM, "probe case G: a symbol in code is not a command");
  assert.equal(claim("`handle()` -> nothing useful here."), NEEDS.CLAIM, "probe case L: an arrow after a symbol is not a result");
  assert.equal(claim("`npm test` → exit 0, 12 passing"), null, "code with a space inside reads as a command");
  assert.equal(claim("`handle()` and `x` -> null"), NEEDS.CLAIM, "the prose between two spans is not a span");
  assert.equal(claim("ran `node --test`: it printed 46 pass"), NEEDS.CLAIM, "a result word is not an arrow");
  assert.equal(claim("`$ npm test`"), NEEDS.CLAIM, "a command alone");
  assert.equal(claim("`$ npm test`\nand then it was fine"), NEEDS.CLAIM, "the next line does not open with an arrow");
  assert.equal(claim("the tests exit 0"), NEEDS.CLAIM);
});

test("CITE: a URL passes; test/tested/ran/run with a command in code passes; a bare assertion, or the words without a command, does not", () => {
  assert.equal(cite("the docs say so: https://example.com/docs#x"), null);
  assert.equal(cite("per http://localhost:3000/health"), null);
  assert.equal(cite("tested: `curl -s -o /dev/null -w '%{http_code}' localhost` gave 200"), null);
  assert.equal(cite("I ran `vendor-cli --version`"), null);
  assert.equal(cite("the vendor's docs say the limit is 100"), NEEDS.CITE);
  assert.equal(cite("I tested it and it works"), NEEDS.CITE);
  assert.equal(cite("`vendor-cli --version` is 2.0"), NEEDS.CITE);
});

// ─── the warning ────────────────────────────────────────────────────────────────────────

const st = (line, label, text) => ({ line, label, text });

test("nameOf: line, label, and the first 80 characters on one line", () => {
  assert.equal(nameOf(st(4, "CLAIM", "short  one\nwith\tbreaks")), 'line 4 **CLAIM** "short one with breaks"');
  const long = "x".repeat(100);
  assert.equal(nameOf(st(1, "CITE", long)), `line 1 **CITE** "${"x".repeat(79)}…"`);
});

test("renderWarning: null for nothing; one message naming each line, capped at 5 with +N more; singular and plural", () => {
  assert.equal(renderWarning([]), null);
  const one = renderWarning([{ statement: st(3, "CLAIM", "a"), why: NEEDS.CLAIM }]);
  assert.equal(one, `output-types: 1 labelled statement without a receipt that holds. Add the receipt or remove the label (unlabeled means unreceipted).\n  line 3 **CLAIM** "a": ${NEEDS.CLAIM}`);
  const many = Array.from({ length: 8 }, (_, i) => ({ statement: st(i + 1, "CITE", `s${i + 1}`), why: NEEDS.CITE }));
  const msg = renderWarning(many);
  assert.equal(WARNING_CAP, 5);
  assert.ok(msg.startsWith("output-types: 8 labelled statements without a receipt that holds."));
  assert.equal(msg.split("\n").length, 1 + 5 + 1);
  assert.ok(msg.includes('line 5 **CITE** "s5"'));
  assert.ok(!msg.includes('line 6 **CITE**'));
  assert.ok(msg.endsWith("\n  +3 more"));
});

// ─── config and logs ────────────────────────────────────────────────────────────────────

test("config: ${XDG_CONFIG_HOME:-~/.config}/output-types/config.json; absent, broken or non-object is {}; judge is on only for the boolean true", () => {
  const box = sandbox();
  const env = { ...box.env, XDG_CONFIG_HOME: join(box.root, "config") };
  assert.equal(configPath(env), join(box.root, "config", "output-types", "config.json"));
  assert.equal(configPath({ HOME: box.home }), join(box.home, ".config", "output-types", "config.json"));
  assert.deepEqual(readConfig(env), {});
  assert.equal(judgeEnabled(env), false);
  mkdirSync(join(box.root, "config", "output-types"), { recursive: true });
  const file = configPath(env);
  writeFileSync(file, "{broken");
  assert.deepEqual(readConfig(env), {});
  writeFileSync(file, "[1]");
  assert.deepEqual(readConfig(env), {});
  writeFileSync(file, JSON.stringify({ judge: "true" }));
  assert.equal(judgeEnabled(env), false, "the string is not the boolean");
  writeFileSync(file, JSON.stringify({ judge: true, judgeCommand: "echo x", judgeTimeoutMs: 5 }));
  assert.equal(judgeEnabled(env), true);
  assert.deepEqual(judgeFor(env), { command: "echo x", timeoutMs: 5, source: `judgeCommand in ${file}` });
  assert.deepEqual(judgeFor({ ...env, OUTPUT_TYPES_JUDGE_BIN: "from-env" }), { command: "from-env", timeoutMs: 5, source: "env OUTPUT_TYPES_JUDGE_BIN" });
  writeFileSync(file, JSON.stringify({ judge: true }));
  assert.equal(judgeFor(env), null, "judge on but no command anywhere");
  mkdirSync(join(box.root, "config", "judge"), { recursive: true });
  writeFileSync(join(box.root, "config", "judge", "config.json"), JSON.stringify({ command: "shared", timeoutMs: 7 }));
  assert.deepEqual(judgeFor(env), { command: "shared", timeoutMs: 7, source: join(box.root, "config", "judge", "config.json") });
});

test("logSkipped: one line, iso, hook file, text flattened, under the state dir; never throws when it cannot write", () => {
  const box = sandbox();
  assert.equal(skippedLogPath(box.env), join(box.root, "state", "output-types", "skipped.log"));
  const path = logSkipped("a\n  b", box.env, new Date("2026-11-04T00:00:00Z"));
  assert.equal(path, skippedLogPath(box.env));
  assert.equal(readFileSync(path, "utf8"), "2026-11-04T00:00:00.000Z hooks/output-types-stop.mjs a b\n");
  const blocked = join(box.root, "file-not-dir");
  writeFileSync(blocked, "");
  assert.equal(logSkipped("x", { ...box.env, XDG_STATE_HOME: blocked }), null);
});

// ─── the judge stage ────────────────────────────────────────────────────────────────────

test("judgePrompt carries the label, the statement verbatim, and the JSON shape asked for", () => {
  const p = judgePrompt(st(1, "CITE", "the docs: https://x.y"));
  assert.ok(p.includes("Label: CITE\n"));
  assert.ok(p.includes("<<<\nthe docs: https://x.y\n>>>"));
  assert.ok(p.includes('{"verdict": "pass" | "fail", "reason": "<one sentence>"}'));
});

test("judgeStage: pass is silent, fail and an unreadable verdict are findings, a dispatch error is a skipped.log line naming the source; calls are clamped to the budget and skipped when none is left", async () => {
  const box = sandbox();
  const calls = [];
  const answers = [
    { verdict: "pass", reason: "fine" },
    { verdict: "FAIL", reason: "reaches  past\nthe receipt" },
    { verdict: "maybe", reason: "cannot  tell\nfrom the receipt" },
    { error: "timeout", detail: "no exit within 10 ms", stderr: "slow\nthing" },
    { error: "nonzero", detail: "exit 2", stderr: "" },
    "not an object",
  ];
  const run = async (prompt, opts) => {
    calls.push({ prompt, opts });
    return answers[calls.length - 1];
  };
  const statements = answers.map((_, i) => st(i + 1, "CLAIM", `s${i + 1} /a/b.ts:1`));
  const judge = { command: "fake", timeoutMs: 100_000, source: "the test" };
  const startedAt = Date.now();
  const findings = await judgeStage(statements, judge, { env: box.env, startedAt, budgetMs: 10_000, marginMs: 2_000, run });
  assert.deepEqual(
    findings.map((f) => [f.statement.line, f.why]),
    [
      [2, "the judge says the receipt does not license it: reaches past the receipt"],
      [3, "the judge's answer was neither pass nor fail (unverified): cannot tell from the receipt"],
      [6, "the judge's answer was neither pass nor fail (unverified)"],
    ],
  );
  assert.equal(calls.length, 6);
  assert.ok(calls[0].prompt.includes("<<<\ns1 /a/b.ts:1\n>>>"));
  assert.equal(calls[0].opts.command, "fake");
  assert.equal(calls[0].opts.mode, "json");
  assert.ok(calls[0].opts.timeoutMs <= 8_000 && calls[0].opts.timeoutMs > 7_000, `clamped to budget minus margin, got ${calls[0].opts.timeoutMs}`);
  const log = readFileSync(skippedLogPath(box.env), "utf8").split("\n").filter(Boolean);
  assert.equal(log.length, 2);
  assert.match(log[0], /^\S+ hooks\/output-types-stop\.mjs line 4 \*\*CLAIM\*\* "s4 \/a\/b\.ts:1" judge timeout: no exit within 10 ms stderr="slow thing" \(source=the test\)$/);
  assert.match(log[1], /line 5 .* judge nonzero: exit 2 \(source=the test\)$/);

  // No time left: every statement is skipped with a log line and no call.
  const before = calls.length;
  const none = await judgeStage([st(9, "CITE", "x")], judge, { env: box.env, startedAt: Date.now() - 20_000, budgetMs: 10_000, run });
  assert.deepEqual(none, []);
  assert.equal(calls.length, before);
  assert.match(readFileSync(skippedLogPath(box.env), "utf8").split("\n").at(-2), /line 9 .* judge skipped: no time left in the hook's budget \(source=the test\)$/);

  // A runner that throws is a spawn-failed line, not a crash.
  const thrown = await judgeStage([st(10, "CLAIM", "y")], judge, { env: box.env, budgetMs: 10_000, run: async () => { throw new Error("boom"); } });
  assert.deepEqual(thrown, []);
  assert.match(readFileSync(skippedLogPath(box.env), "utf8").split("\n").at(-2), /line 10 .* judge spawn-failed: boom/);
  assert.ok(existsSync(skippedLogPath(box.env)));
});

test("judgeStage with the real runner: a shell judge that answers fail, one that times out (killed inside the clamp)", async () => {
  const box = sandbox();
  const started = Date.now();
  const findings = await judgeStage([st(1, "CLAIM", "a"), st(2, "CLAIM", "b")], { command: "echo '{\"verdict\":\"fail\",\"reason\":\"nope\"}'", timeoutMs: 5_000, source: "s" }, { env: box.env, budgetMs: 10_000 });
  assert.deepEqual(findings.map((f) => f.statement.line), [1, 2]);
  const slow = await judgeStage([st(3, "CLAIM", "c")], { command: "sleep 30", timeoutMs: 30_000, source: "s" }, { env: box.env, budgetMs: 2_400, marginMs: 2_000 });
  assert.deepEqual(slow, []);
  assert.ok(Date.now() - started < 3_000, "the call was clamped to the 400 ms left");
  assert.match(readFileSync(skippedLogPath(box.env), "utf8"), /line 3 .* judge timeout: no exit within 400 ms/);
});
