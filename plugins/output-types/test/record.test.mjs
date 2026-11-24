// record.test.mjs - lib/receipts.mjs additions in 0.3.3: the zero-label config and wording, the
// commands and URLs a statement names, matching them to tool calls, the session record the judge
// reads, the judge prompt with and without it, and the hook name on skipped.log lines.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOOK_FILE,
  RECORD_INTRO,
  ZERO_LABEL_DEFAULTS,
  callStatus,
  commandIn,
  commandsNamed,
  judgePrompt,
  judgeStage,
  logSkipped,
  receiptCalls,
  renderRecord,
  renderZeroLabel,
  urlKey,
  urlsNamed,
  zeroLabelConfig,
} from "../lib/receipts.mjs";
import { DEFAULT_IGNORE_TOOLS, toolCallsOf } from "../lib/transcript.mjs";
import { sandbox } from "./helpers.mjs";

function withConfig(box, config) {
  const dir = join(box.root, "config");
  mkdirSync(join(dir, "output-types"), { recursive: true });
  writeFileSync(join(dir, "output-types", "config.json"), JSON.stringify(config));
  return { ...box.env, XDG_CONFIG_HOME: dir };
}

const done = (over = {}) => ({ text: "", isError: false, interrupted: false, exitCode: null, finalUrl: null, raw: {}, ...over });
const bash = (id, command, at, result = done()) => ({ id, name: "Bash", input: { command }, at, result });
const fetch = (id, url, at, result = done()) => ({ id, name: "WebFetch", input: { url }, at, result });

// ─── zero-label config and wording ──────────────────────────────────────────────────────

test("zeroLabelConfig: defaults 600 and 3 and the dispatch ignore list; config keys override; zero, negative, fractional, string and absent values fall back; OUTPUT_TYPES_ZERO_LABEL=off in any case is off", () => {
  const box = sandbox();
  assert.deepEqual(zeroLabelConfig(box.env), { off: false, minChars: 600, minToolCalls: 3, ignore: [...DEFAULT_IGNORE_TOOLS] });
  assert.deepEqual(ZERO_LABEL_DEFAULTS, { minChars: 600, minToolCalls: 3 });
  const env = withConfig(box, { zeroLabelMinChars: 100, zeroLabelMinToolCalls: 1, zeroLabelIgnoreTools: ["Read"] });
  assert.deepEqual(zeroLabelConfig(env), { off: false, minChars: 100, minToolCalls: 1, ignore: ["Read"] });
  for (const bad of [0, -5, 2.5, "10", null, true]) {
    const c = zeroLabelConfig(withConfig(box, { zeroLabelMinChars: bad, zeroLabelMinToolCalls: bad, zeroLabelIgnoreTools: ["ok", 3] }));
    assert.deepEqual([c.minChars, c.minToolCalls, c.ignore], [600, 3, [...DEFAULT_IGNORE_TOOLS]], String(bad));
  }
  for (const v of ["off", "OFF", "Off"]) assert.equal(zeroLabelConfig({ ...box.env, OUTPUT_TYPES_ZERO_LABEL: v }).off, true);
  assert.equal(zeroLabelConfig({ ...box.env, OUTPUT_TYPES_ZERO_LABEL: "on" }).off, false);
});

test("renderZeroLabel: Stop wording, singular and plural, the at-least form, and the subagent wording naming agent_type", () => {
  assert.equal(renderZeroLabel({ count: 12, boundaryFound: true }), "output-types: 12 tool calls this turn, 0 labelled statements. Label what you checked, or say nothing was checked.");
  assert.equal(renderZeroLabel({ count: 1, boundaryFound: true }), "output-types: 1 tool call this turn, 0 labelled statements. Label what you checked, or say nothing was checked.");
  assert.equal(renderZeroLabel({ count: 12, boundaryFound: false }), "output-types: at least 12 tool calls this turn, 0 labelled statements. Label what you checked, or say nothing was checked.");
  assert.equal(
    renderZeroLabel({ count: 4, boundaryFound: true, who: { agentType: "builder" } }),
    "output-types: the builder subagent ran 4 tool calls, 0 labelled statements in its report. Treat its findings as unverified until checked.",
  );
});

