// agents.test.mjs — the kit's agents (README "Agents"): each `agents/*.md` opens with frontmatter
// that parses as plain `key: value` lines a YAML reader takes as strings, carries the required
// `name` (the file's stem) and `description`, a `tools` allowlist without Agent and a Claude
// `model`; its text has the CLAIM/CITE contract and a "How it fails" heading the plugin gate's
// `says` check accepts; it names no personal home directory; it runs checkout code only on an
// `execute: <sha>` authorization; every git command it runs goes through one pinned `g`
// function, and each one, run as written against a repository whose own config names an
// fsmonitor and a gpg helper, runs neither; its snapshot block, run as written against throwaway
// repositories in bash and zsh, writes each committed blob's exact bytes with `git cat-file`,
// checks every blob's hash, runs no driver even when attributes and filter config are hostile or
// swapped in mid-run, refuses links, submodules, escaping paths, a substituted object and file
// names the volume cannot hold, and stops on any git failure; the gate never runs ledger; the
// README lists every agent.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { KIT_ROOT } from "../scripts/new-plugin.mjs";

const AGENTS = join(KIT_ROOT, "agents");
const LEDGER_GATE = join(KIT_ROOT, "..", "ledger", "lib", "plugin-gate.mjs");
const MODELS = new Set(["sonnet", "opus", "haiku", "inherit"]);
const files = () => readdirSync(AGENTS).filter((n) => n.endsWith(".md")).sort();
/** The one pinned git function every git command in both agents goes through. */
const PINNED_G = 'g() { env -i PATH="$PATH" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1 git --no-pager --no-optional-locks -c core.hooksPath=/dev/null -c core.fsmonitor=false -c log.showSignature=false -C "<repo>" "$@"; }';

/** Every `/Users/<name>` in text whose whole name is not `example`, by the agents' own scrub class. */
function personalPaths(text) {
  return [...text.matchAll(/\/Users\/([A-Za-z0-9._-]+)/g)].map((m) => m[0]).filter((p) => p !== "/Users/example");
}

/** The frontmatter as { key: value }, or a string naming why it does not parse. */
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return "no frontmatter block at the top of the file";
  const fields = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*): (.+)$/.exec(line);
    if (!kv) return `not a single-line "key: value": ${JSON.stringify(line)}`;
    const [, key, value] = kv;
    // An unquoted YAML plain scalar may not start with an indicator or hold ": " or " #";
    // either would make the value a mapping, a list or a cut-off comment instead of a string.
    if (/^[[\]{}&*!|>'"%@`,#?:-]/.test(value) || / #|: /.test(value)) return `${key} is not a plain YAML string: ${JSON.stringify(value)}`;
    if (key in fields) return `${key} appears twice`;
    fields[key] = value;
  }
  return fields;
}

test("agents: the kit ships cross-lab-reviewer and release-gate, and nothing else", () => {
  assert.deepEqual(files(), ["cross-lab-reviewer.md", "release-gate.md"]);
});

test("agents: each file's frontmatter parses, with name (the stem), description, a tools allowlist without Agent, and a Claude model", () => {
  for (const file of files()) {
    const fm = frontmatter(readFileSync(join(AGENTS, file), "utf8"));
    assert.equal(typeof fm, "object", `${file}: ${fm}`);
    assert.equal(fm.name, file.slice(0, -3), `${file}: name`);
    assert.ok(fm.description && fm.description.length >= 80, `${file}: description is the routing text`);
    assert.match(fm.description, /Use proactively /, `${file}: description says when to route to it`);
    const tools = fm.tools.split(/,\s*/);
    assert.ok(tools.length > 0 && tools.every((t) => /^[A-Z][A-Za-z]+$/.test(t)), `${file}: tools is a comma list`);
    assert.ok(!tools.includes("Agent"), `${file}: an agent here never spawns another`);
    assert.ok(MODELS.has(fm.model), `${file}: model ${fm.model}`);
    for (const ignored of ["hooks", "mcpServers", "permissionMode"]) assert.ok(!(ignored in fm), `${file}: plugin agents ignore ${ignored}`);
  }
});

test("agents: the report-only gate has no Write or Edit and runs on haiku; the reviewer writes only through Write, never Edit", () => {
  const gate = frontmatter(readFileSync(join(AGENTS, "release-gate.md"), "utf8"));
  assert.deepEqual(gate.tools.split(/,\s*/), ["Read", "Grep", "Glob", "Bash"]);
  assert.equal(gate.model, "haiku");
  const reviewer = frontmatter(readFileSync(join(AGENTS, "cross-lab-reviewer.md"), "utf8"));
  assert.ok(!reviewer.tools.split(/,\s*/).includes("Edit"));
  assert.match(readFileSync(join(AGENTS, "cross-lab-reviewer.md"), "utf8"), /codex exec --sandbox read-only /);
});

