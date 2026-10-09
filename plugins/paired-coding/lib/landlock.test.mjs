// landlock.test.mjs — node --test, run from plugins/paired-coding/.
//
// The Landlock half of the Linux sandbox. Finding and checking the helper runs over fake helper
// scripts, and the backend choice over the probes' answers, so both run on every platform. The
// live cases run pair-landlock for real: they skip where it cannot run (not Linux, a kernel
// without Landlock ABI 3) and fail instead when PAIRED_CODING_REQUIRE_LANDLOCK=1, which CI and
// the Docker recipe set so a broken setup cannot pass as all-skipped.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pairWriteLandlock } from "../core/gate.mjs";
import { bwrapProblem, seccompFilter } from "./bwrap.mjs";
import { createOnHost, describeSandbox, pickLinuxBackend, runSandboxed, writeSandboxed } from "./host-io.mjs";
import { HELPER_ARCHES, LANDLOCK_DIR, landlockAbi, landlockIo, landlockProblem, probeLandlock } from "./landlock.mjs";

// ─── finding and checking the helper ────────────────────────────────────────────────────

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * A plugin directory holding a fake aarch64 helper: a shell script that leaves a marker when it
 * runs and answers --abi with `body`. SHA256SUMS lists `sums` (default: the script's own hash).
 */
function fakeHelper(body, { sums } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-landlock-probe-")));
  const marker = join(dir, "ran");
  mkdirSync(join(dir, "bin"));
  const script = `#!/bin/sh\necho ran > '${marker}'\n${body}\n`;
  const helper = join(dir, "bin", "pair-landlock-aarch64-linux");
  writeFileSync(helper, script);
  chmodSync(helper, 0o755);
  const listed = sums === undefined ? `${sha256(Buffer.from(script))}  bin/pair-landlock-aarch64-linux\n` : sums;
  if (listed !== null) writeFileSync(join(dir, "SHA256SUMS"), listed);
  return { dir, helper, marker };
}

describe("probeLandlock", () => {
  test("a helper whose bytes match SHA256SUMS is run and reports the kernel's ABI", () => {
    const f = fakeHelper("echo 6");
    assert.deepEqual(probeLandlock({ dir: f.dir, arch: "arm64" }), { helper: f.helper, abi: 6 });
    assert.equal(existsSync(f.marker), true);
  });

  test("a checksum mismatch refuses without running the helper, and never falls back", () => {
    const f = fakeHelper("echo 6", { sums: `${"0".repeat(64)}  bin/pair-landlock-aarch64-linux\n` });
    const p = probeLandlock({ dir: f.dir, arch: "arm64" });
    assert.equal(p.fallback, false);
    assert.match(p.problem, /does not match its checksum/);
    assert.equal(existsSync(f.marker), false, "the helper ran before its checksum was checked");
  });

  test("an architecture with no helper, or no checksum to check it against, refuses", () => {
    const f = fakeHelper("echo 6");
    for (const arch of ["ia32", "riscv64", "x64"]) {
      const p = probeLandlock({ dir: f.dir, arch });
      assert.equal(p.fallback, false, arch);
    }
    assert.match(probeLandlock({ dir: f.dir, arch: "ia32" }).problem, /built for x86_64 and aarch64/);
    assert.match(probeLandlock({ dir: f.dir, arch: "x64" }).problem, /lists no bin\/pair-landlock-x86_64-linux/);
    const none = fakeHelper("echo 6", { sums: null });
    assert.match(probeLandlock({ dir: none.dir, arch: "arm64" }).problem, /cannot read the helper's checksums/);
    assert.equal(existsSync(none.marker), false);
  });

  test("a kernel without Landlock ABI 3 falls back to bubblewrap: exit 120, or ABI 1 and 2", () => {
    const missing = probeLandlock({ dir: fakeHelper("echo 'pair-landlock: Landlock is not supported by this kernel' >&2; exit 120").dir, arch: "arm64" });
    assert.deepEqual(missing, { problem: "Landlock is not supported by this kernel", fallback: true });
    const old = probeLandlock({ dir: fakeHelper("echo 2").dir, arch: "arm64" });
    assert.equal(old.fallback, true);
    assert.match(old.problem, /ABI 2 is below 3/);
  });

  test("a helper that fails its probe any other way refuses", () => {
    for (const body of ["exit 1", "echo nonsense", "kill -9 $$"]) {
      const p = probeLandlock({ dir: fakeHelper(body).dir, arch: "arm64" });
      assert.equal(p.fallback, false, body);
      assert.match(p.problem, /failed its ABI probe/, body);
    }
  });

  test("the committed helpers match the committed SHA256SUMS, one per architecture", () => {
    const sums = readFileSync(join(LANDLOCK_DIR, "SHA256SUMS"), "utf8").trim().split("\n").map((l) => l.split(/\s+/));
    assert.deepEqual(sums.map(([, f]) => f).sort(), Object.values(HELPER_ARCHES).map((a) => `bin/pair-landlock-${a}-linux`).sort());
    for (const [want, rel] of sums) assert.equal(sha256(readFileSync(join(LANDLOCK_DIR, rel))), want, rel);
  });

  test("the helper's socket filter is bubblewrap's, instruction for instruction", () => {
    // main.rs's unit test pins socket_filter() to these vectors; this one pins them to
    // seccompFilter, so neither side can drift alone.
    const src = readFileSync(join(LANDLOCK_DIR, "src", "main.rs"), "utf8");
    const vectors = (name) => {
      const body = src.match(new RegExp(`let ${name} = vec!\\[([^\\]]*)\\];`))[1];
      return [...body.matchAll(/\((0x[0-9a-f_]+|\d+), (\d+), (\d+), (0x[0-9a-f_]+|\d+)\)/g)].map((m) => m.slice(1).map((n) => Number(n.replaceAll("_", ""))));
    };
    const decode = (buf) => Array.from({ length: buf.length / 8 }, (_, i) => [buf.readUInt16LE(i * 8), buf[i * 8 + 2], buf[i * 8 + 3], buf.readUInt32LE(i * 8 + 4)]);
    assert.deepEqual(vectors("x86"), decode(seccompFilter("x64")));
    assert.deepEqual(vectors("arm"), decode(seccompFilter("arm64")));
  });
});

describe("backend choice", () => {
  const never = () => { throw new Error("bubblewrap was probed"); };

  test("Landlock when it works, without probing bubblewrap", () => {
    assert.deepEqual(pickLinuxBackend(null, never), { name: "landlock" });
  });

  test("bubblewrap only when the kernel lacks Landlock, and it says why", () => {
    assert.deepEqual(pickLinuxBackend({ problem: "Landlock ABI 2 is below 3", fallback: true }, () => null), { name: "bwrap", why: "Landlock ABI 2 is below 3" });
    const neither = pickLinuxBackend({ problem: "no Landlock", fallback: true }, () => "bwrap is not installed");
    assert.match(neither.problem, /no Landlock.*bwrap is not installed/);
  });

  test("a checksum mismatch or a missing helper refuses even where bubblewrap works", () => {
    const r = pickLinuxBackend({ problem: "the helper does not match its checksum", fallback: false }, never);
    assert.deepEqual(r, { problem: "the helper does not match its checksum" });
  });

  test("pair_start names the sandbox", () => {
    assert.match(describeSandbox({ name: "seatbelt" }), /^Sandbox: macOS Seatbelt/);
    assert.match(describeSandbox({ name: "bwrap", why: "Landlock ABI 2 is below 3" }), /^Sandbox: bubblewrap, which fences writes per directory \(Landlock is not usable here: Landlock ABI 2/);
    assert.match(describeSandbox({ problem: "nothing here" }), /^No sandbox: nothing here\./);
  });
});

// ─── live: Landlock really fences ───────────────────────────────────────────────────────

const PROBLEM = process.platform === "linux" ? landlockProblem()?.problem ?? null : "needs Linux Landlock";
const REQUIRED = process.env.PAIRED_CODING_REQUIRE_LANDLOCK === "1";
const BWRAP = process.platform === "linux" ? bwrapProblem() : "not Linux";

function live(name, fn) {
  test(name, PROBLEM === null || REQUIRED ? {} : { skip: PROBLEM }, async (t) => {
    assert.equal(PROBLEM, null, "PAIRED_CODING_REQUIRE_LANDLOCK=1 and Landlock cannot run");
    await fn(t);
  });
}

const has = (bin) => spawnSync("/bin/sh", ["-c", `command -v ${bin}`]).status === 0;

/**
 * A worktree, a temp path and a state directory side by side under $HOME, the state directory
 * outside the temp path so Landlock can express the run. Not under /tmp: a default temp path
 * there would hold the worktree. "Outside" for a write is the fixture's own top directory.
 */
function liveState(boundary, over = {}) {
  const top = realpathSync(mkdtempSync(join(homedir(), ".pc-landlock-")));
  const root = join(top, "repo");
  for (const d of ["src", "lib", ".git"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, "src", "a.txt"), "alpha\n");
  writeFileSync(join(root, "src", "b.txt"), "bravo\n");
  writeFileSync(join(root, "lib", "l.txt"), "lima\n");
  writeFileSync(join(root, "notes.txt"), "notes\n");
  const temp = join(top, "tmp");
  mkdirSync(temp);
  const stateDir = join(top, "state", "s1");
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

const run = (state, command, extra = {}) => runSandboxed({ state, command, cwd: state.root, timeoutMs: 30_000, backend: "landlock", ...extra });
const write = (opts) => writeSandboxed({ tempPath: join(opts.path, "..", ".pair-write-0000000000000000.tmp"), ...opts, backend: "landlock" });
const EACCES = /Permission denied/;
const read = (...p) => readFileSync(join(...p), "utf8");

describe("live Landlock: pair_run", () => {
  live("a write inside the boundary lands", async () => {
    const f = liveState(["src/a.txt"]);
    const r = await run(f.state, "echo changed > src/a.txt && echo scratch > \"$T/x\" && echo ok > /dev/null", { env: { ...process.env, T: f.temp } });
    assert.equal(r.exitCode, 0, r.stderr || r.error);
    assert.equal(r.backend, "landlock");
    assert.equal(read(f.root, "src", "a.txt"), "changed\n");
    assert.equal(read(f.temp, "x"), "scratch\n");
  });

  live("a write outside the boundary is refused by the kernel: Permission denied", async () => {
    const f = liveState(["src/a.txt"]);
    for (const target of ["src/b.txt", "notes.txt", "src/new.txt", `${f.top}/outside.txt`]) {
      const r = await run(f.state, `echo pwned > '${target}'`);
      assert.notEqual(r.exitCode, 0, target);
      assert.equal(r.backend, "landlock");
      assert.match(r.stderr, EACCES, target);
    }
    assert.equal(read(f.root, "src", "b.txt"), "bravo\n");
    assert.equal(read(f.root, "notes.txt"), "notes\n");
    assert.equal(existsSync(join(f.root, "src", "new.txt")), false);
    assert.equal(existsSync(join(f.top, "outside.txt")), false);
  });

  live(".git is never granted; a .git inside a directory grant sends the run to bubblewrap", async () => {
    const f = liveState(["src/a.txt", ".git/HEAD"]);
    const r = await run(f.state, "echo pwned > .git/HEAD");
    assert.equal(r.backend, "landlock");
    assert.match(r.stderr, EACCES);
    assert.equal(read(f.root, ".git", "HEAD"), "ref: refs/heads/main\n");
    // A submodule under lib/**: Landlock could not take the grant on lib back off lib/sub/.git.
    mkdirSync(join(f.root, "lib", "sub", ".git"), { recursive: true });
    writeFileSync(join(f.root, "lib", "sub", ".git", "HEAD"), "ref: refs/heads/main\n");
    const g = await run({ ...f.state, changeSet: { ...f.state.changeSet, boundary: ["lib/**"] } }, "echo pwned > lib/sub/.git/HEAD; echo fine > lib/l.txt");
    if (BWRAP === null) {
      assert.equal(g.backend, "bwrap");
      assert.match(g.fellBack, /lib\/sub\/\.git/);
      assert.match(g.stderr, /Read-only file system/);
      assert.equal(read(f.root, "lib", "l.txt"), "fine\n");
    } else {
      assert.match(g.error, /Landlock cannot fence this .*lib\/sub\/\.git.*bubblewrap is unavailable/);
    }
    assert.equal(read(f.root, "lib", "sub", ".git", "HEAD"), "ref: refs/heads/main\n");
  });

  live("a new file under a glob entry lands, in a new directory too", async () => {
    const f = liveState(["lib/**"]);
    const r = await run(f.state, "mkdir -p lib/new/deep && echo x > lib/new/deep/x.txt && echo y > lib/l.txt");
    assert.equal(r.exitCode, 0, r.stderr || r.error);
    assert.equal(r.backend, "landlock");
    assert.equal(read(f.root, "lib", "new", "deep", "x.txt"), "x\n");
    assert.equal(read(f.root, "lib", "l.txt"), "y\n");
  });

  live("pair_run cannot write the state directory; where a temp path covers it, the run goes to bubblewrap", async () => {
    const f = liveState(["src/a.txt"]);
    const r = await run(f.state, `echo pwned > '${f.stateDir}/state.json'`);
    assert.equal(r.backend, "landlock");
    assert.match(r.stderr, EACCES);
    assert.equal(read(f.stateDir, "state.json"), "{}");
    const covered = await run({ ...f.state, tempPaths: [f.temp, join(f.top, "state")] }, `echo pwned > '${f.stateDir}/state.json'`);
    if (BWRAP === null) {
      assert.equal(covered.backend, "bwrap");
      assert.match(covered.fellBack, /holds .*state\/s1/);
    } else {
      assert.match(covered.error, /bubblewrap is unavailable/);
    }
    assert.equal(read(f.stateDir, "state.json"), "{}");
  });

  live("the case bubblewrap cannot pass: under src/**/*.ts a file that does not match is refused by the kernel", async () => {
    const f = liveState(["src/**/*.ts"]);
    writeFileSync(join(f.root, "src", "a.ts"), "a\n");
    writeFileSync(join(f.root, "src", "README.md"), "readme\n");
    mkdirSync(join(f.root, "src", "lib"));
    writeFileSync(join(f.root, "src", "lib", "b.ts"), "b\n");
    const outcome = async (cmd, state = f.state, extra = {}) => {
      const r = await run(state, cmd, extra);
      return r.exitCode === 0 ? "lands" : EACCES.test(r.stderr) ? "Permission denied" : `exit ${r.exitCode}: ${r.stderr}${r.error ?? ""}`;
    };
    // src holds a file outside the boundary (README.md, and a.txt, b.txt), so it gets no
    // directory grant: only its existing .ts files are writable, and no new file of any name.
    assert.equal(await outcome("echo x > src/README.md"), "Permission denied");
    assert.equal(await outcome("echo x > src/new.md"), "Permission denied");
    assert.equal(await outcome("echo x > src/new.ts"), "Permission denied");
    assert.equal(await outcome("echo x > src/a.ts"), "lands");
    // src/lib holds only .ts files: it gets a directory grant, and there a new file of any name
    // lands. That is the gap left: new files under a glob are fenced per directory.
    assert.equal(await outcome("echo x > src/lib/new.ts"), "lands");
    assert.equal(await outcome("mkdir src/lib/n && echo x > src/lib/n/c.ts"), "lands");
    assert.equal(await outcome("echo x > src/lib/new.md"), "lands");
    assert.equal(read(f.root, "src", "README.md"), "readme\n");
    assert.equal(existsSync(join(f.root, "src", "new.md")), false);
    // pair_write still creates a new matching file where pair_run cannot.
    assert.equal(write({ state: f.state, path: join(f.root, "src", "new.ts"), content: "n\n" }).ok, true);
    assert.equal(read(f.root, "src", "new.ts"), "n\n");
    // Under bubblewrap the same boundary binds all of src, so the existing README.md is writable.
    if (BWRAP === null) {
      assert.equal((await run(f.state, "echo x > src/README.md", { backend: "bwrap" })).exitCode, 0);
      assert.equal(read(f.root, "src", "README.md"), "x\n");
    }
  });

  live("a literal that does not exist yet is not creatable by pair_run, and pair_write creates it", async () => {
    const f = liveState(["src/new.txt"]);
    const r = await run(f.state, "echo x > src/new.txt");
    assert.match(r.stderr, EACCES);
    assert.deepEqual(r.uncreatable, ["src/new.txt"]);
    assert.equal(existsSync(join(f.root, "src", "new.txt")), false);
    const w = write({ state: f.state, path: join(f.root, "src", "new.txt"), content: "made\n" });
    assert.equal(w.ok, true, w.error);
    assert.equal(w.backend, "landlock");
    assert.equal(read(f.root, "src", "new.txt"), "made\n");
  });

  live("a missing glob directory pair_run cannot get a grant for does not stop the run: the rest runs on Landlock, and it is named", async () => {
    // With notes.txt outside the boundary the root is not clean and gets no grant; with the rest
    // of the root in the boundary it is clean, and the grant that would make newpkg (on the root,
    // so holding .git) is dropped.
    for (const boundary of [["newpkg/**", "src/a.txt"], ["newpkg/**", "src/**", "lib/**", "notes.txt"]]) {
      const f = liveState(boundary);
      const r = await run(f.state, "echo changed > src/a.txt && mkdir -p newpkg && echo x > newpkg/x");
      assert.equal(r.backend, "landlock", `${boundary}: the same whether or not bubblewrap works here`);
      assert.equal(r.fellBack, undefined);
      assert.deepEqual(r.uncreatable, ["newpkg/**"]);
      assert.notEqual(r.exitCode, 0);
      assert.match(r.stderr, EACCES);
      assert.equal(read(f.root, "src", "a.txt"), "changed\n");
      assert.equal(existsSync(join(f.root, "newpkg")), false);
    }
  });

  live("a pathname Unix socket outside the sandbox cannot be reached", async (t) => {
    if (!has("python3")) return t.skip("needs python3");
    const f = liveState(["src/a.txt"]);
    const path = join(f.top, "s.sock");
    const server = createServer((c) => c.end("hello"));
    await new Promise((resolve) => server.listen(path, resolve));
    try {
      const r = await run(f.state, `python3 -c "import socket; s = socket.socket(socket.AF_UNIX); s.connect('${path}'); print(s.recv(5))"`);
      assert.notEqual(r.exitCode, 0, r.stdout);
      if (landlockAbi() < 9) assert.match(r.stderr, /Operation not permitted/, "the helper's seccomp filter refuses socket(AF_UNIX)");
      const pair = await run(f.state, `python3 -c "import socket; a, b = socket.socketpair(); a.send(b'hi'); print(b.recv(2).decode())"`);
      assert.equal(pair.stdout.trim(), "hi", pair.stderr);
    } finally {
      server.close();
    }
  });

  live("the link check still runs after the run: a hard link in a granted directory is caught, a symlink cannot be made", async () => {
    const f = liveState(["lib/**"]);
    writeFileSync(join(f.top, "floor"), "");
    const sinceMs = statSync(join(f.top, "floor")).mtimeMs;
    const r = await run(f.state, "ln lib/l.txt lib/l2.txt; ln -s /etc/passwd lib/p; exit 0", { linkCheck: { sinceMs, exclusions: [] } });
    assert.equal(r.backend, "landlock");
    assert.deepEqual(r.links, ["lib/l.txt", "lib/l2.txt"]);
    assert.equal(existsSync(join(f.root, "lib", "p")), false, "Landlock grants no MAKE_SYM");
    assert.match(r.stderr, EACCES);
  });

  live("a timed-out run's whole process group is killed", async () => {
    const f = liveState(["src/a.txt"]);
    const r = await run(f.state, "sleep 30 & sleep 30", { timeoutMs: 1000 });
    assert.equal(r.timedOut, true);
    assert.equal(r.backend, "landlock");
    assert.equal(r.error, undefined);
    // A zombie counts as dead, as in reapGroups: in a container with no init, nothing reaps
    // the orphaned `sleep`, but it no longer runs.
    const ps = spawnSync("ps", ["-eo", "pgid=,stat="], { encoding: "utf8" }).stdout.split("\n").map((l) => l.trim().split(/\s+/));
    assert.deepEqual(ps.filter(([g, stat]) => Number(g) === r.pgid && !stat.startsWith("Z")), []);
  });

  live("in a clean glob directory, and below it, rm, mv and sed -i of agreed files work", async () => {
    const f = liveState(["lib/**"]);
    mkdirSync(join(f.root, "lib", "sub"));
    writeFileSync(join(f.root, "lib", "m.txt"), "mike\n");
    writeFileSync(join(f.root, "lib", "sub", "s.txt"), "sierra\n");
    writeFileSync(join(f.root, "lib", "sub", "r.txt"), "romeo\n");
    const r = await run(f.state, "rm lib/l.txt && mv lib/m.txt lib/m2.txt && sed -i s/sierra/SIERRA/ lib/sub/s.txt && rm lib/sub/r.txt && mv lib/m2.txt lib/sub/m3.txt");
    assert.equal(r.exitCode, 0, r.stderr || r.error);
    assert.equal(r.backend, "landlock");
    assert.deepEqual(readdirSync(join(f.root, "lib")).sort(), ["sub"]);
    assert.deepEqual(readdirSync(join(f.root, "lib", "sub")).sort(), ["m3.txt", "s.txt"]);
    assert.equal(read(f.root, "lib", "sub", "s.txt"), "SIERRA\n");
    assert.equal(read(f.root, "lib", "sub", "m3.txt"), "mike\n");
  });

  live("a literal file cannot be deleted or renamed, and nothing leaves a clean glob directory", async () => {
    const f = liveState(["src/a.txt", "lib/**"]);
    for (const cmd of ["rm -f src/a.txt", "mv src/a.txt src/a2.txt", "sed -i s/alpha/x/ src/a.txt", "mv lib/l.txt notes2.txt", `mv lib/l.txt '${f.top}/out.txt'`]) {
      const r = await run(f.state, cmd);
      assert.equal(r.backend, "landlock");
      assert.notEqual(r.exitCode, 0, cmd);
      assert.match(r.stderr, /Permission denied|Invalid cross-device link/, cmd);
    }
    assert.equal(read(f.root, "src", "a.txt"), "alpha\n");
    assert.equal(read(f.root, "lib", "l.txt"), "lima\n");
    assert.equal(existsSync(join(f.root, "notes2.txt")), false);
    assert.equal(existsSync(join(f.top, "out.txt")), false);
  });

  /** A loop that appends to lib/bg-<name>.txt from a new session, outside the run's group. */
  const escapee = (name) => `setsid sh -c 'while :; do echo t >> lib/bg-${name}.txt; sleep 0.05; done' </dev/null >/dev/null 2>&1 &`;
  const stopsGrowing = async (f, name) => {
    const size = () => statSync(join(f.root, "lib", `bg-${name}.txt`)).size;
    const a = size();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { a, b: size() };
  };

  live("a writer that leaves the process group with setsid stops once pair_run returns", async () => {
    const f = liveState(["lib/**"]);
    const r = await run(f.state, `${escapee("exit")} sleep 0.3`);
    assert.equal(r.exitCode, 0, r.stderr || r.error);
    assert.equal(r.backend, "landlock");
    const { a, b } = await stopsGrowing(f, "exit");
    assert.ok(a > 0, "the writer ran");
    assert.equal(b, a, "the writer kept writing after pair_run returned");
  });

  live("timeout and abort end a writer that left the process group, too", async () => {
    const f = liveState(["lib/**"]);
    const t = await run(f.state, `${escapee("timeout")} sleep 30`, { timeoutMs: 800 });
    assert.equal(t.timedOut, true);
    assert.equal(t.error, undefined);
    const ta = await stopsGrowing(f, "timeout");
    assert.ok(ta.a > 0, "the writer ran");
    assert.equal(ta.b, ta.a, "the writer outlived the timeout");
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 800);
    const ab = await run(f.state, `${escapee("abort")} sleep 30`, { signal: ctl.signal });
    assert.equal(ab.aborted, true);
    assert.equal(ab.error, undefined);
    const aa = await stopsGrowing(f, "abort");
    assert.ok(aa.a > 0, "the writer ran");
    assert.equal(aa.b, aa.a, "the writer outlived the abort");
  });
});

describe("live Landlock: pair_write", () => {
  live("an in-place write lands and keeps the file's inode and mode, with nothing staged", async () => {
    const f = liveState(["src/a.txt"]);
    chmodSync(join(f.root, "src", "a.txt"), 0o640);
    const before = statSync(join(f.root, "src", "a.txt"));
    const w = write({ state: f.state, path: join(f.root, "src", "a.txt"), content: "A" });
    assert.equal(w.ok, true, w.error);
    assert.equal(w.backend, "landlock");
    const after = statSync(join(f.root, "src", "a.txt"));
    assert.equal(read(f.root, "src", "a.txt"), "A");
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode & 0o777, 0o640);
    assert.deepEqual(readdirSync(join(f.root, "src")).sort(), ["a.txt", "b.txt"]);
  });

  live("a new file in a new directory lands", async () => {
    const f = liveState(["src/new/deep/x.txt"]);
    const path = join(f.root, "src", "new", "deep", "x.txt");
    const w = write({ state: f.state, path, content: "x" });
    assert.equal(w.ok, true, w.error);
    assert.equal(w.backend, "landlock");
    assert.equal(read(path), "x");
  });

  live("the write cannot reach outside the boundary, the state dir, or .git", async () => {
    const f = liveState(["src/a.txt"]);
    for (const path of [join(f.top, "outside.txt"), join(f.root, "notes.txt"), join(f.root, ".git", "HEAD"), join(f.stateDir, "state.json")]) {
      const w = write({ state: f.state, path, content: "pwned" });
      assert.equal(w.ok, false, path);
    }
    assert.equal(existsSync(join(f.top, "outside.txt")), false);
    assert.equal(read(f.root, "notes.txt"), "notes\n");
    assert.equal(read(f.root, ".git", "HEAD"), "ref: refs/heads/main\n");
    assert.equal(read(f.stateDir, "state.json"), "{}");
  });

  live("a target with a second hard link, or a symlink, is replaced by the staged write and the file outside is untouched", async () => {
    const f = liveState(["src/a.txt", "src/l.txt", "notes.txt"]);
    writeFileSync(join(f.top, "outside.txt"), "outside\n");
    // src/a.txt replaced by a hard link to the outside file; src/l.txt a symlink to it.
    const a = join(f.root, "src", "a.txt");
    spawnSync("/bin/rm", ["-f", a]);
    linkSync(join(f.top, "outside.txt"), a);
    symlinkSync(join(f.top, "outside.txt"), join(f.root, "src", "l.txt"));
    for (const path of [a, join(f.root, "src", "l.txt")]) {
      const w = write({ state: f.state, path, content: "new\n" });
      assert.equal(w.ok, true, w.error);
      assert.equal(w.backend, "landlock");
      assert.equal(w.fellBack, undefined);
      assert.equal(read(path), "new\n");
      const st = lstatSync(path);
      assert.equal(st.isFile() && st.nlink === 1, true, `${path} is now a file of its own`);
    }
    assert.deepEqual(readdirSync(join(f.root, "src")).sort(), ["a.txt", "b.txt", "l.txt"], "no temp file is left");
    // In the worktree root the grant would hold .git, so bubblewrap stages it, where it works.
    const n = join(f.root, "notes.txt");
    spawnSync("/bin/rm", ["-f", n]);
    linkSync(join(f.top, "outside.txt"), n);
    const w = write({ state: f.state, path: n, content: "notes2\n" });
    if (BWRAP === null) {
      assert.equal(w.ok, true, w.error);
      assert.equal(w.backend, "bwrap");
      assert.match(w.fellBack, /2 hard links.*worktree root/);
      assert.equal(read(n), "notes2\n");
    } else {
      assert.equal(w.ok, false);
      assert.match(w.error, /bubblewrap is unavailable/);
    }
    assert.equal(read(f.top, "outside.txt"), "outside\n");
  });

  live("a new file whose grant would hold .git is made on the host: a root-level file and a new package both land", async () => {
    const f = liveState(["new.md", "newpkg/**"]);
    for (const [path, content] of [[join(f.root, "new.md"), "# new\n"], [join(f.root, "newpkg", "deep", "x.ts"), "export {};\n"]]) {
      const w = write({ state: f.state, path, content });
      assert.equal(w.ok, true, w.error);
      assert.equal(w.backend, "landlock", "the same whether or not bubblewrap works here");
      assert.equal(w.fellBack, undefined);
      assert.equal(read(path), content);
      const st = lstatSync(path);
      assert.equal(st.isFile() && st.nlink === 1, true);
      assert.equal(st.mode & 0o777, 0o666 & ~process.umask());
    }
    assert.equal(lstatSync(join(f.root, "newpkg", "deep")).isDirectory(), true);
  });

  live("a symlink or a hard link planted at the target between plan and create refuses, and the file outside is untouched", async () => {
    const f = liveState(["new.md", "newpkg/**"]);
    const outside = join(f.top, "outside.txt");
    writeFileSync(outside, "outside\n");
    for (const [target, plant] of [
      [join(f.root, "new.md"), (p) => symlinkSync(outside, p)],
      [join(f.root, "newpkg", "x.ts"), (p) => linkSync(outside, p)],
    ]) {
      const plan = pairWriteLandlock(f.state, target, landlockIo);
      assert.ok(plan.create, "planned as a host create");
      if (plan.create.dirs.length) mkdirSync(plan.create.dirs.at(-1), { recursive: true });
      plant(target);
      const before = lstatSync(target);
      assert.throws(() => createOnHost(plan.create), /appeared before it could be created/);
      const after = lstatSync(target);
      assert.equal(after.ino, before.ino, `${target} is still what was planted`);
      if (before.isSymbolicLink()) assert.equal(readlinkSync(target), outside);
    }
    assert.equal(read(outside), "outside\n");
    assert.equal(lstatSync(outside).nlink, 2, "only the planted hard link, nothing more");
  });

  live("a symlinked parent refuses before anything is made", async () => {
    const f = liveState(["newpkg/**"]);
    mkdirSync(join(f.top, "elsewhere"));
    symlinkSync(join(f.top, "elsewhere"), join(f.root, "newpkg"));
    const w = write({ state: f.state, path: join(f.root, "newpkg", "deep", "x.ts"), content: "x" });
    assert.equal(w.ok, false);
    assert.match(w.error, /symlink/);
    assert.deepEqual(readdirSync(join(f.top, "elsewhere")), []);
  });

  live("a write that fails after the host made the file leaves no empty file or directory behind", async () => {
    const f = liveState(["newpkg/**"]);
    const path = join(f.root, "newpkg", "deep", "x.ts");
    // The helper inherits a file-size limit of 0, so its `cat` dies with SIGXFSZ on the first byte.
    const code = `
      import { writeSandboxed } from ${JSON.stringify(new URL("./host-io.mjs", import.meta.url).href)};
      import { landlockProblem } from ${JSON.stringify(new URL("./landlock.mjs", import.meta.url).href)};
      landlockProblem();
      const o = JSON.parse(process.env.PC_WRITE);
      process.stdout.write(JSON.stringify(writeSandboxed({ ...o, backend: "landlock" })));
    `;
    const opts = { state: f.state, path, tempPath: join(f.root, "newpkg", "deep", ".pair-write-0000000000000000.tmp"), content: "x" };
    const res = spawnSync("/bin/sh", ["-c", 'ulimit -f 0 && exec "$0" --input-type=module -e "$1"', process.execPath, code], {
      encoding: "utf8", env: { ...process.env, PC_WRITE: JSON.stringify(opts) },
    });
    assert.equal(res.status, 0, res.stderr);
    const w = JSON.parse(res.stdout);
    assert.equal(w.ok, false);
    assert.equal(w.backend, "landlock");
    assert.doesNotMatch(w.error, /left behind/);
    assert.equal(existsSync(join(f.root, "newpkg")), false);
  });
});