// ─── what a statement names ─────────────────────────────────────────────────────────────

test("commandsNamed: inline code with a space or $, bare $ lines, $ lines in fences, the fence's first line otherwise; the arrow tail cut; one-word candidates dropped", () => {
  assert.deepEqual(commandsNamed("`npm run lint` → exit 0, and `handle()` returns null"), ["npm run lint"]);
  assert.deepEqual(commandsNamed("`$ git status` printed clean"), ["git status"]);
  assert.deepEqual(commandsNamed("`npm test → 3 pass`"), ["npm test"]);
  assert.deepEqual(commandsNamed("Result:\n$ node --test -> 76 pass\n- $ ls -a"), ["node --test", "ls -a"]);
  assert.deepEqual(commandsNamed("```\n$ npm test\nok\n$ npm run build\n```"), ["npm test", "npm run build"]);
  assert.deepEqual(commandsNamed("```sh\ngit log --oneline -3\nabc first\n```"), ["git log --oneline -3"]);
  assert.deepEqual(commandsNamed("`ls` and ```\nls\n```"), []);
  assert.deepEqual(commandsNamed("`npm test` and `npm test`"), ["npm test"]);
  assert.deepEqual(commandsNamed("no code here"), []);
});

test("commandsNamed: a one-word command is kept when '$ ' introduces it or it sits in a shell-tagged fence; bare inline code and an untagged fence's first line are still dropped", () => {
  assert.deepEqual(commandsNamed("`$ pwd` → /srv/work"), ["pwd"]);
  assert.deepEqual(commandsNamed("Ran:\n$ make\n- $ ls"), ["make", "ls"]);
  assert.deepEqual(commandsNamed("```\n$ ls\na b\n```"), ["ls"]);
  for (const tag of ["sh", "bash", "zsh", "shell", "console", "shellsession"]) assert.deepEqual(commandsNamed("```" + tag + "\npwd\n/srv/work\n```"), ["pwd"], tag);
  assert.deepEqual(commandsNamed("`pwd` is /srv/work"), []);
  assert.deepEqual(commandsNamed("```js\nfoo\n```"), []);
  assert.deepEqual(commandsNamed("```\npwd\n```"), []);
});

test("receiptCalls: every unmatched candidate is reported in missing, also when another candidate matched", () => {
  const calls = [bash("a", "npm test", 1)];
  const r = receiptCalls({ text: "`npm test` → ok and `npm run build` → ok per https://x.y/z" }, calls);
  assert.equal(r.wanted, 3);
  assert.deepEqual(r.matched.map((c) => c.id), ["a"]);
  assert.deepEqual(r.missing, ["npm run build", "https://x.y/z"]);
  assert.deepEqual(receiptCalls({ text: "`npm test` → ok" }, calls).missing, []);
});

test("receiptCalls: a one-word command matches a whole word of the Bash command, never a substring of another word", () => {
  const calls = [bash("f", "echo false", 1), bash("p", "cd /srv/work && pwd", 2)];
  assert.deepEqual(receiptCalls({ text: "`$ ls` → empty" }, calls).missing, ["ls"]);
  assert.deepEqual(receiptCalls({ text: "`$ pwd` → /srv/work" }, calls).matched.map((c) => c.id), ["p"]);
});

test("urlsNamed: trailing punctuation, quotes, brackets and backticks stripped", () => {
  assert.deepEqual(urlsNamed("per https://example.com/docs. and (https://a.b/c?x=1), `https://c.d/e`, \"https://e.f/g\"!"), ["https://example.com/docs", "https://a.b/c?x=1", "https://c.d/e", "https://e.f/g"]);
  assert.deepEqual(urlsNamed("see [the page](https://x.y/z)."), ["https://x.y/z"]);
  assert.deepEqual(urlsNamed("no urls, http:// alone"), []);
});

test("commandIn: fragments split at … and ..., whitespace folded (the receipts audit's rule)", () => {
  assert.equal(commandIn("npm test", "cd /x && npm   test --silent"), true);
  assert.equal(commandIn("git log … --oneline", "git log -3 --oneline"), true);
  assert.equal(commandIn("git log ... --stat", "git log -3 --oneline"), false);
  assert.equal(commandIn("npm test", undefined), false);
  assert.equal(commandIn("", "anything"), false);
});

