// agents.test.mjs — the kit's agents (README "Agents"): each `agents/*.md` opens with frontmatter
// that parses as plain `key: value` lines a YAML reader takes as strings, carries the required
// `name` (the file's stem) and `description`, a `tools` allowlist without Agent and a Claude
// `model`; its text has the CLAIM/CITE contract and a "How it fails" heading the plugin gate's
// `says` check accepts; it names no personal home directory; the README lists every agent.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
