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
  for (const row of ["database file missing", "database locked", "database read-only", "database corrupt, default path", "database corrupt, configured path", "config file unparsable", "unknown config key", "hook throws or stdin is not JSON", "hook times out", "switch off in config", "project not enabled"]) {
    assert.ok(readme.includes(`| ${row}`), row);
  }
});
