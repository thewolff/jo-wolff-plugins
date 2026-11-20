// review-receipt-edit.test.mjs — a finding raised under one pattern-check receipt, after the
// human edits a criterion in it (0.4.10). The labs always read the current receipt; each finding
// records the hash of the receipt it was raised under; a dropped finding whose receipt changed
// goes to the judge with the receipt diff, quotation evidence, the current receipt and a question
// that counts a removed requirement as resolved. Reproduces newdle-web 2026-11-19 (35eb3e4f),
// where the judge re-asserted "markdown image syntax inserts nothing" after it was edited out.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, cli, openDb } from "./helpers.mjs";
import { JUDGE_QUESTION, PASSAGE_CAP_BYTES, QUOTE_CAP_BYTES, RECEIPT_CHANGED_QUESTION, passageFor, receiptChangeUnits } from "../lib/ledger-judge.mjs";
import { removedQuotes, textDiff } from "../lib/review.mjs";

const SID = "s-receipt-edit";
const OLD_AC5 = "5. Image file paste -> still uploads; markdown image syntax inserts nothing.";
const NEW_AC5 =
  '5. Image file paste -> still uploads. Markdown containing an image, a table or raw HTML inserts as literal plain text (changed by Jo: supersedes "markdown image syntax inserts nothing").';
const plan = (ac5) => `# PLAN\n\n## Acceptance\n1. Plain-text markdown paste is formatted.\n${ac5}\n6. ScriptEditor paste behaviour unchanged.\n`;
const FINDING = "1. [blocking] fault-tolerance: `c.txt:1` — Markdown images insert literal text, contradicting acceptance criterion 5 (“markdown image syntax inserts nothing”).";

