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
import { LANDLOCK_DEVICES, boundaryMatches, bwrapArgsFor, globToRegexSource, isGitControl, landlockRulesFor, pairWriteLandlock } from "./gate.mjs";

const ROOT = "/w/repo";

const within = (dir, abs) => abs === dir || abs.startsWith(`${dir}/`);
const inGit = (abs) => abs.split("/").some((seg) => seg.toLowerCase() === ".git");

/**
 * A fake filesystem for the Landlock builders: `dirs` and `files` exist (a file may be
 * `[path, nlink]`), `links` are symlinks. walk lists everything under a directory and does not
 * descend into `.git` or a symlink, as landlockIo does. `extra.others` are FIFOs, sockets or
 * devices; `extra.unlisted` are directories that cannot be listed (walk gives one
 * "unreadable" entry for each, as landlockIo does, and nothing under it); `extra.mounts` is
 * what io.mounts returns.
 * @param {{ others?: string[], unlisted?: string[], mounts?: string[] | null }} [extra]
 */
function fakeFs(dirs, files = [], links = [], extra = {}) {
  const entries = new Map();
  for (const d of dirs) entries.set(d, { type: "dir", nlink: 2 });
  for (const f of files) {
    const [path, nlink] = Array.isArray(f) ? f : [f, 1];
    entries.set(path, { type: "file", nlink });
  }
  for (const l of links) entries.set(l, { type: "symlink", nlink: 1 });
  for (const o of extra.others ?? []) entries.set(o, { type: "other", nlink: 1 });
  const unlisted = extra.unlisted ?? [];
  return {
    lstat: (abs) => entries.get(abs) ?? null,
    walk(dir) {
      if (unlisted.includes(dir)) return [{ path: `${dir}/`, type: "unreadable", nlink: 0 }];
      const hidden = (p) => unlisted.some((u) => p.startsWith(`${u}/`));
      return [
        ...[...entries.entries()]
          .filter(([p]) => p.startsWith(`${dir}/`) && !hidden(p) && !p.slice(dir.length + 1).split("/").slice(0, -1).some((s) => s.toLowerCase() === ".git"))
          .map(([path, st]) => ({ path, ...st })),
        ...unlisted.filter((u) => u.startsWith(`${dir}/`) && !hidden(u)).map((u) => ({ path: `${u}/`, type: "unreadable", nlink: 0 })),
      ];
    },
    mounts: () => (extra.mounts === undefined ? [] : extra.mounts),
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

  test("an existing literal is granted as that one file; a missing literal gets nothing, and is named", () => {
    const io = fakeFs(BASE_DIRS, BASE_FILES);
    assert.deepEqual(landlockRulesFor(open(["src/a.ts", "src/new/x.ts", "src/c.ts"]), [], io),
      { files: [...DEVICES, `${ROOT}/src/a.ts`], dirs: [], rw_trees: [], uncreatable: ["src/new/x.ts", "src/c.ts"] });
    // A missing literal a directory grant holds can be made, so it is not named.
    assert.equal("uncreatable" in landlockRulesFor(open(["src/**", "src/new/x.ts"]), [], io), false);
  });

  test("a grant wanted only to make a missing path, that would hold the root, a .git, the state or a protected path, is dropped and the path named", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/lib`, `${ROOT}/lib/.git`], BASE_FILES);
    assert.deepEqual(landlockRulesFor(open(["newpkg/**", "src/a.ts"]), [], io),
      { files: [...DEVICES, `${ROOT}/src/a.ts`], dirs: [], rw_trees: [], uncreatable: ["newpkg/**"] });
    assert.deepEqual(landlockRulesFor(open(["lib/new/**"]), [], io), { files: DEVICES, dirs: [], rw_trees: [], uncreatable: ["lib/new/**"] });
    // An empty src is granted to make src/new. Holding only the protected src/keep, or the state
    // directory, it is still clean, but the grant would hold them, so it is dropped.
    const bare = (...dirs) => fakeFs(["/", "/dev", "/w", ROOT, `${ROOT}/.git`, `${ROOT}/src`, "/state", "/state/s1", ...dirs], DEVICES);
    assert.deepEqual(landlockRulesFor(open(["src/new/**"]), [], bare()), { files: DEVICES, dirs: [{ path: `${ROOT}/src`, make_dir: true, remove: true }], rw_trees: [] });
    assert.deepEqual(landlockRulesFor(open(["src/new/**"], { protect: [`${ROOT}/src/keep`] }), [], bare(`${ROOT}/src/keep`)),
      { files: DEVICES, dirs: [], rw_trees: [], uncreatable: ["src/new/**"] });
    assert.deepEqual(landlockRulesFor(open(["src/new/**"], { stateDir: `${ROOT}/src/st` }), [], bare(`${ROOT}/src/st`)),
      { files: DEVICES, dirs: [], rw_trees: [], uncreatable: ["src/new/**"] });
    // The root is never granted, so with `**` agreed as well newpkg still cannot be made there.
    assert.deepEqual(landlockRulesFor(open(["**", "newpkg/**"]), [], fakeFs(BASE_DIRS, BASE_FILES)), {
      files: [...DEVICES, `${ROOT}/README.md`], dirs: [{ path: `${ROOT}/src`, make_dir: true, remove: true }], rw_trees: [], uncreatable: ["**", "newpkg/**"],
    });
  });

  test("the worktree root is never granted: a glob there grants its matching root files one by one, and names itself", () => {
    // The tree of the round-3 premise check: src/a.ts, README.md and .git/HEAD.
    const io = fakeFs(["/", "/dev", "/w", ROOT, `${ROOT}/src`, `${ROOT}/.git`, "/state", "/state/s1"], [...DEVICES, `${ROOT}/src/a.ts`, `${ROOT}/README.md`, `${ROOT}/.git/HEAD`]);
    const src = { path: `${ROOT}/src`, make_dir: true, remove: true };
    assert.deepEqual(landlockRulesFor(open(["**"]), [], io), { files: [...DEVICES, `${ROOT}/README.md`], dirs: [src], rw_trees: [], uncreatable: ["**"] });
    assert.deepEqual(landlockRulesFor(open(["newpkg/**", "src/**", "*.md"]), [], io),
      { files: [...DEVICES, `${ROOT}/README.md`], dirs: [src], rw_trees: [], uncreatable: ["newpkg/**", "*.md"] });
    // A root file outside the boundary stays out, and a glob that cannot hold a root file is not
    // named: `*/a.ts` gets the clean src as a directory without make_dir.
    const io2 = fakeFs(["/", "/dev", "/w", ROOT, `${ROOT}/src`, `${ROOT}/.git`, "/state", "/state/s1"], [...DEVICES, `${ROOT}/src/a.ts`, `${ROOT}/README.md`, `${ROOT}/notes.txt`]);
    assert.deepEqual(landlockRulesFor(open(["*.md", "*/a.ts"]), [], io2),
      { files: [...DEVICES, `${ROOT}/README.md`], dirs: [{ ...src, make_dir: false }], rw_trees: [], uncreatable: ["*.md"] });
    assert.deepEqual(landlockRulesFor(open(["**/*.ts"]), [], io2),
      { files: DEVICES, dirs: [src], rw_trees: [], uncreatable: ["**/*.ts"] });
  });

  test("a glob grants each existing match, and a directory only where every existing file matches", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/src/lib`, `${ROOT}/src/docs`],
      [...BASE_FILES, `${ROOT}/src/README.md`, `${ROOT}/src/lib/c.ts`, `${ROOT}/src/lib/d.ts`, `${ROOT}/src/docs/e.md`, `${ROOT}/src/docs/f.ts`]);
    const rules = landlockRulesFor(open(["src/**/*.ts"]), [], io);
    assert.deepEqual(rules, {
      files: [...DEVICES, `${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`, `${ROOT}/src/docs/f.ts`],
      dirs: [{ path: `${ROOT}/src/lib`, make_dir: true, remove: true }],
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
    assert.deepEqual(landlockRulesFor(open(["src/*.ts"]), [], io2).dirs, [{ path: `${ROOT}/src`, make_dir: false, remove: true }]);
    const docs = landlockRulesFor(open(["docs/*.md"]), [], io);
    assert.deepEqual(docs.dirs, [], "docs is clean but docs/sub can hold no docs/*.md; docs holds sub, so it is not granted as a whole");
    assert.deepEqual(docs.files, [...DEVICES, `${ROOT}/docs/a.md`]);
  });

  test("a glob whose fixed directory does not exist yet grants its deepest existing directory, if clean", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/pkg`], BASE_FILES);
    assert.deepEqual(landlockRulesFor(open(["pkg/new/**"]), [], io).dirs, [{ path: `${ROOT}/pkg`, make_dir: true, remove: true }]);
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

  test("a directory grant that would hold a protected path is not expressible", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/lib`, `${ROOT}/lib/vendor`], [...BASE_FILES, `${ROOT}/lib/a.mjs`]);
    assert.match(landlockRulesFor(open(["lib/**"], { protect: [`${ROOT}/lib/vendor/keep`] }), [], io).notExpressible, /lib\/vendor\/keep/);
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

  test("a glob does not descend into a symlinked directory, and a symlink keeps its directory from a grant even when the glob matches it", () => {
    const io = fakeFs([...BASE_DIRS], [...BASE_FILES, `${ROOT}/src/x.md`], [`${ROOT}/src/out`]);
    const rules = landlockRulesFor(open(["src/**"]), [], fakeFs(BASE_DIRS, BASE_FILES, [`${ROOT}/src/out`]));
    assert.deepEqual(rules.dirs, []);
    assert.deepEqual(rules.files, [...DEVICES, `${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`]);
    assert.deepEqual(landlockRulesFor(open(["src/**/*.ts"]), [], io).dirs, []);
  });

  test("a FIFO, socket or device, or a directory that cannot be listed, keeps every directory above it from a grant", () => {
    const lib = `${ROOT}/src/lib`;
    const grant = (path) => [{ path, make_dir: true, remove: true }];
    const tree = (extra) => fakeFs([...BASE_DIRS, lib, `${lib}/deep`], [...BASE_FILES, `${lib}/c.ts`, `${lib}/deep/d.ts`], [], extra);
    assert.deepEqual(landlockRulesFor(open(["src/**"]), [], tree({})).dirs, grant(`${ROOT}/src`), "the clean tree is granted whole");
    // A FIFO in src/lib: src/lib and src are dirty, src/lib/deep is still clean.
    const fifo = landlockRulesFor(open(["src/**"]), [], tree({ others: [`${lib}/pipe`] }));
    assert.deepEqual(fifo.dirs, grant(`${lib}/deep`));
    assert.deepEqual(fifo.files, [...DEVICES, `${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`, `${lib}/c.ts`]);
    // src/lib cannot be listed: it might hold anything, so neither it nor src gets a grant, and
    // nothing below it is looked at.
    const unlisted = landlockRulesFor(open(["src/**"]), [], tree({ unlisted: [lib] }));
    assert.deepEqual(unlisted.dirs, []);
    assert.deepEqual(unlisted.files, [...DEVICES, `${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`]);
    // A directory the glob starts at that cannot be listed gets no grant either.
    assert.deepEqual(landlockRulesFor(open(["src/lib/**"]), [], tree({ unlisted: [lib] })).dirs, []);
  });

  test("a directory that is or holds a mount point gets no grant; matching files under it are granted one by one", () => {
    const lib = `${ROOT}/src/lib`;
    const tree = (mounts) => fakeFs([...BASE_DIRS, lib, `${lib}/m`], [...BASE_FILES, `${lib}/c.ts`, `${lib}/m/d.ts`], [], { mounts });
    const atM = landlockRulesFor(open(["src/**"]), [], tree(["/", "/proc", ROOT, `${lib}/m`]));
    assert.deepEqual(atM.dirs, [], "src/lib/m is a mount point, so it, src/lib and src are dirty");
    assert.deepEqual(atM.files, [...DEVICES, `${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`, `${lib}/c.ts`, `${lib}/m/d.ts`]);
    // A file bind-mounted over src/lib/c.ts makes src/lib dirty, and leaves src/lib/m clean.
    assert.deepEqual(landlockRulesFor(open(["src/**"]), [], tree([`${lib}/c.ts`])).dirs, [{ path: `${lib}/m`, make_dir: true, remove: true }]);
    // Mounts at or above the worktree root (a container's volume) do not count against it.
    assert.deepEqual(landlockRulesFor(open(["src/**"]), [], tree(["/", ROOT])).dirs, [{ path: `${ROOT}/src`, make_dir: true, remove: true }]);
    // When the mount table cannot be read, no directory is granted.
    assert.deepEqual(landlockRulesFor(open(["src/**"]), [], tree(null)).dirs, []);
  });

  test("literal files get no directory grant, so pair_run cannot delete or rename them", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/lib`], [...BASE_FILES, `${ROOT}/lib/only.mjs`]);
    // lib holds nothing but the agreed file, and still gets no grant: only a glob opens a directory.
    assert.deepEqual(landlockRulesFor(open(["src/a.ts", "lib/only.mjs", "README.md"]), [], io),
      { files: [...DEVICES, `${ROOT}/README.md`, `${ROOT}/lib/only.mjs`, `${ROOT}/src/a.ts`], dirs: [], rw_trees: [] });
  });
});

describe("pairWriteLandlock", () => {
  test("an existing target: a grant on that one file and a write in place", () => {
    const p = pairWriteLandlock(open(["src/a.ts"]), `${ROOT}/src/a.ts`, fakeFs(BASE_DIRS, BASE_FILES));
    assert.deepEqual(p, { files: [`${ROOT}/src/a.ts`], dirs: [], rw_trees: [], command: `/bin/cat > '${ROOT}/src/a.ts'` });
  });

  test("a new target: a grant on its directory and a create with noclobber", () => {
    const p = pairWriteLandlock(open(["src/c.ts"]), `${ROOT}/src/c.ts`, fakeFs(BASE_DIRS, BASE_FILES));
    assert.deepEqual(p.dirs, [{ path: `${ROOT}/src`, make_dir: false, remove: false }]);
    assert.deepEqual(p.files, []);
    assert.equal(p.command, `set -C && /bin/mkdir -p -- '${ROOT}/src' && /bin/cat > '${ROOT}/src/c.ts'`);
    const deep = pairWriteLandlock(open(["src/**"]), `${ROOT}/src/n/m/x.ts`, fakeFs(BASE_DIRS, BASE_FILES));
    assert.deepEqual(deep.dirs, [{ path: `${ROOT}/src`, make_dir: true, remove: false }]);
  });

  test("a target outside the boundary, in .git or in the state directory gets no grant at all", () => {
    const io = fakeFs(BASE_DIRS, BASE_FILES);
    for (const t of [`${ROOT}/src/b.ts`, `${ROOT}/.git/HEAD`, `${ROOT}/README.md`, `${ROOT}/src/zz.ts`]) {
      const p = pairWriteLandlock(open(["src/a.ts", ".git/HEAD"]), t, io);
      assert.deepEqual([p.files, p.dirs, p.rw_trees], [[], [], []], t);
    }
  });

  test("a symlink or a second hard link gets the staged write under Landlock: a remove grant on its directory", () => {
    const io = fakeFs(BASE_DIRS, [...BASE_FILES, [`${ROOT}/src/h.ts`, 2]], [`${ROOT}/src/l.ts`]);
    const staged = { files: [], dirs: [{ path: `${ROOT}/src`, make_dir: false, remove: true }], rw_trees: [], staged: true };
    assert.deepEqual(pairWriteLandlock(open(["src/**"]), `${ROOT}/src/l.ts`, io), staged);
    assert.deepEqual(pairWriteLandlock(open(["src/**"]), `${ROOT}/src/h.ts`, io), staged);
    // In the worktree root, or beside a .git, the grant would hold .git: bubblewrap stages it.
    const top = fakeFs([...BASE_DIRS, `${ROOT}/lib`, `${ROOT}/lib/.git`], [...BASE_FILES, [`${ROOT}/h.md`, 2], [`${ROOT}/lib/h.c`, 2]]);
    assert.match(pairWriteLandlock(open(["h.md"]), `${ROOT}/h.md`, top).notExpressible, /2 hard links.*worktree root/);
    assert.match(pairWriteLandlock(open(["lib/**"]), `${ROOT}/lib/h.c`, top).notExpressible, /lib\/\.git/);
    const dev = fakeFs(BASE_DIRS, BASE_FILES);
    dev.lstat = ((orig) => (p) => (p === `${ROOT}/src/fifo` ? { type: "other", nlink: 1 } : orig(p)))(dev.lstat);
    assert.match(pairWriteLandlock(open(["src/**"]), `${ROOT}/src/fifo`, dev).notExpressible, /not a regular file/);
  });

  test("a new file whose grant would hold the root, a .git or a protected path is made on the host, then written through a file grant", () => {
    const io = fakeFs([...BASE_DIRS, `${ROOT}/lib`, `${ROOT}/lib/.git`], BASE_FILES);
    const hostMade = (file, dirs = []) => ({ files: [file], dirs: [], rw_trees: [], command: `/bin/cat > '${file}'`, create: { dirs, file } });
    assert.deepEqual(pairWriteLandlock(open(["new.md"]), `${ROOT}/new.md`, io), hostMade(`${ROOT}/new.md`));
    assert.deepEqual(pairWriteLandlock(open(["newpkg/**"]), `${ROOT}/newpkg/deep/x.ts`, io),
      hostMade(`${ROOT}/newpkg/deep/x.ts`, [`${ROOT}/newpkg`, `${ROOT}/newpkg/deep`]));
    assert.deepEqual(pairWriteLandlock(open(["lib/**"]), `${ROOT}/lib/x.c`, io), hostMade(`${ROOT}/lib/x.c`));
    assert.deepEqual(pairWriteLandlock(open(["src/**"], { protect: [`${ROOT}/src/keep`] }), `${ROOT}/src/x.c`, io), hostMade(`${ROOT}/src/x.c`));
    // Where a directory grant is clean of all of them, the new file is still made in the sandbox.
    assert.equal("create" in pairWriteLandlock(open(["src/**"]), `${ROOT}/src/x.c`, io), false);
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
/** A new path the run names as uncreatable: directly in the root, or in a directory still missing. */
const uncreatableGlob = (rules, state, abs, io) => {
  const parent = abs.slice(0, abs.lastIndexOf("/"));
  return (parent === state.root || io.lstat(parent) === null)
    && (rules.uncreatable ?? []).some((e) => glob(e) && within(state.root, abs) && boundaryMatches([e], abs.slice(state.root.length + 1)));
};

/**
 * Every legitimate difference between the backends, for a ruleset Landlock can express. `sb`
 * and `ll` are what each allows; a difference applies only in the direction it names.
 */
const DIFFERENCES = {
  "a literal that does not exist yet gets no grant of its own, so only a granted directory above it lets pair_run create it (pair_write can)": ({ sb, ll, abs, state, io }) =>
    sb && !ll && io.lstat(abs) === null && state.changeSet.boundary.some((e) => !glob(e) && `${state.root}/${e}` === abs),
  "a new file under a glob is fenced per directory: any name lands in a granted directory": ({ sb, ll, abs, io, rules }) =>
    !sb && ll && io.lstat(abs) === null && rules.dirs.some((d) => within(d.path, abs)),
  "a glob's directory that is not clean (a file outside the boundary, a link, a special file, an unlistable directory or a mount) takes no new file from pair_run": ({ sb, ll, abs, state, io, rules }) =>
    sb && !ll && io.lstat(abs) === null && !rules.dirs.some((d) => within(d.path, abs)) && !uncreatableGlob(rules, state, abs, io),
  "a glob takes no new file from pair_run directly in the worktree root, or in a missing directory whose grant would hold the root, a .git or a protected path (the run names the entry; pair_write can)": ({ sb, ll, abs, state, io, rules }) =>
    sb && !ll && io.lstat(abs) === null && uncreatableGlob(rules, state, abs, io),
  "a temp path that does not exist when the run starts is not granted": ({ sb, ll, abs, state, io }) =>
    sb && !ll && state.tempPaths.some((t) => io.lstat(t) === null && within(t, abs)),
};

describe("parity: Landlock against the Seatbelt profile from the same state", () => {
  const io = fakeFs(
    [...BASE_DIRS, "/tmp", `${ROOT}/lib`, `${ROOT}/lib/a`, `${ROOT}/lib/vendor`, `${ROOT}/docs`, "/var", "/var/tmpx"],
    [...BASE_FILES, `${ROOT}/lib/x.txt`, `${ROOT}/lib/a/b.mjs`, `${ROOT}/lib/vendor/v.mjs`, `${ROOT}/docs/guide.md`, `${ROOT}/.git/config`],
  );
  const state = open(["src/a.ts", "src/new/x.ts", "lib/**/*.mjs", "docs/**", "newpkg/**", "*.md"], {
    tempPaths: ["/tmp", "/var/tmpx", "/nope/tmp"],
    protect: [`${ROOT}/lib/vendor`],
  });
  const rules = landlockRulesFor(state, [], io);
  const probes = [
    `${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`, `${ROOT}/src/new/x.ts`, `${ROOT}/src/new/y.ts`, `${ROOT}/src/c.ts`, `${ROOT}/README.md`, `${ROOT}/NEW.md`,
    `${ROOT}/.git/HEAD`, `${ROOT}/.git/config`, `${ROOT}/.git/objects/ab/cd`, `${ROOT}/lib/x.txt`, `${ROOT}/lib/new.mjs`, `${ROOT}/lib/a/b.mjs`,
    `${ROOT}/lib/a/c.mjs`, `${ROOT}/lib/a/new.txt`, `${ROOT}/lib/a/n/d.mjs`, `${ROOT}/lib/vendor/v.mjs`, `${ROOT}/lib/vendor/w.mjs`,
    `${ROOT}/docs/guide.md`, `${ROOT}/docs/new/deep.md`, `${ROOT}/newpkg/x.ts`, `${ROOT}/newpkg/deep/y.ts`,
    "/var/tmpx/build.o", "/state/s1/state.json", "/tmp/x", "/nope/tmp/x", "/etc/passwd",
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
    ];
    for (const [s, fs] of cases) {
      assert.ok("notExpressible" in landlockRulesFor(s, [], fs), JSON.stringify(s.changeSet.boundary));
      assert.doesNotThrow(() => bwrapArgsFor(s, [], fs));
    }
  });
});

/**
 * The first landlockRulesFor, kept here only as a reference: it asks each directory question
 * of the whole walk, so it costs directories times files, and the gate's indexed, memoized
 * version has to give exactly its answers. Its private helpers are copied with it, and it has
 * the two later rules (dropping a grant wanted only to make a missing path, and never granting
 * the worktree root) written their own way.
 */
function referenceRulesFor(state, extraAllow, io) {
  const path = (p) => {
    if (typeof p !== "string" || !p.startsWith("/")) throw new Error(`a sandboxed path is not usable (${JSON.stringify(p)})`);
    return p;
  };
  const relativeTo = (root, abs) => (abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null);
  const normalizeEntry = (e) => (e.endsWith("/") ? `${e}**` : e);
  const isGlob = (e) => /[*?]/.test(e);
  const inGitDir = (rel) => rel.split("/").some((seg) => seg.toLowerCase() === ".git");
  const outermost = (paths) => {
    const out = [];
    for (const p of [...new Set(paths)].sort((a, b) => a.length - b.length)) if (!out.some((o) => within(o, p))) out.push(p);
    return out;
  };
  const globCanHold = (entry, dirRel) => {
    const g = entry.split("/");
    const d = dirRel === "" ? [] : dirRel.split("/");
    const seg = (s, name) => new RegExp(`^${globToRegexSource(s)}$`).test(name);
    const m = (i, j) => {
      if (j === g.length) return false;
      if (g[j] === "**") return i === d.length || m(i, j + 1) || m(i + 1, j);
      if (i === d.length) return true;
      return seg(g[j], d[i]) && m(i + 1, j + 1);
    };
    return m(0, 0);
  };
  const deepestExistingL = (p, stop) => {
    while (p !== stop && io.lstat(p) === null) p = p.slice(0, p.lastIndexOf("/")) || "/";
    return io.lstat(p) === null ? null : p;
  };
  const checkNoSymlinkAbove = (root, abs) => {
    const rel = relativeTo(root, abs);
    if (rel === null) return;
    let p = root;
    for (const seg of rel.split("/").slice(0, -1)) {
      p = `${p}/${seg}`;
      const st = io.lstat(p);
      if (st === null) return;
      if (st.type === "symlink") throw new Error(`${p} is a symlink; pair_run grants only paths that are what they name`);
    }
  };

  const root = path(state.root);
  const denied = [state.stateDir, ...(state.protect ?? [])].map(path);
  const files = LANDLOCK_DEVICES.filter((p) => io.lstat(p) !== null);
  const rwTrees = [];
  for (const t of outermost((state.tempPaths ?? []).map(path))) {
    if (io.lstat(t)?.type !== "dir" || within(root, t)) continue;
    if (within(t, root)) return { notExpressible: `the temp path ${t} holds the worktree, and Landlock cannot fence the worktree inside it` };
    const held = denied.find((d) => within(t, d));
    if (held) return { notExpressible: `the temp path ${t} holds ${held}, which Landlock cannot fence inside it` };
    rwTrees.push(t);
  }
  if (state.phase !== "open" || !state.changeSet) return { files, dirs: [], rw_trees: rwTrees };
  const boundary = state.changeSet.boundary;
  const grantable = (abs) => {
    const rel = relativeTo(root, abs);
    return rel !== null && !inGitDir(rel) && !denied.some((d) => within(d, abs));
  };
  const matches = (abs) => grantable(abs) && boundaryMatches(boundary, relativeTo(root, abs)) && !isGitControl(relativeTo(root, abs));
  const wantFiles = new Set();
  const wantDirs = new Map();
  const walks = new Map();
  const walk = (dir) => {
    if (!walks.has(dir)) walks.set(dir, io.walk(dir));
    return walks.get(dir);
  };
  const under = (dir) => walk(walks.has(dir) ? dir : [...walks.keys()].find((w) => within(w, dir)) ?? dir).filter((e) => within(dir, e.path) && e.path !== dir);
  const globs = boundary.map(normalizeEntry).filter(isGlob);
  const fenced = (abs) => inGitDir(relativeTo(root, abs) ?? "") || denied.some((d) => within(d, abs));
  // Round 6: every non-directory must be a matching regular file with one link, and no mount
  // point may be at or under the directory (every directory counts when mounts are unknown).
  const mounts = io.mounts();
  const clean = (dir) => (mounts !== null && !mounts.some((m) => m !== root && within(dir, m))) && under(dir).every((e) => fenced(e.path)
    || (e.type === "dir" ? globs.some((g) => globCanHold(g, relativeTo(root, e.path) ?? "")) : e.type === "file" && e.nlink === 1 && matches(e.path)));
  const creatingOnly = new Set();
  const existing = new Set();
  const wantDir = (dir, makeDir, creating = false) => {
    if (dir === root || !clean(dir)) return;
    wantDirs.set(dir, (wantDirs.get(dir) ?? false) || makeDir);
    (creating ? creatingOnly : existing).add(dir);
  };
  const literal = (abs) => {
    if (!grantable(abs)) return;
    checkNoSymlinkAbove(root, abs);
    if (io.lstat(abs)?.type === "file") wantFiles.add(abs);
  };
  for (const raw of boundary) {
    const e = normalizeEntry(raw);
    if (!isGlob(e)) { literal(`${root}/${e}`); continue; }
    const fixed = [];
    for (const seg of e.split("/")) { if (isGlob(seg)) break; fixed.push(seg); }
    const top = fixed.length ? `${root}/${fixed.join("/")}` : root;
    if (top !== root && !grantable(top)) continue;
    const makeDir = e.split("/").includes("**");
    checkNoSymlinkAbove(root, top);
    const st = io.lstat(top);
    if (st === null) {
      const at = deepestExistingL(top, root);
      if (at !== null && io.lstat(at)?.type === "dir") wantDir(at, true, true);
      continue;
    }
    if (st.type === "symlink") throw new Error(`${top} is a symlink; pair_run grants only paths that are what they name`);
    if (st.type !== "dir") continue;
    for (const f of walk(top)) if (f.type === "file" && matches(f.path)) wantFiles.add(f.path);
    const descend = (dir) => {
      if (!globCanHold(e, relativeTo(root, dir) ?? "")) return;
      if (dir !== root && clean(dir)) { wantDir(dir, makeDir); return; }
      for (const c of under(dir)) {
        if (c.type === "dir" && c.path.lastIndexOf("/") === dir.length && grantable(c.path)) descend(c.path);
      }
    };
    descend(top);
  }
  for (const p of extraAllow) literal(path(p));
  // Round 3: a grant wanted only to make a missing path is dropped where it would hold a .git,
  // the state directory or a protected path.
  for (const d of creatingOnly) {
    if (existing.has(d)) continue;
    const git = under(d).some((e) => e.path.split("/").at(-1).toLowerCase() === ".git");
    if (git || denied.some((x) => within(d, x))) wantDirs.delete(d);
  }
  const dirs = outermost([...wantDirs.keys()]);
  for (const d of dirs) {
    if (within(d, root)) return { notExpressible: "a directory grant would hold the whole worktree, and Landlock cannot fence .git or the state inside it" };
    const git = under(d).find((e) => e.path.split("/").at(-1).toLowerCase() === ".git");
    if (git) return { notExpressible: `a directory grant on ${relativeTo(root, d)} would hold ${relativeTo(root, git.path)}, and Landlock cannot fence it inside the grant` };
    const held = denied.find((x) => within(d, x));
    if (held) return { notExpressible: `a directory grant on ${relativeTo(root, d)} would hold ${held}, and Landlock cannot fence it inside the grant` };
    const linked = under(d).find((e) => e.type === "file" && e.nlink > 1);
    if (linked) return { notExpressible: `${relativeTo(root, linked.path)} has ${linked.nlink} hard links, and a grant on it would reach every one` };
  }
  const outFiles = [...wantFiles].filter((f) => !dirs.some((d) => within(d, f))).sort();
  for (const f of outFiles) {
    const n = io.lstat(f)?.nlink ?? 1;
    if (n > 1) return { notExpressible: `${relativeTo(root, f)} has ${n} hard links, and a grant on it would reach every one` };
  }
  return {
    files: [...files, ...outFiles],
    dirs: dirs.sort().map((p) => ({ path: p, make_dir: wantDirs.get(p), remove: true })),
    rw_trees: rwTrees,
  };
}

/** A result or the message it threw, so a refusal compares as well as a ruleset. */
const outcome = (f) => {
  try {
    return f();
  } catch (err) {
    return { threw: err.message };
  }
};

describe("landlockRulesFor gives the reference implementation's answers", () => {
  /** The result without `uncreatable`, which only the gate computes (its own tests check it). */
  const rules = (f) => {
    const r = outcome(f);
    if ("uncreatable" in r) delete r.uncreatable;
    return r;
  };
  const same = (state, io, extra = []) =>
    assert.deepEqual(rules(() => landlockRulesFor(state, extra, io)), rules(() => referenceRulesFor(state, extra, io)), JSON.stringify(state.changeSet?.boundary));

  test("a nested glob, a dirty directory deep below a clean one, a symlinked directory and an empty one", () => {
    const dirs = [...BASE_DIRS, `${ROOT}/src/a`, `${ROOT}/src/a/b`, `${ROOT}/src/a/b/c`, `${ROOT}/src/a/b/c/d`, `${ROOT}/src/a/e`,
      `${ROOT}/src/empty`, `${ROOT}/src/lib`, `${ROOT}/src/lib/x`, `${ROOT}/docs`, `${ROOT}/docs/one`, `${ROOT}/docs/two`, `${ROOT}/target`];
    const files = [...BASE_FILES, `${ROOT}/src/a/one.ts`, `${ROOT}/src/a/b/two.ts`, `${ROOT}/src/a/b/c/three.ts`, `${ROOT}/src/a/b/c/d/four.ts`,
      `${ROOT}/src/a/b/c/d/stray.js`, `${ROOT}/src/a/e/five.ts`, `${ROOT}/src/lib/x/y.mjs`, `${ROOT}/docs/one/x.md`, `${ROOT}/docs/two/y.md`, `${ROOT}/target/t.md`];
    const links = [`${ROOT}/src/a/b/linked`, `${ROOT}/src/via`];
    const io = fakeFs(dirs, files, links);
    const boundaries = [
      ["src/**/*.ts"],
      ["src/**/*.ts", "src/lib/**"],
      ["src/a/**", "docs/*/x.md"],
      ["src/*/b/**/*.ts", "src/a/b/c/d/stray.js"],
      ["src/**/*.ts", "src/**/*.js"],
      ["src/empty/**"],
      ["src/empty/*.ts", "src/missing/deeper/**"],
      ["docs/**", "src/a/b/c/d/four.ts"],
      ["src/via/**"],
      ["src/a/b/linked/*.ts"],
      ["**/*.md"],
    ];
    for (const b of boundaries) {
      same(open(b), io);
      same(open(b, { protect: [`${ROOT}/src/a/b/c`] }), io);
    }
    same(open(["src/**/*.ts"]), io, [`${ROOT}/target/t.md`, `${ROOT}/src/a/b/c/d/stray.js`]);
    // An empty directory, two levels down, that the glob cannot hold keeps src from a grant.
    const deep = fakeFs([...BASE_DIRS, `${ROOT}/src/x`, `${ROOT}/src/x/hollow`], BASE_FILES);
    for (const b of [["src/*.ts"], ["src/*.ts", "src/x/*.ts"], ["src/**/*.ts"]]) same(open(b), deep);
    assert.deepEqual(landlockRulesFor(open(["src/*.ts", "src/x/*.ts"]), [], deep).dirs, []);
  });

  test("generated trees, boundaries and protected paths, with special files, unlisted directories and mounts", () => {
    let seed = 1;
    const rand = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const names = ["a", "b", "c", "node_modules", ".git", "lib"];
    const exts = [".ts", ".js", ".md"];
    const globPool = ["src/**/*.ts", "src/**", "src/*/*.js", "src/a/**/*.md", "src/b/**", "src/**/lib/**", "*.md", "src/c/*.ts", "src/missing/**"];
    for (let round = 0; round < 150; round++) {
      const dirs = [...BASE_DIRS];
      const files = [...BASE_FILES];
      const links = [];
      const grow = (dir, depth) => {
        for (let i = rand(4); i > 0; i--) {
          const kind = rand(10);
          const name = names[rand(names.length)];
          if (kind < 4 && depth < 4) {
            const d = `${dir}/${name}`;
            if (dirs.includes(d)) continue;
            dirs.push(d);
            grow(d, depth + 1);
          } else if (kind < 9) {
            files.push(rand(15) === 0 ? [`${dir}/f${rand(9)}${exts[rand(3)]}`, 2] : `${dir}/f${rand(9)}${exts[rand(3)]}`);
          } else {
            links.push(`${dir}/l${rand(9)}`);
          }
        }
      };
      grow(`${ROOT}/src`, 0);
      const below = [...new Set(dirs)].filter((d) => d.startsWith(`${ROOT}/src/`));
      const pick = () => below[rand(below.length)];
      const extra = {
        others: rand(5) === 0 ? [`${rand(2) && below.length ? pick() : `${ROOT}/src`}/p${rand(3)}`] : [],
        unlisted: rand(6) === 0 && below.length ? [pick()] : [],
        mounts: rand(10) === 0 ? null : rand(5) === 0 && below.length ? [pick()] : [],
      };
      const io = fakeFs([...new Set(dirs)], files, [...new Set(links)].filter((l) => !dirs.includes(l)), extra);
      const boundary = [...new Set(Array.from({ length: 1 + rand(3) }, () => globPool[rand(globPool.length)]))];
      const ours = files.map((f) => (Array.isArray(f) ? f[0] : f)).filter((f) => within(`${ROOT}/src`, f));
      if (rand(3) === 0 && ours.length) boundary.push(ours[rand(ours.length)].slice(ROOT.length + 1));
      const protect = rand(4) === 0 ? [dirs[rand(dirs.length)]].filter((d) => within(`${ROOT}/src`, d)) : [];
      same(open(boundary, { protect }), io);
    }
  });
});
