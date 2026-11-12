// errors.log lines name the SQLite codes and the context that wrote them: a read-only write logs
// the primary and the extended errcode, and every line carries session id, cwd and the parent
// process command, the last looked up fail-open (no ps on PATH still logs the line).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, hook, cli, openDb, HOOKS } from "./helpers.mjs";
import { readErrors } from "../lib/failopen.mjs";

const end = (box, id) => ({ session_id: id, cwd: box.work, hook_event_name: "SessionEnd", reason: "other" });

/** The one errors.log line, parsed, with the raw text alongside. */
function onlyLine(box) {
  const raw = readFileSync(box.errorsLog, "utf8").trim().split("\n");
  assert.equal(raw.length, 1, raw.join("\n"));
  const [entry] = readErrors(box.env);
  return { raw: raw[0], entry };
}

/** A store with a row in it, held open by this process so `-wal` and `-shm` exist. */
function heldStore(box) {
  assert.equal(cli(box, ["ask", "Held?", "--name", "held", "--options", "a,b"]).code, 0);
  const holder = openDb(box);
  holder.prepare("SELECT count(*) FROM cc_questions").get();
  assert.ok(existsSync(`${box.dbPath}-wal`) && existsSync(`${box.dbPath}-shm`), "the holder keeps -wal and -shm present");
  return holder;
}

function assertCodes(entry, raw) {
  assert.match(entry.message, /database read-only at /, raw);
  assert.match(entry.message, /\(sqlite errcode 8 SQLITE_READONLY, extended \d+( SQLITE_READONLY\w*)?\)/, raw);
}

const sandboxExec = process.platform === "darwin" && spawnSync("sandbox-exec", ["-n", "no-network", "true"]).status === 0;

test("read-only write under a write-denying sandbox, -wal/-shm present → the line has primary and extended errcode", { skip: !sandboxExec && "needs macOS sandbox-exec" }, () => {
  const box = sandbox();
  const holder = heldStore(box);
  try {
    const profile = join(box.root, "deny.sb");
    // Deny only the database and its -wal/-shm, so errors.log (under the same root) stays writable.
    writeFileSync(profile, `(version 1)(allow default)(deny file-write* (literal ${JSON.stringify(box.dbPath)}) (literal ${JSON.stringify(`${box.dbPath}-wal`)}) (literal ${JSON.stringify(`${box.dbPath}-shm`)}))`);
    const r = spawnSync("sandbox-exec", ["-f", profile, process.execPath, HOOKS["session-end"]], {
      cwd: box.work,
      env: box.env,
      input: JSON.stringify(end(box, "s-sandboxed")),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    const { raw, entry } = onlyLine(box);
    assertCodes(entry, raw);
    assert.equal(entry.ctx.session, "s-sandboxed");
    assert.equal(entry.ctx.cwd, box.work);
    assert.equal(typeof entry.ctx.ppid, "number");
    // The seatbelt profile also stops the setuid ps, and the line says so instead of going without.
    assert.match(entry.ctx.parent, /^(\? \(ps EPERM\)|.*node.*)$/);
  } finally {
    holder.close();
  }
});

test("read-only database file with -wal/-shm present → the line has primary and extended errcode and the session context", () => {
  const box = sandbox();
  const holder = heldStore(box);
  chmodSync(box.dbPath, 0o444);
  try {
    const r = hook(box, "session-end", end(box, "s-ro"));
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "");
    const { raw, entry } = onlyLine(box);
    assertCodes(entry, raw);
    assert.equal(entry.ctx.session, "s-ro");
    assert.equal(entry.ctx.cwd, box.work);
    assert.equal(entry.ctx.ppid, process.pid, "the hook's parent is this test process");
    assert.match(entry.ctx.parent, /node/);
    assert.equal(entry.db, box.dbPath, "the db tag stays last and still parses");
  } finally {
    chmodSync(box.dbPath, 0o644);
    holder.close();
  }
});

test("the parent lookup failing (no ps on PATH) still logs the line, with parent \"? (ps ENOENT)\"", () => {
  const box = sandbox();
  const r = hook(box, "session-end", "not json", { env: { PATH: join(box.root, "empty-path") } });
  assert.equal(r.code, 0, r.err);
  const { raw, entry } = onlyLine(box);
  assert.match(entry.message, /^stdin not JSON: /, raw);
  assert.equal(entry.ctx.parent, "? (ps ENOENT)");
  assert.equal(entry.ctx.session, null, "no payload, no LEDGER_SESSION_ID");
});

test("LEDGER_SESSION_ID names the session when the hook input has none", () => {
  const box = sandbox();
  const r = hook(box, "session-end", "not json", { env: { LEDGER_SESSION_ID: "s-env" } });
  assert.equal(r.code, 0, r.err);
  assert.equal(onlyLine(box).entry.ctx.session, "s-env");
});

// The tag's own JSON can contain ` ctx={`: the reader must split at the writer's tag, not inside it.
test("a cwd containing \" ctx={x\" round-trips: ctx intact, message without the tag", () => {
  const box = sandbox();
  const cwd = join(box.root, "dir ctx={x");
  mkdirSync(cwd);
  const r = hook(box, "session-end", "not json", { cwd });
  assert.equal(r.code, 0, r.err);
  const { raw, entry } = onlyLine(box);
  assert.ok(raw.includes(" ctx={x"), raw);
  assert.equal(entry.ctx?.cwd, cwd, raw);
  assert.match(entry.message, /^stdin not JSON: /, raw);
  assert.ok(!entry.message.includes("ctx="), entry.message);
});

test("a session id containing \" ctx=\" round-trips", () => {
  const box = sandbox();
  const session = 's ctx={"y":2}';
  const r = hook(box, "session-end", "not json", { env: { LEDGER_SESSION_ID: session } });
  assert.equal(r.code, 0, r.err);
  const { raw, entry } = onlyLine(box);
  assert.equal(entry.ctx?.session, session, raw);
  assert.match(entry.message, /^stdin not JSON: /, raw);
  assert.ok(!entry.message.includes("ctx="), entry.message);
});

test("a parent command line containing ' ctx={\"a\":1}' round-trips", () => {
  const box = sandbox();
  // The hook's parent is a node process whose argv carries the substring early, before ps output is cut.
  const spawner = `/* ctx={"a":1} */ const r = require("node:child_process").spawnSync(process.execPath, [process.env.HOOK], { input: "not json", stdio: ["pipe", "inherit", "inherit"] }); process.exit(r.status ?? 1);`;
  const r = spawnSync(process.execPath, ["-e", spawner], { cwd: box.work, env: { ...box.env, HOOK: HOOKS["session-end"] }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const { raw, entry } = onlyLine(box);
  assert.ok(entry.ctx, raw);
  assert.ok(entry.ctx.parent.includes(' ctx={"a":1}'), raw);
  assert.equal(entry.ctx.cwd, box.work, raw);
  assert.match(entry.message, /^stdin not JSON: /, raw);
  assert.ok(!entry.message.includes("ctx="), entry.message);
});

test("a tagless line whose message ends in JSON keeps its message whole", () => {
  const box = sandbox();
  mkdirSync(join(box.root, "state", "ledger"), { recursive: true });
  // A ledger 0.4.0 line has no ctx tag; JSON at its end is message text, not context.
  writeFileSync(box.errorsLog, '2026-11-01T00:00:00.000Z SessionEnd boom ctx={"a":1}\n');
  const [entry] = readErrors(box.env);
  assert.equal(entry.ctx, null);
  assert.equal(entry.message, 'boom ctx={"a":1}');
});
