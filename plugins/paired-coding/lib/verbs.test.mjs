// Tests for the host-neutral session layer (verbs.mjs over host-io.mjs) on real temp
// directories. pair_run tests use the real /usr/bin/sandbox-exec and skip where it is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endSession, executeVerb, recordTrustedInput, verdict } from "./verbs.mjs";
import { reapGroups } from "./host-io.mjs";

const hasSandbox = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "pc-verbs-")));
  const root = join(top, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.txt"), "alpha\n");
  writeFileSync(join(root, "src", "b.txt"), "bravo\n");
  writeFileSync(join(root, "notes.txt"), "user's own notes\n");
  const base = join(top, "state");
  const dir = join(base, "sess-1");
  const ctx = { sessionId: "sess-1", sessionDir: dir, root };
  return { top, root, base, dir, ctx };
}

const typed = (f, text) => recordTrustedInput({ sessionDir: f.dir, text, source: "interactive" });
const journal = (f) => readFileSync(join(f.dir, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

async function openChangeSet(f, boundary = ["src/a.txt"]) {
  assert.equal((await executeVerb("pair_start", {}, f.ctx)).ok, true);
  const p = await executeVerb("pair_propose", { boundary, decision: "d" }, f.ctx);
  assert.equal(p.ok, true, p.text);
  typed(f, "yes, go ahead with that");
  const b = await executeVerb("pair_begin", { cardId: p.result.card.id, quote: "go ahead" }, f.ctx);
  assert.equal(b.ok, true, b.text);
  return p.result.card.id;
}

test("a session that never ran pair_start is inert and creates no file", () => {
  const f = fixture();
  assert.deepEqual(verdict("Write", { sessionDir: f.dir }), { allow: true, active: false });
  assert.equal(recordTrustedInput({ sessionDir: f.dir, text: "go", source: "interactive" }).recorded, false);
  assert.equal(endSession({ sessionDir: f.dir }).active, false);
  assert.equal(existsSync(f.base), false);
});

test("a refused pair_start does not activate the session", { skip: !hasSandbox }, async () => {
  const f = fixture();
  // The state base inside the worktree is refused, and the session stays inert.
  const inside = { ...f.ctx, sessionDir: join(f.root, "state", "sess-1") };
  const r = await executeVerb("pair_start", {}, inside);
  assert.equal(r.ok, false);
  assert.match(r.text, /inside the worktree/);
  assert.equal(verdict("Write", { sessionDir: inside.sessionDir }).allow, true);
});

test("pair_start closes the gate: host writers, shells and dispatch refused, reads allowed", { skip: !hasSandbox }, async () => {
  const f = fixture();
  const r = await executeVerb("pair_start", {}, f.ctx);
  assert.equal(r.ok, true, r.text);
  for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Agent", "Task", "mcp__other__thing"]) {
    assert.equal(verdict(t, { sessionDir: f.dir }).allow, false, t);
  }
  assert.equal(verdict("Read", { sessionDir: f.dir }).allow, true);
  assert.equal(verdict("ToolSearch", { sessionDir: f.dir, allow: ["ToolSearch"] }).allow, true);
  assert.equal(verdict("pair_write", { sessionDir: f.dir }).allow, false, "pair_write needs an open change set");
  const w = await executeVerb("pair_write", { path: "src/a.txt", content: "x" }, f.ctx);
  assert.equal(w.ok, false);
  assert.equal(readFileSync(join(f.root, "src/a.txt"), "utf8"), "alpha\n");
});

test("pair_begin binds only to a trusted turn typed after the card", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await executeVerb("pair_start", {}, f.ctx);
  typed(f, "go ahead");
  const p = await executeVerb("pair_propose", { boundary: ["src/a.txt"] }, f.ctx);
  const before = await executeVerb("pair_begin", { cardId: "card-1", quote: "go ahead" }, f.ctx);
  assert.equal(before.ok, false, "a turn from before the card is not agreement");
  recordTrustedInput({ sessionDir: f.dir, text: "go ahead", source: "claude:system/unknown" });
  const untrusted = await executeVerb("pair_begin", { cardId: p.result.card.id, quote: "go ahead" }, f.ctx);
  assert.equal(untrusted.ok, false, "an untrusted source is not agreement");
  typed(f, "sounds right, ship it");
  assert.equal((await executeVerb("pair_begin", { cardId: "card-1", quote: "go ahead" }, f.ctx)).ok, false, "quote not in the latest turn");
  assert.equal((await executeVerb("pair_begin", { cardId: "card-1", quote: "ship it" }, f.ctx)).ok, true);
});

test("pair_write and pair_edit write inside the boundary only, never the state dir", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await openChangeSet(f);
  assert.equal((await executeVerb("pair_edit", { path: "src/a.txt", oldString: "alpha", newString: "ALPHA" }, f.ctx)).ok, true);
  assert.equal(readFileSync(join(f.root, "src/a.txt"), "utf8"), "ALPHA\n");
  for (const path of ["src/b.txt", "notes.txt", join(f.dir, "state.json"), "../x.txt"]) {
    const r = await executeVerb("pair_write", { path, content: "pwned" }, f.ctx);
    assert.equal(r.ok, false, path);
  }
  assert.equal(readFileSync(join(f.root, "src/b.txt"), "utf8"), "bravo\n");
  assert.equal(JSON.parse(readFileSync(join(f.dir, "state.json"), "utf8")).phase, "open");
});

