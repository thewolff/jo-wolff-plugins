// Tests for the host-neutral session layer (verbs.mjs over host-io.mjs) on real temp
// directories. pair_run tests use the real /usr/bin/sandbox-exec and skip where it is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CARRY_MAX_AGE_MS, PLUGIN_ROOT, carryInto, endSession, executeVerb, recordTrustedInput, takeCarryMarker, verdict, writeCarryMarker,
} from "./verbs.mjs";
import { loadState, reapGroups, writeSandboxed } from "./host-io.mjs";
import { pairRunProfile, pairWriteProfile } from "../core/gate.mjs";

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

// ─── typed stop ─────────────────────────────────────────────────────────────────────────

test("a typed 'pair stop' ends pairing in any phase and the host's tools open again", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await openChangeSet(f);
  assert.equal(verdict("Write", { sessionDir: f.dir }).allow, false);
  const r = typed(f, "  Pair Stop ");
  assert.equal(r.stopped, true);
  assert.equal(verdict("Write", { sessionDir: f.dir }).allow, true);
  assert.equal(loadState(f.dir).phase, "inactive");
  assert.equal(journal(f).at(-1).verb, "typed-stop");
});

test("an untrusted 'pair stop' changes nothing, and the agent has no stop tool", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await executeVerb("pair_start", {}, f.ctx);
  for (const source of ["claude:mid-turn", "claude:queued/human", "extension", "rpc"]) {
    const r = recordTrustedInput({ sessionDir: f.dir, text: "pair stop", source });
    assert.equal(r.stopped, undefined, source);
    assert.equal(verdict("Write", { sessionDir: f.dir }).allow, false, source);
  }
  const stop = await executeVerb("pair_stop", { quote: "pair stop" }, f.ctx);
  assert.equal(stop.ok, false);
  assert.match(stop.text, /unknown pairing verb/);
  assert.equal(loadState(f.dir).phase, "closed");
});

// ─── carried sessions and the /clear marker ─────────────────────────────────────────────

test("the carry marker is single-use", () => {
  const f = fixture();
  writeCarryMarker(f.base, { root: f.root, from: "sess-1", exclusions: [".git"] });
  const m = takeCarryMarker(f.base, f.root);
  assert.equal(m.root, f.root);
  assert.equal(m.from, "sess-1");
  assert.equal(takeCarryMarker(f.base, f.root), null);
});

test("an expired carry marker is not used, and is deleted", () => {
  const f = fixture();
  writeCarryMarker(f.base, { root: f.root, from: "sess-1" });
  assert.equal(takeCarryMarker(f.base, f.root, { now: Date.now() + CARRY_MAX_AGE_MS + 1000 }), null);
  assert.equal(takeCarryMarker(f.base, f.root), null);
});

test("a carry marker for another worktree is not used", () => {
  const f = fixture();
  const other = join(f.top, "other-repo");
  writeCarryMarker(f.base, { root: other, from: "sess-1" });
  assert.equal(takeCarryMarker(f.base, f.root), null);
  // A marker whose recorded root disagrees with its key is refused too.
  const key = createHash("sha256").update(f.root).digest("hex").slice(0, 32);
  writeFileSync(join(f.base, "carry", `${key}.json`), JSON.stringify({ root: other, from: "x", at: Date.now() }));
  assert.equal(takeCarryMarker(f.base, f.root), null);
  assert.notEqual(takeCarryMarker(f.base, other), null);
});

test("a session carried after a clear refuses host writes until pair_start, which restarts it", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await executeVerb("pair_start", {}, f.ctx);
  const ended = endSession({ sessionDir: f.dir });
  assert.equal(ended.carry.root, f.root);
  const next = { sessionId: "sess-2", sessionDir: join(f.base, "sess-2"), root: f.root };
  assert.equal(carryInto({ ...next, exclusions: ended.carry.exclusions, protect: ended.carry.protect, from: "sess-1" }).ok, true);
  assert.equal(verdict("Write", { sessionDir: next.sessionDir }).allow, false);
  assert.equal((await executeVerb("pair_propose", { boundary: ["src/a.txt"] }, next)).ok, false);
  assert.equal(readFileSync(join(next.sessionDir, "journal.jsonl"), "utf8").includes('"carried-after-clear"'), true);
  const start = await executeVerb("pair_start", {}, next);
  assert.equal(start.ok, true, start.text);
  assert.equal((await executeVerb("pair_propose", { boundary: ["src/a.txt"] }, next)).ok, true);
});

test("every pair_run profile denies the plugin's own root, also in a carried session", { skip: !hasSandbox }, async () => {
  // A worktree that contains this plugin (pairing on the plugin itself) must not let a run
  // rewrite the gate: the deny comes after the boundary allow, so it wins inside the boundary.
  const f = fixture();
  const denied = `(deny file-write* (subpath ${JSON.stringify(PLUGIN_ROOT)}))`;
  await executeVerb("pair_start", {}, f.ctx);
  const s = loadState(f.dir);
  assert.ok(s.protect.includes(PLUGIN_ROOT));
  assert.ok(pairRunProfile(s).includes(denied));
  const ended = endSession({ sessionDir: f.dir });
  const next = { sessionId: "sess-2", sessionDir: join(f.base, "sess-2"), root: f.root };
  assert.equal(carryInto({ ...next, exclusions: ended.carry.exclusions, protect: [], from: "sess-1" }).ok, true);
  assert.ok(pairRunProfile(loadState(next.sessionDir)).includes(denied));
});

test("an inactive session leaves no carry", () => {
  const f = fixture();
  assert.equal(endSession({ sessionDir: f.dir }).carry, undefined);
});

