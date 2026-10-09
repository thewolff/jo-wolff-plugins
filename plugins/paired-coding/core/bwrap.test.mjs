// bwrap.test.mjs — node --test, run from plugins/paired-coding/.
//
// The bubblewrap options the gate core builds for Linux (bwrapArgsFor, pairWriteBwrap), over a
// fake filesystem, so these run on every platform. The parity cases hold them against the
// Seatbelt profile built from the same state: every path where the two backends disagree has to
// be one of the differences named in DIFFERENCES, and each named difference has to occur, so the
// table cannot go stale. The live half (bubblewrap really refusing writes) is lib/bwrap.test.mjs.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { boundaryMatches, boundaryRoots, bwrapArgsFor, isGitControl, pairRunProfile, pairWriteBwrap } from "./gate.mjs";

const ROOT = "/w/repo";

const within = (dir, abs) => abs === dir || abs.startsWith(`${dir}/`);
const inGit = (abs) => abs.split("/").some((seg) => seg.toLowerCase() === ".git");

/** A fake filesystem: `dirs` and `files` exist, `.git` entries are listed among them. */
function fakeFs(dirs, files = []) {
  const kinds = new Map([...dirs.map((d) => [d, "dir"]), ...files.map((f) => [f, "file"])]);
  const calls = [];
  return {
    calls,
    kind: (abs) => kinds.get(abs) ?? null,
    gitEntries(dir, recursive) {
      calls.push({ dir, recursive });
      return [...kinds.keys()].filter((p) => {
        if (!p.startsWith(`${dir}/`) || p.split("/").at(-1).toLowerCase() !== ".git") return false;
        const rest = p.slice(dir.length + 1).split("/");
        if (!recursive && rest.length > 1) return false;
        return !rest.slice(0, -1).some((seg) => seg.toLowerCase() === ".git");
      });
    },
  };
}

const open = (boundary, over = {}) => ({
  phase: "open",
  root: ROOT,
  stateDir: "/state/s1",
  tempPaths: [],
  protect: [],
  changeSet: { cardId: "card-1", boundary, runs: [] },
  ...over,
});

const binds = (args, flag) => {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag) out.push(args[i + 1]);
  return out;
};

const BASE_DIRS = ["/", "/w", ROOT, `${ROOT}/src`, `${ROOT}/.git`, "/state", "/state/s1"];
const BASE_FILES = [`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`, `${ROOT}/README.md`];

