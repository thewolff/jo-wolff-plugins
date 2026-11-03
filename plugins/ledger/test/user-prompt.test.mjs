import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, hook, cli, openDb, count } from "./helpers.mjs";
import { ledgerLines, looksLikeLedgerLine } from "../hooks/user-prompt.mjs";

const box = sandbox();
const prompt = (text, extra = {}) => ({ session_id: "s-prompt", cwd: box.work, hook_event_name: "UserPromptSubmit", prompt: text, ...extra });

function nothing(r) {
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "", `expected no output, got ${r.out}`);
}

test("step 9: `approve q-…\\nwithdraw q-…` → both applied, additionalContext is the batch block, no decision field", () => {
  cli(box, ["open", "prompt"]);
  const q1 = /q-[a-z0-9]+/.exec(cli(box, ["ask", "One?", "--name", "one", "--options", "approve,deny"]).out)[0];
  const q2 = /q-[a-z0-9]+/.exec(cli(box, ["ask", "Two?", "--name", "two", "--options", "approve,deny"]).out)[0];
  const r = hook(box, "user-prompt", prompt(`approve ${q1}\nwithdraw ${q2}`));
  assert.equal(r.code, 0, r.err);
  assert.ok(r.json, r.out);
  assert.equal(r.json.decision, undefined);
  assert.equal(r.json.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^ledger applied the lines in this prompt/);
  assert.match(ctx, new RegExp(`\n1: ok an-[a-z0-9]+ approve → ${q1} \\(one\\)\n2: ok an-[a-z0-9]+ withdrew ${q2} \\(two\\)\napplied 2, refused 0, not commands 0$`));
  assert.match(r.json.systemMessage, /applied 2, refused 0/);
  const db = openDb(box);
  assert.deepEqual(db.prepare("SELECT answered_by, via FROM answers WHERE question_id = ?").get(q1).via, "prompt-hook");
  assert.equal(db.prepare("SELECT state FROM questions WHERE id = ?").get(q2).state, "withdrawn");
  db.close();
});

test("step 9: a prose line anywhere → nothing; a free-text verb → nothing; config off → nothing", () => {
  cli(box, ["open", "prompt 2"]);
  const q = /q-[a-z0-9]+/.exec(cli(box, ["ask", "Three?", "--name", "three", "--options", "approve,deny"]).out)[0];
  nothing(hook(box, "user-prompt", prompt(`can you approve ${q} for me?`)));
  nothing(hook(box, "user-prompt", prompt("open a thing")));
  nothing(hook(box, "user-prompt", prompt('open "a thing"')));
  nothing(hook(box, "user-prompt", prompt(`approve ${q}\nand then carry on with the refactor`)));
  nothing(hook(box, "user-prompt", prompt("")));
  nothing(hook(box, "user-prompt", prompt("fix the login bug")));
  const db = openDb(box);
  assert.equal(count(db, "answers", "question_id = ?", q), 0);
  db.close();
  const b = sandbox();
  b.writeConfig({ hooks: { userPromptCommands: false } });
  nothing(hook(b, "user-prompt", { ...prompt(`approve ${q}`), cwd: b.work }));
});

test("step 9: a refused line is reported, not swallowed, and the prompt is never blocked", () => {
  const r = hook(box, "user-prompt", prompt("raise q-nope"));
  assert.ok(r.json, r.out);
  assert.equal(r.json.decision, undefined);
  assert.match(r.json.hookSpecificOutput.additionalContext, /1: refused no such question q-nope\napplied 0, refused 1/);
});

test("step 9: ordinals, pending, and pasted_content markers; comments and blank lines are ignored", () => {
  const b = sandbox();
  cli(b, ["open", "paste"]);
  const q = /q-[a-z0-9]+/.exec(cli(b, ["ask", "Four?", "--name", "four", "--options", "approve,deny"]).out)[0];
  const r = hook(b, "user-prompt", { ...prompt(`<pasted_content lines="3">\n\n# from pending\n1 deny\npending\n</pasted_content>`), cwd: b.work });
  assert.ok(r.json, r.out);
  const ctx = r.json.hookSpecificOutput.additionalContext;
  // Marker lines are dropped, so numbers count the pasted lines themselves: blank, comment, `1 deny`, `pending`.
  assert.match(ctx, /1: skipped \(blank\)\n2: skipped \(blank\)\n/);
  assert.match(ctx, new RegExp(`3: ok an-[a-z0-9]+ deny → ${q}`));
  assert.match(ctx, /4: ok\nno open questions for /);
});

test("looksLikeLedgerLine and ledgerLines", () => {
  assert.equal(looksLikeLedgerLine("approve q-abc"), true);
  assert.equal(looksLikeLedgerLine("approve q-"), true);
  assert.equal(looksLikeLedgerLine("1 approve"), true);
  assert.equal(looksLikeLedgerLine("pending"), true);
  assert.equal(looksLikeLedgerLine("stale 3"), true);
  assert.equal(looksLikeLedgerLine("help me"), false);
  assert.equal(looksLikeLedgerLine("please fix it"), false);
  assert.equal(looksLikeLedgerLine(""), null);
  assert.equal(looksLikeLedgerLine("# comment"), null);
  assert.equal(looksLikeLedgerLine(`please look at q-abc and ${"word ".repeat(12)}`), false);
  assert.deepEqual(ledgerLines("approve q-abc\n\nclose wl-x done"), ["approve q-abc", "", "close wl-x done"]);
  assert.equal(ledgerLines("approve q-abc\nthanks"), null);
  assert.equal(ledgerLines("\n\n"), null);
});