// ─── kernel-enforced pair_write ─────────────────────────────────────────────────────────

test("pair_write runs under the kernel: a path checkWrite passes but the profile denies does not land", { skip: !hasSandbox }, async () => {
  const f = fixture();
  mkdirSync(join(f.root, "src", "guarded"));
  const ctx = { ...f.ctx, protect: [join(f.root, "src", "guarded")] };
  assert.equal((await executeVerb("pair_start", {}, ctx)).ok, true);
  const p = await executeVerb("pair_propose", { boundary: ["src/**"] }, ctx);
  typed(f, "go ahead");
  assert.equal((await executeVerb("pair_begin", { cardId: p.result.card.id, quote: "go ahead" }, ctx)).ok, true);
  const w = await executeVerb("pair_write", { path: "src/guarded/x.txt", content: "pwned" }, ctx);
  assert.equal(w.ok, false, w.text);
  assert.match(w.text, /sandboxed write failed/);
  assert.equal(existsSync(join(f.root, "src", "guarded", "x.txt")), false);
  const ok = await executeVerb("pair_write", { path: "src/new/deep/y.txt", content: "fine" }, ctx);
  assert.equal(ok.ok, true, ok.text);
  assert.equal(readFileSync(join(f.root, "src", "new", "deep", "y.txt"), "utf8"), "fine");
});

test("the pair_write profile refuses a boundary path that a symlink points outside, temp included", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await openChangeSet(f, ["src/a.txt", "src/link.txt"]);
  const tempFile = join(f.top, "outside.txt");
  writeFileSync(tempFile, "untouched");
  const profile = pairWriteProfile(loadState(f.dir));
  for (const target of [tempFile, join(f.root, "src", "b.txt"), join(f.dir, "state.json")]) {
    const before = readFileSync(target, "utf8");
    rmSync(join(f.root, "src", "link.txt"), { force: true });
    symlinkSync(target, join(f.root, "src", "link.txt"));
    assert.equal(writeSandboxed({ profile, path: join(f.root, "src", "link.txt"), content: "pwned" }).ok, false, target);
    assert.equal(readFileSync(target, "utf8"), before, target);
  }
  assert.equal(writeSandboxed({ profile, path: join(f.root, "src", "a.txt"), content: "A" }).ok, true);
});

// ─── roadmap ────────────────────────────────────────────────────────────────────────────

const roadmap = [
  { id: "parser", title: "Split the parser", status: "done" },
  { id: "cache", title: "Add the cache", status: "open" },
  { id: "auth", title: "Auth refresh", status: "not-ready", note: "waits on the token API" },
];

test("pair_done lists the roadmap items still open or not ready", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await executeVerb("pair_start", {}, f.ctx);
  assert.equal((await executeVerb("pair_note", { roadmap }, f.ctx)).ok, true);
  const p = await executeVerb("pair_propose", { boundary: ["src/a.txt"] }, f.ctx);
  typed(f, "go ahead");
  await executeVerb("pair_begin", { cardId: p.result.card.id, quote: "go ahead" }, f.ctx);
  const done = await executeVerb("pair_done", { cardId: p.result.card.id }, f.ctx);
  assert.deepEqual(done.result.roadmapOpen.map((i) => i.id), ["cache", "auth"]);
  assert.match(done.text, /\[not-ready\] auth: Auth refresh \(waits on the token API\)/);
});

test("pair_start offers the open roadmap of the latest earlier session in the same worktree, read-only", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await executeVerb("pair_start", {}, f.ctx);
  await executeVerb("pair_note", { roadmap }, f.ctx);
  await executeVerb("pair_note", { text: "free text after the roadmap" }, f.ctx);
  endSession({ sessionDir: f.dir });
  const oldJournal = readFileSync(join(f.dir, "journal.jsonl"));
  const s2 = { sessionId: "sess-2", sessionDir: join(f.base, "sess-2"), root: f.root };
  const r = await executeVerb("pair_start", {}, s2);
  assert.equal(r.ok, true, r.text);
  assert.equal(r.result.roadmapOffer.fromSession, "sess-1");
  assert.deepEqual(r.result.roadmapOffer.items.map((i) => i.id), ["cache", "auth"]);
  assert.match(r.text, /\[open\] cache: Add the cache/);
  assert.deepEqual(readFileSync(join(f.dir, "journal.jsonl")), oldJournal);
  // Nothing reopens: the new session has no roadmap of its own until a note records one.
  assert.equal(loadState(s2.sessionDir).roadmap, null);
});

test("pair_start makes no offer for another worktree, or when the latest earlier session has none open", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await executeVerb("pair_start", {}, f.ctx);
  await executeVerb("pair_note", { roadmap }, f.ctx);
  endSession({ sessionDir: f.dir });
  const otherRoot = join(f.top, "other");
  mkdirSync(join(otherRoot, ".git"), { recursive: true });
  const elsewhere = await executeVerb("pair_start", {}, { sessionId: "sess-x", sessionDir: join(f.base, "sess-x"), root: otherRoot });
  assert.equal(elsewhere.result.roadmapOffer, null);
  const s2 = { sessionId: "sess-2", sessionDir: join(f.base, "sess-2"), root: f.root };
  await executeVerb("pair_start", {}, s2);
  await executeVerb("pair_note", { roadmap: roadmap.map((i) => ({ ...i, status: "done", note: undefined })) }, s2);
  endSession({ sessionDir: s2.sessionDir });
  const s3 = await executeVerb("pair_start", {}, { sessionId: "sess-3", sessionDir: join(f.base, "sess-3"), root: f.root });
  assert.equal(s3.result.roadmapOffer, null);
});
