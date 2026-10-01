// gate.test.mjs — node --test, run from plugins/paired-coding/.
//
// Every verdict in the gate core, driven by fake events: a fake worktree (a Map of path to
// content) supplies hashBoundary and snapshot, and a fake clock stamps the journal. The
// pair_run cases also run the real profile under macOS `sandbox-exec` against a temp
// directory, because a Seatbelt profile is only proven by the kernel refusing a write; those
// cases skip where sandbox-exec does not exist.
//
// The adversarial tests carry the numbers of the plan's adversarial gate tests (11 to 17),
// plus "stop without the user's words". The host-only halves of those tests (auto-backgrounding,
// timeouts and process-group kills, a second extension really rewriting a call) belong to the
// adapters' live runs; here they are reduced to the core's part of the contract.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PAIR_TOOLS,
  boundaryMatches,
  boundaryProblem,
  checkWrite,
  diffSnapshots,
  inactiveState,
  pairBegin,
  pairDone,
  pairNote,
  pairPropose,
  pairRunProfile,
  pairStart,
  pairStop,
  readState,
  recordInput,
  resolvePath,
  runEnd,
  runStart,
  serializeState,
  sessionEnd,
  toolVerdict,
} from "./gate.mjs";

const ROOT = "/work/repo";
const STATE_DIR = "/state/session-1";

// ─── fake host ──────────────────────────────────────────────────────────────────────────

function fakeHost(initial = { "src/a.ts": "a1", "src/b.ts": "b1", "README.md": "r1" }) {
  const files = new Map(Object.entries(initial));
  const log = [];
  let clock = 1000;
  const io = {
    now: () => ++clock,
    snapshot: () => {
      log.push("snapshot");
      return Object.fromEntries([...files].map(([p, c]) => [p, `file:${c}`]));
    },
    hashBoundary: (boundary) => {
      const out = {};
      for (const [p, c] of files) if (boundaryMatches(boundary, p)) out[p] = `file:${c}`;
      for (const e of boundary) if (!/[*?]/.test(e) && !e.endsWith("/") && !(e in out)) out[e] = "absent";
      return out;
    },
    reapRuns: (ids) => log.push(`reap:${ids.join(",")}`),
  };
  return { files, io, log };
}

const card = (over = {}) => ({
  whyNow: "first step of the roadmap",
  decision: "return early instead of throwing",
  currentCode: "throw new Error()",
  effect: "callers get null",
  boundary: ["src/a.ts"],
  checks: ["node --test"],
  openPoints: [],
  ...over,
});

const ok = (r) => {
  assert.equal(r.ok, true, r.reason);
  return r.state;
};
const say = (state, text, source = "interactive") => recordInput(state, { text, source }).state;

function started(host = fakeHost()) {
  return ok(pairStart(inactiveState(), { sessionId: "s1", root: ROOT, stateDir: STATE_DIR }, host.io));
}

/** A session with card-1 proposed and agreed: phase open on ["src/a.ts"] unless overridden. */
function opened(host = fakeHost(), over = {}) {
  let s = started(host);
  s = ok(pairPropose(s, card(over), host.io));
  s = say(s, "yes, go ahead with that");
  return ok(pairBegin(s, { cardId: s.card.id, quote: "go ahead" }, host.io));
}

const refusedWith = (r, pattern) => {
  assert.equal(r.ok, false, "expected a refusal");
  assert.match(r.reason, pattern);
  assert.equal(r.journal.at(-1).type, "refusal");
};

// ─── inactive ───────────────────────────────────────────────────────────────────────────

describe("inactive: the gate does nothing", () => {
  test("every host tool is allowed, nothing is journaled", () => {
    for (const toolName of ["write", "Bash", "task", "mcp__anything"]) {
      const v = toolVerdict(inactiveState(), { toolName });
      assert.equal(v.allow, true);
      assert.deepEqual(v.journal, []);
    }
  });

  test("human turns are not recorded and pairing verbs refuse", () => {
    const s = inactiveState();
    assert.equal(recordInput(s, { text: "hi", source: "interactive" }).state, s);
    const host = fakeHost();
    refusedWith(pairPropose(s, card(), host.io), /not active/);
    refusedWith(pairBegin(s, { cardId: "card-1", quote: "x" }, host.io), /not active/);
    refusedWith(pairStop(s, { quote: "x" }, host.io), /not active/);
    refusedWith(pairNote(s, { text: "n" }, host.io), /not active/);
    refusedWith(runStart(s, { runId: "r" }, host.io), /not active/);
    assert.match(checkWrite(s, { path: "src/a.ts" }).reason, /not active/);
  });
});

// ─── state persistence ──────────────────────────────────────────────────────────────────

