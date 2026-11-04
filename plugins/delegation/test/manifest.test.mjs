// test/manifest.test.mjs — the manifests agree on name and version, hooks.json names only
// files that exist, every agent has usable frontmatter whose name matches its file and whose
// preloaded skills exist in a sibling plugin, and the template carries the headings the gate
// reads. No test here spawns anything.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ROOT } from "./helpers.mjs";
import { hasHeading, headingReason, HOW_IT_FAILS, HOW_IT_FAILS_SECTION, SPIRAL_BOUND, SPIRAL_BOUND_SECTION, STOPPED_SECTION, stoppedBecause, TEMPLATE } from "../lib/brief.mjs";
import { DEFAULTS } from "../lib/config.mjs";

const read = (p) => readFileSync(join(PLUGIN_ROOT, p), "utf8");
const json = (p) => JSON.parse(read(p));

test("package.json, .claude-plugin/plugin.json and .omp-plugin/plugin.json agree, and the OMP extension exists", () => {
  const pkg = json("package.json");
  const cc = json(".claude-plugin/plugin.json");
  const omp = json(".omp-plugin/plugin.json");
  assert.equal(pkg.name, "delegation");
  assert.equal(cc.name, "delegation");
  assert.equal(omp.name, "delegation");
  assert.equal(cc.version, pkg.version);
  assert.equal(omp.version, pkg.version);
  assert.match(read("CHANGELOG.md"), new RegExp(`^## ${pkg.version.replaceAll(".", "\\.")}`, "m"));
  for (const ext of pkg.omp.extensions) assert.ok(existsSync(join(PLUGIN_ROOT, ext)), ext);
});

test("hooks.json names hook files that exist, each under CLAUDE_PLUGIN_ROOT with a 5 s timeout (the runner's 4 s deadline answers first)", () => {
  const hooks = json("hooks/hooks.json").hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "SubagentStop"]);
  for (const groups of Object.values(hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[a-z-]+\.mjs)"$/.exec(h.command);
        assert.ok(m, h.command);
        assert.ok(existsSync(join(PLUGIN_ROOT, m[1])), m[1]);
        assert.equal(h.timeout, 5, h.command);
      }
    }
  }
});

test("every agent has frontmatter whose name matches its file, a model, and preloaded skills that exist in a sibling plugin", () => {
  const dir = join(PLUGIN_ROOT, "agents");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(files, ["auditor.md", "builder.md", "changelog.md", "checker.md", "debugger.md", "planner.md", "reader.md", "research.md", "scout.md", "storyteller.md", "summarizer.md"]);
  const skillDirs = [join(PLUGIN_ROOT, "..", "as2-skills", "skills"), join(PLUGIN_ROOT, "..", "output-types", "skills")];
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(m, `${f}: no frontmatter`);
    const fm = Object.fromEntries(m[1].split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
    assert.equal(fm.name, f.replace(/\.md$/, ""));
    assert.ok(fm.description, `${f}: no description`);
    assert.ok(["opus", "sonnet", "haiku"].includes(fm.model), `${f}: model ${fm.model}`);
    for (const skill of (fm.skills ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      assert.ok(skillDirs.some((d) => existsSync(join(d, skill, "SKILL.md"))), `${f}: skill ${skill} is in no sibling plugin`);
    }
    assert.doesNotMatch(text, /newdle|shipyard|\.projects\/|ENG-\d|CLAUDE_PLUGIN_ROOT|VOICE\.md|Linear/i, `${f}: carries source-specific text`);
  }
});

test("the builder brief template carries the exact section texts the deny reasons carry, and a valid Stopped-because line", () => {
  const tpl = read(TEMPLATE);
  assert.ok(hasHeading(tpl, HOW_IT_FAILS));
  assert.ok(hasHeading(tpl, SPIRAL_BOUND));
  assert.ok(tpl.includes(`\n${HOW_IT_FAILS_SECTION}\n`), "How-it-fails section verbatim");
  assert.ok(tpl.includes(`\n${SPIRAL_BOUND_SECTION}\n`), "Spiral-bound section verbatim");
  assert.ok(tpl.includes(`\n${STOPPED_SECTION}\n`), "Report section verbatim");
  for (const line of ["Stopped because: acceptance met", "Stopped because: bound hit", "Stopped because: told to stop"]) {
    assert.ok(tpl.includes(`\n${line}\n`), line);
    assert.equal(stoppedBecause(`Report.\n${line}`).valid, true, line);
  }
  // A brief rebuilt from a refusal alone passes the gate: the deny text's sections satisfy the heading match.
  const rebuilt = `Do the thing.\n\n${headingReason([HOW_IT_FAILS, SPIRAL_BOUND], "builder").split("\n\n").slice(1).join("\n\n")}`;
  assert.ok(hasHeading(rebuilt, HOW_IT_FAILS) && hasHeading(rebuilt, SPIRAL_BOUND));
});
