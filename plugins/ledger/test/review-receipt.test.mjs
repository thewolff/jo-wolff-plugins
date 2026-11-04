// review-receipt.test.mjs — the pattern-check receipt in the review prompt (README "The review
// and the pattern-check receipt"): the newest `.md` of the receipt directory goes to every lab
// under its heading before `## Diff`, cut at 32 KiB; no directory or no receipt leaves the prompt
// as before; an unreadable receipt is one errors.log line and the prompt as before; a finding
// tagged `fault-tolerance:` keeps that kind.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, cli, openDb } from "./helpers.mjs";
import { newestReceipt } from "../lib/review.mjs";
import { parseItems, receiptSection, PROMPT, RECEIPT_HEADING, RECEIPT_MAX } from "../lib/review/common.mjs";

const SID = "s-receipt";

function git(b, ...args) {
  const r = spawnSync("git", args, { cwd: b.work, encoding: "utf8", env: { ...b.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function repo() {
  const b = sandbox();
  git(b, "init", "-q", "-b", "main");
  writeFileSync(join(b.work, "a.txt"), "one\n");
  git(b, "add", "a.txt");
  git(b, "commit", "-qm", "a");
  git(b, "checkout", "-q", "-b", "feat");
  writeFileSync(join(b.work, "b.txt"), "two\n");
  git(b, "add", "b.txt");
  git(b, "commit", "-qm", "b");
  b.writeConfig({ review: { mode: "gate", labs: ["codex"] } });
  return b;
}
/** A codex stub that saves its stdin to `<path>.prompt` and prints PASS. */
function codex(b) {
  const path = join(b.root, "stub-codex");
  writeFileSync(path, `#!/bin/sh\ncat > "${path}.prompt"\necho PASS\n`);
  chmodSync(path, 0o755);
  return path;
}
const review = (b, bin) => cli(b, ["review"], { env: { LEDGER_SESSION_ID: SID, LEDGER_REVIEW_BIN_CODEX: bin } });
const receipt = (b, dir, name, text, ageS = 0) => {
  mkdirSync(join(b.work, dir), { recursive: true });
  const path = join(b.work, dir, name);
  writeFileSync(path, text);
  const t = (Date.now() - ageS * 1000) / 1000;
  utimesSync(path, t, t);
  return path;
};
/** What the lab was given after the fixed prompt: the receipt section (if any) and the diff. */
const given = (bin) => {
  const all = readFileSync(`${bin}.prompt`, "utf8");
  assert.ok(all.startsWith(`${PROMPT}\n\n`), all.slice(0, 120));
  return all.slice(PROMPT.length + 2);
};
const errorLines = (b) => {
  try {
    return readFileSync(b.errorsLog, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

test("the newest receipt by mtime goes to the lab under its heading, before the diff; the diff follows unchanged", () => {
  const b = repo();
  receipt(b, ".pattern-check", "old.md", "# old receipt\n", 60);
  receipt(b, ".pattern-check", "new.md", "# new receipt\n\n| piece | fails how |\n", 0);
  receipt(b, ".pattern-check", "notes.txt", "not a receipt", 0);
  const bin = codex(b);
  const r = review(b, bin);
  assert.match(r.out, /codex: pass/, r.out);
  const prompt = given(bin);
  const head = prompt.indexOf(`## ${RECEIPT_HEADING}\n\n# new receipt\n\n| piece | fails how |\n\n## Diff\n\n`);
  assert.equal(head, 0, prompt.slice(0, 200));
  assert.ok(!prompt.includes("old receipt"));
  assert.match(prompt, /\n## Diff\n\ndiff --git a\/b\.txt b\/b\.txt\n/);
  assert.deepEqual(errorLines(b), []);
});

test("no receipt directory, or none with a .md in it, leaves the prompt as before: the diff alone", () => {
  const b = repo();
  const bin = codex(b);
  review(b, bin);
  assert.match(given(bin), /^diff --git a\/b\.txt/);
  mkdirSync(join(b.work, ".pattern-check"));
  writeFileSync(join(b.work, ".pattern-check", "README"), "x");
  const b2 = repo();
  const bin2 = codex(b2);
  receipt(b2, ".pattern-check", "notes.txt", "not a receipt");
  review(b2, bin2);
  assert.match(given(bin2), /^diff --git a\/b\.txt/);
  assert.deepEqual(errorLines(b2), []);
});

test("receiptDir from .pattern-check.json is honoured", () => {
  const b = repo();
  writeFileSync(join(b.work, ".pattern-check.json"), JSON.stringify({ receiptDir: "docs/receipts" }));
  receipt(b, "docs/receipts", "s1.md", "# configured dir\n");
  receipt(b, ".pattern-check", "s1.md", "# default dir\n");
  assert.equal(newestReceipt(b.work, b.env).text, "# configured dir\n");
  const bin = codex(b);
  review(b, bin);
  assert.match(given(bin), /^## .*\n\n# configured dir\n\n## Diff/);
});

test("a receipt over 32 KiB is cut with a marker; the lab still gets the diff", () => {
  const b = repo();
  const big = `# big\n${"x".repeat(RECEIPT_MAX + 5000)}\n`;
  receipt(b, ".pattern-check", "big.md", big);
  const bin = codex(b);
  review(b, bin);
  const prompt = given(bin);
  const section = prompt.slice(0, prompt.indexOf("\n## Diff\n"));
  assert.ok(Buffer.byteLength(section) < RECEIPT_MAX + 200, `${Buffer.byteLength(section)} bytes`);
  assert.match(section, /…\[receipt cut at 32 KiB\]\n?$/);
  assert.match(prompt, /\n## Diff\n\ndiff --git/);
  assert.equal(receiptSection(null), "");
});

test("an unreadable receipt → one errors.log line naming it, the prompt as before, the review still runs", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, () => {
  const b = repo();
  const path = receipt(b, ".pattern-check", "locked.md", "# locked\n");
  chmodSync(path, 0o000);
  try {
    const bin = codex(b);
    const r = review(b, bin);
    assert.match(r.out, /codex: pass/, r.out);
    assert.match(given(bin), /^diff --git a\/b\.txt/);
    const lines = errorLines(b);
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0], / review pattern-check receipt .*locked\.md not readable: .*; reviewing without a receipt/);
  } finally {
    chmodSync(path, 0o644);
  }
  // The directory itself unreadable: the same, naming the directory.
  const b2 = repo();
  receipt(b2, ".pattern-check", "s.md", "# s\n");
  chmodSync(join(b2.work, ".pattern-check"), 0o000);
  try {
    const bin2 = codex(b2);
    review(b2, bin2);
    assert.match(given(bin2), /^diff --git a\/b\.txt/);
    assert.match(errorLines(b2)[0] ?? "", / review pattern-check receipt directory .*\.pattern-check not readable: /);
  } finally {
    chmodSync(join(b2.work, ".pattern-check"), 0o755);
  }
});

test("a finding tagged `fault-tolerance:` keeps the kind, in the parsed items and in the stored row", () => {
  const items = parseItems("1. [blocking] fault-tolerance: the receipt says retries stop after 3; src/net.ts:12 loops forever\n2. [nit] naming");
  assert.deepEqual(items, [
    { severity: "blocking", kind: "fault-tolerance", text: "the receipt says retries stop after 3; src/net.ts:12 loops forever" },
    { severity: "nit", text: "naming" },
  ]);
  const b = repo();
  const path = join(b.root, "stub-codex");
  writeFileSync(path, "#!/bin/sh\ncat > /dev/null\necho '1. [blocking] fault-tolerance: src/net.ts:12 retries forever; the receipt says 3'\n");
  chmodSync(path, 0o755);
  const r = review(b, path);
  assert.match(r.out, /codex: findings/, r.out);
  const db = openDb(b);
  try {
    const row = db.prepare("SELECT findings_json FROM cc_reviews WHERE lab = 'codex'").get();
    assert.equal(JSON.parse(row.findings_json)[0].kind, "fault-tolerance");
  } finally {
    db.close();
  }
});
