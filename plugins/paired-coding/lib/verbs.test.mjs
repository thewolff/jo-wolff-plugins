// Tests for the host-neutral session layer (verbs.mjs over host-io.mjs) on real temp
// directories. pair_run and pair_write tests use the real sandbox (sandbox-exec on macOS,
// Landlock or bubblewrap on Linux) and skip where none is usable. A few cases differ by backend
// on purpose; each names the difference where it skips.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CARRY_MAX_AGE_MS, PLUGIN_ROOT, ROADMAP_WALK_LIMIT, carryInto, clearInPlace, endSession, executeVerb, recordTrustedInput, takeCarryMarker, verdict, writeCarryMarker,
} from "./verbs.mjs";
import { loadState, realpathLoose, reapGroups, sandboxBackend, sandboxProblem, writeSandboxed } from "./host-io.mjs";
import { pairRunProfile, pairWriteProfile } from "../core/gate.mjs";

const hasSandbox = sandboxProblem() === null;
const BACKEND = hasSandbox ? sandboxBackend().name : null;
const NEEDS_LANDLOCK = BACKEND === "landlock" ? false : "needs the Linux Landlock backend";
const LINUX = process.platform === "linux";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fixtures live under $HOME, not /tmp: pair_run may write the temp directories, so a
// worktree inside one is not fenced the way a real one is, and on Linux Landlock cannot express
// that run at all (the temp grant would hold the worktree's .git) and hands it to bubblewrap.
const FIXTURES = realpathSync(mkdtempSync(join(homedir(), ".pc-verbs-")));
after(() => rmSync(FIXTURES, { recursive: true, force: true }));

function fixture() {
  const top = mkdtempSync(join(FIXTURES, "f-"));
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

test("a quote of a turn typed while a tool ran is refused with a request to say it again, across saved state", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await executeVerb("pair_start", {}, f.ctx);
  const p = await executeVerb("pair_propose", { boundary: ["src/a.txt"] }, f.ctx);
  assert.equal(recordTrustedInput({ sessionDir: f.dir, text: "ship it now", source: "claude:mid-turn" }).trusted, false);
  const r = await executeVerb("pair_begin", { cardId: p.result.card.id, quote: "ship it now" }, f.ctx);
  assert.equal(r.ok, false);
  assert.match(r.text, /your partner's words arrived while a tool was running, so they don't count as agreement; ask them to say it again/);
  assert.equal(loadState(f.dir).phase, "closed");
});

