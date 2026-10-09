// bwrap.test.mjs — node --test, run from plugins/paired-coding/.
//
// The Linux sandbox. The seccomp program is run here through a small classic-BPF interpreter,
// and the link check over real temp directories, so both run on every platform. The live
// cases run bubblewrap for real: they skip where it cannot run (not Linux, no bwrap, user
// namespaces off) and fail instead when PAIRED_CODING_REQUIRE_BWRAP=1, which CI and the Docker
// recipe set so a broken setup cannot pass as all-skipped.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SECCOMP_ARCHES, seccompFilter } from "./bwrap.mjs";
import { gitBaseline, newLinks, runSandboxed, sandboxProblem, writeSandboxed } from "./host-io.mjs";

// ─── the seccomp program ────────────────────────────────────────────────────────────────

const EPERM = 0x00050001;
const ALLOW = 0x7fff0000;

/** Run a classic-BPF seccomp program over one struct seccomp_data. Only the opcodes it uses. */
function runFilter(prog, { arch, nr, arg0 = 0 }) {
  const data = Buffer.alloc(64);
  data.writeInt32LE(nr, 0);
  data.writeUInt32LE(arch >>> 0, 4);
  data.writeUInt32LE(arg0 >>> 0, 16);
  let acc = 0;
  for (let pc = 0; pc * 8 < prog.length;) {
    const code = prog.readUInt16LE(pc * 8);
    const jt = prog.readUInt8(pc * 8 + 2);
    const jf = prog.readUInt8(pc * 8 + 3);
    const k = prog.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) { acc = data.readUInt32LE(k); pc += 1; }
    else if (code === 0x15) pc += 1 + (acc === k ? jt : jf);
    else if (code === 0x35) pc += 1 + (acc >= k ? jt : jf);
    else if (code === 0x06) return k;
    else throw new Error(`opcode ${code} at ${pc}`);
  }
  throw new Error("the program ran off its end");
}

describe("the seccomp filter", () => {
  // Syscall numbers from arch/x86/entry/syscalls/syscall_64.tbl and scripts/syscall.tbl.
  const SOCKETPAIR = { x64: 53, arm64: 199 };
  const CONNECT = { x64: 42, arm64: 203 };
  const OTHER = { x64: 0xc00000b7, arm64: 0xc000003e };

  for (const arch of Object.keys(SECCOMP_ARCHES)) {
    test(`${arch}: socket(AF_UNIX) and io_uring_setup get EPERM; other sockets, socketpair and the rest pass`, () => {
      const a = SECCOMP_ARCHES[arch];
      const prog = seccompFilter(arch);
      const run = (nr, arg0) => runFilter(prog, { arch: a.audit, nr, arg0 });
      assert.equal(run(a.socket, 1), EPERM, "AF_UNIX");
      assert.equal(run(a.socket, 2), ALLOW, "AF_INET");
      assert.equal(run(a.socket, 10), ALLOW, "AF_INET6");
      assert.equal(run(a.socket, 16), ALLOW, "AF_NETLINK");
      assert.equal(run(a.ioUringSetup, 0), EPERM, "io_uring_setup");
      assert.equal(run(SOCKETPAIR[arch], 1), ALLOW, "socketpair(AF_UNIX)");
      assert.equal(run(CONNECT[arch], 1), ALLOW, "connect");
      assert.equal(runFilter(prog, { arch: OTHER[arch], nr: a.socket, arg0: 2 }), EPERM, "a call from another architecture");
    });
  }

  test("x86_64: an x32 call is refused whatever its number", () => {
    const prog = seccompFilter("x64");
    for (const nr of [0x40000000, 0x40000000 + 41, 0x40000000 + 0]) {
      assert.equal(runFilter(prog, { arch: SECCOMP_ARCHES.x64.audit, nr, arg0: 2 }), EPERM, String(nr));
    }
    assert.equal(runFilter(prog, { arch: SECCOMP_ARCHES.x64.audit, nr: 0 }), ALLOW, "read");
  });

  test("the program's layout: the arch check comes first, every instruction is 8 bytes", () => {
    for (const arch of Object.keys(SECCOMP_ARCHES)) {
      const prog = seccompFilter(arch);
      assert.equal(prog.length % 8, 0);
      assert.deepEqual([prog.readUInt16LE(0), prog.readUInt32LE(4)], [0x20, 4], "load arch");
      assert.equal(prog.readUInt32LE(12), SECCOMP_ARCHES[arch].audit);
    }
  });

  test("an architecture with no table gets no filter, and pair_run is refused there", () => {
    assert.equal(seccompFilter("ia32"), null);
    assert.equal(seccompFilter("riscv64"), null);
  });
});