describe("readState fails closed once activated", () => {
  test("a missing file in a never-activated session is inactive", () => {
    assert.equal(readState(null).phase, "inactive");
  });

  test("a missing file in an activated session is closed", () => {
    const s = readState(null, { activated: true, root: ROOT, stateDir: STATE_DIR });
    assert.equal(s.phase, "closed");
    assert.equal(s.degraded, "state file missing");
  });

  test("unreadable and malformed files are closed, never inactive", () => {
    assert.equal(readState("{not json").phase, "closed");
    assert.equal(readState(JSON.stringify({ v: 1, phase: "open" })).phase, "closed");
    assert.equal(readState(JSON.stringify({ v: 2, phase: "inactive" })).phase, "closed");
    assert.equal(readState(JSON.stringify({ ...opened(), changeSet: null })).phase, "closed");
    const s = opened();
    const broken = { ...s, changeSet: { ...s.changeSet, boundary: ["/etc/passwd"] } };
    assert.equal(readState(JSON.stringify(broken)).phase, "closed");
  });

  test("a valid state round-trips", () => {
    const s = opened();
    assert.deepEqual(readState(serializeState(s)), s);
  });

  test("a degraded closed state refuses the host's writes and has nothing to agree to", () => {
    const s = readState("garbage", { root: ROOT, stateDir: STATE_DIR });
    assert.equal(toolVerdict(s, { toolName: "write" }).allow, false);
    refusedWith(pairBegin(s, { cardId: "card-1", quote: "go" }, fakeHost().io), /no card/);
  });

  test("a degraded state without its root refuses pair_run and pair_propose", () => {
    const s = readState("garbage");
    refusedWith(runStart(s, { runId: "r1" }), /lost its worktree root/);
    refusedWith(pairPropose(s, card(), fakeHost().io), /lost its worktree root/);
  });
});

// ─── start ──────────────────────────────────────────────────────────────────────────────

describe("pair_start", () => {
  test("activates into closed with a baseline snapshot", () => {
    const host = fakeHost();
    const r = pairStart(inactiveState(), { root: ROOT, stateDir: STATE_DIR, exclusions: ["node_modules"] }, host.io);
    assert.equal(r.state.phase, "closed");
    assert.deepEqual(Object.keys(r.state.baseline).sort(), ["README.md", "src/a.ts", "src/b.ts"]);
    assert.equal(r.journal[0].type, "start");
    assert.deepEqual(r.journal[0].exclusions, ["node_modules"]);
  });

  test("refuses when already pairing", () => {
    refusedWith(pairStart(started(), { root: ROOT, stateDir: STATE_DIR }, fakeHost().io), /already active/);
  });

  test("refuses unusable paths, a worktree inside the state dir, and a failed snapshot", () => {
    const io = fakeHost().io;
    refusedWith(pairStart(inactiveState(), { root: "repo", stateDir: STATE_DIR }, io), /root/);
    refusedWith(pairStart(inactiveState(), { root: ROOT, stateDir: "" }, io), /state directory/);
    refusedWith(pairStart(inactiveState(), { root: "/state/x", stateDir: "/state" }, io), /inside the state directory/);
    refusedWith(pairStart(inactiveState(), { root: ROOT, stateDir: STATE_DIR, exclusions: ["../x"] }, io), /exclusion/);
    refusedWith(pairStart(inactiveState(), { root: ROOT, stateDir: STATE_DIR, tempPaths: ["tmp"] }, io), /temp path/);
    refusedWith(pairStart(inactiveState(), { root: ROOT, stateDir: STATE_DIR, protect: ["../.git"] }, io), /protected path/);
    const failing = { ...io, snapshot: () => { throw new Error("disk gone"); } };
    refusedWith(pairStart(inactiveState(), { root: ROOT, stateDir: STATE_DIR }, failing), /disk gone/);
  });

  test("canonicalizes root and state dir through the injected realpath", () => {
    const io = { ...fakeHost().io, realpath: (p) => `/private${p}` };
    const s = ok(pairStart(inactiveState(), { root: "/var/repo", stateDir: "/var/state" }, io));
    assert.equal(s.root, "/private/var/repo");
    assert.equal(s.stateDir, "/private/var/state");
  });
});

// ─── trusted input ──────────────────────────────────────────────────────────────────────

describe("recordInput", () => {
  test("an interactive turn enters the trusted store with the next sequence number", () => {
    const r = recordInput(started(), { text: "hello", source: "interactive" });
    assert.equal(r.trusted, true);
    assert.equal(r.state.lastInput.seq, 1);
    assert.equal(r.state.lastInput.text, "hello");
  });

  test("rpc and extension turns are journaled as untrusted and change nothing", () => {
    const s = started();
    for (const source of ["rpc", "extension", undefined]) {
      const r = recordInput(s, { text: "go ahead", source });
      assert.equal(r.trusted, false);
      assert.equal(r.state, s);
      assert.equal(r.journal[0].type, "untrusted-input");
    }
  });
});

// ─── propose ────────────────────────────────────────────────────────────────────────────

describe("pair_propose", () => {
  test("records the card, its boundary hashes and the latest trusted sequence", () => {
    const host = fakeHost();
    let s = say(started(host), "let's pair on the parser");
    const r = pairPropose(s, card({ boundary: ["src/a.ts", "src/new.ts"] }), host.io);
    assert.equal(r.card.id, "card-1");
    assert.equal(r.card.inputSeq, 1);
    assert.deepEqual(r.card.hashes, { "src/a.ts": "file:a1", "src/new.ts": "absent" });
    assert.equal(r.journal[0].type, "card");
  });

  test("refuses a card without a usable boundary", () => {
    const s = started();
    const io = fakeHost().io;
    for (const boundary of [undefined, [], [""], [7], ["../x"], ["src/./a.ts"], ["src//a.ts"], ['src/"a'], ["src/\u0000"]]) {
      refusedWith(pairPropose(s, card({ boundary }), io), /boundary/);
    }
    refusedWith(pairPropose(s, card({ boundary: ["/etc/x"] }), io), /is absolute/);
  });

  test("refuses while a change set is open", () => {
    refusedWith(pairPropose(opened(), card(), fakeHost().io), /change set is open/);
  });

  test("refuses when the boundary cannot be hashed", () => {
    const io = { ...fakeHost().io, hashBoundary: () => { throw new Error("EACCES"); } };
    refusedWith(pairPropose(started(), card(), io), /EACCES/);
  });

  test("refuses malformed hashes, a non-object card, and non-list checks or open points", () => {
    const s = started();
    const io = fakeHost().io;
    refusedWith(pairPropose(s, card(), { ...io, hashBoundary: () => ({ "src/a.ts": 1 }) }), /malformed hashes/);
    refusedWith(pairPropose(s, null, io), /not an object/);
    refusedWith(pairPropose(s, card({ openPoints: "which null?" }), io), /openPoints/);
    refusedWith(pairPropose(s, card({ checks: "node --test" }), io), /checks/);
  });
});

