import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// claude.ai's plugin service (which feeds Claude Desktop) refuses to ingest a plugin that ships a
// top-level bin/ (added to PATH on the CLI, not shown on the admin approval surface), or that
// carries a .claude-plugin/plugin.json anywhere but at its root. It also strips angle brackets
// from a skill's frontmatter description ("SKILL.md description cannot contain XML tags"), so the
// description claude.ai stores differs from the one Claude Code reads. paired-coding (bin/pair.mjs),
// plugin-kit (templates/.claude-plugin/plugin.json), ask-graham and ledger's review skill tripped
// these on 2026-11-16. Only git-tracked files count: untracked junk in a checkout never ships.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tracked = execFileSync("git", ["-C", ROOT, "ls-files", "-z", "--", "plugins"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

/** The text of a SKILL.md frontmatter `description`, block scalars and continuation lines included; null when absent. */
export function frontmatterDescription(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  const front = lines.slice(1, end === -1 ? lines.length : end);
  const at = front.findIndex((l) => /^description:/.test(l));
  if (at === -1) return null;
  const head = front[at].slice("description:".length).trim();
  const parts = /^[>|][-+0-9]*$/.test(head) ? [] : [head];
  for (const l of front.slice(at + 1)) {
    if (!/^\s/.test(l) && l !== "") break;
    parts.push(l.trim());
  }
  return parts.join(" ").trim();
}

test("frontmatterDescription reads plain, quoted and block-scalar descriptions, and a block indicator is not content", () => {
  assert.equal(frontmatterDescription("---\nname: a\ndescription: run git diff <base>..HEAD\n---\n"), "run git diff <base>..HEAD");
  assert.equal(frontmatterDescription("---\ndescription: 'quoted'\nlicense: MIT\n---\n"), "'quoted'");
  assert.equal(frontmatterDescription("---\ndescription: >-\n  folded\n  text\nname: a\n---\n"), "folded text");
  assert.equal(frontmatterDescription("---\nname: a\n---\n"), null);
});

test("no plugin ships a top-level bin/ directory", () => {
  const offending = tracked.filter((p) => /^plugins\/[^/]+\/bin\//.test(p));
  assert.deepEqual(offending, [], "claude.ai-hosted plugins may not ship bin/ executables; move them (scripts/ is the convention) and declare entry points via hooks, commands or mcpServers");
});

test("every .claude-plugin/plugin.json is at a plugin's root", () => {
  const offending = tracked.filter((p) => /(^|\/)\.claude-plugin\/plugin\.json$/.test(p) && !/^plugins\/[^/]+\/\.claude-plugin\/plugin\.json$/.test(p));
  assert.deepEqual(offending, [], "claude.ai requires plugin.json at <plugin>/.claude-plugin/plugin.json only; rename a nested one (a template, a fixture) so it is not .claude-plugin/plugin.json");
});

test("no skill's frontmatter description contains < or >", () => {
  const offending = tracked
    .filter((p) => /^plugins\/[^/]+\/skills\/[^/]+\/SKILL\.md$/.test(p))
    .filter((p) => /[<>]/.test(frontmatterDescription(readFileSync(join(ROOT, p), "utf8")) ?? ""));
  assert.deepEqual(offending, [], "claude.ai stores a skill description with angle brackets removed; reword the description (argument-hint is not affected)");
});
