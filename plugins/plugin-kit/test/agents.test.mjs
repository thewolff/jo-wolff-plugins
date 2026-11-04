// agents.test.mjs — the kit's agents (README "Agents"): each `agents/*.md` opens with frontmatter
// that parses as plain `key: value` lines a YAML reader takes as strings, carries the required
// `name` (the file's stem) and `description`, a `tools` allowlist without Agent and a Claude
// `model`; its text has the CLAIM/CITE contract and a "How it fails" heading the plugin gate's
// `says` check accepts; it names no personal home directory; it runs checkout code only on an
// `execute: <sha>` authorization; its snapshot block, run as written against throwaway
// repositories in bash and zsh, writes each committed blob's exact bytes with `git cat-file` and
// runs no driver even when attributes and filter config are hostile or swapped in mid-run,
// refuses links, submodules and escaping paths, and stops on any git failure; the gate never
// runs ledger; the README lists every agent.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KIT_ROOT } from "../scripts/new-plugin.mjs";

const AGENTS = join(KIT_ROOT, "agents");
const LEDGER_GATE = join(KIT_ROOT, "..", "ledger", "lib", "plugin-gate.mjs");
const MODELS = new Set(["sonnet", "opus", "haiku", "inherit"]);
const files = () => readdirSync(AGENTS).filter((n) => n.endsWith(".md")).sort();

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
    assert.ok(text.includes('g cat-file blob "$oid" > "$snap/$p"'), `${file}: each blob written by git cat-file`);
    assert.ok(text.includes("export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1"), `${file}: no global or system config`);
    assert.ok(text.includes('g() { git --no-pager -c core.hooksPath=/dev/null -C "<repo>" "$@"; }'), `${file}: every git call through one pinned function`);
    assert.doesNotMatch(text, /git -C "<repo>" (archive|check-attr)/, `${file}: no archive and no attribute guard`);
    assert.doesNotMatch(text, /git -C "<repo>" worktree /, `${file}: no worktree snapshot`);
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
  assert.match(r.stdout, new RegExp(`^snapshot: ${Object.keys(repo.files).length} files of ${repo.head}, no conversion$`, "m"), label);
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
      "ls-tree-silent": ['case "$*" in *ls-tree*) exit 0 ;; esac', "refused: 0 blobs written, 0 tree entries, 0 files in "],
      // ls-tree exits 0 with its last entry cut short.
      "ls-tree-cut": ['case "$*" in *ls-tree*) "' + REAL_GIT + '" "$@" | head -c 60; exit 0 ;; esac', "refused: the listing of "],
      "cat-file-dies": ['case "$*" in *cat-file*) exit 1 ;; esac', "refused: cannot write a.txt from git cat-file"],
    };
    for (const [mode, [body, reason]] of Object.entries(modes)) {
      const r = runBlock(shell, block, repo, { PATH: fakeGit(mode, body) });
      assert.equal(r.status, 1, `${shell} ${mode}: ${r.stdout}${r.stderr}`);
      assert.ok(r.stdout.startsWith(reason), `${shell} ${mode}: ${r.stdout}`);
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