// ─── begin: checks (a) to (d) and the rest ──────────────────────────────────────────────

describe("pair_begin", () => {
  function proposed(host = fakeHost(), over = {}) {
    return ok(pairPropose(started(host), card(over), host.io));
  }

  test("opens the change set on a quote from the user's turn after the card", () => {
    const host = fakeHost();
    const s = say(proposed(host), "Sounds right. Go ahead.");
    const r = pairBegin(s, { cardId: "card-1", quote: "Go ahead." }, host.io);
    assert.equal(r.state.phase, "open");
    assert.deepEqual(r.state.changeSet.boundary, ["src/a.ts"]);
    const agreement = r.journal.find((e) => e.type === "agreement");
    assert.equal(agreement.quote, "Go ahead.");
    assert.equal(agreement.inputSeq, 1);
    assert.ok(agreement.cardAt < agreement.at);
  });

  test("(a) refuses a card that is not the latest", () => {
    const host = fakeHost();
    let s = ok(pairPropose(proposed(host), card({ decision: "revised" }), host.io));
    s = say(s, "go ahead");
    refusedWith(pairBegin(s, { cardId: "card-1", quote: "go ahead" }, host.io), /not the latest card/);
  });

  test("(b) refuses when the user has typed nothing since the card", () => {
    const host = fakeHost();
    let s = say(started(host), "go ahead");
    s = ok(pairPropose(s, card(), host.io));
    refusedWith(pairBegin(s, { cardId: "card-1", quote: "go ahead" }, host.io), /not typed a turn since the card/);
  });

  test("(c) refuses a quote that is not verbatim in the latest turn", () => {
    const host = fakeHost();
    const s = say(proposed(host), "hmm, why not keep the throw?");
    refusedWith(pairBegin(s, { cardId: "card-1", quote: "go ahead" }, host.io), /does not occur verbatim/);
    refusedWith(pairBegin(s, { cardId: "card-1", quote: "Why not keep" }, host.io), /does not occur verbatim/);
  });

  test("(c) refuses an empty or blank quote", () => {
    const host = fakeHost();
    const s = say(proposed(host), "go ahead");
    for (const quote of ["", "   ", undefined, 7]) {
      refusedWith(pairBegin(s, { cardId: "card-1", quote }, host.io), /quote .* is empty/);
    }
  });

  test("(d) refuses a stale card when a boundary file changed after it was shown", () => {
    const host = fakeHost();
    const s = say(proposed(host), "go ahead");
    host.files.set("src/a.ts", "edited in another editor");
    refusedWith(pairBegin(s, { cardId: "card-1", quote: "go ahead" }, host.io), /stale/);
  });

  test("(d) a new file matching a glob boundary also makes the card stale", () => {
    const host = fakeHost();
    const s = say(proposed(host, { boundary: ["src/*.ts"] }), "go ahead");
    host.files.set("src/c.ts", "new");
    refusedWith(pairBegin(s, { cardId: "card-1", quote: "go ahead" }, host.io), /stale/);
  });

  test("refuses when the boundary cannot be re-hashed or the worktree cannot be snapshotted", () => {
    const host = fakeHost();
    const s = say(proposed(host), "go ahead");
    const noHash = { ...host.io, hashBoundary: () => { throw new Error("EIO"); } };
    refusedWith(pairBegin(s, { cardId: "card-1", quote: "go ahead" }, noHash), /EIO/);
    const noSnap = { ...host.io, snapshot: () => "not a snapshot" };
    refusedWith(pairBegin(s, { cardId: "card-1", quote: "go ahead" }, noSnap), /malformed snapshot/);
  });

  test("refuses while the card still lists open points", () => {
    const host = fakeHost();
    const s = say(proposed(host, { openPoints: ["null or undefined?"] }), "looks good, go ahead");
    refusedWith(pairBegin(s, { cardId: "card-1", quote: "go ahead" }, host.io), /open points/);
  });

  test("refuses when no card exists or a change set is already open", () => {
    const host = fakeHost();
    refusedWith(pairBegin(say(started(host), "go"), { cardId: "card-1", quote: "go" }, host.io), /no card/);
    const s = say(opened(host), "go again");
    refusedWith(pairBegin(s, { cardId: "card-1", quote: "go again" }, host.io), /already open/);
  });

  test("changes found between change sets ride on the next card", () => {
    const host = fakeHost();
    let s = say(proposed(host), "go ahead");
    host.files.set("README.md", "the user's own edit");
    s = ok(pairBegin(s, { cardId: "card-1", quote: "go ahead" }, host.io));
    assert.deepEqual(s.unreviewed, [{ path: "README.md", change: "modified" }]);
    s = ok(pairDone(s, { cardId: "card-1" }, host.io));
    const r = pairPropose(s, card({ boundary: ["src/b.ts"] }), host.io);
    assert.deepEqual(r.card.changedSinceReadBack, [{ path: "README.md", change: "modified" }]);
    assert.deepEqual(r.state.unreviewed, []);
  });
});