test("agents: each runs checkout code only on an execute authorization for the head sha, and snapshots from git objects, never a checkout or an archive", () => {
  const flat = (text) => text.replace(/\s+/g, " ");
  for (const file of files()) {
    const text = flat(readFileSync(join(AGENTS, file), "utf8"));
    assert.ok(
      text.includes("Code from the checkout runs only when the invoking prompt carries `execute: <sha>` naming the full head sha and the containment check in 0c passes."),
      `${file}: the execute authorization sentence`,
    );
    assert.ok(text.includes("`unavailable: no execute authorization for <head>`"), `${file}: the missing-authorization outcome`);
    assert.ok(text.includes("containment strips credentials from the environment"), `${file}: says what containment does not cover`);
    assert.ok(text.includes('g cat-file blob "$oid" > "$stage/$n"'), `${file}: each blob written by git cat-file`);
    assert.ok(text.includes('g hash-object --no-filters -t blob --stdin-paths < "$snaproot/staged"'), `${file}: every written blob hash-checked`);
    assert.ok(text.includes('cmp -s "$snaproot/want" "$snaproot/have"'), `${file}: names reconciled, not only counts`);
    const defs = text.match(/g\(\) \{[^}]*\}/g) ?? [];
    assert.deepEqual(defs, [PINNED_G, PINNED_G], `${file}: one pinned g, in Inputs and in the snapshot block`);
    assert.doesNotMatch(text, /git -C/, `${file}: no git call outside g`);
    assert.doesNotMatch(text, /\bg (archive|check-attr|worktree|checkout|clone)\b/, `${file}: no archive, attribute guard, checkout or worktree`);
  }
  const readme = flat(readFileSync(join(KIT_ROOT, "README.md"), "utf8"));
  assert.ok(readme.includes("execute: <the full 40-character sha printed by git rev-parse HEAD>"), "README shows the invocation");
});

test("agents: the release gate reports the ledger plugin gate unavailable and never runs it", () => {
  const text = readFileSync(join(AGENTS, "release-gate.md"), "utf8");
  assert.ok(text.includes("`unavailable: ledger gate check runs against live HEAD; pinned invocation not supported`"), "check 6 outcome");
  assert.doesNotMatch(text, /ledger\.mjs/, "no ledger invocation");
});

/** The fenced `sh` snapshot block of one agent, dedented. */
function snapshotBlock(file) {
  const text = readFileSync(join(AGENTS, file), "utf8");
  const m = /\*\*Snapshot\*\*[\s\S]*?\n( *)```sh\n([\s\S]*?)\n *```\n/.exec(text);
  assert.ok(m, `${file}: an sh block under "Snapshot"`);
  return m[2]
    .split("\n")
    .map((l) => (l.startsWith(m[1]) ? l.slice(m[1].length) : l))
    .join("\n");
}

const SHELLS = ["/bin/bash", "/bin/zsh"].filter((s) => existsSync(s));
const REAL_GIT = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

/** A git environment that reads no user or system config. */
function gitEnv(home) {
  return { HOME: home, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}

/** A throwaway repository with a.txt and d/e/b.md committed, plus a git helper. */
function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "plugin-kit-snap-"));
  const env = gitEnv(dir);
  const git = (args, input) => {
    const r = spawnSync(REAL_GIT, ["-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env, input });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.toString().trim();
  };
  const files = { "a.txt": "a\n", "d/e/b.md": "b\n" };
  git(["init", "-q"]);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  git(["add", "-A"]);
  git(["commit", "-qm", "fixture"]);
  const repo = { dir, env, git, files, head: git(["rev-parse", "HEAD"]) };
  /** Commit more files exactly as given (no attribute applies at add: .gitattributes goes last). */
  repo.commit = (more, { exec = [] } = {}) => {
    for (const [p, body] of Object.entries(more)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), body);
      if (exec.includes(p)) chmodSync(join(dir, p), 0o755);
      git(["add", "--", p]);
      git(["commit", "-qm", p]);
    }
    Object.assign(files, more);
    repo.head = git(["rev-parse", "HEAD"]);
  };
  return repo;
}

/** Run one agent's block, as written, with <repo>, $head and a fresh $snaproot filled in. */
function runBlock(shell, block, repo, { env = repo.env, PATH } = {}) {
  const snaproot = mkdtempSync(join(tmpdir(), "plugin-kit-snaproot-"));
  const script = block.replaceAll('"<repo>"', `"${repo.dir}"`);
  const r = spawnSync(shell, ["-c", script], { env: { ...env, ...(PATH ? { PATH } : {}), head: repo.head, snaproot }, encoding: "utf8" });
  return { ...r, snaproot, snap: join(snaproot, "snap") };
}

/** Every regular file under dir, relative, sorted. */
function walk(dir, rel = "") {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    assert.ok(e.isFile() || e.isDirectory(), `${p} is neither file nor directory`);
    return e.isDirectory() ? walk(dir, p) : [p];
  }).sort();
}