test("a forged inactive state.json does not switch the gate off; only the gate ending pairing does", { skip: !hasSandbox }, async () => {
  const f = fixture();
  const forge = () => writeFileSync(join(f.dir, "state.json"), JSON.stringify({ v: 1, phase: "inactive" }));
  await executeVerb("pair_start", {}, f.ctx);
  forge();
  assert.equal(verdict("Write", { sessionDir: f.dir }).allow, false, "forged while pairing");
  assert.equal(loadState(f.dir).phase, "closed");
  assert.equal(typed(f, "pair stop").stopped, true);
  assert.equal(verdict("Write", { sessionDir: f.dir }).allow, true, "ended by a typed stop");
  assert.equal((await executeVerb("pair_start", {}, f.ctx)).ok, true);
  forge();
  assert.equal(verdict("Write", { sessionDir: f.dir }).allow, false, "forged after pairing restarted");
  assert.equal(endSession({ sessionDir: f.dir }).ok, true);
  assert.equal(verdict("Write", { sessionDir: f.dir }).allow, true, "ended by the session ending");
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

test("a worktree named in another letter case is recorded in its on-disk spelling, and writes still land", { skip: !hasSandbox }, async (t) => {
  const f = fixture();
  const shouted = join(f.top, "REPO");
  if (!existsSync(shouted)) return t.skip("this volume is case-sensitive");
  const g = { ...f, ctx: { ...f.ctx, root: shouted } };
  await openChangeSet(g, ["src/a.txt", ".git/"]);
  assert.equal(loadState(f.dir).root, f.root);
  const w = await executeVerb("pair_write", { path: "src/a.txt", content: "written\n" }, g.ctx);
  assert.equal(w.ok, true, w.text);
  assert.equal(readFileSync(join(f.root, "src", "a.txt"), "utf8"), "written\n");
  const c = await executeVerb("pair_write", { path: ".GIT/config", content: "[core]\n\thooksPath = /tmp\n" }, g.ctx);
  assert.equal(c.ok, false, c.text);
  assert.equal(existsSync(join(f.root, ".git", "config")), false);
});

test("realpathLoose returns existing components in their on-disk spelling, so .GIT/hooks/x is .git/hooks/x", (t) => {
  const f = fixture();
  mkdirSync(join(f.root, ".git", "hooks"));
  if (!existsSync(join(f.root, ".GIT"))) return t.skip("this volume is case-sensitive");
  assert.equal(realpathLoose(join(f.top, "REPO", ".GIT", "Hooks", "pre-commit")), join(f.root, ".git", "hooks", "pre-commit"));
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
  // `rm` without -f: on Linux the state dir under the host's /tmp is not there at all for the run
  // (its /tmp is private), and `rm -f` of a missing file succeeds without touching anything.
  for (const cmd of ["echo x > src/b.txt", `echo x > '${f.dir}/state.json'`, `rm '${f.dir}/state.json'`, `echo x > '${f.base}/other'`]) {
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

test("an escaped writer from change set A is caught by change set B's comparison", { skip: !hasSandbox || (LINUX && "on Linux the sandbox ends every process the run started when it exits (bubblewrap's PID namespace, or pair-landlock as their subreaper), so no writer escapes; the next test checks that") }, async () => {
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

test("on Linux a writer that leaves the process group still ends with its run", { skip: !hasSandbox || (!LINUX && "macOS has neither a PID namespace nor a subreaper helper; the test above covers a writer that escapes there") }, async () => {
  const f = fixture();
  const a = await openChangeSet(f, ["src/a.txt"]);
  const r = await executeVerb("pair_run", { command: "perl -e 'use POSIX; if (fork()==0) { POSIX::setsid(); sleep 1; open(F, \">>\", \"src/a.txt\"); print F \"late\\n\"; close F; exit 0 }' ; exit 0" }, f.ctx);
  assert.equal(r.ok, true, r.text);
  assert.equal((await executeVerb("pair_done", { cardId: a }, f.ctx)).ok, true);
  await sleep(1500);
  assert.equal(readFileSync(join(f.root, "src", "a.txt"), "utf8"), "alpha\n", "the setsid child died with the run");
});

test("a pair_run that makes a link where it could write stops the session until a typed stop", { skip: !hasSandbox }, async () => {
  const f = fixture();
  const cardId = await openChangeSet(f, ["src/**"]);
  // Landlock grants no symlink creation, so there the link a run can make is a second hard link
  // to a file in the same clean directory, and both names of it are listed.
  const landlock = BACKEND === "landlock";
  const command = landlock ? "ln -s ../notes.txt src/sym; ln src/a.txt src/ln" : "ln -s ../notes.txt src/ln";
  const r = await executeVerb("pair_run", { command }, f.ctx);
  assert.equal(r.ok, false);
  const listed = landlock ? "src/a.txt, src/ln" : "src/ln";
  assert.ok(r.text.includes(`STOPPED: pair_run made a link or a .git entry inside the paths it could write (${listed})`), r.text);
  if (BACKEND === "landlock") assert.equal(existsSync(join(f.root, "src", "sym")), false, "Landlock refused the symlink");
  assert.ok(journal(f).some((e) => e.type === "link-made"));
  const done = await executeVerb("pair_done", { cardId }, f.ctx);
  assert.equal(done.ok, false);
  assert.match(done.text, /only your partner ends it, by typing pair stop/);
  assert.equal((await executeVerb("pair_write", { path: "src/a.txt", content: "x" }, f.ctx)).ok, false);
  assert.equal((await executeVerb("pair_run", { command: "true" }, f.ctx)).ok, false);
  assert.equal(typed(f, "pair stop").stopped, true);
  assert.equal(verdict("Write", { sessionDir: f.dir }).allow, true);
});

test("a pair_run that makes no link leaves the session going", { skip: !hasSandbox }, async () => {
  const f = fixture();
  const cardId = await openChangeSet(f, ["src/**"]);
  const r = await executeVerb("pair_run", { command: "mkdir -p src/n && echo x > src/n/x.txt && mv src/n/x.txt src/n/y.txt" }, f.ctx);
  assert.equal(r.ok, true, r.text);
  assert.equal((await executeVerb("pair_done", { cardId }, f.ctx)).ok, true);
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
  // Under Landlock the grant for a new file would be on src, which holds src/guarded, so the
  // gate makes src/new/deep/y.txt on the host and writes it through a grant on that one file.
  const ok = await executeVerb("pair_write", { path: "src/new/deep/y.txt", content: "fine" }, ctx);
  assert.equal(ok.ok, true, ok.text);
  assert.doesNotMatch(ok.text, /under bubblewrap/);
  assert.equal(readFileSync(join(f.root, "src", "new", "deep", "y.txt"), "utf8"), "fine");
});

test("pair_run names the boundary paths a Landlock run cannot create, and says pair_write can", { skip: NEEDS_LANDLOCK }, async () => {
  const f = fixture();
  await openChangeSet(f, ["newpkg/**", "src/a.txt"]);
  const r = await executeVerb("pair_run", { command: "echo changed > src/a.txt" }, f.ctx);
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(r.result.uncreatable, ["newpkg/**"]);
  assert.match(r.text, /could not create newpkg\/\*\*.*Create it with pair_write first/s);
  assert.doesNotMatch(r.text, /under bubblewrap/);
  assert.equal(readFileSync(join(f.root, "src", "a.txt"), "utf8"), "changed\n");
});

const stage = (f) => join(f.root, "src", `.pair-write-${"ab".repeat(8)}.tmp`);

test("the pair_write profile refuses a boundary path that a symlink points outside, temp included", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await openChangeSet(f, ["src/a.txt", "src/link.txt"]);
  const tempFile = join(f.top, "outside.txt");
  writeFileSync(tempFile, "untouched");
  const tempPath = stage(f);
  const s = loadState(f.dir);
  for (const target of [tempFile, join(f.root, "src", "b.txt"), join(f.dir, "state.json")]) {
    const before = readFileSync(target, "utf8");
    rmSync(join(f.root, "src", "link.txt"), { force: true });
    symlinkSync(target, join(f.root, "src", "link.txt"));
    writeSandboxed({ state: s, path: join(f.root, "src", "link.txt"), tempPath, content: "pwned" });
    assert.equal(readFileSync(target, "utf8"), before, target);
  }
  assert.equal(writeSandboxed({ state: s, path: join(f.root, "src", "a.txt"), tempPath, content: "A" }).ok, true);
  assert.equal(readFileSync(join(f.root, "src", "a.txt"), "utf8"), "A");
  assert.equal(existsSync(tempPath), false);
});

test("the pair_write profile takes only a staging file named for it inside the worktree", async () => {
  const f = fixture();
  await openChangeSet(f, ["src/a.txt"]);
  const s = loadState(f.dir);
  for (const bad of [undefined, join(f.root, "src", "x.tmp"), join(f.top, `.pair-write-${"ab".repeat(8)}.tmp`), `${f.root}/src/../../.pair-write-${"ab".repeat(8)}.tmp`]) {
    assert.throws(() => pairWriteProfile(s, bad), /staging file/, String(bad));
  }
  assert.doesNotThrow(() => pairWriteProfile(s, stage(f)));
});

test("a sandboxed write to a directory is refused and leaves nothing behind, even under a glob boundary", { skip: !hasSandbox }, async () => {
  const f = fixture();
  mkdirSync(join(f.root, "src", "d"));
  await openChangeSet(f, ["src/**"]);
  const tempPath = stage(f);
  const w = writeSandboxed({ state: loadState(f.dir), path: join(f.root, "src", "d"), tempPath, content: "x" });
  assert.equal(w.ok, false);
  assert.deepEqual(readdirSync(join(f.root, "src", "d")), []);
  assert.equal(existsSync(tempPath), false);
});

test("a staged write the kernel refuses at the rename leaves no staging file behind", { skip: !hasSandbox || (BACKEND === "bwrap" && "bubblewrap fences pair_write at the target's directory, so a sibling of the target is checkWrite's to refuse; the README lists this") }, async () => {
  const f = fixture();
  await openChangeSet(f, ["src/a.txt"]);
  const tempPath = stage(f);
  const w = writeSandboxed({ state: loadState(f.dir), path: join(f.root, "src", "b.txt"), tempPath, content: "pwned" });
  assert.equal(w.ok, false);
  assert.equal(readFileSync(join(f.root, "src", "b.txt"), "utf8"), "bravo\n");
  assert.deepEqual(readdirSync(join(f.root, "src")).filter((n) => n.startsWith(".pair-write-")), []);
});

test("a boundary directory swapped for a symlink into a temp path takes no staged write, temp paths notwithstanding", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await openChangeSet(f, ["src/sub/x.txt"]);
  const away = join(f.top, "away");
  mkdirSync(away);
  symlinkSync(away, join(f.root, "src", "sub"));
  const tempPath = join(f.root, "src", "sub", `.pair-write-${"cd".repeat(8)}.tmp`);
  const state = { ...loadState(f.dir), tempPaths: [away] };
  const w = writeSandboxed({ state, path: join(f.root, "src", "sub", "x.txt"), tempPath, content: "pwned" });
  assert.equal(w.ok, false);
  assert.deepEqual(readdirSync(away), []);
});

for (const verb of ["pair_write", "pair_edit"]) {
  test(`${verb} replaces a hard link at its target instead of writing through it to the file outside`, { skip: !hasSandbox }, async () => {
    const f = fixture();
    await openChangeSet(f, ["src/a.txt", "src/hl.txt"]);
    const outside = join(f.top, "outside-secret.txt");
    writeFileSync(outside, "secret");
    chmodSync(outside, 0o640);
    linkSync(outside, join(f.root, "src", "hl.txt"));
    const args = verb === "pair_write" ? { path: "src/hl.txt", content: "pwned" } : { path: "src/hl.txt", oldString: "secret", newString: "pwned" };
    const r = await executeVerb(verb, args, f.ctx);
    assert.equal(r.ok, true, r.text);
    assert.equal(readFileSync(outside, "utf8"), "secret");
    assert.equal(statSync(outside).nlink, 1);
    assert.equal(readFileSync(join(f.root, "src", "hl.txt"), "utf8"), "pwned");
    assert.equal(statSync(join(f.root, "src", "hl.txt")).mode & 0o777, 0o640);
    assert.deepEqual(readdirSync(join(f.root, "src")).filter((n) => n.startsWith(".pair-write-")), []);
  });
}

test("pair_write keeps the permission bits of the file it replaces", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await openChangeSet(f, ["src/a.txt", "src/run.sh"]);
  writeFileSync(join(f.root, "src", "run.sh"), "#!/bin/sh\n");
  chmodSync(join(f.root, "src", "run.sh"), 0o750);
  const r = await executeVerb("pair_write", { path: "src/run.sh", content: "#!/bin/sh\necho hi\n" }, f.ctx);
  assert.equal(r.ok, true, r.text);
  assert.equal(statSync(join(f.root, "src", "run.sh")).mode & 0o777, 0o750);
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
  // sess-2's journal has to be newer than sess-1's; a coarse clock can give both the same mtime.
  await sleep(10);
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

const sessionCtx = (f, name) => ({ sessionId: name, sessionDir: join(f.base, name), root: f.root });

/** sess-1 records the roadmap and quits; every later session's journal is written after it. */
async function roadmapLeftOpen(f) {
  await executeVerb("pair_start", {}, f.ctx);
  await executeVerb("pair_note", { roadmap }, f.ctx);
  endSession({ sessionDir: f.dir });
  await sleep(10);
}

test("pair_start walks back past sessions that recorded no roadmap: a carried, restarted middle session", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await roadmapLeftOpen(f);
  // The trial's shape: /clear carries sess-2 closed, the agent restarts pairing, the partner stops.
  const s2 = sessionCtx(f, "sess-2");
  assert.equal(carryInto({ ...s2, from: "sess-1", reason: "clear" }).ok, true);
  assert.equal((await executeVerb("pair_start", {}, s2)).ok, true);
  typed({ dir: s2.sessionDir }, "pair stop");
  await sleep(10);
  // A third session that never answered the offer before it ended does not stop the walk either.
  const s3 = sessionCtx(f, "sess-3");
  assert.equal((await executeVerb("pair_start", {}, s3)).result.roadmapOffer.fromSession, "sess-1");
  endSession({ sessionDir: s3.sessionDir });
  await sleep(10);
  const r = await executeVerb("pair_start", {}, sessionCtx(f, "sess-4"));
  assert.equal(r.result.roadmapOffer.fromSession, "sess-1");
  assert.deepEqual(r.result.roadmapOffer.items.map((i) => i.id), ["cache", "auth"]);
  assert.match(r.text, /earlierRoadmap/);
});

test("a start-fresh decline stops the walk for every later session", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await roadmapLeftOpen(f);
  const s2 = sessionCtx(f, "sess-2");
  assert.equal((await executeVerb("pair_start", {}, s2)).result.roadmapOffer.fromSession, "sess-1");
  const declined = await executeVerb("pair_note", { earlierRoadmap: "start-fresh" }, s2);
  assert.equal(declined.ok, true, declined.text);
  assert.match(declined.text, /not offered again/);
  assert.equal(loadState(s2.sessionDir).roadmap, null);
  endSession({ sessionDir: s2.sessionDir });
  await sleep(10);
  const s3 = sessionCtx(f, "sess-3");
  assert.equal((await executeVerb("pair_start", {}, s3)).result.roadmapOffer, null);
  endSession({ sessionDir: s3.sessionDir });
  await sleep(10);
  assert.equal((await executeVerb("pair_start", {}, sessionCtx(f, "sess-4"))).result.roadmapOffer, null);
});

test("a picked-up roadmap is copied forward: after a quit, the next fresh start offers it from the new journal", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await roadmapLeftOpen(f);
  const firstJournal = readFileSync(join(f.dir, "journal.jsonl"));
  const s2 = sessionCtx(f, "sess-2");
  await executeVerb("pair_start", {}, s2);
  const picked = await executeVerb("pair_note", { earlierRoadmap: "pick-up" }, s2);
  assert.equal(picked.ok, true, picked.text);
  assert.deepEqual(loadState(s2.sessionDir).roadmap, roadmap);
  assert.ok(journal({ dir: s2.sessionDir }).some((e) => e.type === "note" && e.carriedFrom === "sess-1"));
  endSession({ sessionDir: s2.sessionDir });
  await sleep(10);
  const r = await executeVerb("pair_start", {}, sessionCtx(f, "sess-3"));
  assert.equal(r.result.roadmapOffer.fromSession, "sess-2");
  assert.deepEqual(r.result.roadmapOffer.items.map((i) => i.id), ["cache", "auth"]);
  assert.deepEqual(readFileSync(join(f.dir, "journal.jsonl")), firstJournal, "the earlier journal stays as it is");
});

test("an OMP /clear in place offers the roadmap the same session recorded before it", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await executeVerb("pair_start", {}, f.ctx);
  await executeVerb("pair_note", { roadmap }, f.ctx);
  assert.equal(clearInPlace({ sessionId: "sess-1", sessionDir: f.dir, reason: "clear" }).carried, true);
  const r = await executeVerb("pair_start", {}, f.ctx);
  assert.equal(r.result.roadmapOffer.fromSession, "sess-1");
});

test("the OMP joint test's shape: two cards and a not-ready item, /clear in place, then pair_start offers it and numbers on", { skip: !hasSandbox }, async () => {
  const f = fixture();
  await executeVerb("pair_start", {}, f.ctx);
  for (const boundary of [["src/a.txt"], ["src/b.txt"]]) assert.equal((await executeVerb("pair_propose", { boundary }, f.ctx)).ok, true);
  const trial = [
    { id: "shout", title: "Shout the greeting", status: "done" },
    { id: "readme", title: "Document it in the README", status: "not-ready", note: "waits on the wording" },
  ];
  assert.equal((await executeVerb("pair_note", { roadmap: trial }, f.ctx)).ok, true);
  // OMP /clear: the same session dir ends with stop session-end and carries closed.
  assert.equal(clearInPlace({ sessionId: "sess-1", sessionDir: f.dir, reason: "omp:clear" }).carried, true);
  const refused = await executeVerb("pair_propose", { boundary: ["src/a.txt"] }, f.ctx);
  assert.equal(refused.ok, false);
  assert.match(refused.text, /pairing is still on and the card is closed after a session change\. Tell your partner pairing carried over closed and wait for their answer/);
  const r = await executeVerb("pair_start", {}, f.ctx);
  assert.equal(r.ok, true, r.text);
  assert.equal(r.result.roadmapOffer.fromSession, "sess-1");
  assert.deepEqual(r.result.roadmapOffer.items.map((i) => `${i.id}:${i.status}`), ["readme:not-ready"]);
  const types = journal(f).map((e) => e.type === "stop" ? `stop:${e.verb}` : e.type);
  assert.deepEqual(types.slice(types.indexOf("stop:session-end")), ["stop:session-end", "carried-after-clear", "refusal", "start", "roadmap-offered"]);
  // The new card does not reuse an id this journal already holds.
  const next = await executeVerb("pair_propose", { boundary: ["src/a.txt"] }, f.ctx);
  assert.equal(next.result.card.id, "card-3");
  assert.equal(journal(f).filter((e) => e.type === "card").map((e) => e.card.id).join(","), "card-1,card-2,card-3");
});

test("card numbering continues after a typed stop and a later pair_start in the same session", { skip: !hasSandbox }, async () => {
  const f = fixture();
  assert.equal(await openChangeSet(f), "card-1");
  typed(f, "pair stop");
  assert.equal(loadState(f.dir).phase, "inactive");
  assert.equal(await openChangeSet(f), "card-2", "pair_start after the stop numbers on from the same journal");
});

test(`the walk reads at most ${ROADMAP_WALK_LIMIT} journals, newest first`, { skip: !hasSandbox }, async () => {
  const f = fixture();
  await roadmapLeftOpen(f);
  const old = statSync(join(f.dir, "journal.jsonl")).mtime.getTime() / 1000;
  const empty = (i) => {
    const dir = join(f.base, `empty-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "activated"), JSON.stringify({ root: f.root, stateDir: dir, ended: true }));
    writeFileSync(join(dir, "journal.jsonl"), `${JSON.stringify({ type: "start" })}\n`);
    utimesSync(join(dir, "journal.jsonl"), old + 1 + i, old + 1 + i);
  };
  for (let i = 0; i < ROADMAP_WALK_LIMIT - 1; i++) empty(i);
  assert.equal((await executeVerb("pair_start", {}, sessionCtx(f, "within"))).result.roadmapOffer.fromSession, "sess-1");
  // "within" holds only an unanswered offer; age it below sess-1 so exactly ROADMAP_WALK_LIMIT
  // empty journals sit above sess-1, which puts sess-1 one past the limit.
  utimesSync(join(f.base, "within", "journal.jsonl"), old - 1, old - 1);
  empty(ROADMAP_WALK_LIMIT);
  assert.equal((await executeVerb("pair_start", {}, sessionCtx(f, "beyond"))).result.roadmapOffer, null);
});
