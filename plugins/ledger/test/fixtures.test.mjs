// fixtures.test.mjs — the review adapters and the judge read against what the real CLIs printed
// (test/fixtures/, saved by capture-fixtures.mjs from one live run each against
// fixtures/review.diff, where `add` subtracts). Each adapter runs for real here, through a stub
// binary that replays the saved stdout. A lab whose live run failed has <lab>.unavailable.txt
// instead, and the stub replays that error on stderr with exit 1.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS } from "../lib/review.mjs";
import { ask, parseAnswer } from "../lib/judge.mjs";
import { open } from "../lib/db.mjs";
import { sandbox, cli, openDb } from "./helpers.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const DIFF = readFileSync(join(FIXTURES, "review.diff"), "utf8");
const fixture = (name) => (existsSync(join(FIXTURES, name)) ? readFileSync(join(FIXTURES, name), "utf8") : null);

/** A stub that replays `file` on stdout (exit 0), or on stderr with exit 1 when `failing`. */
function replay(b, lab, file, failing) {
  const path = join(b.root, `replay-${lab}`);
  writeFileSync(path, `#!/bin/sh\ncat > /dev/null\ncat "${file}"${failing ? " >&2\nexit 1" : ""}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("every adapter has a captured fixture: a real reply or a recorded failure", () => {
  for (const lab of Object.keys(ADAPTERS)) {
    assert.ok(fixture(`${lab}.txt`) !== null || fixture(`${lab}.unavailable.txt`) !== null, `no fixture for ${lab}`);
  }
});

for (const [lab, adapter] of Object.entries(ADAPTERS)) {
  const reply = fixture(`${lab}.txt`);
  if (reply === null) continue;
  test(`${lab}: the captured real reply parses to findings with one blocking item on math.js:2`, async () => {
    const b = sandbox();
    const env = { ...b.env, [`LEDGER_REVIEW_BIN_${lab.toUpperCase()}`]: replay(b, lab, join(FIXTURES, `${lab}.txt`), false) };
    const r = await adapter.run({ diff: DIFF, timeoutMs: 10_000, env, config: {} });
    assert.equal(r.verdict, "findings");
    assert.equal(r.items.length, 1, JSON.stringify(r.items));
    assert.equal(r.items[0].severity, "blocking");
    assert.match(r.items[0].text, /math\.js:2/);
    assert.match(r.items[0].text, /a - b|subtract/i, "the finding names the bug");
    assert.ok(!r.items[0].text.startsWith("[blocking]"), "the tag is parsed off the text");
  });
}

for (const [lab] of Object.entries(ADAPTERS)) {
  const error = fixture(`${lab}.unavailable.txt`);
  if (error === null) continue;
  test(`${lab}: the captured real failure is recorded as an unavailable row carrying the error`, () => {
    const b = sandbox();
    const git = (...args) => assert.equal(spawnSync("git", args, { cwd: b.work, env: { ...b.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).status, 0);
    git("init", "-q", "-b", "main");
    writeFileSync(join(b.work, "math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
    git("add", "math.js");
    git("commit", "-qm", "add");
    b.writeConfig({ review: { mode: "gate", labs: [lab] } });
    const r = cli(b, ["review"], { env: { [`LEDGER_REVIEW_BIN_${lab.toUpperCase()}`]: replay(b, lab, join(FIXTURES, `${lab}.unavailable.txt`), true) } });
    assert.equal(r.code, 0, r.out + r.err);
    const db = openDb(b);
    try {
      const row = db.prepare("SELECT verdict, reason FROM cc_reviews WHERE lab = ?").get(lab);
      assert.equal(row.verdict, "unavailable");
      assert.ok(row.reason.includes(error.trim().split("\n").at(-1).slice(-60)), row.reason);
    } finally {
      db.close();
    }
  });
}

test("judge: the captured real answer parses, and ask() replaying it returns that answer and caches it", async () => {
  const saved = fixture("judge.txt");
  if (saved === null) {
    assert.ok(fixture("judge.unavailable.txt") !== null, "no judge fixture at all");
    return;
  }
  const answer = parseAnswer(saved);
  assert.equal(answer, "yes", "the live judge was asked whether restoring a + b resolves the subtraction finding");
  const b = sandbox();
  const dbPath = join(b.root, "judge.db");
  const store = open(dbPath);
  try {
    const env = { ...b.env, LEDGER_JUDGE_BIN: `cat > /dev/null; cat '${join(FIXTURES, "judge.txt")}'` };
    const first = await ask({ db: store.db, dbPath, config: {}, env, passage: "finding and fix" });
    assert.deepEqual([first.verdict, first.cached], ["yes", false]);
    const again = await ask({ db: store.db, dbPath, config: {}, env: { ...env, LEDGER_JUDGE_BIN: "exit 1" }, passage: "finding and fix" });
    assert.deepEqual([again.verdict, again.cached], ["yes", true]);
  } finally {
    store.db.close();
  }
});
