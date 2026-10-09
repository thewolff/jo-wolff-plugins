// landlock.test.mjs — node --test, run from plugins/paired-coding/.
//
// The pair-landlock rulesets the gate core builds for Linux (landlockRulesFor,
// pairWriteLandlock), over a fake filesystem, so these run on every platform. The parity cases
// hold the ruleset against the Seatbelt profile built from the same state: every path where the
// two disagree has to be one of the differences named in DIFFERENCES, and each named difference
// has to occur, so the table cannot go stale. The live half (Landlock really refusing writes)
// is lib/landlock.test.mjs.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LANDLOCK_DEVICES, boundaryMatches, bwrapArgsFor, isGitControl, landlockRulesFor, pairWriteLandlock } from "./gate.mjs";

const ROOT = "/w/repo";

const within = (dir, abs) => abs === dir || abs.startsWith(`${dir}/`);
const inGit = (abs) => abs.split("/").some((seg) => seg.toLowerCase() === ".git");

/**
 * A fake filesystem for the Landlock builders: `dirs` and `files` exist (a file may be
 * `[path, nlink]`), `links` are symlinks. walk lists everything under a directory and does not
 * descend into `.git` or a symlink, as landlockIo does.
 */
function fakeFs(dirs, files = [], links = []) {
  const entries = new Map();
  for (const d of dirs) entries.set(d, { type: "dir", nlink: 2 });
  for (const f of files) {
    const [path, nlink] = Array.isArray(f) ? f : [f, 1];
    entries.set(path, { type: "file", nlink });
  }
  for (const l of links) entries.set(l, { type: "symlink", nlink: 1 });
  return {
    lstat: (abs) => entries.get(abs) ?? null,
    walk(dir) {
      return [...entries.entries()]
        .filter(([p]) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).split("/").slice(0, -1).some((s) => s.toLowerCase() === ".git"))
        .map(([path, st]) => ({ path, ...st }));
    },
    // the bwrapArgsFor half of the same filesystem, for the fallback case
    kind: (abs) => {
      const t = entries.get(abs)?.type;
      return t === "dir" || t === "file" ? t : null;
    },
    gitEntries(dir, recursive) {
      return [...entries.keys()].filter((p) => {
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

const BASE_DIRS = ["/", "/dev", "/w", ROOT, `${ROOT}/src`, `${ROOT}/.git`, "/state", "/state/s1"];
const BASE_FILES = [...LANDLOCK_DEVICES, `${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`, `${ROOT}/README.md`, `${ROOT}/.git/HEAD`];
const DEVICES = [...LANDLOCK_DEVICES];

describe("landlockRulesFor", () => {
  test("closed: the devices and the existing temp paths outside the worktree, nothing in it", () => {
    const io = fakeFs([...BASE_DIRS, "/var", "/var/tmpx", `${ROOT}/build`], BASE_FILES);
    const rules = landlockRulesFor({ ...open([]), phase: "closed", changeSet: null, tempPaths: ["/var/tmpx", "/nope", `${ROOT}/build`] }, [], io);
    assert.deepEqual(rules, { files: DEVICES, dirs: [], rw_trees: ["/var/tmpx"] });
  });

  test("a device that does not exist is not listed", () => {
    const io = fakeFs(BASE_DIRS, BASE_FILES.filter((f) => f !== "/dev/tty"));
    assert.deepEqual(landlockRulesFor({ ...open([]), phase: "closed", changeSet: null }, [], io).files, ["/dev/null", "/dev/zero"]);
  });

  test("a temp path that holds the state directory or the worktree is not expressible", () => {
    const io = fakeFs([...BASE_DIRS, "/var", "/var/tmpx", "/var/tmpx/state", "/var/tmpx/state/s1"], BASE_FILES);
    const st = landlockRulesFor(open(["src/a.ts"], { stateDir: "/var/tmpx/state/s1", tempPaths: ["/var/tmpx"] }), [], io);
    assert.match(st.notExpressible, /holds \/var\/tmpx\/state\/s1/);
    const wt = landlockRulesFor(open(["src/a.ts"], { tempPaths: ["/w"] }), [], io);
    assert.match(wt.notExpressible, /holds the worktree/);
  });

  test("an existing literal is granted as that one file; a missing literal gets nothing", () => {
    const io = fakeFs(BASE_DIRS, BASE_FILES);
    assert.deepEqual(landlockRulesFor(open(["src/a.ts", "src/new/x.ts", "src/c.ts"]), [], io), { files: [...DEVICES, `${ROOT}/src/a.ts`], dirs: [], rw_trees: [] });
  });

  test("a glob grants each existing match, and a directory only where every existing file matches", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/src/lib`, `${ROOT}/src/docs`],
      [...BASE_FILES, `${ROOT}/src/README.md`, `${ROOT}/src/lib/c.ts`, `${ROOT}/src/lib/d.ts`, `${ROOT}/src/docs/e.md`, `${ROOT}/src/docs/f.ts`]);
    const rules = landlockRulesFor(open(["src/**/*.ts"]), [], io);
    assert.deepEqual(rules, {
      files: [...DEVICES, `${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`, `${ROOT}/src/docs/f.ts`],
      dirs: [{ path: `${ROOT}/src/lib`, make_dir: true }],
      rw_trees: [],
    });
    // No existing file outside the boundary is reachable through any grant.
    const reach = (abs) => rules.files.includes(abs) || rules.dirs.some((d) => within(d.path, abs));
    for (const out of [`${ROOT}/src/README.md`, `${ROOT}/src/docs/e.md`, `${ROOT}/README.md`]) assert.equal(reach(out), false, out);
  });

  test("a directory the glob can hold nothing under gets no grant, even when it is empty", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/src/empty`, `${ROOT}/docs`, `${ROOT}/docs/sub`], [...BASE_FILES, `${ROOT}/docs/a.md`]);
    const flat = landlockRulesFor(open(["src/*.ts"]), [], io);
    assert.deepEqual(flat.dirs, [], "src holds only .ts files but src/empty can never hold a src/*.ts");
    // src itself is clean for src/*.ts once README-free: it gets the grant, without make_dir.
    const io2 = fakeFs([...BASE_DIRS], BASE_FILES);
    assert.deepEqual(landlockRulesFor(open(["src/*.ts"]), [], io2).dirs, [{ path: `${ROOT}/src`, make_dir: false }]);
    const docs = landlockRulesFor(open(["docs/*.md"]), [], io);
    assert.deepEqual(docs.dirs, [], "docs is clean but docs/sub can hold no docs/*.md; docs holds sub, so it is not granted as a whole");
    assert.deepEqual(docs.files, [...DEVICES, `${ROOT}/docs/a.md`]);
  });

  test("a glob whose fixed directory does not exist yet grants its deepest existing directory, if clean", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/pkg`], BASE_FILES);
    assert.deepEqual(landlockRulesFor(open(["pkg/new/**"]), [], io).dirs, [{ path: `${ROOT}/pkg`, make_dir: true }]);
    assert.deepEqual(landlockRulesFor(open(["src/new/**"]), [], fakeFs(BASE_DIRS, [...BASE_FILES, `${ROOT}/src/x.md`])).dirs, []);
  });

  test("a directory grant that would hold a .git is not expressible: a submodule's under lib/**", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/lib`, `${ROOT}/lib/sub`, `${ROOT}/lib/sub/.git`], [...BASE_FILES, `${ROOT}/lib/sub/x.c`, `${ROOT}/lib/sub/.git/HEAD`]);
    const r = landlockRulesFor(open(["lib/**"]), [], io);
    assert.match(r.notExpressible, /lib\/sub\/\.git/);
    // A .git file (a worktree's or a submodule's gitlink) counts the same.
    const io2 = fakeFs([...BASE_DIRS, `${ROOT}/lib`], [...BASE_FILES, `${ROOT}/lib/.git`]);
    assert.match(landlockRulesFor(open(["lib/**"]), [], io2).notExpressible, /lib\/\.git/);
    // bubblewrap can still take that run.
    assert.ok(bwrapArgsFor(open(["lib/**"]), [], io).writable.includes(`${ROOT}/lib`));
  });

  test("a directory grant that would hold a protected path, or the worktree root, is not expressible", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/lib`, `${ROOT}/lib/vendor`], [...BASE_FILES, `${ROOT}/lib/a.mjs`]);
    assert.match(landlockRulesFor(open(["lib/**"], { protect: [`${ROOT}/lib/vendor/keep`] }), [], io).notExpressible, /lib\/vendor\/keep/);
    const flat = fakeFs(["/", "/dev", "/w", ROOT, `${ROOT}/.git`, "/state", "/state/s1"], [...LANDLOCK_DEVICES, `${ROOT}/a.md`, `${ROOT}/.git/HEAD`]);
    assert.match(landlockRulesFor(open(["**"]), [], flat).notExpressible, /whole worktree/);
  });

  test("a granted file with a second hard link is not expressible, through a literal or a directory", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/lib`], [...BASE_FILES.filter((f) => f !== `${ROOT}/src/a.ts`), [`${ROOT}/src/a.ts`, 2], [`${ROOT}/lib/x.mjs`, 3]]);
    assert.match(landlockRulesFor(open(["src/a.ts"]), [], io).notExpressible, /src\/a\.ts has 2 hard links/);
    assert.match(landlockRulesFor(open(["lib/**"]), [], io).notExpressible, /lib\/x\.mjs has 3 hard links/);
  });

  test("nothing in .git, the state directory or a protected path is granted, whatever the boundary says", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/keep`], [...BASE_FILES, `${ROOT}/keep/k.ts`]);
    const r = landlockRulesFor(open([".git/HEAD", "keep/k.ts", ".git/**"], { protect: [`${ROOT}/keep`] }), [], io);
    assert.deepEqual(r, { files: DEVICES, dirs: [], rw_trees: [] });
  });

  test("a path through a symlinked directory in the worktree refuses the run", () => {
    const io = fakeFs(BASE_DIRS, BASE_FILES, [`${ROOT}/ln`]);
    assert.throws(() => landlockRulesFor(open(["ln/a.ts"]), [], io), /ln is a symlink/);
    assert.throws(() => landlockRulesFor(open(["ln/**"]), [], io), /ln is a symlink/);
  });

  test("a glob does not descend into a symlinked directory", () => {
    const io = fakeFs([...BASE_DIRS], [...BASE_FILES, `${ROOT}/src/x.md`], [`${ROOT}/src/out`]);
    assert.deepEqual(landlockRulesFor(open(["src/**"]), [], fakeFs(BASE_DIRS, BASE_FILES, [`${ROOT}/src/out`])).dirs, [{ path: `${ROOT}/src`, make_dir: true }]);
    assert.deepEqual(landlockRulesFor(open(["src/**/*.ts"]), [], io).dirs, []);
  });
});

describe("pairWriteLandlock", () => {
  test("an existing target: a grant on that one file and a write in place", () => {
    const p = pairWriteLandlock(open(["src/a.ts"]), `${ROOT}/src/a.ts`, fakeFs(BASE_DIRS, BASE_FILES));
    assert.deepEqual(p, { files: [`${ROOT}/src/a.ts`], dirs: [], rw_trees: [], command: `/bin/cat > '${ROOT}/src/a.ts'` });
  });

  test("a new target: a grant on its directory and a create with noclobber", () => {
    const p = pairWriteLandlock(open(["src/c.ts"]), `${ROOT}/src/c.ts`, fakeFs(BASE_DIRS, BASE_FILES));
    assert.deepEqual(p.dirs, [{ path: `${ROOT}/src`, make_dir: false }]);
    assert.deepEqual(p.files, []);
    assert.equal(p.command, `set -C && /bin/mkdir -p -- '${ROOT}/src' && /bin/cat > '${ROOT}/src/c.ts'`);
    const deep = pairWriteLandlock(open(["src/**"]), `${ROOT}/src/n/m/x.ts`, fakeFs(BASE_DIRS, BASE_FILES));
    assert.deepEqual(deep.dirs, [{ path: `${ROOT}/src`, make_dir: true }]);
  });

  test("a target outside the boundary, in .git or in the state directory gets no grant at all", () => {
    const io = fakeFs(BASE_DIRS, BASE_FILES);
    for (const t of [`${ROOT}/src/b.ts`, `${ROOT}/.git/HEAD`, `${ROOT}/README.md`, `${ROOT}/src/zz.ts`]) {
      const p = pairWriteLandlock(open(["src/a.ts", ".git/HEAD"]), t, io);
      assert.deepEqual([p.files, p.dirs, p.rw_trees], [[], [], []], t);
    }
  });

  test("a symlink, a second hard link, or a non-regular target goes to the staged write", () => {
    const io = fakeFs(BASE_DIRS, [...BASE_FILES, [`${ROOT}/src/h.ts`, 2]], [`${ROOT}/src/l.ts`]);
    assert.match(pairWriteLandlock(open(["src/**"]), `${ROOT}/src/l.ts`, io).notExpressible, /symlink/);
    assert.match(pairWriteLandlock(open(["src/**"]), `${ROOT}/src/h.ts`, io).notExpressible, /2 hard links/);
  });

  test("a new file whose grant would hold the root, a .git or a protected path goes to the staged write", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/lib`, `${ROOT}/lib/.git`], BASE_FILES);
    assert.match(pairWriteLandlock(open(["new.md"]), `${ROOT}/new.md`, io).notExpressible, /worktree root/);
    assert.match(pairWriteLandlock(open(["lib/**"]), `${ROOT}/lib/x.c`, io).notExpressible, /lib\/\.git/);
    assert.match(pairWriteLandlock(open(["src/**"], { protect: [`${ROOT}/src/keep`] }), `${ROOT}/src/x.c`, io).notExpressible, /src\/keep/);
  });

  test("refuses a directory target, a symlinked parent, a target outside the worktree, and a closed card", () => {
    const io = fakeFs(BASE_DIRS, BASE_FILES, [`${ROOT}/ln`]);
    assert.throws(() => pairWriteLandlock(open(["src/**"]), `${ROOT}/src`, io), /directory/);
    assert.throws(() => pairWriteLandlock(open(["ln/**"]), `${ROOT}/ln/x`, io), /symlink/);
    assert.throws(() => pairWriteLandlock(open(["src/**"]), "/etc/passwd", io), /inside the worktree/);
    assert.throws(() => pairWriteLandlock({ ...open([]), phase: "closed" }, `${ROOT}/src/a.ts`, io), /open change set/);
  });

  test("quotes a target holding a single quote", () => {
    const io = fakeFs(BASE_DIRS, [...BASE_FILES, `${ROOT}/src/it's.ts`]);
    assert.equal(pairWriteLandlock(open(["src/**"]), `${ROOT}/src/it's.ts`, io).command, `/bin/cat > '${ROOT}/src/it'\\''s.ts'`);
  });
});