test("pair_run is fenced by the phase: closed denies worktree writes, open allows only the boundary", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await executeVerb("pair_start", {}, f.ctx);
  const closed = await executeVerb("pair_run", { command: "echo x > src/a.txt" }, f.ctx);
  assert.equal(closed.ok, false);
  assert.equal(readFileSync(join(f.root, "src/a.txt"), "utf8"), "alpha\n");
  const p = await executeVerb("pair_propose", { boundary: ["src/a.txt"] }, f.ctx);
  typed(f, "go ahead");
  await executeVerb("pair_begin", { cardId: p.result.card.id, quote: "go ahead" }, f.ctx);
  assert.equal((await executeVerb("pair_run", { command: "echo new > src/a.txt" }, f.ctx)).ok, true);
  assert.equal(readFileSync(join(f.root, "src/a.txt"), "utf8"), "new\n");
  for (const cmd of ["echo x > src/b.txt", `echo x > '${f.dir}/state.json'`, `rm -f '${f.dir}/state.json'`, `echo x > '${f.base}/other'`]) {
    const r = await executeVerb("pair_run", { command: cmd }, f.ctx);
    assert.equal(r.ok, false, cmd);
  }
  assert.equal(readFileSync(join(f.root, "src/b.txt"), "utf8"), "bravo\n");
  assert.equal(JSON.parse(readFileSync(join(f.dir, "state.json"), "utf8")).phase, "open");
  const done = await executeVerb("pair_done", { cardId: p.result.card.id }, f.ctx);
  assert.equal(done.ok, true);
  assert.match(done.text, /-alpha\n\+new/);
  assert.equal(done.result.halted, false);
});

test("pair_run times out and kills its whole process group", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await openChangeSet(f);
  const t0 = Date.now();
  const r = await executeVerb("pair_run", { command: "(while :; do echo tick >> src/a.txt; sleep 0.05; done) & sleep 60", timeoutSeconds: 1 }, f.ctx);
  assert.equal(r.result.timedOut, true);
  assert.ok(Date.now() - t0 < 10000);
  const size = statSync(join(f.root, "src/a.txt")).size;
  await sleep(400);
  assert.equal(statSync(join(f.root, "src/a.txt")).size, size, "the background writer is dead");
});

test("an aborted pair_run kills its group before it returns", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await openChangeSet(f);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 500);
  const r = await executeVerb("pair_run", { command: "(while :; do echo tick >> src/a.txt; sleep 0.05; done) & sleep 60" }, { ...f.ctx, signal: ac.signal });
  assert.equal(r.result.aborted, true);
  const size = statSync(join(f.root, "src/a.txt")).size;
  await sleep(400);
  assert.equal(statSync(join(f.root, "src/a.txt")).size, size);
});

test("pair_done refuses while a run is going, then reaps leftovers before its snapshot", { skip: !hasSandbox }, async () => {
  const f = fixture();
  const cardId = await openChangeSet(f);
  const ac = new AbortController();
  const running = executeVerb("pair_run", { command: "sleep 30" }, { ...f.ctx, signal: ac.signal, runId: "long" });
  await sleep(500);
  const early = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(early.ok, false);
  assert.match(early.text, /still running/);
  ac.abort();
  await running;
  // A run that returns while a child it started keeps writing to the boundary file.
  const r = await executeVerb("pair_run", { command: "(while :; do echo tick >> src/a.txt; sleep 0.05; done) > /dev/null 2>&1 & exit 0" }, f.ctx);
  assert.equal(r.ok, true, r.text);
  await sleep(300);
  const done = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(done.ok, true, done.text);
  const size = statSync(join(f.root, "src/a.txt")).size;
  await sleep(400);
  assert.equal(statSync(join(f.root, "src/a.txt")).size, size, "no write lands after the read-back");
});

test("a corrupted or deleted state file reads as closed, never inactive", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await executeVerb("pair_start", {}, f.ctx);
  writeFileSync(join(f.dir, "state.json"), "{not json");
  assert.equal(verdict("Write", { sessionDir: f.dir }).allow, false);
  const run = await executeVerb("pair_run", { command: "echo x > src/a.txt" }, f.ctx);
  assert.equal(run.ok, false);
  assert.equal(readFileSync(join(f.root, "src/a.txt"), "utf8"), "alpha\n");
  const ends = journal(f).map((e) => e.type);
  assert.ok(ends.includes("refusal"));
});

test("an escaped writer from change set A is caught by change set B's comparison", { skip: !hasSandbox }, async () => {
  const f = fixture();
  const a = await openChangeSet(f, ["src/a.txt"]);
  // Leaves the process group (perl setsid), then writes A's file after A is done.
  const r = await executeVerb("pair_run", { command: "perl -e 'use POSIX; if (fork()==0) { POSIX::setsid(); sleep 1; open(F, \">>\", \"src/a.txt\"); print F \"late\\n\"; close F; exit 0 }' ; exit 0" }, f.ctx);
  assert.equal(r.ok, true, r.text);
  assert.equal((await executeVerb("pair_done", { cardId: a }, f.ctx)).ok, true);
  const p = await executeVerb("pair_propose", { boundary: ["src/b.txt"] }, f.ctx);
  typed(f, "go ahead on b");
  assert.equal((await executeVerb("pair_begin", { cardId: p.result.card.id, quote: "go ahead on b" }, f.ctx)).ok, true);
  await sleep(1500);
  const done = await executeVerb("pair_done", { cardId: p.result.card.id }, f.ctx);
  assert.equal(done.result.halted, true, done.text);
  assert.deepEqual(done.result.unapproved.map((u) => u.path), ["src/a.txt"]);
  assert.equal((await executeVerb("pair_write", { path: "src/b.txt", content: "x" }, f.ctx)).ok, false, "stopped session refuses writes");
});

test("reapGroups is safe on a group that is already gone", () => {
  assert.deepEqual(reapGroups([999999]), []);
});