function git(b, ...args) {
  const r = spawnSync("git", args, { cwd: b.work, encoding: "utf8", env: { ...b.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function commit(b, name, text) {
  writeFileSync(join(b.work, name), text);
  git(b, "add", name);
  git(b, "commit", "-qm", `add ${name}`);
}
function repo() {
  const b = sandbox();
  git(b, "init", "-q", "-b", "main");
  commit(b, "a.txt", "one\n");
  git(b, "checkout", "-q", "-b", "feat");
  commit(b, "c.txt", "insert(plain)\n");
  b.writeConfig({ review: { mode: "gate", labs: ["codex"], claudexDirs: [] } });
  return b;
}
let n = 0;
/** A receipt at .pattern-check/PLAN.md, stamped `n` seconds later than the last, so it is the newest. */
const writeReceipt = (b, text) => {
  mkdirSync(join(b.work, ".pattern-check"), { recursive: true });
  const path = join(b.work, ".pattern-check", "PLAN.md");
  writeFileSync(path, text);
  const t = Date.now() / 1000 + ++n;
  utimesSync(path, t, t);
};
/** A lab stub that saves its stdin to `<path>.prompt` and prints `reply`. */
function lab(b, name, reply) {
  const path = join(b.root, `stub-${name}`);
  writeFileSync(path, `#!/bin/sh\ncat > "${path}.prompt"\ncat <<'EOF'\n${reply}\nEOF\n`);
  chmodSync(path, 0o755);
  return path;
}
/** A judge stub: prints `answer` and saves its stdin to `<path>.prompt`. */
function judge(b, answer) {
  const path = join(b.root, `judge-${answer}-${++n}`);
  writeFileSync(path, `#!/bin/sh\ncat > "${path}.prompt"\necho ${answer}\n`);
  chmodSync(path, 0o755);
  return path;
}
const review = (b, args, env) => cli(b, ["review", ...args], { env: { LEDGER_SESSION_ID: SID, ...env } });
const rows = (b) => {
  const db = openDb(b);
  try {
    return db.prepare("SELECT lab, verdict, findings_json FROM cc_reviews ORDER BY id").all().map((r) => ({ ...r, items: r.findings_json ? JSON.parse(r.findings_json) : [] }));
  } finally {
    db.close();
  }
};
const meta = (b, key) => {
  const db = openDb(b);
  try {
    return db.prepare("SELECT value FROM cc_meta WHERE key = ?").get(key)?.value ?? null;
  } finally {
    db.close();
  }
};

test("(a) an edited criterion reaches the lab and the judge; the old one is shown only as removed, and a yes clears the finding", () => {
  const b = repo();
  writeReceipt(b, plan(OLD_AC5));
  const first = lab(b, "codex-1", FINDING);
  const r1 = review(b, [], { LEDGER_REVIEW_BIN_CODEX: first });
  assert.match(r1.out, /codex: findings/, r1.out);
  const raised = rows(b)[0].items[0];
  assert.match(raised.receipt, /^[0-9a-f]{64}$/, "the finding records the receipt it was raised under");
  assert.equal(meta(b, `receipt:${raised.receipt}`), plan(OLD_AC5), "the receipt text is kept for later rounds");

  writeReceipt(b, plan(NEW_AC5));
  const second = lab(b, "codex-2", "PASS");
  const yes = judge(b, "yes");
  const r2 = review(b, [], { LEDGER_REVIEW_BIN_CODEX: second, LEDGER_JUDGE_BIN: yes });
  assert.match(r2.out, /codex: pass/, r2.out);
  assert.match(r2.out, /judge yes/, r2.out);

  const labPrompt = readFileSync(`${second}.prompt`, "utf8");
  assert.ok(labPrompt.includes(NEW_AC5), "the lab reads the current criterion");
  assert.ok(!labPrompt.includes(OLD_AC5), "the old criterion's line is not in the lab's prompt");

  const judged = readFileSync(`${yes}.prompt`, "utf8");
  assert.ok(judged.includes("The pattern-check receipt changed since the finding was raised."), judged.slice(0, 400));
  assert.ok(judged.includes(`-${OLD_AC5}`), "the old line is shown as removed");
  assert.ok(judged.includes(`+${NEW_AC5}`), "the new line is shown as added");
  assert.ok(judged.includes("The finding quotes “markdown image syntax inserts nothing”, which is on a line the receipt edit removed or replaced."));
  assert.ok(judged.includes(`Current receipt:\n${plan(NEW_AC5)}`));
  assert.ok(judged.includes("(no code changes since the finding was raised; the receipt changed, see above)"));
  assert.ok(!judged.includes("Pattern-check receipt (current text):"), "the current receipt is shown once");
  assert.ok(judged.includes(`Question: ${RECEIPT_CHANGED_QUESTION}`));
  const after = rows(b).at(-1);
  assert.equal(after.verdict, "pass");
  assert.equal(after.items[0].resolved, true);
});

test("(a) the judge still decides: a no after the edit keeps the finding open", () => {
  const b = repo();
  writeReceipt(b, plan(OLD_AC5));
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: lab(b, "codex-1", FINDING) });
  writeReceipt(b, plan(NEW_AC5));
  const no = judge(b, "no");
  const r = review(b, [], { LEDGER_REVIEW_BIN_CODEX: lab(b, "codex-2", "PASS"), LEDGER_JUDGE_BIN: no });
  assert.match(r.out, /codex: findings/, r.out);
  assert.match(readFileSync(`${no}.prompt`, "utf8"), /receipt changed since the finding was raised/);
});

test("(a5) the current receipt exists but cannot be read: not treated as an edit; default question, no receipt-change section", () => {
  const b = repo();
  writeReceipt(b, plan(OLD_AC5));
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: lab(b, "codex-1", FINDING) });
  const path = join(b.work, ".pattern-check", "PLAN.md");
  chmodSync(path, 0o000);
  try {
    const no = judge(b, "no");
    const r = review(b, [], { LEDGER_REVIEW_BIN_CODEX: lab(b, "codex-2", "PASS"), LEDGER_JUDGE_BIN: no });
    assert.match(r.out, /codex: findings/, r.out);
    const judged = readFileSync(`${no}.prompt`, "utf8");
    assert.ok(!judged.includes("receipt changed"), judged.slice(0, 300));
    assert.ok(judged.includes(`Question: ${JUDGE_QUESTION}`));
  } finally {
    chmodSync(path, 0o644);
  }
});

