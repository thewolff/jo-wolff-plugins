// agents.test.mjs — the kit's agents (README "Agents"): each `agents/*.md` opens with frontmatter
// that parses as plain `key: value` lines a YAML reader takes as strings, carries the required
// `name` (the file's stem) and `description`, a `tools` allowlist without Agent and a Claude
// `model`; its text has the CLAIM/CITE contract and a "How it fails" heading the plugin gate's
// `says` check accepts; it names no personal home directory; it runs checkout code only on an
// `execute: <sha>` authorization and snapshots with `git archive`; its attribute block, run as
// written against throwaway repositories, refuses every attribute name that runs a driver or
// changes bytes, whatever the value, and stops on any git failure; the gate never runs ledger;
// the README lists every agent.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

test("agents: each runs checkout code only on an execute authorization for the head sha, and snapshots with git archive, never a checkout", () => {
  const flat = (text) => text.replace(/\s+/g, " ");
  for (const file of files()) {
    const text = flat(readFileSync(join(AGENTS, file), "utf8"));
    assert.ok(
      text.includes("Code from the checkout runs only when the invoking prompt carries `execute: <sha>` naming the full head sha and the containment check in 0c passes."),
      `${file}: the execute authorization sentence`,
    );
    assert.ok(text.includes("`unavailable: no execute authorization for <head>`"), `${file}: the missing-authorization outcome`);
    assert.ok(text.includes("containment strips credentials from the environment"), `${file}: says what containment does not cover`);
    assert.ok(text.includes('set -o pipefail; git -C "<repo>" archive --format=tar "$head" | tar -x -f - -C "$snap"'), `${file}: the git archive snapshot line`);
    assert.ok(text.includes('check-attr --source="$head" -z --all --stdin'), `${file}: every attribute name asked for before the archive`);
    assert.ok(text.includes('diff <(git -C "<repo>" ls-tree -r -z --name-only "$head"'), `${file}: extracted names compared with the commit`);
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

/** The fenced `sh` attribute block of one agent, dedented. */
function attributeBlock(file) {
  const text = readFileSync(join(AGENTS, file), "utf8");
  const m = /\*\*Attributes first\.\*\*[\s\S]*?\n( *)```sh\n([\s\S]*?)\n *```\n/.exec(text);
  assert.ok(m, `${file}: an sh block under "Attributes first"`);
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

/** A throwaway repository with a.txt, d/e/b.md and an optional .gitattributes, committed. */
function fixtureRepo(attributes) {
  const dir = mkdtempSync(join(tmpdir(), "plugin-kit-attr-"));
  const env = gitEnv(dir);
  const git = (...args) => {
    const r = spawnSync(REAL_GIT, ["-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q");
  writeFileSync(join(dir, "a.txt"), "a\n");
  mkdirSync(join(dir, "d", "e"), { recursive: true });
  writeFileSync(join(dir, "d", "e", "b.md"), "b\n");
  if (attributes !== undefined) writeFileSync(join(dir, ".gitattributes"), attributes);
  git("add", "-A");
  git("commit", "-qm", "fixture");
  return { dir, env, head: git("rev-parse", "HEAD"), git };
}

/** Run one agent's block, as written, with <repo> and $head filled in. */
function runBlock(shell, block, repo, { env = repo.env, PATH } = {}) {
  const script = block.replaceAll('"<repo>"', `"${repo.dir}"`);
  return spawnSync(shell, ["-c", script], { env: { ...env, ...(PATH ? { PATH } : {}), head: repo.head }, encoding: "utf8" });
}

test("agents: both agents carry the same attribute block", () => {
  assert.equal(attributeBlock("cross-lab-reviewer.md"), attributeBlock("release-gate.md"));
});

test("agents: the attribute block passes a clean commit and refuses every driver or byte-changing attribute name, whatever its value", () => {
  assert.ok(REAL_GIT, "git on PATH");
  const block = attributeBlock("release-gate.md");
  const refusals = [
    ["*.txt filter=evil\n", "a.txt: filter"],
    // The round-3 bypass: a driver literally named `unspecified`, which check-attr prints as the
    // same token it uses for an absent attribute when asked for `filter` by name.
    ["*.txt filter=unspecified\n", "a.txt: filter"],
    ["*.md -filter\n", "d/e/b.md: filter"],
    ["e/ export-ignore\n", "d/e/: export-ignore"],
    ["d export-subst\n", "d: export-subst"],
    ["* text=auto\n", ": text"],
    ["*.md binary\n", "d/e/b.md: diff"],
    ["*.txt ident\n", "a.txt: ident"],
  ];
  for (const shell of SHELLS) {
    const clean = fixtureRepo();
    const ok = runBlock(shell, block, clean);
    assert.equal(ok.status, 0, `${shell} clean: ${ok.stdout}${ok.stderr}`);
    assert.match(ok.stdout, /^attributes: none refused on 6 paths of [0-9a-f]{40}$/m, `${shell} clean`);
    const harmless = fixtureRepo("*.md linguist-documentation\n");
    assert.equal(runBlock(shell, block, harmless).status, 0, `${shell}: an unrelated attribute passes`);
    // `!filter` over `filter=evil` assigns nothing: check-attr --all lists nothing for a.txt and
    // git archive runs no driver for it, so the block passes it and that is safe.
    const overridden = fixtureRepo("*.txt filter=evil\na.txt !filter\n");
    overridden.git("config", "filter.evil.smudge", `touch "${join(overridden.dir, "SMUDGED")}"; cat`);
    const o = runBlock(shell, block, overridden);
    assert.equal(o.status, 0, `${shell} !filter override: ${o.stdout}${o.stderr}`);
    const archive = spawnSync(REAL_GIT, ["archive", "--format=tar", overridden.head], { cwd: overridden.dir, env: overridden.env });
    assert.equal(archive.status, 0, `${shell}: git archive of the !filter override`);
    assert.ok(!existsSync(join(overridden.dir, "SMUDGED")), `${shell}: !filter ran no driver in git archive`);
    for (const [attributes, named] of refusals) {
      const repo = fixtureRepo(attributes);
      for (const driver of ["evil", "unspecified"]) repo.git("config", `filter.${driver}.smudge`, `touch "${join(repo.dir, "SMUDGED")}"; cat`);
      const r = runBlock(shell, block, repo);
      assert.equal(r.status, 1, `${shell} ${JSON.stringify(attributes)}: ${r.stdout}${r.stderr}`);
      assert.ok(r.stdout.startsWith("refused: ") && r.stdout.includes(named), `${shell} ${JSON.stringify(attributes)} names ${named}: ${r.stdout}`);
      assert.ok(!existsSync(join(repo.dir, "SMUDGED")), `${shell}: no driver ran`);
      if (/filter=/.test(attributes)) {
        // The control: the same repository's git archive does run the driver the block refused.
        spawnSync(REAL_GIT, ["archive", "--format=tar", repo.head], { cwd: repo.dir, env: repo.env });
        assert.ok(existsSync(join(repo.dir, "SMUDGED")), `${shell} ${JSON.stringify(attributes)}: git archive runs the driver`);
      }
    }
  }
});

test("agents: the attribute block stops with a named reason when git fails mid-pipe, answers nothing, or has no --source", () => {
  const block = attributeBlock("release-gate.md");
  const fake = mkdtempSync(join(tmpdir(), "plugin-kit-fakegit-"));
  const modes = {
    // check-attr reads part of its input, then dies: the case pipefail exists for.
    "check-attr-dies": ['case "$*" in *check-attr*) head -c 3 >/dev/null; exit 1 ;; esac', "refused: git check-attr --source failed"],
    // check-attr exits 0 with no answer: an empty --all result must not read as clean.
    "check-attr-silent": ['case "$*" in *check-attr*) cat >/dev/null; exit 0 ;; esac', "refused: git check-attr answered 0 fields for 6 paths"],
    // A git from before check-attr --source.
    "no-source": ['case "$*" in *--source=*) echo "error: unknown option" >&2; exit 129 ;; esac', "refused: git check-attr --source failed"],
    // ls-tree of the directories fails inside the path list.
    "ls-tree-dirs-die": ['case "$*" in *ls-tree*-d*) exit 1 ;; esac', "refused: git ls-tree failed"],
    // Only the --all pass fails, after the coverage pass succeeded.
    "all-dies": ['case "$*" in *--all*) cat >/dev/null; exit 1 ;; esac', "refused: git check-attr --all failed"],
  };
  for (const shell of SHELLS) {
    const repo = fixtureRepo();
    for (const [mode, [body, reason]] of Object.entries(modes)) {
      const bin = join(fake, mode);
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\nexec "${REAL_GIT}" "$@"\n`);
      chmodSync(join(bin, "git"), 0o755);
      const r = runBlock(shell, block, repo, { PATH: `${bin}:${dirname(REAL_GIT)}:/usr/bin:/bin` });
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