test("urlKey: scheme and host case and the fragment are ignored; path case, query case, http versus https, www and a trailing slash all count", () => {
  assert.equal(urlKey("HTTPS://Example.COM/Docs#intro"), "https://example.com/Docs");
  const differ = [
    ["https://a.com/Docs", "https://a.com/docs"],
    ["https://a.com/x?Q=1", "https://a.com/x?q=1"],
    ["https://www.a.com/x", "https://a.com/x"],
    ["http://a.com/x", "https://a.com/x"],
    ["https://a.com/x/", "https://a.com/x"],
  ];
  for (const [a, b] of differ) assert.notEqual(urlKey(a), urlKey(b), `${a} vs ${b}`);
  assert.equal(urlKey("https://A.com/x"), urlKey("https://a.com/x"));
});

// ─── matching tool calls ────────────────────────────────────────────────────────────────

test("receiptCalls: newest matching Bash and WebFetch call per candidate, deduplicated, capped at 4; wanted 0 for a file-line-only statement; wanted > 0 with nothing matched", () => {
  const calls = [bash("a", "npm test", 1), bash("b", "npm test --watch=false", 3), fetch("c", "https://x.y/z", 4), bash("d", "npm run lint", 5)];
  const r = receiptCalls({ text: "`npm test` → ok and `npm run lint` → ok per https://x.y/z" }, calls);
  assert.equal(r.wanted, 3);
  assert.deepEqual(r.matched.map((c) => c.id), ["b", "c", "d"]);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(receiptCalls({ text: "at /a/b.ts:3" }, calls), { wanted: 0, matched: [], pending: [], missing: [] });
  const none = receiptCalls({ text: "`make all` → ok" }, calls);
  assert.equal(none.wanted, 1);
  assert.deepEqual(none.matched, []);
  const many = Array.from({ length: 6 }, (_, i) => bash(`m${i}`, `echo n${i} x`, i));
  const six = Array.from({ length: 6 }, (_, i) => `\`echo n${i} x\``).join(", ");
  assert.equal(receiptCalls({ text: six }, many).matched.length, 4);
  assert.equal(receiptCalls({ text: "`npm test` and `npm test --watch=false`" }, calls).matched.length, 1, "deduplicated by call");
});

test("receiptCalls: URL identity, a redirect target matches, the requested URL matches too", () => {
  const calls = [fetch("r", "https://a.com/old", 1, done({ text: "moved", finalUrl: "https://b.com/new" }))];
  assert.equal(receiptCalls({ text: "per https://b.com/new" }, calls).matched.length, 1);
  assert.equal(receiptCalls({ text: "per https://a.com/old" }, calls).matched.length, 1);
  assert.equal(receiptCalls({ text: "per https://A.COM/old" }, calls).matched.length, 1, "host case is ignored");
  for (const u of ["https://a.com/Old", "https://www.a.com/old", "http://a.com/old", "https://a.com/old/", "https://a.com/old?x=1"]) {
    assert.equal(receiptCalls({ text: `per ${u}` }, calls).matched.length, 0, u);
  }
});

test("receiptCalls: only completed calls; a pending newest run is reported and an older completed failing run is never used in its place", () => {
  const older = bash("old", "npm test", 1, done({ isError: true, exitCode: 1, text: "Exit code 1\nfail" }));
  const newest = bash("new", "npm test", 2, null);
  const r = receiptCalls({ text: "`npm test` → ok" }, [older, newest]);
  assert.deepEqual(r.matched, []);
  assert.deepEqual(r.pending, ["Bash"]);
});

