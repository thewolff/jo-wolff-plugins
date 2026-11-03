import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, cli, openDb, count, CLI } from "./helpers.mjs";
import { splitCliFlags } from "../scripts/ledger.mjs";

const box = sandbox();

test("step 5: a three-line batch prints numbered results, line 2 refused, the trailer, exit 1, one note in the db", () => {
  const r = cli(box, [], { input: 'note "demo"\napprove q-nope\nhelp\n' });
  assert.equal(r.code, 1, r.err);
  const lines = r.out.split("\n");
  assert.match(lines[0], /^1: ok nt-[a-z0-9]+ noted for .*: demo$/);
  assert.equal(lines[1], "2: refused no such question q-nope");
  assert.equal(lines[2], "3: ok");
  assert.ok(r.out.includes("\napplied 2, refused 1, not commands 0\n"), r.out);
  const db = openDb(box);
  assert.equal(count(db, "cc_notes"), 1);
  db.close();
});

test("step 5: the same answer twice → `already answered approve (an-…)` the second time, exit 0", () => {
  const asked = cli(box, ["ask", "Ship?", "--name", "ship", "--options", "approve,deny"]);
  const q = /q-[a-z0-9]+/.exec(asked.out)[0];
  const first = cli(box, ["approve", q]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, new RegExp(`^ok an-[a-z0-9]+ approve → ${q} \\(ship\\)`));
  const second = cli(box, ["approve", q]);
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /^ok already answered approve \(an-[a-z0-9]+\)/);
});

test("argv mode keeps shell quoting: a multi-word note is one argument", () => {
  const r = cli(box, ["note", "fix the login bug first"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /noted for .*: fix the login bug first/);
});

test("--json prints the results array; --by names the actor; --cwd binds the folder", () => {
  const r = cli(box, ["--json", "--cwd", box.sibling, "note", "json one"]);
  assert.equal(r.code, 0, r.err);
  const arr = JSON.parse(r.out);
  assert.equal(arr.length, 1);
  assert.deepEqual(Object.keys(arr[0]), ["line", "text", "status", "id", "message"]);
  assert.match(arr[0].id, /^nt-/);
  const db = openDb(box);
  assert.equal(db.prepare("SELECT cwd FROM cc_notes WHERE id = ?").get(arr[0].id).cwd, box.sibling);
  db.close();
  const by = cli(box, ["--by", "jo", "note", "from json"]);
  assert.equal(by.code, 0, by.err);
  const db2 = openDb(box);
  assert.equal(db2.prepare("SELECT made_by FROM cc_notes WHERE id = ?").get(/nt-[a-z0-9]+/.exec(by.out)[0]).made_by, "jo");
  db2.close();
});

test("fail-open table (CLI): a config file that does not parse → one stderr line, command still runs on defaults", () => {
  box.writeConfig("{");
  const r = cli(box, ["pending"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /^ledger: config .*config\.json ignored: /);
  assert.match(r.out, /^no open questions for /);
  box.writeConfig({});
});

test("fail-open table (CLI): a corrupt db is moved aside with a stderr line, the command runs on a fresh one", () => {
  const b = sandbox();
  const { writeFileSync } = globalThis.process.getBuiltinModule("node:fs");
  writeFileSync(b.dbPath, "junk ".repeat(1000));
  const r = cli(b, ["pending"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /^ledger: moved corrupt database aside to .*\.corrupt-/);
  assert.match(r.out, /^no open questions/);
});

test("fail-open table (CLI): a busy db → exit 2 and `nothing applied`", () => {
  const b = sandbox();
  const db = openDb(b);
  db.exec("BEGIN IMMEDIATE");
  const r = cli(b, ["note", "blocked"]);
  db.exec("ROLLBACK");
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /^ledger: database busy at .*; nothing applied$/m);
  assert.equal(r.out, "");
  assert.equal(count(db, "cc_notes"), 0);
  db.close();
});

test("fail-open table (CLI): an unwritable db directory → exit 2, one line", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, () => {
  const b = sandbox();
  const { mkdirSync, chmodSync } = globalThis.process.getBuiltinModule("node:fs");
  const dir = `${b.root}/ro`;
  mkdirSync(dir);
  chmodSync(dir, 0o500);
  try {
    const r = cli(b, ["pending"], { env: { LEDGER_DB: `${dir}/sub/ledger.db` } });
    assert.equal(r.code, 2);
    assert.match(r.err, /^ledger: database unavailable at /);
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("fail-open table (CLI): a read-only db file → a write exits 2 with `read-only`, a read still works", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, () => {
  const b = sandbox();
  const { chmodSync } = globalThis.process.getBuiltinModule("node:fs");
  cli(b, ["note", "before"]);
  chmodSync(b.dbPath, 0o444);
  try {
    const w = cli(b, ["note", "after"]);
    assert.equal(w.code, 2, w.out + w.err);
    assert.match(w.err, /^ledger: database read-only at .*; nothing applied$/m);
    const r = cli(b, ["log"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /note: before/);
    assert.doesNotMatch(r.out, /after/);
  } finally {
    chmodSync(b.dbPath, 0o644);
  }
});

test("nothing on stdin → says so, exit 0", () => {
  const r = cli(box, [], { input: "" });
  assert.equal(r.code, 0);
  assert.equal(r.out, "nothing on stdin\n");
});

test("splitCliFlags pulls the CLI's own flags out of argv in any position", () => {
  assert.deepEqual(splitCliFlags(["--json", "approve", "q-1", "--by=jo", "--cwd", "/x"]), { json: true, by: "jo", cwd: "/x", rest: ["approve", "q-1"] });
  assert.ok(CLI.endsWith("/scripts/ledger.mjs"));
});