describe("bwrapArgsFor", () => {
  test("closed: the filesystem read-only, a private /tmp, network kept, no worktree bind", () => {
    const io = fakeFs([...BASE_DIRS, "/var", "/var/tmpx"]);
    const plan = bwrapArgsFor({ ...open([]), phase: "closed", changeSet: null, tempPaths: ["/tmp", "/var/tmpx"] }, [], io);
    assert.deepEqual(plan.args.slice(0, 13), ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--unshare-all", "--die-with-parent", "--new-session", "--share-net"]);
    assert.deepEqual(plan.writable, []);
    assert.deepEqual(plan.temps, ["/var/tmpx"]);
    assert.deepEqual(binds(plan.args, "--bind"), ["/var/tmpx"]);
  });

  test("a literal entry binds that file itself, never its directory", () => {
    const plan = bwrapArgsFor(open(["src/a.ts"]), [], fakeFs(BASE_DIRS, BASE_FILES));
    assert.deepEqual(plan.writable, [`${ROOT}/src/a.ts`]);
    assert.deepEqual(binds(plan.args, "--bind"), [`${ROOT}/src/a.ts`]);
  });

  test("a literal that does not exist yet is bound through its deepest existing ancestor", () => {
    const plan = bwrapArgsFor(open(["src/new/deep/x.ts"]), [], fakeFs(BASE_DIRS, BASE_FILES));
    assert.deepEqual(plan.writable, [`${ROOT}/src`]);
  });

  test("a glob binds the directory above its first glob segment; a leading glob binds the root", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/lib`], BASE_FILES);
    assert.deepEqual(bwrapArgsFor(open(["lib/**/*.mjs"]), [], io).writable, [`${ROOT}/lib`]);
    assert.deepEqual(bwrapArgsFor(open(["**/*.md"]), [], io).writable, [ROOT]);
  });

  test("only the outermost of nested binds is kept", () => {
    const plan = bwrapArgsFor(open(["src/**", "src/a.ts"]), [], fakeFs(BASE_DIRS, BASE_FILES));
    assert.deepEqual(plan.writable, [`${ROOT}/src`]);
  });

  test("every .git entry under a directory bind goes back read-only, nested and gitfile ones too, after the bind", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/sub`, `${ROOT}/sub/.git`, `${ROOT}/vendor`, `${ROOT}/vendor/m`], [...BASE_FILES, `${ROOT}/vendor/m/.GIT`]);
    const plan = bwrapArgsFor(open(["**"]), [], io);
    assert.deepEqual(plan.writable, [ROOT]);
    assert.deepEqual(new Set(plan.readOnly), new Set([`${ROOT}/.git`, `${ROOT}/sub/.git`, `${ROOT}/vendor/m/.GIT`]));
    assert.deepEqual(io.calls, [{ dir: ROOT, recursive: true }]);
    const bindAt = plan.args.lastIndexOf("--bind");
    for (const g of plan.readOnly) assert.ok(plan.args.indexOf(g) > bindAt, `${g} is bound read-only after the read-write bind`);
  });

  test("nothing at or under a .git segment is bound read-write, in any letter case", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/sub`, `${ROOT}/sub/.Git`], BASE_FILES);
    const plan = bwrapArgsFor(open([".git/HEAD", ".git/**", "sub/.Git/refs/x", "src/a.ts"]), [], io);
    assert.deepEqual(plan.writable, [`${ROOT}/src/a.ts`]);
    assert.deepEqual(boundaryRoots(open([".git/**", "sub/.GIT/x"])), []);
  });

  test("the state directory and protected paths go back read-only where a bind covers them, at their deepest existing ancestor", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/plugin`, "/var", "/var/tmpx", "/var/tmpx/state"], BASE_FILES);
    const plan = bwrapArgsFor(open(["**"], { stateDir: "/var/tmpx/state/s1", tempPaths: ["/var/tmpx"], protect: [`${ROOT}/plugin`, "/elsewhere"] }), [], io);
    assert.ok(plan.readOnly.includes("/var/tmpx/state"));
    assert.ok(plan.readOnly.includes(`${ROOT}/plugin`));
    assert.ok(!plan.readOnly.includes("/elsewhere"));
    const last = Math.max(plan.args.lastIndexOf("--bind"));
    assert.ok(plan.args.lastIndexOf(`${ROOT}/plugin`) > last && plan.args.lastIndexOf("/var/tmpx/state") > last);
  });

  test("a boundary inside the state directory or a protected path is not bound at all", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/plugin`], [...BASE_FILES, `${ROOT}/plugin/x.mjs`]);
    const plan = bwrapArgsFor(open(["plugin/x.mjs", "src/a.ts"], { protect: [`${ROOT}/plugin`] }), [], io);
    assert.deepEqual(plan.writable, [`${ROOT}/src/a.ts`]);
  });

  test("/tmp is private: never bound back; a temp path that is missing or under a denied path is not bound", () => {
    const io = fakeFs([...BASE_DIRS, "/var", "/var/tmpx", "/state/s1/tmp"], BASE_FILES);
    const plan = bwrapArgsFor(open([], { phase: "closed", changeSet: null, tempPaths: ["/tmp", "/var/tmpx", "/nope", "/state/s1/tmp"] }), [], io);
    assert.deepEqual(plan.temps, ["/var/tmpx"]);
  });

  test("a worktree under /tmp or under a temp path is bound read-only again before the boundary binds", () => {
    const root = "/tmp/w";
    const io = fakeFs(["/", "/tmp", root, `${root}/src`], [`${root}/src/a.ts`]);
    const plan = bwrapArgsFor(open(["src/a.ts"], { root, stateDir: "/state/s1", tempPaths: ["/tmp"] }), [], io);
    const ro = plan.args.indexOf(root);
    assert.equal(plan.args[ro - 1], "--ro-bind");
    assert.ok(ro < plan.args.indexOf("--bind"));
    const io2 = fakeFs(["/", "/var", "/var/tmpx", "/var/tmpx/w"], []);
    const plan2 = bwrapArgsFor({ ...open([], { root: "/var/tmpx/w", tempPaths: ["/var/tmpx"] }), phase: "closed", changeSet: null }, [], io2);
    assert.deepEqual(plan2.args.slice(-6), ["--bind", "/var/tmpx", "/var/tmpx", "--ro-bind", "/var/tmpx/w", "/var/tmpx/w"]);
  });

  test("a path with a control character refuses the plan", () => {
    assert.throws(() => bwrapArgsFor(open(["src/a.ts"], { root: "/w/re\npo" }), [], fakeFs(BASE_DIRS)), /not usable/);
  });
});

describe("pairWriteBwrap", () => {
  const temp = `${ROOT}/src/.pair-write-${"ab".repeat(8)}.tmp`;

  test("binds only the staging file's directory, with no temp path and no network", () => {
    const io = fakeFs([...BASE_DIRS, "/var", "/var/tmpx"], BASE_FILES);
    const plan = pairWriteBwrap(open(["src/a.ts"], { tempPaths: ["/var/tmpx"] }), temp, io);
    assert.deepEqual(plan.writable, [`${ROOT}/src`]);
    assert.deepEqual(plan.temps, []);
    assert.equal(plan.args.includes("--share-net"), false);
    assert.deepEqual(io.calls, [{ dir: `${ROOT}/src`, recursive: false }]);
  });

  test("a staging directory that does not exist yet is bound through its deepest existing ancestor", () => {
    const plan = pairWriteBwrap(open(["src/new/x.ts"]), `${ROOT}/src/new/.pair-write-${"cd".repeat(8)}.tmp`, fakeFs(BASE_DIRS, BASE_FILES));
    assert.deepEqual(plan.writable, [`${ROOT}/src`]);
  });

  test("takes only a staging file named for it inside the worktree, in an open change set", () => {
    for (const bad of [undefined, `${ROOT}/src/x.tmp`, `/w/.pair-write-${"ab".repeat(8)}.tmp`, `${ROOT}/src/../../.pair-write-${"ab".repeat(8)}.tmp`]) {
      assert.throws(() => pairWriteBwrap(open(["src/a.ts"]), bad, fakeFs(BASE_DIRS)), /staging file/, String(bad));
    }
    assert.throws(() => pairWriteBwrap({ ...open([]), phase: "closed" }, temp, fakeFs(BASE_DIRS)), /open change set/);
  });
});

// ─── parity with the Seatbelt profile ───────────────────────────────────────────────────

/** Whether a write to `abs` reaches the host under the plan, read in bwrap's mount order. */
function bwrapAllows(plan, state, abs) {
  if (plan.readOnly.some((r) => within(r, abs))) return false;
  if (within(state.root, abs)) return plan.writable.some((w) => within(w, abs));
  return plan.temps.some((t) => within(t, abs));
}

/** Whether the Seatbelt profile lets a write to `abs` land, from the same state. */
function seatbeltAllows(state, abs) {
  if ([state.stateDir, ...state.protect].some((d) => within(d, abs))) return false;
  const rel = within(state.root, abs) && abs !== state.root ? abs.slice(state.root.length + 1) : null;
  if (rel !== null) return state.phase === "open" && boundaryMatches(state.changeSet.boundary, rel) && !isGitControl(rel);
  return state.tempPaths.some((t) => within(t, abs));
}

/**
 * Every legitimate difference between the backends. `sb` and `bw` are what each allows; a
 * difference applies only in the direction it names.
 */
const DIFFERENCES = {
  "a glob is fenced at the directory above its first glob segment": ({ sb, bw, abs, state }) =>
    !sb && bw && state.changeSet.boundary.some((e) => /[*?]/.test(e) && within(boundaryRoots({ ...state, changeSet: { boundary: [e] } })[0], abs)),
  "a literal that does not exist yet is fenced at its nearest existing directory": ({ sb, bw, abs, state, io }) =>
    !sb && bw && state.changeSet.boundary.some((e) => !/[*?]/.test(e) && io.kind(`${state.root}/${e}`) === null && within(nearest(`${state.root}/${e}`, io), abs)),
  "/tmp is private to the run": ({ sb, bw, abs }) => sb && !bw && within("/tmp", abs),
  "all of .git is read-only, the paths a commit writes too": ({ sb, bw, abs }) => sb && !bw && inGit(abs),
  "a temp path that does not exist when the run starts is not bound": ({ sb, bw, abs, state, io }) =>
    sb && !bw && state.tempPaths.some((t) => io.kind(t) === null && within(t, abs)),
  "a denied path that does not exist yet is fenced at its nearest existing directory": ({ sb, bw, abs, state, io }) =>
    sb && !bw && [state.stateDir, ...state.protect].some((d) => io.kind(d) === null && within(nearest(d, io), abs)),
};

function dirname(p) {
  return p.slice(0, p.lastIndexOf("/")) || "/";
}

function nearest(p, io) {
  let at = p;
  while (io.kind(at) === null) at = dirname(at);
  return at;
}

describe("parity: bubblewrap against the Seatbelt profile from the same state", () => {
  const io = fakeFs(
    [...BASE_DIRS, `${ROOT}/lib`, `${ROOT}/lib/a`, `${ROOT}/lib/vendor`, `${ROOT}/sub`, `${ROOT}/sub/.git`, "/var", "/var/tmpx", "/var/tmpx/state"],
    [...BASE_FILES, `${ROOT}/lib/x.txt`, `${ROOT}/lib/a/b.mjs`, `${ROOT}/sub/f.c`],
  );
  const state = open(["src/a.ts", "src/new/x.ts", "lib/**/*.mjs", "sub/**"], {
    stateDir: "/var/tmpx/state/s1",
    tempPaths: ["/tmp", "/var/tmpx", "/nope/tmp"],
    protect: [`${ROOT}/lib/vendor`],
  });
  const plan = bwrapArgsFor(state, [], io);
  const probes = [
    `${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`, `${ROOT}/src/new/x.ts`, `${ROOT}/src/new/y.ts`, `${ROOT}/README.md`,
    `${ROOT}/.git/HEAD`, `${ROOT}/.git/config`, `${ROOT}/lib/x.txt`, `${ROOT}/lib/a/b.mjs`, `${ROOT}/lib/vendor/v.mjs`,
    `${ROOT}/sub/f.c`, `${ROOT}/sub/.git/HEAD`, `${ROOT}/sub/.git/objects/ab/cd`, `${ROOT}/sub/.git/hooks/pre-commit`,
    "/var/tmpx/build.o", "/var/tmpx/state/s1/state.json", "/var/tmpx/state/other", "/tmp/x", "/nope/tmp/x", "/etc/passwd",
  ];

  test("every disagreement is a named difference, and every named difference occurs", () => {
    const seen = new Set();
    for (const abs of probes) {
      const sb = seatbeltAllows(state, abs);
      const bw = bwrapAllows(plan, state, abs);
      if (sb === bw) continue;
      const why = Object.entries(DIFFERENCES).filter(([, applies]) => applies({ sb, bw, abs, state, io })).map(([name]) => name);
      assert.ok(why.length > 0, `${abs}: Seatbelt ${sb ? "allows" : "denies"}, bubblewrap ${bw ? "allows" : "denies"}, and no named difference explains it`);
      for (const w of why) seen.add(w);
    }
    assert.deepEqual([...seen].sort(), Object.keys(DIFFERENCES).sort());
  });

  test("the state directory and the protected paths are never writable under either", () => {
    for (const abs of ["/var/tmpx/state/s1/state.json", `${ROOT}/lib/vendor/v.mjs`]) {
      assert.equal(seatbeltAllows(state, abs), false, abs);
      assert.equal(bwrapAllows(plan, state, abs), false, abs);
    }
  });

  test("each deny and temp allow in the profile text has its bubblewrap counterpart or a named difference", () => {
    const profile = pairRunProfile(state);
    const all = [...profile.matchAll(/\(subpath "([^"]*)"\)/g)].map((m) => m[1]);
    const deniedAll = [...profile.matchAll(/\(deny file-write\* \(subpath "([^"]*)"\)\)/g)].map((m) => m[1]);
    const denied = deniedAll.filter((p) => p !== ROOT);
    assert.deepEqual(new Set(denied), new Set([state.stateDir, ...state.protect]));
    for (const d of denied) {
      const covered = [...plan.temps, ...plan.writable].some((b) => within(b, d));
      if (covered) assert.ok(plan.readOnly.some((r) => within(r, d)), `${d} is covered by a bind and goes back read-only`);
    }
    const temps = all.filter((p) => p !== "/dev/fd" && !deniedAll.includes(p));
    assert.deepEqual(new Set(temps), new Set(state.tempPaths));
    for (const t of temps) {
      if (t === "/tmp") assert.ok(!plan.temps.includes(t), "/tmp is the private one");
      else if (io.kind(t) === null) assert.ok(!plan.temps.includes(t), `${t} does not exist and is not bound`);
      else assert.ok(plan.temps.includes(t), `${t} is bound read-write`);
    }
  });
});