// ─── done ───────────────────────────────────────────────────────────────────────────────

describe("pair_done", () => {
  test("returns the boundary changes for the read-back and closes", () => {
    const host = fakeHost();
    let s = opened(host);
    host.files.set("src/a.ts", "a2");
    const r = pairDone(s, { cardId: "card-1" }, host.io);
    assert.equal(r.state.phase, "closed");
    assert.deepEqual(r.changed, [{ path: "src/a.ts", change: "modified" }]);
    assert.deepEqual(r.unapproved, []);
    assert.equal(r.halted, false);
  });

  test("refuses when nothing is open or the card is not the open one", () => {
    const host = fakeHost();
    refusedWith(pairDone(started(host), { cardId: "card-1" }, host.io), /no change set is open/);
    refusedWith(pairDone(opened(host), { cardId: "card-9" }, host.io), /not the open change set/);
  });

  test("a change outside the boundary is an unapproved write and stops the session", () => {
    const host = fakeHost();
    const s = opened(host);
    host.files.set("src/b.ts", "stray");
    const r = pairDone(s, { cardId: "card-1" }, host.io);
    assert.equal(r.halted, true);
    assert.deepEqual(r.unapproved, [{ path: "src/b.ts", change: "modified" }]);
    assert.ok(r.journal.some((e) => e.type === "unapproved-write"));
    assert.match(r.state.halt.reason, /src\/b\.ts/);
  });

  test("a stopped session refuses every way forward except pair_stop", () => {
    const host = fakeHost();
    let s = opened(host);
    host.files.set("src/b.ts", "stray");
    s = pairDone(s, { cardId: "card-1" }, host.io).state;
    refusedWith(pairPropose(s, card(), host.io), /stopped/);
    refusedWith(pairBegin(s, { cardId: "card-1", quote: "x" }, host.io), /stopped/);
    refusedWith(runStart(s, { runId: "r9" }, host.io), /stopped/);
    s = say(s, "ok, stop pairing");
    assert.equal(pairStop(s, { quote: "stop pairing" }, host.io).state.phase, "inactive");
  });

  test("a failed snapshot refuses the close and keeps the change set open", () => {
    const host = fakeHost();
    const r = pairDone(opened(host), { cardId: "card-1" }, { ...host.io, snapshot: () => { throw new Error("EIO"); } });
    refusedWith(r, /EIO/);
    assert.equal(r.state.phase, "open");
  });

  test("a failed reap refuses the close", () => {
    const host = fakeHost();
    let s = ok(runStart(opened(host), { runId: "r1" }));
    s = ok(runEnd(s, { runId: "r1", exitCode: 0 }));
    const io = { ...host.io, reapRuns: () => { throw new Error("EPERM"); } };
    refusedWith(pairDone(s, { cardId: "card-1" }, io), /reap/);
  });
});

// ─── tool verdicts ──────────────────────────────────────────────────────────────────────

describe("toolVerdict while pairing", () => {
  test("read-only tools and the pair verbs are allowed in closed and open", () => {
    for (const s of [started(), opened()]) {
      for (const toolName of ["read", "grep", "glob", "find", "Read", "Grep", "Glob", "pair_propose", "pair_note", "pair_run", "pair_stop"]) {
        assert.equal(toolVerdict(s, { toolName }).allow, true, toolName);
      }
    }
  });

  test("pair_write and pair_edit are refused at the call in closed, allowed in open", () => {
    for (const toolName of ["pair_write", "pair_edit"]) {
      assert.equal(toolVerdict(started(), { toolName }).allow, false);
      assert.equal(toolVerdict(opened(), { toolName }).allow, true);
    }
  });

  test("an unknown tool fails closed", () => {
    for (const toolName of ["mcp__server__tool", "todo_write", "", undefined]) {
      const v = toolVerdict(started(), { toolName });
      assert.equal(v.allow, false);
      assert.match(v.reason, /not on the pairing allowlist/);
      assert.equal(v.journal[0].type, "refusal");
    }
  });

  test("opts.allow adds lifecycle tools but cannot re-allow a mutating or dispatch tool", () => {
    const s = started();
    assert.equal(toolVerdict(s, { toolName: "host_resume_read" }, { allow: ["host_resume_read"] }).allow, true);
    for (const toolName of ["write", "bash", "task", "Agent"]) {
      assert.equal(toolVerdict(s, { toolName }, { allow: [toolName] }).allow, false, toolName);
    }
  });
});

// ─── pair_write / pair_edit ─────────────────────────────────────────────────────────────