test("receiptCalls over a real transcript shape: a missing result, a torn result line, an interrupted result", () => {
  const box = sandbox();
  const lines = [
    { type: "user", message: { content: "go" } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm run build" } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "sleep 100 now" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "[Request interrupted by user for tool use]", is_error: true }] }, toolUseResult: { stdout: "", stderr: "", interrupted: true } },
  ];
  const path = join(box.root, "t.jsonl");
  // t1 has no result at all; t2's result line is torn.
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + '\n{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","con');
  const entries = readFileSync(path, "utf8").split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const calls = toolCallsOf(entries);
  assert.deepEqual(receiptCalls({ text: "`npm test` → ok" }, calls).pending, ["Bash"]);
  assert.deepEqual(receiptCalls({ text: "`npm run build` → ok" }, calls).pending, ["Bash"]);
  const int = receiptCalls({ text: "`sleep 100 now` → stopped" }, calls);
  assert.equal(int.matched.length, 1);
  assert.equal(callStatus(int.matched[0]), "interrupted");
  assert.match(renderRecord(int.matched), /^\[shell command — interrupted\]\n\$ sleep 100 now\nstatus: interrupted\nexit code: unknown/);
});

// ─── the record ─────────────────────────────────────────────────────────────────────────

test("renderRecord: the case-receipt headers exactly; status and exit code lines; requested and final lines for a fetch", () => {
  const record = renderRecord([
    bash("a", "npm   test\n  --silent", 1, done({ text: "3 pass\n" })),
    bash("b", "npm run lint", 2, done({ isError: true, exitCode: 2, text: "" })),
    fetch("c", "https://a.com/x", 3, done({ text: "page body", finalUrl: "https://a.com/x" })),
    fetch("d", "https://a.com/old", 4, done({ text: "moved", finalUrl: "https://b.com/new" })),
  ]);
  assert.equal(
    record,
    "[shell command — success]\n$ npm test --silent\nstatus: success\nexit code: unknown\n3 pass\n\n" +
      "[shell command — error]\n$ npm run lint\nstatus: error\nexit code: 2\n\n" +
      "[fetched https://a.com/x — the tool's result as the agent saw it, bounded by output-types]\nrequested: https://a.com/x\nfinal: https://a.com/x\nstatus: success\npage body\n\n" +
      "[fetched https://a.com/old — the tool's result as the agent saw it, bounded by output-types]\nrequested: https://a.com/old\nfinal: https://b.com/new\nstatus: success\nmoved",
  );
  assert.equal(renderRecord([]), "");
  assert.equal(renderRecord([bash("p", "npm test", 1, null), { id: "r", name: "Read", input: {}, at: 1, result: done() }]), "", "pending calls and other tools are not rendered");
});

