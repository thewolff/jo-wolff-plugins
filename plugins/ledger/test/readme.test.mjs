import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULTS } from "../lib/config.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function leafKeys(obj, prefix = "") {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) ? leafKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

test("example.config.json is DEFAULTS verbatim and the README config table lists exactly its keys", () => {
  const example = JSON.parse(readFileSync(join(root, "example.config.json"), "utf8"));
  assert.deepEqual(example, DEFAULTS);
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("\n## Config"), readme.indexOf("\n## Fail-open table"));
  const documented = [...section.matchAll(/^\| `([a-zA-Z.]+)` \| /gm)].map((m) => m[1]);
  assert.deepEqual(documented, leafKeys(example));
});

test("the README fail-open table has a row per condition", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  for (const row of ["database file missing", "database locked", "database read-only", "database corrupt, default path", "database corrupt, configured path", "config file unparsable", "unknown config key", "hook throws or stdin is not JSON", "hook times out", "switch off in config", "project disabled"]) {
    assert.ok(readme.includes(`| ${row}`), row);
  }
});

test("/ledger:enable and /ledger:disable run the CLI verb of the same name through the plugin root, and the README names both", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  for (const verb of ["enable", "disable"]) {
    const text = readFileSync(join(root, "skills", verb, "SKILL.md"), "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(front, `${verb}.md has frontmatter`);
    assert.match(front[1], new RegExp(`^name: ${verb}$`, "m"));
    assert.match(front[1], /^description: '.+'$/m);
    assert.ok(front[1].includes(`allowed-tools: Bash(node "\${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" ${verb})`), front[1]);
    assert.ok(text.includes(`!\`node "\${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" ${verb}\``), verb);
    assert.ok(readme.includes(`/ledger:${verb}`), `README mentions /ledger:${verb}`);
  }
});