// ─── parity with the Seatbelt profile ───────────────────────────────────────────────────

const parent = (p) => p.slice(0, p.lastIndexOf("/")) || "/";

/**
 * Whether pair-landlock lets a write to `abs` land under `rules`: a file rule on that very
 * path; a temp tree; or a directory grant above it, which takes writes to existing files and
 * creates new ones, and creates missing directories only with make_dir.
 */
function landlockAllows(rules, abs, io) {
  if (rules.files.includes(abs)) return true;
  if (rules.rw_trees.some((t) => within(t, abs))) return true;
  const d = rules.dirs.find((g) => within(g.path, abs) && g.path !== abs);
  if (!d) return false;
  const st = io.lstat(abs);
  if (st) return st.type === "file";
  return io.lstat(parent(abs))?.type === "dir" || d.make_dir;
}

/** Whether the Seatbelt profile lets a write to `abs` land, from the same state. */
function seatbeltAllows(state, abs) {
  if ([state.stateDir, ...state.protect].some((d) => within(d, abs))) return false;
  const rel = within(state.root, abs) && abs !== state.root ? abs.slice(state.root.length + 1) : null;
  if (rel !== null) return state.phase === "open" && boundaryMatches(state.changeSet.boundary, rel) && !isGitControl(rel);
  return state.tempPaths.some((t) => within(t, abs));
}