/** The snapshot holds exactly the committed bytes: same names, byte-equal content, +x only where committed. */
function assertCommittedBytes(r, repo, exec, label) {
  assert.equal(r.status, 0, `${label}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, new RegExp(`^snapshot: ${Object.keys(repo.files).length} files of ${repo.head}, every blob hash-checked, no conversion$`, "m"), label);
  assert.deepEqual(walk(r.snap), Object.keys(repo.files).sort(), `${label}: names`);
  for (const [p, body] of Object.entries(repo.files)) {
    assert.ok(readFileSync(join(r.snap, p)).equals(Buffer.from(body)), `${label}: ${p} bytes equal the committed blob`);
    assert.equal((statSync(join(r.snap, p)).mode & 0o100) !== 0, exec.includes(p), `${label}: ${p} executable bit`);
  }
}

/** A fake git on PATH: `body` runs first, then the real git. */
function fakeGit(name, body) {
  const bin = join(mkdtempSync(join(tmpdir(), "plugin-kit-fakegit-")), name);
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\nexec "${REAL_GIT}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  return `${bin}:${dirname(REAL_GIT)}:/usr/bin:/bin`;
}

// Bytes every byte-changing attribute would rewrite: an ident keyword, an export-subst
// placeholder, a CRLF line, and an executable script.
const TRAPS = { "x.txt": "$Id$\r\n$Format:%H$\n", "run.sh": "#!/bin/sh\nexit 0\n" };
const HOSTILE_ATTRIBUTES = "* filter=evil text eol=crlf ident\n*.txt export-subst\nd/ export-ignore\n";

test("agents: both agents carry the same snapshot block", () => {
  assert.equal(snapshotBlock("cross-lab-reviewer.md"), snapshotBlock("release-gate.md"));
});

test("agents: the snapshot holds the committed bytes and runs no driver, whatever the committed, local, global and info attributes say", () => {
  assert.ok(REAL_GIT, "git on PATH");
  const block = snapshotBlock("release-gate.md");
  for (const shell of SHELLS) {
    const clean = fixtureRepo();
    assertCommittedBytes(runBlock(shell, block, clean), clean, [], `${shell} clean`);

    const repo = fixtureRepo();
    repo.commit({ ...TRAPS, ".gitattributes": HOSTILE_ATTRIBUTES }, { exec: ["run.sh"] });
    const marker = join(repo.dir, "SMUDGED");
    const touch = `touch "${marker}"; cat`;
    repo.git(["config", "filter.evil.smudge", touch]);
    writeFileSync(join(repo.dir, ".git", "info", "attributes"), "* filter=info\n");
    repo.git(["config", "filter.info.smudge", touch]);
    // A global config naming a helper and its own attributes file: the block must not read it.
    const globalAttrs = join(repo.dir, "global-attributes");
    writeFileSync(globalAttrs, "* filter=glob\n");
    const globalConfig = join(repo.dir, "global-config");
    writeFileSync(globalConfig, `[core]\n\tattributesFile = ${globalAttrs}\n[filter "glob"]\n\tsmudge = ${touch}\n`);
    const env = { ...repo.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_PARAMETERS: `'filter.evil.smudge'='${touch}'` };
    const r = runBlock(shell, block, repo, { env });
    assertCommittedBytes(r, repo, ["run.sh"], `${shell} hostile`);
    assert.ok(!existsSync(marker), `${shell}: no driver ran`);
    // The control: the same repository's git archive runs the driver the snapshot never ran.
    spawnSync(REAL_GIT, ["archive", "--format=tar", repo.head], { cwd: repo.dir, env: repo.env });
    assert.ok(existsSync(marker), `${shell}: git archive runs the driver`);
  }
});

test("agents: attributes and a filter driver swapped in after the listing and before the blobs are written change nothing", () => {
  const block = snapshotBlock("release-gate.md");
  for (const shell of SHELLS) {
    const repo = fixtureRepo();
    repo.commit(TRAPS, { exec: ["run.sh"] });
    const marker = join(repo.dir, "SMUDGED");
    const evilAttrs = join(repo.dir, "evil-attributes");
    writeFileSync(evilAttrs, "* filter=evil text eol=crlf ident\n");
    // Between the block's ls-tree and its first cat-file, another process points
    // core.attributesFile at a filter, writes $GIT_DIR/info/attributes and configures the driver.
    const PATH = fakeGit(
      "swap",
      `case "$*" in *ls-tree*)
  "${REAL_GIT}" -C "${repo.dir}" config core.attributesFile "${evilAttrs}"
  "${REAL_GIT}" -C "${repo.dir}" config filter.evil.smudge 'touch "${marker}"; cat'
  printf '* filter=evil ident\\n' > "${repo.dir}/.git/info/attributes" ;;
esac`,
    );
    const r = runBlock(shell, block, repo, { PATH });
    assertCommittedBytes(r, repo, ["run.sh"], `${shell} swapped`);
    assert.ok(!existsSync(marker), `${shell}: no driver ran after the swap`);
    assert.match(spawnSync(REAL_GIT, ["config", "core.attributesFile"], { cwd: repo.dir, env: repo.env, encoding: "utf8" }).stdout, /evil-attributes/, `${shell}: the swap happened`);
    spawnSync(REAL_GIT, ["archive", "--format=tar", repo.head], { cwd: repo.dir, env: repo.env });
    assert.ok(existsSync(marker), `${shell}: after the swap, git archive runs the driver`);
  }
});

test("agents: the snapshot block refuses a symlink, a submodule, an escaping or .git path, and stops with a named reason on any git failure", () => {
  const block = snapshotBlock("release-gate.md");
  /** A commit whose root tree holds one blob under `name`, written without git's path checks. */
  const craftedCommit = (repo, name) => {
    const blob = repo.git(["hash-object", "-w", "--stdin"], "escaped\n");
    const entry = Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.from(blob, "hex")]);
    const tree = repo.git(["hash-object", "-t", "tree", "--literally", "-w", "--stdin"], entry);
    repo.head = repo.git(["commit-tree", tree, "-m", "crafted"]);
  };
  for (const shell of SHELLS) {
    const link = fixtureRepo();
    symlinkSync("a.txt", join(link.dir, "l"));
    link.git(["add", "l"]);
    link.git(["commit", "-qm", "link"]);
    link.head = link.git(["rev-parse", "HEAD"]);
    const sub = fixtureRepo();
    sub.git(["update-index", "--add", "--cacheinfo", `160000,${sub.head},sub`]);
    sub.git(["commit", "-qm", "sub"]);
    sub.head = sub.git(["rev-parse", "HEAD"]);
    const escape = fixtureRepo();
    craftedCommit(escape, "../escaped");
    const dotgit = fixtureRepo();
    craftedCommit(dotgit, ".GiT");
    for (const [repo, reason] of [
      [link, "refused: symlink l in "],
      [sub, "refused: submodule sub in "],
      [escape, "refused: path ../escaped in "],
      [dotgit, "refused: path .GiT in "],
    ]) {
      const r = runBlock(shell, block, repo);
      assert.equal(r.status, 1, `${shell} ${reason}: ${r.stdout}${r.stderr}`);
      assert.ok(r.stdout.startsWith(reason), `${shell}: ${r.stdout}`);
      assert.ok(!existsSync(join(r.snaproot, "escaped")), `${shell}: nothing written outside the snapshot`);
    }
    const repo = fixtureRepo();
    const modes = {
      // ls-tree writes part of the listing, then dies.
      "ls-tree-dies": ['case "$*" in *ls-tree*) "' + REAL_GIT + '" "$@" | head -c 10; exit 1 ;; esac', "refused: git ls-tree failed on "],
      // ls-tree exits 0 with no listing: an empty snapshot is never a clean one.
      "ls-tree-silent": ['case "$*" in *ls-tree*) exit 0 ;; esac', "refused: the listing of "],
      // ls-tree exits 0 with its last entry cut short.
      "ls-tree-cut": ['case "$*" in *ls-tree*) "' + REAL_GIT + '" "$@" | head -c 60; exit 0 ;; esac', "refused: the listing of "],
      "cat-file-dies": ['case "$*" in *cat-file*) exit 1 ;; esac', "refused: cannot write a.txt from git cat-file"],
      "hash-object-dies": ['case "$*" in *hash-object*) exit 1 ;; esac', "refused: git hash-object failed on the written blobs"],
    };
    for (const [mode, [body, reason]] of Object.entries(modes)) {
      const r = runBlock(shell, block, repo, { PATH: fakeGit(mode, body) });
      assert.equal(r.status, 1, `${shell} ${mode}: ${r.stdout}${r.stderr}`);
      assert.ok(r.stdout.startsWith(reason), `${shell} ${mode}: ${r.stdout}`);
    }
  }
});

/** Every inline command span of one agent that calls `g` (the `gh` line runs `gh`, not only git). */
function gCommands(file) {
  const text = readFileSync(join(AGENTS, file), "utf8").replace(/\n *```sh\n[\s\S]*?\n *```\n/g, "\n").replace(/\n\s*/g, " ");
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((s) => /(^|\$\()g [a-z]/.test(s) && !/\bgh /.test(s));
}

/** A helper that leaves a marker when run, and the repository-local config that names it. */
function helperRepo() {
  const repo = fixtureRepo();
  const marker = join(repo.dir, "HELPER-RAN");
  const helper = join(repo.dir, "helper.sh");
  writeFileSync(helper, `#!/bin/sh\necho "$0 $*" >> "${marker}"\nexit 1\n`);
  chmodSync(helper, 0o755);
  // A commit carrying a gpgsig header, so log.showSignature has a signature to verify.
  const tree = repo.git(["rev-parse", "HEAD^{tree}"]);
  const signed = `tree ${tree}\nparent ${repo.head}\nauthor t <t@example.com> 0 +0000\ncommitter t <t@example.com> 0 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQ==\n -----END PGP SIGNATURE-----\n\nsigned\n`;
  const base = repo.head;
  repo.head = repo.git(["hash-object", "-t", "commit", "-w", "--stdin"], signed);
  repo.git(["update-ref", "HEAD", repo.head]);
  repo.git(["config", "core.fsmonitor", helper]);
  repo.git(["config", "log.showSignature", "true"]);
  repo.git(["config", "gpg.program", helper]);
  return { repo, marker, base };
}