test("(a) with the receipt unchanged, a dropped finding is judged as before: default question, no receipt-change section", () => {
  const b = repo();
  writeReceipt(b, plan(OLD_AC5));
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: lab(b, "codex-1", FINDING) });
  const yes = judge(b, "yes");
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: lab(b, "codex-2", "PASS"), LEDGER_JUDGE_BIN: yes });
  const judged = readFileSync(`${yes}.prompt`, "utf8");
  assert.ok(!judged.includes("receipt changed"), judged.slice(0, 300));
  assert.ok(judged.includes("(no changes since the finding was raised)"));
  assert.ok(judged.includes("Pattern-check receipt (current text):"), "a fault-tolerance finding still gets the receipt");
  assert.ok(judged.includes(`Question: ${JUDGE_QUESTION}`));
});

test("(a) a missing receipt snapshot: the judge gets the current receipt, the receipt question, and a line saying the earlier text is not on record", () => {
  const b = repo();
  writeReceipt(b, plan(OLD_AC5));
  review(b, [], { LEDGER_REVIEW_BIN_CODEX: lab(b, "codex-1", FINDING) });
  const db = openDb(b);
  db.prepare("DELETE FROM cc_meta WHERE key LIKE 'receipt:%'").run();
  db.close();
  writeReceipt(b, plan(NEW_AC5));
  const yes = judge(b, "yes");
  const r = review(b, [], { LEDGER_REVIEW_BIN_CODEX: lab(b, "codex-2", "PASS"), LEDGER_JUDGE_BIN: yes });
  assert.equal(r.code, 0, r.out);
  const judged = readFileSync(`${yes}.prompt`, "utf8");
  assert.ok(judged.includes("The receipt's text when the finding was raised is not on record; only the current text is shown."));
  assert.ok(judged.includes(`Current receipt:\n${plan(NEW_AC5)}`));
  assert.ok(judged.includes(`Question: ${RECEIPT_CHANGED_QUESTION}`));
});

test("(a3) review addressed: unchanged receipt → default question; edited receipt → the receipt question and diff, for a finding not tagged fault-tolerance", () => {
  for (const edit of [false, true]) {
    const b = repo();
    writeReceipt(b, plan(OLD_AC5));
    review(b, [], { LEDGER_REVIEW_BIN_CODEX: lab(b, "codex-1", "1. [blocking] `c.txt:1` breaks criterion 5 (“markdown image syntax inserts nothing”).") });
    assert.equal(rows(b)[0].items[0].kind, undefined, "not a fault-tolerance finding");
    commit(b, "d.txt", "unrelated\n");
    if (edit) writeReceipt(b, plan(NEW_AC5));
    const yes = judge(b, "yes");
    const r = review(b, ["addressed", "criterion 5 was changed by the human"], { LEDGER_JUDGE_BIN: yes });
    assert.equal(r.code, 0, r.out);
    const judged = readFileSync(`${yes}.prompt`, "utf8");
    if (edit) {
      assert.ok(judged.includes(`Question: ${RECEIPT_CHANGED_QUESTION}`), "edited");
      assert.ok(judged.includes(`-${OLD_AC5}`));
      assert.ok(judged.includes(`Current receipt:\n${plan(NEW_AC5)}`));
    } else {
      assert.ok(judged.includes(`Question: ${JUDGE_QUESTION}`), "unchanged");
      assert.ok(!judged.includes("receipt changed"));
    }
  }
});