const glob = (e) => /[*?]/.test(e) || e.endsWith("/");

/**
 * Every legitimate difference between the backends, for a ruleset Landlock can express. `sb`
 * and `ll` are what each allows; a difference applies only in the direction it names.
 */
const DIFFERENCES = {
  "a literal that does not exist yet cannot be created by pair_run (pair_write can)": ({ sb, ll, abs, state, io }) =>
    sb && !ll && io.lstat(abs) === null && state.changeSet.boundary.some((e) => !glob(e) && `${state.root}/${e}` === abs),
  "a new file under a glob is fenced per directory: any name lands in a granted directory": ({ sb, ll, abs, io, rules }) =>
    !sb && ll && io.lstat(abs) === null && rules.dirs.some((d) => within(d.path, abs)),
  "a glob's directory that holds a file outside the boundary takes no new file from pair_run": ({ sb, ll, abs, io, rules }) =>
    sb && !ll && io.lstat(abs) === null && !rules.dirs.some((d) => within(d.path, abs)),
  "a temp path that does not exist when the run starts is not granted": ({ sb, ll, abs, state, io }) =>
    sb && !ll && state.tempPaths.some((t) => io.lstat(t) === null && within(t, abs)),
};

describe("parity: Landlock against the Seatbelt profile from the same state", () => {
  const io = fakeFs(
    [...BASE_DIRS, "/tmp", `${ROOT}/lib`, `${ROOT}/lib/a`, `${ROOT}/lib/vendor`, `${ROOT}/docs`, "/var", "/var/tmpx"],
    [...BASE_FILES, `${ROOT}/lib/x.txt`, `${ROOT}/lib/a/b.mjs`, `${ROOT}/lib/vendor/v.mjs`, `${ROOT}/docs/guide.md`, `${ROOT}/.git/config`],
  );
  const state = open(["src/a.ts", "src/new/x.ts", "lib/**/*.mjs", "docs/**"], {
    tempPaths: ["/tmp", "/var/tmpx", "/nope/tmp"],
    protect: [`${ROOT}/lib/vendor`],
  });
  const rules = landlockRulesFor(state, [], io);
  const probes = [
    `${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`, `${ROOT}/src/new/x.ts`, `${ROOT}/src/new/y.ts`, `${ROOT}/src/c.ts`, `${ROOT}/README.md`,
    `${ROOT}/.git/HEAD`, `${ROOT}/.git/config`, `${ROOT}/.git/objects/ab/cd`, `${ROOT}/lib/x.txt`, `${ROOT}/lib/new.mjs`, `${ROOT}/lib/a/b.mjs`,
    `${ROOT}/lib/a/c.mjs`, `${ROOT}/lib/a/new.txt`, `${ROOT}/lib/a/n/d.mjs`, `${ROOT}/lib/vendor/v.mjs`, `${ROOT}/lib/vendor/w.mjs`,
    `${ROOT}/docs/guide.md`, `${ROOT}/docs/new/deep.md`, "/var/tmpx/build.o", "/state/s1/state.json", "/tmp/x", "/nope/tmp/x", "/etc/passwd",
  ];

  test("the fixture is expressible", () => {
    assert.equal("notExpressible" in rules, false, rules.notExpressible);
  });

  test("every disagreement is a named difference, and every named difference occurs", () => {
    const seen = new Set();
    for (const abs of probes) {
      const sb = seatbeltAllows(state, abs);
      const ll = landlockAllows(rules, abs, io);
      if (sb === ll) continue;
      const why = Object.entries(DIFFERENCES).filter(([, applies]) => applies({ sb, ll, abs, state, io, rules })).map(([name]) => name);
      assert.ok(why.length > 0, `${abs}: Seatbelt ${sb ? "allows" : "denies"}, Landlock ${ll ? "allows" : "denies"}, and no named difference explains it`);
      for (const w of why) seen.add(w);
    }
    assert.deepEqual([...seen].sort(), Object.keys(DIFFERENCES).sort());
  });

  test("no existing file outside the boundary is writable under Landlock", () => {
    for (const abs of probes) {
      if (io.lstat(abs)?.type !== "file" || !within(ROOT, abs)) continue;
      if (landlockAllows(rules, abs, io)) assert.ok(seatbeltAllows(state, abs), `${abs} is writable under Landlock only`);
    }
  });

  test("the state directory, the protected paths and .git are never writable under either", () => {
    for (const abs of ["/state/s1/state.json", `${ROOT}/lib/vendor/v.mjs`, `${ROOT}/lib/vendor/w.mjs`, `${ROOT}/.git/HEAD`, `${ROOT}/.git/objects/ab/cd`]) {
      assert.equal(seatbeltAllows(state, abs), false, abs);
      assert.equal(landlockAllows(rules, abs, io), false, abs);
    }
  });

  test("what Landlock cannot express, bubblewrap takes: the runs that fall back", () => {
    // Each of these returns notExpressible; the adapter (lib/host-io.mjs runCommand) then runs
    // bwrapArgsFor's plan, which re-denies inside its binds what Landlock cannot.
    const sub = fakeFs([...BASE_DIRS, `${ROOT}/sub`, `${ROOT}/sub/.git`], [...BASE_FILES, `${ROOT}/sub/f.c`]);
    const cases = [
      [open(["sub/**"]), sub],
      [open(["src/a.ts"], { stateDir: "/var/tmpx/state/s1", tempPaths: ["/var/tmpx"] }), fakeFs([...BASE_DIRS, "/var", "/var/tmpx", "/var/tmpx/state", "/var/tmpx/state/s1"], BASE_FILES)],
      [open(["**"]), fakeFs(BASE_DIRS, BASE_FILES)],
    ];
    for (const [s, fs] of cases) {
      assert.ok("notExpressible" in landlockRulesFor(s, [], fs), JSON.stringify(s.changeSet.boundary));
      assert.doesNotThrow(() => bwrapArgsFor(s, [], fs));
    }
  });
});