test("agents: every git command either agent runs goes through g, and none runs a helper the repository's own config names", () => {
  for (const file of files()) {
    const commands = gCommands(file);
    const subcommands = new Set(commands.map((c) => /(?:^|\$\()g ([a-z-]+)/.exec(c)[1]));
    const expected = file === "release-gate.md" ? ["grep", "rev-parse", "status"] : ["diff", "grep", "log", "remote", "rev-parse", "show", "status"];
    for (const sub of expected) assert.ok(subcommands.has(sub), `${file}: a g ${sub} command is checked (${[...subcommands]})`);
    for (const shell of SHELLS) {
      const { repo, marker, base } = helperRepo();
      // The control: the same repository runs both helpers for a plain git status and git log.
      spawnSync(REAL_GIT, ["status", "--porcelain"], { cwd: repo.dir, env: repo.env });
      spawnSync(REAL_GIT, ["log", "--oneline", `${base}..${repo.head}`], { cwd: repo.dir, env: repo.env });
      const ran = existsSync(marker) ? readFileSync(marker, "utf8") : "";
      assert.match(ran, /helper\.sh .*fsmonitor|helper\.sh \d/, `${shell}: plain git status runs the fsmonitor helper: ${ran}`);
      assert.match(ran, /--verify/, `${shell}: plain git log runs gpg.program: ${ran}`);
      rmSync(marker);
      const briefdir = mkdtempSync(join(tmpdir(), "plugin-kit-brief-"));
      for (const command of commands) {
        const script = `${PINNED_G.replace('"<repo>"', `"${repo.dir}"`)}\n${command.replaceAll("<base>", base).replaceAll("<plugin>", "p").replaceAll("<name>", "p")}`;
        const r = spawnSync(shell, ["-c", script], { env: { ...repo.env, head: repo.head, base_sha: base, briefdir }, encoding: "utf8" });
        if (existsSync(marker)) assert.fail(`${file} ${shell}: \`${command}\` ran a helper: ${readFileSync(marker, "utf8")}`);
        if (/^g (status|log|diff|rev-parse)\b|\$\(g rev-parse/.test(command)) assert.equal(r.status, 0, `${file} ${shell}: \`${command}\`: ${r.stderr}`);
      }
      const r = runBlock(shell, snapshotBlock(file), repo);
      assertCommittedBytes(r, repo, [], `${file} ${shell} helper config`);
      assert.ok(!existsSync(marker), `${file} ${shell}: the snapshot block ran a helper`);
    }
  }
});

test("agents: a blob an alternate object store substitutes for a listed id is refused with the hash mismatch, and no snapshot is made", () => {
  const block = snapshotBlock("release-gate.md");
  for (const shell of SHELLS) {
    const repo = fixtureRepo();
    const oid = repo.git(["rev-parse", `${repo.head}:a.txt`]);
    const other = Buffer.from("not the committed bytes\n");
    const store = join(mkdtempSync(join(tmpdir(), "plugin-kit-alternate-")), "objects");
    mkdirSync(join(store, oid.slice(0, 2)), { recursive: true });
    writeFileSync(join(store, oid.slice(0, 2), oid.slice(2)), deflateSync(Buffer.concat([Buffer.from(`blob ${other.length}\0`), other])));
    rmSync(join(repo.dir, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
    writeFileSync(join(repo.dir, ".git", "objects", "info", "alternates"), `${store}\n`);
    // The control: git cat-file hands back the substituted bytes for the committed id.
    assert.equal(repo.git(["cat-file", "blob", oid]), other.toString().trim(), `${shell}: the alternate answers for ${oid}`);
    const r = runBlock(shell, block, repo);
    assert.equal(r.status, 1, `${shell}: ${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.startsWith(`refused: hash mismatch: a.txt is listed as blob ${oid}, the bytes written hash to `), `${shell}: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /^snapshot:/m, `${shell}: no snapshot line`);
    assert.deepEqual(walk(r.snap), [], `${shell}: nothing placed in the snapshot`);
  }
});

test("agents: paths the volume folds into one name are refused by the name check, whatever the counts say", () => {
  const block = snapshotBlock("release-gate.md");
  const probe = mkdtempSync(join(tmpdir(), "plugin-kit-case-"));
  writeFileSync(join(probe, "X"), "");
  const foldsCase = existsSync(join(probe, "x"));
  /** Stage blobs under the given paths straight into the index (no work tree), then commit. */
  const commitPaths = (repo, paths) => {
    for (const p of paths) {
      const blob = repo.git(["hash-object", "-w", "--stdin"], `${p}\n`);
      // core.ignorecase=false: the index keeps each spelling as committed, whatever the volume.
      repo.git(["-c", "core.ignorecase=false", "update-index", "--add", "--cacheinfo", `100644,${blob},${p}`]);
      repo.files[p] = `${p}\n`;
    }
    repo.git(["commit", "-qm", "case"]);
    repo.head = repo.git(["rev-parse", "HEAD"]);
  };
  for (const shell of SHELLS) {
    for (const paths of [["Docs/a.txt", "docs/b.txt"], ["README", "readme"]]) {
      const repo = fixtureRepo();
      commitPaths(repo, paths);
      const r = runBlock(shell, block, repo);
      if (foldsCase) {
        assert.equal(r.status, 1, `${shell} ${paths}: ${r.stdout}${r.stderr}`);
        assert.ok(r.stdout.startsWith("refused: name mismatch: "), `${shell} ${paths}: ${r.stdout}`);
        assert.doesNotMatch(r.stdout, /^snapshot:/m, `${shell} ${paths}: no snapshot line`);
      } else {
        assertCommittedBytes(r, repo, [], `${shell} ${paths} on a case-sensitive volume`);
      }
    }
  }
});

test("agents: each text has the CLAIM/CITE contract, a How-it-fails heading the says check accepts, and no personal home directory", async () => {
  const gate = existsSync(LEDGER_GATE) ? await import(LEDGER_GATE) : null;
  for (const file of files()) {
    const text = readFileSync(join(AGENTS, file), "utf8");
    assert.match(text, /\*\*CLAIM\*\* needs an inspectable receipt/, `${file}: CLAIM contract`);
    assert.match(text, /\*\*CITE\*\* needs a URL fetched this session/, `${file}: CITE contract`);
    assert.match(text, /^## How it fails: when this can't run$/m, `${file}: How it fails`);
    assert.deepEqual(personalPaths(text), [], `${file}: a personal path`);
  }
  if (gate) assert.deepEqual(gate.textsWithoutWhenCant(KIT_ROOT), [], "the plugin gate's says check finds every text");
});

test("agents: the personal-path check takes the whole username, so only exactly `example` is exempt", () => {
  // Built from parts so the repository's own scrub never matches the fixtures in this file.
  const at = (name) => ["", "Users", name].join("/");
  for (const name of ["123", "_person", "example-person", "example.old", "alice"]) {
    assert.deepEqual(personalPaths(`see ${at(name)}/code`), [at(name)], `${name} is flagged`);
  }
  assert.deepEqual(personalPaths(`see ${at("example")}/code and \`${at("example")}\``), [], "example is exempt");
  assert.deepEqual(personalPaths(`see ${at("<name>")}`), [], "a placeholder is not a username");
});

test("agents: the README's Agents section names every agent", () => {
  const readme = readFileSync(join(KIT_ROOT, "README.md"), "utf8");
  const section = /\n## Agents\n([\s\S]*?)\n## /.exec(readme);
  assert.ok(section, "README has an Agents section");
  for (const file of files()) assert.ok(section[1].includes(`\`${file.slice(0, -3)}\``), `README Agents names ${file}`);
});

// The review budget (README "Review budget"): the reviewer's verdict vocabulary, the guard on
// `fix-first`, the threat-model line the brief cannot go without, the per-finding fields and the
// round rules. Each is pinned by its exact wording, so a reword that loosens one fails here.
const REVIEWER = () => readFileSync(join(AGENTS, "cross-lab-reviewer.md"), "utf8");
const DEFAULT_THREAT_MODEL = "Threat model: none — every input is Jo's own; review for correctness and fail-safety, not adversarial inputs";
const flatText = (text) => text.replace(/\s+/g, " ");

/** The rows of the first markdown table under `## <heading>`, as arrays of trimmed cells. */
function tableUnder(text, heading) {
  const section = new RegExp(`\\n## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(text);
  if (!section) return null;
  const rows = section[1].split("\n").filter((l) => /^\|.*\|$/.test(l.trim()));
  return rows.slice(2).map((l) => l.trim().slice(1, -1).split("|").map((c) => c.trim()));
}

/** The fenced `text` block that follows the line "The brief template:", dedented. */
function briefTemplate(text) {
  const m = /The brief template:\n\n( *)```text\n([\s\S]*?)\n\1```/.exec(text);
  if (!m) return null;
  return m[2].split("\n").map((l) => l.slice(m[1].length)).join("\n");
}

test("review budget: the verdict table has exactly ship, ship-with-limits and fix-first, and only fix-first needs a blocking finding", () => {
  const rows = tableUnder(REVIEWER(), "Verdicts");
  assert.ok(rows, "a `## Verdicts` section with a table");
  assert.deepEqual(rows.map((r) => r[0]), ["`ship`", "`ship-with-limits`", "`fix-first`"]);
  const [ship, limits, fixFirst] = rows;
  assert.match(ship[1], /no in-scope finding is open/);
  assert.match(limits[1], /no in-scope finding is `blocking`/);
  assert.match(limits[2], /one line of README or HOW-IT-FAILS wording/);
  assert.match(fixFirst[1], /at least one in-scope finding is `blocking`/);
});

test("review budget: the fix-first guard, the blocking definition and the severity default are stated, and nothing else permits fix-first", () => {
  const text = flatText(REVIEWER());
  assert.ok(
    text.includes("`fix-first` is allowed only when at least one in-scope finding is `blocking`. A `fix-first` with no in-scope blocking finding is invalid, and the effective verdict is `ship-with-limits`."),
    "the fix-first guard sentence",
  );
  assert.ok(
    text.includes("A finding is `blocking` only when its worst case is one of: data loss; a write to live state outside the plugin's own state; a crash or hang; delivery to the wrong recipient; a security boundary violation inside the stated threat model."),
    "the blocking definition",
  );
  assert.ok(text.includes("When the severity is unclear, the finding is `should-fix`; doubt never makes a finding `blocking`."), "the severity default");
  // Every line that names fix-first also names the blocking condition, bar the template's verdict line.
  assert.doesNotMatch(text, /fix-first` even when/, "no rule keeps fix-first without a blocking finding");
  assert.doesNotMatch(text, /stands as `fix-first`/, "no rule turns another verdict into fix-first");
  for (const line of REVIEWER().split("\n").filter((l) => l.includes("fix-first"))) {
    if (line.trim() === "Verdict: ship | ship-with-limits | fix-first") continue;
    assert.match(line, /blocking/, `a line naming fix-first without the blocking condition: ${line}`);
  }
});

test("review budget: the brief template requires the threat-model line, and the reviewer refuses to start without it", () => {
  const raw = REVIEWER();
  const brief = briefTemplate(raw);
  assert.ok(brief, "a fenced `text` brief template after 'The brief template:'");
  assert.ok(brief.split("\n").includes(DEFAULT_THREAT_MODEL), "the brief carries the threat-model line, prefilled with the repository default");
  assert.match(brief, /^Round: <R>$/m, "the brief carries the round");
  assert.match(brief, /^## Out of scope$/m, "findings outside the threat model have their own section");
  assert.match(brief, /^worst_case: <one sentence>$/m, "every finding carries a worst case");
  assert.match(brief, /^new-mechanism: true \| false$/m, "every finding says whether its fix adds a mechanism");
  assert.match(brief, /^Verdict: ship \| ship-with-limits \| fix-first$/m, "the verdict line");
  const text = flatText(raw);
  assert.ok(
    text.includes("No `Threat model:` line, or one with nothing after the colon, means ask for it in one sentence and stop: nothing is snapshotted, sent to Codex or written."),
    "the refusal",
  );
  assert.ok(text.includes("A finding outside the threat model goes under `Out of scope` and does not affect the verdict."), "out-of-scope rule");
  assert.ok(text.includes("`new-mechanism: true`"), "the hold tag");
  assert.ok(text.includes("Held for Jo"), "the report lists held findings");
});

test("review budget: the default threat model is `none` with a reason, documented as valid in the agent and the README", () => {
  const text = flatText(REVIEWER());
  assert.ok(text.includes(`The repository default, which most prompts carry, is \`${DEFAULT_THREAT_MODEL}\`.`), "the agent states the default");
  assert.ok(
    text.includes("The literal `none` plus a reason is a valid threat model: it names no attacker, so every finding whose worst case needs an adversarial input goes under `Out of scope`, and correctness and fail-safety findings stay in scope."),
    "the agent: none is valid and moves adversarial findings out of scope",
  );
  assert.ok(text.includes("A line that says `none` is not that case and is never asked about."), "the agent: none never triggers the ask");
  assert.ok(text.includes("never fill in the default for a prompt that has no line"), "the agent: an absent line is still asked about");
  const readme = readFileSync(join(KIT_ROOT, "README.md"), "utf8");
  const budget = /\n## Review budget\n([\s\S]*?)\n## /.exec(readme);
  assert.ok(budget, "a Review budget section");
  assert.ok(budget[1].split("\n").includes(DEFAULT_THREAT_MODEL), "Review budget shows the default line");
  assert.ok(budget[1].split("\n").includes("Threat model: untrusted PR authors; trusted: CI secrets"), "Review budget shows a non-default example");
  assert.ok(flatText(budget[1]).includes("The literal `none` plus a reason is a valid threat model, not a missing one"), "Review budget: none is valid");
});

test("review budget: the round count, the round-3 cap and verification-only follow-ups are stated, with their sources", () => {
  const text = flatText(REVIEWER());
  assert.ok(
    text.includes("From round 3 on, the review is blocking-only: Codex reports `blocking` findings and the status of prior findings, nothing else, and the review's header says `Mode: blocking-only (round <R>)`."),
    "the round cap",
  );
  assert.ok(text.includes("A round count that cannot be read is round 1, and the report says so on the line under its `## Round 1` heading: `Round count unreadable: <reason>`."), "unreadable round count");
  assert.ok(
    text.includes("From round 2 on, the review is verification-only: Codex marks each prior finding `closed`, `partial` or `open` and runs no new probe list, unless the invoking prompt carries a `new probes:` line quoting Jo's own words authorizing them."),
    "verification-only follow-ups",
  );
  for (const url of [
    "https://raw.githubusercontent.com/openai/codex/main/codex-rs/prompts/templates/review/rubric.md",
    "https://learn.chatgpt.com/docs/third-party/github",
    "https://google.github.io/eng-practices/review/reviewer/standard.html",
    "https://google.github.io/eng-practices/review/reviewer/comments.html",
    "https://docs.sourcery.ai/reviews/anatomy-of-a-review/",
    "https://cursor.com/docs/bugbot",
    "https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex",
    "https://csaws.cs.technion.ac.il/~kantor/publications/IterativeCodeReviews.pdf",
  ]) assert.ok(text.includes(url), `cites ${url}`);
  for (const quote of [
    "Ignore non-blocking issues such as style, formatting, typos, documentation, and other nits.",
    "Codex flags only P0 and P1 issues",
    "favor approving a CL once it is in a state where it definitely improves the overall code health of the system being worked on, even if the CL isn't perfect.",
    "Automatic re-reviews are capped at five per pull request.",
    "max 3 attempts per PR to prevent loops",
    "max_iterations: int = 3",
    "iterations 4 and 5 of both modules produced only one new fault each",
  ]) assert.ok(text.includes(quote), `quotes ${quote}`);
});

/** The report lines the brief's output shape asks Codex to write, rendered for one round. */
function renderReport(doc, round, mode, unreadable) {
  const brief = briefTemplate(doc);
  assert.ok(brief, "a fenced `text` brief template");
  const shape = /\n## Output shape\n[\s\S]*?\n\n([\s\S]*?)\n\n/.exec(brief);
  assert.ok(shape, "the brief template has an output shape");
  return shape[1]
    .split("\n")
    .filter((l) => !l.startsWith("Round count unreadable:") || unreadable)
    .map((l) => l.replaceAll("<R>", String(round)).replaceAll("<mode>", mode).replaceAll("<reason>", unreadable ?? ""))
    .join("\n");
}

/**
 * The round reader as the agent's "Round:" input documents it: the heading pattern is the one in
 * its `grep -E`, the step is "one more than" the prior round, and a prior file that cannot be
 * read, has a `## Round` heading that is not a number, or has neither marker is round 1,
 * unreadable. Throws when the document no longer states one of those parts.
 */
function roundReader(doc) {
  const bullet = /\n- \*\*Round:\*\*([\s\S]*?)\n- \*\*/.exec(doc);
  assert.ok(bullet, "an Inputs bullet for the round");
  const rule = flatText(bullet[1]);
  const step = /Otherwise it is (.+?) the prior review's last round/.exec(rule);
  assert.equal(step?.[1], "one more than", "the round is one more than the prior review's last round");
  const grep = /grep -E '([^']+)'/.exec(rule);
  assert.ok(grep, "the heading pattern the reader greps for");
  const heading = new RegExp(grep[1], "m");
  return Object.assign((name, text) => {
    if (text === null) return { round: 1, unreadable: "Read failed" };
    const lines = text.split("\n");
    if (lines.some((l) => l.startsWith("## Round") && !heading.test(l))) return { round: 1, unreadable: "a `## Round` heading is not a number" };
    const ns = lines.filter((l) => heading.test(l)).map((l) => Number(/\d+/.exec(l)[0]));
    const file = /-round(\d+)\.md$/.exec(name);
    if (file) ns.push(Number(file[1]));
    if (ns.length === 0) return { round: 1, unreadable: "no round heading or file name" };
    return { round: Math.max(...ns) + 1 };
  }, { rule });
}

/** Throws unless a report from the template, fed to the documented reader, counts on. */
function checkRoundTrip(doc) {
  const next = roundReader(doc);
  const first = renderReport(doc, 1, "full");
  assert.deepEqual(next("REVIEW-0.2.1-codex.md", first), { round: 2 }, `a first report reads as round 1, so the next is 2:\n${first}`);
  assert.ok(next.rule.includes("A round count that cannot be read is round 1"), "unreadable is round 1");
  assert.ok(next.rule.includes("it has neither a `## Round N` heading nor a `-round<N>` file name"), "no marker is unreadable");
  const second = renderReport(doc, 2, "verification-only (round 2)");
  assert.deepEqual(next("REVIEW-0.2.1-codex-round2.md", second), { round: 3 }, "a -round2 report with its heading gives 3");
  assert.deepEqual(next("REVIEW-0.2.1-codex-round2.md", "Mode: full\n"), { round: 3 }, "the file name alone gives 3");
  assert.equal(next("REVIEW-0.2.1-codex.md", null).round, 1, "an unreadable prior file is round 1");
  assert.equal(next("REVIEW-0.2.1-codex.md", "## Round two\n").round, 1, "a heading that is not a number is round 1");
  assert.equal(next("REVIEW-0.2.1-codex.md", "Round: 1\n").round, 1, "a report with no heading is round 1");
  const reset = renderReport(doc, 1, "full", "no round heading or file name");
  assert.match(reset, /^## Round 1\nRound count unreadable: no round heading or file name$/m, "the reset report states why, under its heading");
  assert.deepEqual(next("REVIEW-0.2.1-codex.md", reset), { round: 2 }, "the reset report still counts as round 1");
}

/** Throws unless `fix-first` is tied to an in-scope blocking finding in the Verdicts section. */
function checkFixFirstRule(doc) {
  const rows = tableUnder(doc, "Verdicts");
  assert.ok(rows, "a `## Verdicts` table");
  const fixFirst = rows.find((r) => r[0] === "`fix-first`");
  assert.ok(fixFirst, "a fix-first row");
  assert.match(fixFirst[1], /^at least one in-scope finding is `blocking`$/, "fix-first's condition is an in-scope blocking finding");
  const section = flatText(/\n## Verdicts\n([\s\S]*?)\n## /.exec(doc)[1]);
  assert.ok(section.includes("`fix-first` is allowed only when at least one in-scope finding is `blocking`."), "the fix-first guard");
}

/** A copy of the document with one rule reversed; fails the test if the text to reverse is gone. */
function reversed(doc, from, to) {
  assert.ok(doc.includes(from), `the text to reverse is present: ${from}`);
  return doc.replaceAll(from, to);
}

test("review budget: a report written from the template is read by the documented round reader as its own round", () => {
  checkRoundTrip(REVIEWER());
});

test("review budget: the round-increment and fix-first rules hold, and reversing either fails its check", () => {
  const doc = REVIEWER();
  checkRoundTrip(doc);
  checkFixFirstRule(doc);
  assert.throws(() => checkRoundTrip(reversed(doc, "it is one more than the prior review's", "it is the same as the prior review's")), "a round that does not increment");
  assert.throws(() => checkFixFirstRule(reversed(doc, "| `fix-first` | at least one in-scope finding is `blocking` |", "| `fix-first` | at least one in-scope finding is open |")), "fix-first on any open finding");
  assert.throws(
    () => checkFixFirstRule(reversed(doc, "`fix-first` is allowed only when at least one in-scope finding is `blocking`.", "`fix-first` is allowed even when no in-scope finding is `blocking`.")),
    "fix-first allowed without a blocking finding",
  );
});

test("review budget: the README has the 0.2.1 changes, a Review budget section and the three how-it-fails rows", () => {
  const readme = readFileSync(join(KIT_ROOT, "README.md"), "utf8");
  assert.match(readme, /\n## Changes in 0\.2\.1\n/);
  assert.ok(readme.indexOf("## Changes in 0.2.1") < readme.indexOf("## Changes in 0.1.2"), "0.2.1 is the top Changes heading");
  const budget = /\n## Review budget\n([\s\S]*?)\n## /.exec(readme);
  assert.ok(budget, "a Review budget section");
  for (const word of ["`ship`", "`ship-with-limits`", "`fix-first`", "Threat model:", "round 3", "`new-mechanism: true`"]) assert.ok(budget[1].includes(word), `Review budget names ${word}`);
  const fails = flatText(/\n## How it fails\n([\s\S]*?)\n## /.exec(readme)[1]);
  assert.ok(fails.includes("No `Threat model:` line in the invoking prompt"), "how-it-fails: missing threat model");
  assert.ok(fails.includes("A round count that cannot be read"), "how-it-fails: unreadable round count");
  assert.ok(fails.includes("A severity that is unclear"), "how-it-fails: ambiguous severity");
  for (const file of [".claude-plugin/plugin.json", "package.json"]) {
    assert.equal(JSON.parse(readFileSync(join(KIT_ROOT, file), "utf8")).version, "0.2.1", `${file} version`);
  }
});