describe("checkWrite on the final arguments", () => {
  test("allows a path inside the boundary, relative or absolute", () => {
    const s = opened();
    assert.equal(checkWrite(s, { path: "src/a.ts" }).ok, true);
    assert.equal(checkWrite(s, { path: `${ROOT}/src/a.ts` }).absPath, `${ROOT}/src/a.ts`);
  });

  test("glob and directory boundaries", () => {
    const host = fakeHost();
    const g = opened(host, { boundary: ["src/*.ts", "lib/", "test/**/*.test.mjs"] });
    for (const p of ["src/a.ts", "src/new.ts", "lib/x/y.js", "test/a.test.mjs", "test/x/y/a.test.mjs"]) {
      assert.equal(checkWrite(g, { path: p }).ok, true, p);
    }
    for (const p of ["src/sub/a.ts", "src/a.tsx", "lib", "test/a.mjs", "README.md"]) {
      assert.equal(checkWrite(g, { path: p }).ok, false, p);
    }
  });

  test("brackets and braces in a boundary are literal characters", () => {
    const s = opened(fakeHost(), { boundary: ["app/[id]/page.tsx"] });
    assert.equal(checkWrite(s, { path: "app/[id]/page.tsx" }).ok, true);
    assert.equal(checkWrite(s, { path: "app/i/page.tsx" }).ok, false);
  });

  test("refuses traversal out of the worktree and unusable paths", () => {
    const s = opened(fakeHost(), { boundary: ["**"] });
    for (const path of ["../outside.ts", "src/../../outside.ts", "/etc/hosts", "", "a\u0000b", 42]) {
      assert.equal(checkWrite(s, { path }).ok, false, String(path));
    }
  });

  test("a symlink cannot carry a write out of the boundary or into the state dir", () => {
    const s = opened();
    const toState = { realpath: () => `${STATE_DIR}/state.json` };
    assert.match(checkWrite(s, { path: "src/a.ts" }, toState).reason, /state directory/);
    const outside = { realpath: () => "/etc/passwd" };
    assert.match(checkWrite(s, { path: "src/a.ts" }, outside).reason, /outside the agreed boundary/);
    const broken = { realpath: () => { throw new Error("ELOOP"); } };
    assert.match(checkWrite(s, { path: "src/a.ts" }, broken).reason, /ELOOP/);
  });
});

// ─── pair_run admission and profiles ────────────────────────────────────────────────────