test("without bwrap on PATH, Linux pairing is refused with the package to install", { skip: process.platform !== "linux" && process.platform !== "darwin" }, () => {
  const mod = new URL("./bwrap.mjs", import.meta.url).href;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(mod)}).then((m) => console.log(m.bwrapProblem()))`], { env: { PATH: "" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /needs bubblewrap \(bwrap\) on PATH; install the bubblewrap package/);
});

// ─── the link check ─────────────────────────────────────────────────────────────────────

function tree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pc-links-")));
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "src", "a.txt"), "a");
  writeFileSync(join(root, "outside.txt"), "o");
  return root;
}

const fsNow = (root) => {
  const p = join(root, `.stamp-${randomBytes(4).toString("hex")}`);
  writeFileSync(p, "");
  return statSync(p).mtimeMs;
};

describe("newLinks", () => {
  test("finds a new symlink, a new hard link and a new .git, under the roots only", () => {
    const root = tree();
    const roots = [join(root, "src")];
    const before = gitBaseline(root, roots, []);
    const since = fsNow(root);
    symlinkSync("../outside.txt", join(root, "src", "ln"));
    linkSync(join(root, "outside.txt"), join(root, "src", "deep", "hl"));
    mkdirSync(join(root, "src", "deep", ".GIT"));
    symlinkSync("src", join(root, "not-a-root"));
    assert.deepEqual(newLinks(root, roots, since, before, []), ["src/deep/.GIT", "src/deep/hl", "src/ln"]);
  });

  test("links older than the run are left alone, and an excluded directory is not walked", () => {
    const root = tree();
    symlinkSync("../outside.txt", join(root, "src", "old"));
    const roots = [root];
    const before = gitBaseline(root, roots, ["node_modules"]);
    const since = fsNow(root) + 1;
    symlinkSync("../x", join(root, "node_modules", ".bin-x"));
    assert.deepEqual(newLinks(root, roots, since, before, ["node_modules"]), []);
  });

  test("a .git that git works in is fine; one replaced by another is not", () => {
    const root = tree();
    const roots = [root];
    const before = gitBaseline(root, roots, []);
    const since = fsNow(root);
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/x\n");
    mkdirSync(join(root, ".git", "objects"));
    assert.deepEqual(newLinks(root, roots, since, before, []), []);
    renameSync(join(root, ".git"), join(root, "old-git"));
    mkdirSync(join(root, ".git"));
    assert.deepEqual(newLinks(root, roots, since, before, []), [".git"]);
  });

  test("a literal root that is a fresh symlink is itself found", () => {
    const root = tree();
    const roots = [join(root, "src", "b.txt")];
    const before = gitBaseline(root, roots, []);
    const since = fsNow(root);
    symlinkSync("../outside.txt", join(root, "src", "b.txt"));
    assert.deepEqual(newLinks(root, roots, since, before, []), ["src/b.txt"]);
  });
});

// ─── live: bubblewrap really fences ─────────────────────────────────────────────────────

const PROBLEM = process.platform === "linux" ? sandboxProblem() : "needs Linux bubblewrap";
const REQUIRED = process.env.PAIRED_CODING_REQUIRE_BWRAP === "1";

function live(name, fn) {
  test(name, PROBLEM === null || REQUIRED ? {} : { skip: PROBLEM }, async (t) => {
    assert.equal(PROBLEM, null, "PAIRED_CODING_REQUIRE_BWRAP=1 and bubblewrap cannot run");
    await fn(t);
  });
}

const has = (bin) => spawnSync("/bin/sh", ["-c", `command -v ${bin}`]).status === 0;

/**
 * A temp worktree beside a temp path that holds the state dir, so the temp path is bound
 * read-write and the state dir has to be fenced inside it. Everything sits under the host's
 * /tmp, which the run sees as its private one: the worktree is bound back read-only and the
 * rest of the parent is not there at all. "Outside" for a write is $HOME.
 */
function liveState(boundary, over = {}) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "pc-bwrap-")));
  const root = join(top, "repo");
  for (const d of ["src", "lib", ".git", "sub/.git"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, "sub", ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, "src", "a.txt"), "alpha\n");
  writeFileSync(join(root, "src", "b.txt"), "bravo\n");
  writeFileSync(join(root, "notes.txt"), "notes\n");
  const temp = join(top, "tmp");
  const stateDir = join(temp, "state", "s1");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), "{}");
  const state = {
    phase: boundary ? "open" : "closed",
    root,
    stateDir,
    tempPaths: [temp],
    protect: [],
    changeSet: boundary ? { cardId: "card-1", boundary, runs: [] } : null,
    ...over,
  };
  return { top, root, temp, stateDir, state };
}

const run = (state, command, extra = {}) => runSandboxed({ state, command, cwd: state.root, timeoutMs: 30_000, ...extra });
const EROFS = /Read-only file system/;

describe("live bubblewrap: pair_run", () => {
  live("a write inside the boundary lands", async () => {
    const f = liveState(["src/a.txt"]);
    const r = await run(f.state, "echo new > src/a.txt");
    assert.equal(r.exitCode, 0, r.stderr || r.error);
    assert.equal(readFileSync(join(f.root, "src", "a.txt"), "utf8"), "new\n");
  });

  live("a write outside the boundary is refused by the kernel: Read-only file system", async () => {
    const f = liveState(["src/a.txt"]);
    for (const cmd of ["echo x > src/b.txt", "echo x > notes.txt", "echo x > \"$HOME/.pc-bwrap-probe\""]) {
      const r = await run(f.state, cmd);
      assert.notEqual(r.exitCode, 0, cmd);
      assert.match(r.stderr, EROFS, cmd);
    }
    assert.equal(readFileSync(join(f.root, "src", "b.txt"), "utf8"), "bravo\n");
    assert.equal(readFileSync(join(f.root, "notes.txt"), "utf8"), "notes\n");
    assert.equal(existsSync(join(process.env.HOME ?? "/nonexistent", ".pc-bwrap-probe")), false);
  });

  live("in the closed phase nothing in the worktree is writable", async () => {
    const f = liveState(null);
    const r = await run(f.state, "echo x > src/a.txt");
    assert.match(r.stderr, EROFS);
    assert.equal(readFileSync(join(f.root, "src", "a.txt"), "utf8"), "alpha\n");
  });

  live(".git inside a bound directory is read-only, a submodule's too", async () => {
    const f = liveState(["**"]);
    for (const cmd of ["echo x > .git/HEAD", "mkdir .git/rebase-merge", "echo x > sub/.git/HEAD", "mv .git .git-old"]) {
      const r = await run(f.state, cmd);
      assert.notEqual(r.exitCode, 0, cmd);
      assert.match(r.stderr, /Read-only file system|Device or resource busy/, cmd);
    }
    assert.equal(readFileSync(join(f.root, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
    const ok = await run(f.state, "echo y > notes.txt");
    assert.equal(ok.exitCode, 0, ok.stderr);
  });

  live("git reads work, and git commit fails on the read-only .git", async (t) => {
    if (!has("git")) return t.skip("no git");
    const f = liveState(["**"]);
    const git = (args) => spawnSync("git", args, { cwd: f.root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: f.top } });
    renameSync(join(f.root, ".git"), join(f.top, "fake-git"));
    assert.equal(git(["init", "-q"]).status, 0);
    assert.equal(git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first"]).status, 0);
    const env = { ...process.env, HOME: f.top, GIT_CONFIG_NOSYSTEM: "1" };
    const status = await run(f.state, "git status --porcelain && git log --oneline", { env });
    assert.equal(status.exitCode, 0, status.stderr);
    const commit = await run(f.state, "git -c user.email=t@example.com -c user.name=t commit --allow-empty -m second", { env });
    assert.notEqual(commit.exitCode, 0);
    assert.match(commit.stderr, /index\.lock|Read-only file system/);
  });

  live("a new file under a glob entry lands, in a new directory too", async () => {
    const f = liveState(["lib/**"]);
    const r = await run(f.state, "mkdir -p lib/n && echo y > lib/n/new.md");
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(readFileSync(join(f.root, "lib", "n", "new.md"), "utf8"), "y\n");
  });

  live("pair_run cannot write the state directory, even where a temp path covers it", async () => {
    const f = liveState(["src/a.txt"]);
    const r = await run(f.state, `echo x > '${f.stateDir}/state.json'; echo y > '${f.stateDir}/new'; rm -f '${f.stateDir}/state.json'`);
    assert.match(r.stderr, EROFS);
    assert.equal(readFileSync(join(f.stateDir, "state.json"), "utf8"), "{}");
    assert.deepEqual(readdirSync(f.stateDir), ["state.json"]);
    const temp = await run(f.state, `echo t > '${f.temp}/scratch'`);
    assert.equal(temp.exitCode, 0, temp.stderr);
    assert.equal(readFileSync(join(f.temp, "scratch"), "utf8"), "t\n");
  });

  live("a protected path inside the boundary stays read-only", async () => {
    const f = liveState(["src/**"]);
    mkdirSync(join(f.root, "src", "plugin"));
    const state = { ...f.state, protect: [join(f.root, "src", "plugin")] };
    const r = await run(state, "echo x > src/plugin/gate.mjs");
    assert.match(r.stderr, EROFS);
    assert.equal(existsSync(join(f.root, "src", "plugin", "gate.mjs")), false);
  });

  live("/tmp is private to the run", async () => {
    const f = liveState(["src/a.txt"]);
    const name = `/tmp/pc-private-${randomBytes(6).toString("hex")}`;
    const r = await run(f.state, `echo x > ${name} && cat ${name}`);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, "x\n");
    assert.equal(existsSync(name), false);
  });

  live("a Unix-domain socket is refused (EPERM) through a read-only bind; socketpair, DNS, git and node still work", async (t) => {
    const f = liveState(["src/a.txt"]);
    const sock = join(f.root, "s.sock");
    const server = createServer((c) => c.end("hello\n"));
    await new Promise((resolve) => server.listen(sock, resolve));
    try {
      const connect = `${JSON.stringify(process.execPath)} -e 'require("net").connect(${JSON.stringify(sock)}).on("connect",()=>{console.log("CONNECTED");process.exit(0)}).on("error",(e)=>{console.log(e.code);process.exit(3)})'`;
      const r = await run(f.state, connect);
      assert.equal(r.stdout.trim(), "EPERM", r.stderr);
      assert.equal(r.exitCode, 3);
      const pair = await run(f.state, `${JSON.stringify(process.execPath)} -e 'console.log(require("child_process").execFileSync("/bin/echo",["piped"]).toString().trim())'`);
      assert.equal(pair.stdout.trim(), "piped", pair.stderr);
      const dns = await run(f.state, "getent hosts localhost");
      assert.equal(dns.exitCode, 0, dns.stderr);
      if (has("git")) assert.equal((await run(f.state, "git --version")).exitCode, 0);
      if (!has("python3")) return t.diagnostic("no python3: io_uring_setup not checked");
      const uring = await run(f.state, "python3 -c 'import ctypes; l=ctypes.CDLL(None, use_errno=True); r=l.syscall(425, 1, ctypes.create_string_buffer(120)); print(r, ctypes.get_errno())'");
      assert.equal(uring.stdout.trim(), "-1 1", uring.stderr);
    } finally {
      server.close();
    }
  });

  live("a hard link across mounts fails with EXDEV; a symlink out of the boundary cannot be written through; the link check names both kinds", async () => {
    const f = liveState(["src/**"]);
    const xdev = await run(f.state, "ln notes.txt src/hl");
    assert.notEqual(xdev.exitCode, 0);
    assert.match(xdev.stderr, /Invalid cross-device link/);
    const sinceMs = statSync(join(f.stateDir, "state.json")).mtimeMs;
    const r = await run(f.state, "ln -s ../notes.txt src/out && ln src/a.txt src/a2 && echo pwned > src/out", { linkCheck: { sinceMs, exclusions: [".git"] } });
    assert.match(r.stderr, EROFS);
    assert.equal(readFileSync(join(f.root, "notes.txt"), "utf8"), "notes\n");
    assert.deepEqual(r.links, ["src/a.txt", "src/a2", "src/out"]);
  });

  live("a bind path that resolves through a symlink refuses the run", async () => {
    const f = liveState(["src/sub/**"]);
    mkdirSync(join(f.top, "away"));
    symlinkSync(join(f.top, "away"), join(f.root, "src", "sub"));
    const r = await run(f.state, "echo x > src/sub/x");
    assert.match(r.error ?? "", /cannot open .* to bind it|resolves through a symlink/);
    assert.deepEqual(readdirSync(join(f.top, "away")), []);
  });

  live("every process the run started ends with it", async () => {
    const f = liveState(["src/a.txt"]);
    const r = await run(f.state, "(sleep 1; echo late >> src/a.txt) > /dev/null 2>&1 & setsid sh -c 'sleep 1; echo late >> src/a.txt' > /dev/null 2>&1 & exit 0");
    assert.equal(r.exitCode, 0, r.stderr);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(readFileSync(join(f.root, "src", "a.txt"), "utf8"), "alpha\n");
  });
});

describe("live bubblewrap: pair_write", () => {
  const temp = (dir) => join(dir, `.pair-write-${randomBytes(8).toString("hex")}.tmp`);

  live("staging and rename land the write and leave no staging file", async () => {
    const f = liveState(["src/a.txt"]);
    const w = writeSandboxed({ state: f.state, path: join(f.root, "src", "a.txt"), tempPath: temp(join(f.root, "src")), content: "A" });
    assert.equal(w.ok, true, w.error);
    assert.equal(readFileSync(join(f.root, "src", "a.txt"), "utf8"), "A");
    assert.deepEqual(readdirSync(join(f.root, "src")).sort(), ["a.txt", "b.txt"]);
  });

  live("a new file in a new directory lands", async () => {
    const f = liveState(["src/new/deep/x.txt"]);
    const path = join(f.root, "src", "new", "deep", "x.txt");
    const w = writeSandboxed({ state: f.state, path, tempPath: temp(dirname(path)), content: "x" });
    assert.equal(w.ok, true, w.error);
    assert.equal(readFileSync(path, "utf8"), "x");
  });

  live("the write cannot reach outside the target's directory, the state dir, or .git", async () => {
    const f = liveState(["src/a.txt"]);
    const home = join(process.env.HOME ?? "/nonexistent", ".pc-bwrap-write-probe");
    for (const path of [home, join(f.root, "notes.txt"), join(f.root, ".git", "HEAD")]) {
      const w = writeSandboxed({ state: f.state, path, tempPath: temp(join(f.root, "src")), content: "pwned" });
      assert.equal(w.ok, false, path);
    }
    // The state dir is not even there: it sits under the host's /tmp, which the write sees as its
    // private one, so whatever lands there is gone when the write ends.
    writeSandboxed({ state: f.state, path: join(f.stateDir, "state.json"), tempPath: temp(join(f.root, "src")), content: "pwned" });
    assert.equal(readFileSync(join(f.stateDir, "state.json"), "utf8"), "{}");
    assert.equal(readFileSync(join(f.root, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
    assert.equal(existsSync(home), false);
    assert.equal(readFileSync(join(f.root, "notes.txt"), "utf8"), "notes\n");
    assert.equal(readFileSync(join(f.stateDir, "state.json"), "utf8"), "{}");
  });
});