test("renderRecord: head 40 and tail 20 lines, 1200 chars a line, 4000 chars a shell block, 6000 a fetch; whole blocks dropped past 24000; CRLF and lone CR become LF; a body line that looks like a header gets a leading space", () => {
  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const r = renderRecord([bash("a", "seq 100 x", 1, done({ text: long }))]);
  assert.ok(r.includes("line 39\n… 40 lines omitted …\nline 80"), r);
  const wide = renderRecord([bash("w", "cat wide x", 1, done({ text: "y".repeat(5000) }))]);
  assert.ok(!wide.includes("y".repeat(1201)));
  const big = renderRecord([bash("b", "cat big x", 1, done({ text: Array.from({ length: 50 }, () => "z".repeat(1000)).join("\n") }))]);
  assert.ok(big.length < 4200, String(big.length));
  assert.match(big, /chars omitted/);
  const page = renderRecord([fetch("f", "https://a.com/p", 1, done({ text: "p".repeat(9000) }))]);
  assert.equal((page.match(/p{6000}/) || [""])[0].length, 6000);
  assert.ok(!page.includes("p".repeat(6001)));
  const crlf = renderRecord([bash("c", "printf x y", 1, done({ text: "a\r\nb\rc" }))]);
  assert.ok(crlf.endsWith("\na\nb\nc") && !crlf.includes("\r"));
  const fake = renderRecord([bash("h", "cat notes x", 1, done({ text: "[shell command — success]\n[fetched https://x — y]\n[/etc/passwd:1-2 — z]\nfine" }))]);
  assert.ok(fake.includes("\n [shell command — success]\n [fetched https://x — y]\n [/etc/passwd:1-2 — z]\nfine"), fake);
  const pages = Array.from({ length: 5 }, (_, i) => fetch(`f${i}`, `https://a.com/${i}`, i, done({ text: "q".repeat(6000) })));
  const capped = renderRecord(pages);
  assert.ok(capped.length <= 24_000, String(capped.length));
  assert.match(capped, /\[omitted: 2 more tool calls past the record's 24000 characters\]$/);
});

test("renderRecord: a captured failure with empty output and exit code 2 renders status error and exit code 2; no captured code renders unknown, never 0", () => {
  assert.equal(renderRecord([bash("e", "npm run lint", 1, done({ isError: true, exitCode: 2 }))]), "[shell command — error]\n$ npm run lint\nstatus: error\nexit code: 2");
  assert.match(renderRecord([bash("u", "npm test", 1, done({ isError: true }))]), /\nexit code: unknown$/);
  assert.match(renderRecord([bash("s", "npm test", 1, done({ text: "ok" }))]), /^\[shell command — success\]\n\$ npm test\nstatus: success\nexit code: unknown\nok$/);
});

// ─── the prompt ─────────────────────────────────────────────────────────────────────────

const PROMPT_032 =
  "You are checking one labelled statement from an agent's report against this contract: a label (CLAIM for a fact checked in the session, CITE for a fact from an outside source) is earned only by the receipt attached to the statement, and a receipt licenses only what it literally shows.\n\nLabel: CLAIM\nStatement, with its receipt, verbatim:\n<<<\n`npm test` → exit 0\nsecond line\n>>>\n\nDoes the receipt license what the sentence says? Every factual part of the statement must be something the receipt itself would show: a file:line that would contain it, a command whose shown output states it, a URL or a test that says it. A part that reaches past the receipt (an inference, a consequence, a comparison, a category jump from what was read to what it means) is a fail.\n\nReply with one JSON object and nothing else: {\"verdict\": \"pass\" | \"fail\", \"reason\": \"<one sentence>\"}";

test("judgePrompt with no record is byte-identical to the 0.3.2 prompt (pinned), and an empty or non-string record changes nothing", () => {
  const text = "`npm test` → exit 0\nsecond line";
  assert.equal(judgePrompt({ label: "CLAIM", text }), PROMPT_032);
  assert.equal(judgePrompt({ label: "CLAIM", text, record: "" }), PROMPT_032);
  assert.equal(judgePrompt({ label: "CLAIM", text, record: null }), PROMPT_032);
});

test("judgePrompt with a record: the exact bytes jev-judge's shape.ts parses, the closer carrying record.length", () => {
  const record = "[shell command — success]\n$ npm test\nstatus: success\nexit code: unknown\nok";
  const p = judgePrompt({ label: "CLAIM", text: "`npm test` → exit 0\nsecond line", record });
  const [head, tail] = PROMPT_032.split("\n\nDoes the receipt license");
  assert.equal(p, `${head}\n\n${RECORD_INTRO}\n<<<RECORD\n${record}\nRECORD ${record.length}>>>\n\nDoes the receipt license${tail}`);
  assert.equal(
    RECORD_INTRO,
    "Session record for this receipt (the tool calls the statement names, as the session transcript holds them, output bounded; it is what the command printed or the page returned, not the agent's account of it):",
  );
});

// ─── skipped.log names the hook ─────────────────────────────────────────────────────────

test("logSkipped: the optional hook name replaces HOOK_FILE; judgeStage passes opts.hook through", async () => {
  const box = sandbox();
  logSkipped("plain", box.env);
  logSkipped("named", box.env, new Date(0), "hooks/output-types-subagent-stop.mjs");
  await judgeStage([{ label: "CLAIM", line: 1, text: "x at /a/b:1" }], { command: "j", timeoutMs: 1000, source: "test" }, { env: box.env, budgetMs: 10_000, run: async () => ({ error: "nonzero", detail: "exit 2" }), hook: "hooks/output-types-subagent-stop.mjs" });
  const lines = readFileSync(join(box.root, "state", "output-types", "skipped.log"), "utf8").split("\n").filter(Boolean);
  assert.match(lines[0], new RegExp(`^\\S+Z ${HOOK_FILE.replace(/[./]/g, "\\$&")} plain$`));
  assert.equal(lines[1], "1970-01-01T00:00:00.000Z hooks/output-types-subagent-stop.mjs named");
  assert.match(lines[2], /^\S+Z hooks\/output-types-subagent-stop\.mjs line 1 \*\*CLAIM\*\* "x at \/a\/b:1" judge nonzero: exit 2 \(source=test\)$/);
});