describe("runStart and runEnd", () => {
  test("closed: admitted with the closed profile, not tied to a change set", () => {
    const r = runStart(started(), { runId: "r1" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.state.running, [{ runId: "r1", cardId: null }]);
    assert.match(r.profile, /^\(version 1\)\(allow default\)\(deny file-write\* \(subpath "\/work\/repo"\)\)/);
  });

  test("open: tied to the change set; pair_done refuses until it ends", () => {
    const host = fakeHost();
    let s = ok(runStart(opened(host), { runId: "r1" }));
    assert.deepEqual(s.changeSet.runs, ["r1"]);
    refusedWith(runStart(s, { runId: "r1" }), /already running/);
    refusedWith(pairDone(s, { cardId: "card-1" }, host.io), /still running/);
    s = ok(runEnd(s, { runId: "r1", exitCode: 0 }));
    assert.equal(pairDone(s, { cardId: "card-1" }, host.io).ok, true);
  });

  test("a run needs an id", () => {
    refusedWith(runStart(started(), {}), /no id/);
  });

  test("a profile that cannot be expressed refuses the run", () => {
    const s = { ...started(), root: "/work/re\npo" };
    refusedWith(runStart(s, { runId: "r1" }), /sandbox profile/);
  });

  test("a hand-written open state that also carries a stop refuses writes", () => {
    const s = { ...opened(), halt: { reason: "unapproved write" } };
    assert.match(checkWrite(s, { path: "src/a.ts" }).reason, /stopped/);
  });
});

// ─── pair_note ──────────────────────────────────────────────────────────────────────────

test("pair_note journals a note and refuses an empty one", () => {
  const r = pairNote(started(), { text: "roadmap: 1. parser 2. cache" });
  assert.equal(r.journal[0].type, "note");
  refusedWith(pairNote(started(), { text: "  " }), /empty/);
});

// ─── pair_stop and session end ──────────────────────────────────────────────────────────

describe("pair_stop", () => {
  test("ends pairing on a quote from the user's turn after the latest card", () => {
    const host = fakeHost();
    let s = ok(pairPropose(started(host), card(), host.io));
    s = say(s, "let's stop pairing for today");
    const r = pairStop(s, { quote: "stop pairing" }, host.io);
    assert.equal(r.state.phase, "inactive");
    assert.equal(r.journal.at(-1).type, "stop");
    assert.equal(r.journal.at(-1).quote, "stop pairing");
  });

  test("with no card yet, the turn must come after pair_start", () => {
    const host = fakeHost();
    const s = say(started(host), "stop");
    assert.equal(pairStop(s, { quote: "stop" }, host.io).ok, true);
  });

  test("refuses a quote from before the latest card", () => {
    const host = fakeHost();
    let s = say(started(host), "we can stop after this one");
    s = ok(pairPropose(s, card(), host.io));
    refusedWith(pairStop(s, { quote: "stop" }, host.io), /not typed a turn since the card/);
  });

  test("refuses a quote that is not verbatim, or empty", () => {
    const host = fakeHost();
    const s = say(started(host), "keep going");
    refusedWith(pairStop(s, { quote: "stop" }, host.io), /does not occur verbatim/);
    refusedWith(pairStop(s, { quote: "" }, host.io), /empty/);
  });

  test("refuses while a change set is open or a pair_run is running", () => {
    const host = fakeHost();
    const open = say(opened(host), "stop");
    refusedWith(pairStop(open, { quote: "stop" }, host.io), /change set is open/);
    const running = say(ok(runStart(started(host), { runId: "r1" })), "stop");
    refusedWith(pairStop(running, { quote: "stop" }, host.io), /still running/);
  });

  test("reports what changed since the last read-back", () => {
    const host = fakeHost();
    let s = say(started(host), "stop now");
    host.files.set("README.md", "r2");
    const r = pairStop(s, { quote: "stop now" }, host.io);
    assert.deepEqual(r.changedSinceReadBack, [{ path: "README.md", change: "modified" }]);
  });
});

describe("sessionEnd (adapter machinery)", () => {
  test("reaps every run first, judges an open change set, then goes inactive", () => {
    const host = fakeHost();
    let s = ok(runStart(opened(host), { runId: "r1" }));
    host.files.set("src/b.ts", "late stray");
    const r = sessionEnd(s, host.io);
    assert.deepEqual(host.log.slice(-2), ["reap:r1", "snapshot"]);
    assert.equal(r.state.phase, "inactive");
    assert.deepEqual(r.unapproved, [{ path: "src/b.ts", change: "modified" }]);
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────────────────

test("diffSnapshots names added, removed and modified paths and skips exclusions", () => {
  const d = diffSnapshots({ a: "1", b: "1", "nm/x": "1" }, { a: "2", c: "1", "nm/x": "2" }, ["nm"]);
  assert.deepEqual(d, [
    { path: "a", change: "modified" },
    { path: "b", change: "removed" },
    { path: "c", change: "added" },
  ]);
});

test("resolvePath collapses dot segments lexically", () => {
  assert.equal(resolvePath(ROOT, "src/../x"), `${ROOT}/x`);
  assert.equal(resolvePath(ROOT, "/a/./b"), "/a/b");
  assert.equal(resolvePath(ROOT, ""), null);
});

test("boundaryProblem accepts clean entries", () => {
  assert.equal(boundaryProblem(["src/a.ts", "lib/", "**/*.md", "app/[id]/page.tsx"]), null);
});

test("PAIR_TOOLS are the model-callable verbs", () => {
  assert.deepEqual([...PAIR_TOOLS].sort(), ["pair_begin", "pair_done", "pair_edit", "pair_note", "pair_propose", "pair_run", "pair_start", "pair_stop", "pair_write"]);
});

// ─── adversarial gate tests ─────────────────────────────────────────────────────────────

const SANDBOX = "/usr/bin/sandbox-exec";
const liveSkip = process.platform !== "darwin" || !existsSync(SANDBOX) ? "needs macOS sandbox-exec" : false;

/** A real temp worktree and state dir, both under one temp parent that is also a temp path. */
function liveDirs() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pair-gate-")));
  const root = join(base, "wt");
  const stateDir = join(base, "state");
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "lib"), { recursive: true });
  mkdirSync(stateDir);
  writeFileSync(join(root, "src", "a.ts"), "a1");
  writeFileSync(join(root, "src", "b.ts"), "b1");
  writeFileSync(join(stateDir, "state.json"), '{"v":1}');
  return { base, root, stateDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function liveState(dirs, phase, boundary = ["src/a.ts"]) {
  const io = { snapshot: () => ({}), hashBoundary: () => ({}) };
  let s = ok(pairStart(inactiveState(), { root: dirs.root, stateDir: dirs.stateDir, tempPaths: [dirs.base] }, io));
  if (phase === "open") {
    s = ok(pairPropose(s, card({ boundary }), io));
    s = say(s, "go");
    s = ok(pairBegin(s, { cardId: s.card.id, quote: "go" }, io));
  }
  return s;
}

function sandboxed(state, command, cwd) {
  const r = runStart(state, { runId: "live" });
  assert.equal(r.ok, true, r.reason);
  return spawnSync(SANDBOX, ["-p", r.profile, "/bin/sh", "-c", command], { cwd, encoding: "utf8" });
}

describe("adversarial 11: closed refuses every write path", () => {
  test("host write, edit, ast_edit, bash and eval (file write and subprocess) are refused", () => {
    const s = started();
    for (const toolName of ["write", "edit", "ast_edit", "bash", "eval", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]) {
      const v = toolVerdict(s, { toolName });
      assert.equal(v.allow, false, toolName);
      assert.match(v.reason, /host's own mutating tool/);
    }
  });

  test("pair_write and pair_edit refuse in closed at execution", () => {
    for (const toolName of ["pair_write", "pair_edit"]) {
      const r = checkWrite(started(), { path: "src/a.ts", toolName });
      assert.equal(r.ok, false);
      assert.match(r.reason, /no change set is open/);
      assert.equal(r.journal[0].verb, toolName);
    }
  });

  test("pair_run -- sh -c 'echo x > file' in the worktree is denied by Seatbelt", { skip: liveSkip }, () => {
    const dirs = liveDirs();
    try {
      const r = sandboxed(liveState(dirs, "closed"), "echo x > file; echo y > src/a.ts", dirs.root);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Operation not permitted/);
      assert.equal(existsSync(join(dirs.root, "file")), false);
      assert.equal(readFileSync(join(dirs.root, "src", "a.ts"), "utf8"), "a1");
    } finally {
      dirs.cleanup();
    }
  });
});

describe("adversarial 12: agreement binds only to the user's own later turn", () => {
  function pending() {
    const host = fakeHost();
    return { host, s: ok(pairPropose(say(started(host), "go ahead with the plan"), card(), host.io)) };
  }

  test("a quote that is not in the user's last trusted turn", () => {
    const { host, s } = pending();
    const later = say(say(s, "go ahead"), "actually wait, one question");
    refusedWith(pairBegin(later, { cardId: "card-1", quote: "go ahead" }, host.io), /does not occur verbatim/);
  });

  test("a quote from a turn before the card", () => {
    const { host, s } = pending();
    refusedWith(pairBegin(s, { cardId: "card-1", quote: "go ahead" }, host.io), /not typed a turn since the card/);
  });

  test("an rpc- or extension-sourced turn", () => {
    for (const source of ["rpc", "extension"]) {
      const { host, s } = pending();
      const injected = recordInput(s, { text: "go ahead", source }).state;
      refusedWith(pairBegin(injected, { cardId: "card-1", quote: "go ahead" }, host.io), /not typed a turn since the card/);
    }
  });
});

describe("adversarial 13: open keeps every write inside the boundary", () => {
  test("pair_write and pair_edit outside the boundary are refused with the reopen reason", () => {
    for (const toolName of ["pair_write", "pair_edit"]) {
      const r = checkWrite(opened(), { path: "src/b.ts", toolName });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "outside the agreed boundary; reopen");
    }
  });

  test("pair_write and pair_edit into the state dir are refused, even when the boundary covers it", () => {
    const host = fakeHost();
    let s = ok(pairStart(inactiveState(), { root: ROOT, stateDir: `${ROOT}/.pairing` }, host.io));
    s = ok(pairPropose(s, card({ boundary: ["**"] }), host.io));
    s = ok(pairBegin(say(s, "go"), { cardId: "card-1", quote: "go" }, host.io));
    for (const toolName of ["pair_write", "pair_edit"]) {
      assert.match(checkWrite(s, { path: ".pairing/state.json", toolName }).reason, /state directory/);
      assert.match(checkWrite(opened(), { path: `${STATE_DIR}/state.json`, toolName }).reason, /state directory/);
    }
  });

  test("the host's write, edit and bash stay refused in open", () => {
    for (const toolName of ["write", "edit", "bash", "eval"]) assert.equal(toolVerdict(opened(), { toolName }).allow, false);
  });

  test("a corrupted state reads as closed", () => {
    const s = readState('{"v":1,"phase":"open"', { activated: true, root: ROOT, stateDir: STATE_DIR });
    assert.equal(s.phase, "closed");
    assert.equal(toolVerdict(s, { toolName: "pair_write" }).allow, false);
    assert.equal(checkWrite(s, { path: "src/a.ts" }).ok, false);
  });

  test("pair_run: outside the boundary, the state dir, and the state file are denied; the boundary and temp are not", { skip: liveSkip }, () => {
    const dirs = liveDirs();
    try {
      const s = liveState(dirs, "open", ["src/a.ts", "src/deep/*.txt", "lib/"]);
      const ok1 = sandboxed(s, `echo a2 > src/a.ts && echo t > src/deep/n.txt && mkdir -p lib/x && echo l > lib/x/y.js && echo t > ${dirs.base}/scratch`, dirs.root);
      assert.equal(ok1.status, 0, ok1.stderr);
      assert.equal(readFileSync(join(dirs.root, "src", "a.ts"), "utf8"), "a2\n");
      for (const cmd of [
        "echo x > src/b.ts",
        "echo x > src/new.ts",
        "echo x > src/deep/n.md",
        `echo x > ${dirs.stateDir}/state.json`,
        `echo x > ${dirs.stateDir}/other`,
        `rm ${dirs.stateDir}/state.json`,
        `mv ${dirs.stateDir}/state.json ${dirs.base}/moved`,
      ]) {
        const r = sandboxed(s, cmd, dirs.root);
        assert.notEqual(r.status, 0, cmd);
      }
      assert.equal(readFileSync(join(dirs.root, "src", "b.ts"), "utf8"), "b1");
      assert.equal(existsSync(join(dirs.root, "src", "new.ts")), false);
      assert.equal(readFileSync(join(dirs.stateDir, "state.json"), "utf8"), '{"v":1}');
      assert.equal(existsSync(join(dirs.stateDir, "other")), false);
    } finally {
      dirs.cleanup();
    }
  });

  test("pair_run in closed cannot delete or corrupt the state file", { skip: liveSkip }, () => {
    const dirs = liveDirs();
    try {
      const s = liveState(dirs, "closed");
      for (const cmd of [`rm ${dirs.stateDir}/state.json`, `echo garbage > ${dirs.stateDir}/state.json`]) {
        assert.notEqual(sandboxed(s, cmd, dirs.base).status, 0, cmd);
      }
      assert.equal(readFileSync(join(dirs.stateDir, "state.json"), "utf8"), '{"v":1}');
    } finally {
      dirs.cleanup();
    }
  });

  test("pair_run: open denies writes outside the worktree and temp; closed allows them; protected paths deny both", { skip: liveSkip }, () => {
    const dirs = liveDirs();
    const other = realpathSync(mkdtempSync(join(tmpdir(), "pair-gate-other-")));
    const guarded = realpathSync(mkdtempSync(join(tmpdir(), "pair-gate-guarded-")));
    try {
      const io = { snapshot: () => ({}), hashBoundary: () => ({}) };
      let s = ok(pairStart(inactiveState(), { root: dirs.root, stateDir: dirs.stateDir, tempPaths: [dirs.base], protect: [guarded] }, io));
      assert.equal(sandboxed(s, `echo c > ${other}/closed.txt`, dirs.base).status, 0);
      assert.notEqual(sandboxed(s, `echo c > ${guarded}/closed.txt`, dirs.base).status, 0);
      s = ok(pairPropose(s, card(), io));
      s = ok(pairBegin(say(s, "go"), { cardId: s.card.id, quote: "go" }, io));
      assert.notEqual(sandboxed(s, `echo o > ${other}/open.txt`, dirs.base).status, 0);
      assert.notEqual(sandboxed(s, `echo o > ${guarded}/open.txt`, dirs.base).status, 0);
      assert.equal(existsSync(join(other, "open.txt")), false);
      assert.equal(existsSync(join(guarded, "closed.txt")), false);
    } finally {
      dirs.cleanup();
      rmSync(other, { recursive: true, force: true });
      rmSync(guarded, { recursive: true, force: true });
    }
  });
});

describe("adversarial 14: no write lands after the read-back", () => {
  test("pair_done refuses while the run is going, then reaps before it snapshots", () => {
    const host = fakeHost();
    let s = ok(runStart(opened(host), { runId: "r-long" }));
    // The user types while the long check runs: a trusted turn changes nothing about the run.
    s = say(s, "how's it going?");
    refusedWith(pairDone(s, { cardId: "card-1" }, host.io), /still running/);
    // Abort: the adapter kills and reaps the group, then reports the end.
    s = ok(runEnd(s, { runId: "r-long", exitCode: null }));
    // A grandchild that survived in the group keeps writing until it is reaped.
    let alive = true;
    const io = {
      ...host.io,
      reapRuns: (ids) => {
        host.log.push(`reap:${ids.join(",")}`);
        alive = false;
      },
      snapshot: () => {
        if (alive) host.files.set("src/a.ts", "written after read-back");
        return host.io.snapshot();
      },
    };
    const r = pairDone(s, { cardId: "card-1" }, io);
    assert.equal(r.ok, true);
    assert.deepEqual(host.log.slice(-2), ["reap:r-long", "snapshot"]);
    assert.equal(host.files.get("src/a.ts"), "a1");
  });
});

describe("adversarial 15: sub-agent dispatch is refused while pairing", () => {
  test("OMP task and Claude Code's agent tool, in closed and open", () => {
    for (const s of [started(), opened()]) {
      for (const toolName of ["task", "Task", "Agent"]) {
        const v = toolVerdict(s, { toolName });
        assert.equal(v.allow, false, toolName);
        assert.match(v.reason, /dispatch/);
      }
    }
  });
});

describe("adversarial 16: a revision after the pre-call check cannot widen the write", () => {
  test("pair_write: the pre-call verdict passes, a later handler rewrites the path, execution refuses", () => {
    const s = opened();
    const call = { toolName: "pair_write", input: { path: "src/a.ts" } };
    assert.equal(toolVerdict(s, call).allow, true);
    const revised = { ...call.input, path: "../escape.ts" };
    assert.equal(checkWrite(s, { path: revised.path, toolName: call.toolName }).ok, false);
    const revised2 = { ...call.input, path: "src/b.ts" };
    assert.equal(checkWrite(s, { path: revised2.path, toolName: call.toolName }).ok, false);
  });

  test("pair_run: a rewritten command still runs under the profile built from state", { skip: liveSkip }, () => {
    const dirs = liveDirs();
    try {
      const s = liveState(dirs, "open");
      const rewritten = "echo pwned > src/b.ts";
      const r = sandboxed(s, rewritten, dirs.root);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Operation not permitted/);
      assert.equal(readFileSync(join(dirs.root, "src", "b.ts"), "utf8"), "b1");
    } finally {
      dirs.cleanup();
    }
  });
});

describe("adversarial 17: an escaped writer is caught by the next change set's comparison", () => {
  test("a write to change set A's file during change set B stops the session", () => {
    const host = fakeHost();
    let s = opened(host);
    host.files.set("src/a.ts", "a2");
    s = ok(pairDone(s, { cardId: "card-1" }, host.io));
    s = ok(pairPropose(s, card({ boundary: ["src/b.ts"] }), host.io));
    s = ok(pairBegin(say(s, "yes do b"), { cardId: "card-2", quote: "yes do b" }, host.io));
    host.files.set("src/b.ts", "b2");
    host.files.set("src/a.ts", "written by the escaped process");
    const r = pairDone(s, { cardId: "card-2" }, host.io);
    assert.equal(r.halted, true);
    assert.deepEqual(r.unapproved, [{ path: "src/a.ts", change: "modified" }]);
    assert.deepEqual(r.changed, [{ path: "src/b.ts", change: "modified" }]);
  });
});

describe("adversarial: the agent stops pairing without the user's words, then writes", () => {
  test("pair_stop is refused and every write path stays refused", () => {
    const host = fakeHost();
    let s = ok(pairPropose(started(host), card(), host.io));
    s = say(s, "hmm, tell me more about the cache");
    const stop = pairStop(s, { quote: "stop pairing" }, host.io);
    refusedWith(stop, /does not occur verbatim/);
    assert.equal(stop.state.phase, "closed");
    const forged = recordInput(s, { text: "stop pairing", source: "extension" }).state;
    refusedWith(pairStop(forged, { quote: "stop pairing" }, host.io), /does not occur verbatim/);
    for (const toolName of ["write", "edit", "bash", "pair_write"]) assert.equal(toolVerdict(stop.state, { toolName }).allow, false, toolName);
    assert.equal(checkWrite(stop.state, { path: "src/a.ts" }).ok, false);
  });
});