test("(a2) over the cap: the receipt diff, the quotation evidence and a retained requirement survive a passage filled by source", () => {
  const big = Array.from({ length: 900 }, (_, i) => `${String(i + 1).padStart(4)}| const filler${i} = insert(plain); // ${"x".repeat(20)}`).join("\n");
  const current = [{ path: "c.txt", from: 1, to: 900, text: big, rank: 0 }];
  const rdiff = textDiff(plan(OLD_AC5), plan(NEW_AC5));
  const passage = passageFor(FINDING, "diff --git a/c.txt b/c.txt\n@@ -1 +1 @@\n-a\n+b", {
    current,
    focus: ["insert"],
    receiptChange: { diff: rdiff, quotes: removedQuotes(FINDING, rdiff), current: plan(NEW_AC5) },
  });
  assert.ok(Buffer.byteLength(passage) <= PASSAGE_CAP_BYTES);
  assert.match(passage, /\[cut: the passage was/);
  assert.ok(passage.includes(`-${OLD_AC5}`));
  assert.ok(passage.includes("The finding quotes “markdown image syntax inserts nothing”"));
  assert.ok(passage.includes("6. ScriptEditor paste behaviour unchanged."), "an unchanged requirement of the current receipt is still shown");
});

test("(a2b) a short quotation on a 20 KiB removed line, and seven quotations: evidence holds only the quotations, five at most, and the current receipt still fits", () => {
  const long = `5. ${"y".repeat(20 * 1024)} markdown image syntax inserts nothing ${"z".repeat(100)}`;
  const rdiff = textDiff(plan(long), plan(NEW_AC5));
  const many = ["markdown image syntax inserts nothing", "first other quote", "second other quote", "third other quote", "fourth other quote", "fifth other quote", `${"q".repeat(300)} sixth`];
  const finding = many.map((q) => `“${q}”`).join(" and ");
  const removedLine = `${long} ${many.slice(1).join(" ")}`;
  const quotes = removedQuotes(finding, `-${removedLine}\n`);
  assert.equal(quotes.length, 7);
  assert.deepEqual(removedQuotes(FINDING, rdiff), ["markdown image syntax inserts nothing"], "found inside the 20 KiB line");
  const units = receiptChangeUnits({ diff: rdiff, quotes, current: plan(NEW_AC5) });
  const evidence = units[1].text;
  assert.ok(Buffer.byteLength(evidence) <= 1.3 * 1024, `${Buffer.byteLength(evidence)} bytes`);
  assert.equal(evidence.split("\n").length, 6);
  assert.match(evidence, /\(2 more quotations not shown\)$/);
  assert.ok(!evidence.includes("y".repeat(50)), "the receipt line itself is not copied");
  assert.ok(evidence.split("\n").every((l) => Buffer.byteLength(l) < QUOTE_CAP_BYTES + 120));
  const passage = passageFor(finding, "", { receiptChange: { diff: rdiff, quotes, current: plan(NEW_AC5) }, current: [{ path: "c.txt", from: 1, to: 1, text: "w".repeat(40 * 1024), rank: 1 }] });
  assert.ok(Buffer.byteLength(passage) <= PASSAGE_CAP_BYTES);
  assert.ok(passage.includes(`Current receipt:\n${plan(NEW_AC5)}`));
  assert.ok(passage.includes("(2 more quotations not shown)"));
});

test("(a4) the receipt diff cannot be built (no temporary folder): null and one log line, no throw; the judge gets the earlier text whole", () => {
  const saved = process.env.TMPDIR;
  const b = sandbox();
  process.env.TMPDIR = join(b.root, "no-such-tmp");
  const savedState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = b.env.XDG_STATE_HOME;
  let out;
  try {
    out = textDiff(plan(OLD_AC5), plan(NEW_AC5));
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    if (savedState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedState;
  }
  assert.equal(out, null);
  assert.match(readFileSync(b.errorsLog, "utf8"), /receipt diff not built/);
  const units = receiptChangeUnits({ diff: null, old: plan(OLD_AC5), quotes: [], current: plan(NEW_AC5) });
  assert.ok(units[0].text.startsWith("The receipt diff could not be built; the receipt's text when the finding was raised:\n"));
  assert.ok(units[0].text.includes(OLD_AC5));
});
