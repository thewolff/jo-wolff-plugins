// review-waive-lock.test.mjs — 0.4.12: `review waive` is the human's. It is applied only when
// typed as a prompt (the UserPromptSubmit hook, via "prompt-hook"); the CLI refuses it before the
// store opens, with the line for the human to type.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cli } from "./helpers.mjs";
import { repo, git, push, decision, typed, reviewRows, SID } from "./review-helpers.mjs";
import { gateDecision, waiveAsk } from "../lib/review.mjs";

function storeBytes(b) {
  return ["", "-wal", "-shm"].map((s) => (existsSync(b.dbPath + s) ? createHash("sha256").update(readFileSync(b.dbPath + s)).digest("hex") : "absent")).join(" ");
}

test("waive from the CLI is refused before the store opens: argv, stdin, --by human, and waive --help; exit 1 and nothing written", () => {
  const b = repo();
  const head = git(b, "rev-parse", "HEAD");
  const before = storeBytes(b);
  for (const [args, input] of [
    [["review", "waive", "prototype, push it"], null],
    [["review", "waive", "--help"], null],
    [["--by", "human", "review", "waive", "prototype"], null],
    [[], "review waive prototype\n\nreview waive --help\n"],
  ]) {
    const r = cli(b, args, { input, env: { LEDGER_SESSION_ID: SID } });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, input ? /^1: refused review waive is the human's: / : /^refused review waive is the human's: /);
    assert.ok(r.out.includes(`review waive --in ${b.work} --head ${head} "<their reason>"`), r.out);
    if (input) assert.match(r.out, /^2: skipped \(blank\)\n3: refused review waive is the human's: .*\napplied 0, refused 2, not commands 0$/m);
  }
  assert.equal(storeBytes(b), before);
  assert.equal(decision(push(b)), "deny");
});

test("waive from the CLI with an inaccessible store and with a read-only store that needs migration: exit 1 and the refusal", () => {
  const b = repo();
  const locked = join(b.root, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const r = cli(b, ["review", "waive", "x"], { env: { LEDGER_DB: join(locked, "ledger.db") } });
    assert.equal(r.code, 1, r.err);
    assert.match(r.out, /^refused review waive is the human's/);
  } finally {
    chmodSync(locked, 0o755);
  }
  const old = join(b.root, "old.db");
  const db = new DatabaseSync(old);
  db.exec("PRAGMA user_version = 11");
  db.close();
  chmodSync(old, 0o444);
  const r = cli(b, ["review", "waive", "x"], { env: { LEDGER_DB: old } });
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /^refused review waive is the human's/);
});

test("waive typed as a prompt records a waived row and the push is allowed", () => {
  const b = repo();
  assert.equal(decision(push(b)), "deny");
  const t = typed(b, "review waive prototype, the human said push it");
  assert.match(t.message, /^1: ok\n?.*waived the review gate for [0-9a-f]{8}/m, t.message);
  assert.deepEqual(reviewRows(b).map((r) => [r.lab, r.verdict, r.reason, r.session_id]), [["ledger", "waived", "prototype, the human said push it", "s-typed"]]);
  assert.equal(decision(push(b)), "allow");
});

test("waive --in names another repository; --head must equal its HEAD, and a stale --head is refused with the current sha", () => {
  const b = repo();
  // A second repository in the same sandbox (so the same store): b's sibling folder.
  const other = { ...b, work: b.sibling };
  git(other, "init", "-q", "-b", "main");
  writeFileSync(join(other.work, "x.txt"), "x\n");
  git(other, "add", "x.txt");
  git(other, "commit", "-qm", "x");
  git(other, "checkout", "-q", "-b", "feat");
  writeFileSync(join(other.work, "y.txt"), "y\n");
  git(other, "add", "y.txt");
  git(other, "commit", "-qm", "y");
  const head = git(other, "rev-parse", "HEAD");
  // Typed in b's session, about the other repository.
  const stale = typed(b, `review waive --in ${other.work} --head ${"a".repeat(40)} prototype`);
  assert.ok(stale.message.includes(`refused review waive --head ${"a".repeat(40)}: ${other.work} is at ${head} now; nothing recorded`), stale.message);
  assert.deepEqual(reviewRows(b), []);
  const t = typed(b, `review waive --in ${other.work} --head ${head} "prototype, push it"`);
  assert.ok(t.message.includes(`ok waived the review gate for ${head.slice(0, 8)} in ${other.work}: prototype, push it`), t.message);
  assert.deepEqual(reviewRows(b).map((r) => [r.cwd, r.head_sha, r.verdict]), [[other.work, head, "waived"]]);
  assert.equal(decision(push(b, `git -C ${other.work} push origin feat`)), "allow");
  assert.equal(decision(push(b)), "deny", "the session's own repository is not waived");
  // A short --head that HEAD starts with is the same commit.
  assert.match(typed(b, `review waive --in ${other.work} --head ${head.slice(0, 8)} again`).message, /ok waived/);
});

test("waive refusals: empty reason, placeholder, a reason starting with --", () => {
  const b = repo();
  for (const [line, why] of [
    ["review waive", /needs the reason/],
    ['review waive "<their reason>"', /not the placeholder <their reason>/],
    ["review waive --help", /starts with --help, which reads as a flag/],
    ["review waive --in", /usage: review waive \[--in <folder>\]/],
  ]) {
    const t = typed(b, line);
    assert.match(t.message, /^1: refused /m, line);
    assert.match(t.message, why, line);
  }
  assert.deepEqual(reviewRows(b), []);
});

test("the findings deny, the no-review deny, both round-cap texts and the plugin-gate texts name the line for the human to type and never tell the agent to run waive", () => {
  const top = "/work/repo";
  const head = "0123456789abcdef0123456789abcdef01234567";
  const ask = `\`review waive --in ${top} --head ${head} "<their reason>"\``;
  const base = { top, head, rows: [], labRows: [], nits: [], unavailable: [], unverified: [] };
  const findings = gateDecision({ ...base, kind: "findings", findings: [{ lab: "codex", findings: "1. [blocking] fd-x: a.txt:1 y", findings_json: JSON.stringify([{ id: "fd-x", severity: "blocking", text: "a.txt:1 y" }]) }] }, "gate", "node ledger.mjs").deny;
  const none = gateDecision({ ...base, kind: "none", findings: [] }, "gate", "node ledger.mjs").deny;
  for (const text of [findings, none]) {
    assert.ok(text.includes(`ask them to type as their whole prompt in a Claude Code session: ${ask}; you cannot run it`), text);
    assert.doesNotMatch(text, /ledger\.mjs review waive/);
  }
  assert.ok(findings.includes(`review dismiss fd-x wrong|intentional|doesnt-matter "<your reason>"`));
  // The round caps and the plugin gate, from the source: every waive they name is the human's line.
  const src = readFileSync(new URL("../lib/review.mjs", import.meta.url), "utf8") + readFileSync(new URL("../lib/plugin-gate.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\$\{cli\} review waive|`ledger review waive/);
  assert.equal(waiveAsk(null, head), `\`review waive --head ${head} "<their reason>"\``);
  assert.equal(waiveAsk("/a b", head), `\`review waive --in "/a b" --head ${head} "<their reason>"\``);
});
