// Every SKILL.md here has to upload to claude.ai, which rejects any top-level frontmatter key outside
// name, description, license, compatibility, metadata and allowed-tools
// (https://code.claude.com/docs/en/skills, "Using skill frontmatter outside Claude Code"). The name,
// description, compatibility and metadata limits are the Agent Skills spec's
// (https://agentskills.io/specification).
//
// The frontmatter is parsed by a strict reader for the YAML subset these files use: top-level
// `key: value` lines, quoted or plain scalars, `|`/`>` block scalars, and one level of nested map.
// Anything outside that subset fails the test rather than being guessed at, so a broken edit cannot
// pass as valid.
//
// Run as `node --test skills.test.mjs`: the vendored skills carry their own bun tests under
// skills/*/test/, which a bare `node --test` would try to run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("./", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const readJson = (p) => JSON.parse(read(p));

const ALLOWED = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/;
const NESTED_LINE = /^  ([A-Za-z_][A-Za-z0-9_.-]*):(?: (.*))?$/;

function scalar(raw, where) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(v)) throw new Error(`${where}: unterminated double-quoted string`);
    return { value: JSON.parse(v), plain: false };
  }
  if (v.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(v)) throw new Error(`${where}: unterminated single-quoted string`);
    return { value: v.slice(1, -1).replaceAll("''", "'"), plain: false };
  }
  if (/^[[\]{}&*!|>%@`#,?-](\s|$)|^[[{&*!%@`]/.test(v)) {
    throw new Error(`${where}: value starts with a YAML indicator; quote it`);
  }
  if (v.includes(": ") || v.includes(" #")) throw new Error(`${where}: plain value contains ": " or " #"; quote it`);
  return { value: v, plain: true };
}

function blockScalar(indicator, lines, i, where) {
  const body = [];
  while (i < lines.length && (lines[i] === "" || lines[i].startsWith("  "))) body.push(lines[i++]);
  while (body.length && body.at(-1) === "") body.pop();
  if (body.length === 0) throw new Error(`${where}: empty block scalar`);
  const indent = Math.min(...body.filter(Boolean).map((l) => l.match(/^ */)[0].length));
  const text = body.map((l) => l.slice(indent));
  const folded = indicator.startsWith(">");
  const joined = folded ? text.join("\n").replace(/([^\n])\n(?=[^\n ])/g, "$1 ") : text.join("\n");
  return { value: indicator.endsWith("-") ? joined : `${joined}\n`, next: i };
}

function parseFrontmatter(src, where) {
  const lines = src.split("\n");
  if (lines[0] !== "---") throw new Error(`${where}: first line is not ---`);
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error(`${where}: no closing ---`);
  const fm = lines.slice(1, end);
  const out = {};
  let i = 0;
  while (i < fm.length) {
    const line = fm[i];
    if (line.trim() === "" || line.startsWith("#")) { i++; continue; }
    const m = KEY_LINE.exec(line);
    if (!m) throw new Error(`${where}: line ${i + 2} is not a top-level key: ${JSON.stringify(line)}`);
    const [, key, rest = ""] = m;
    if (Object.hasOwn(out, key)) throw new Error(`${where}: duplicate key ${key}`);
    const at = `${where} ${key}`;
    i++;
    if (/^[|>]-?$/.test(rest.trim())) {
      const b = blockScalar(rest.trim(), fm, i, at);
      out[key] = b.value;
      i = b.next;
    } else if (rest.trim() === "") {
      const map = {};
      while (i < fm.length && fm[i].startsWith("  ")) {
        const n = NESTED_LINE.exec(fm[i]);
        if (!n) throw new Error(`${at}: line ${i + 2} is not a nested "key: value": ${JSON.stringify(fm[i])}`);
        if (Object.hasOwn(map, n[1])) throw new Error(`${at}: duplicate key ${n[1]}`);
        const s = scalar(n[2] ?? "", `${at}.${n[1]}`);
        if (s.plain && /^(?:[-+]?\d[\d_]*(?:\.\d*)?(?:e[-+]?\d+)?|true|false|null|~|yes|no|on|off)$/i.test(s.value)) {
          throw new Error(`${at}.${n[1]}: ${s.value} would parse as a non-string; quote it`);
        }
        map[n[1]] = s.value;
        i++;
      }
      if (Object.keys(map).length === 0) throw new Error(`${at}: key with no value`);
      out[key] = map;
    } else {
      out[key] = scalar(rest, at).value;
    }
  }
  return out;
}

const skillDirs = readdirSync(new URL("./skills/", root), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

test("both manifests carry the same name and version", () => {
  const claude = readJson("./.claude-plugin/plugin.json");
  const omp = readJson("./.omp-plugin/plugin.json");
  const pkg = readJson("./package.json");
  assert.equal(claude.name, "as2-skills");
  assert.equal(omp.name, claude.name);
  assert.equal(omp.version, claude.version);
  assert.equal(pkg.name, claude.name);
  assert.equal(pkg.version, claude.version);
});

test("the plugin ships the 22 vendored skills, each with a SKILL.md", () => {
  assert.equal(skillDirs.length, 22);
  for (const dir of skillDirs) assert.ok(existsSync(new URL(`./skills/${dir}/SKILL.md`, root)), dir);
});

for (const dir of skillDirs) {
  test(`skills/${dir}/SKILL.md frontmatter uploads to claude.ai`, () => {
    const fm = parseFrontmatter(read(`./skills/${dir}/SKILL.md`), `skills/${dir}/SKILL.md`);
    const extra = Object.keys(fm).filter((k) => !ALLOWED.has(k));
    assert.deepEqual(extra, [], `keys outside the six claude.ai accepts: ${extra.join(", ")}`);

    assert.equal(fm.name, dir, "name matches the directory");
    assert.ok(fm.name.length <= 64, "name is at most 64 characters");
    assert.match(fm.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, "name is lowercase letters, digits and single hyphens");

    assert.equal(typeof fm.description, "string");
    assert.ok(fm.description.trim().length > 0, "description is non-empty");
    assert.ok(fm.description.length <= 1024, `description is ${fm.description.length} characters, over 1024`);

    if ("compatibility" in fm) {
      assert.equal(typeof fm.compatibility, "string");
      assert.ok(fm.compatibility.length <= 500, "compatibility is at most 500 characters");
    }
    if ("license" in fm) assert.equal(typeof fm.license, "string");
    if ("metadata" in fm) {
      assert.equal(typeof fm.metadata, "object", "metadata is a map");
      for (const [k, v] of Object.entries(fm.metadata)) assert.equal(typeof v, "string", `metadata.${k} is a string`);
    }
  });
}

test("the reader rejects what it does not understand", () => {
  assert.throws(() => parseFrontmatter("---\nname: x\nversion\n---\n", "t"));
  assert.throws(() => parseFrontmatter("---\nname: x\nname: y\n---\n", "t"));
  assert.throws(() => parseFrontmatter("---\nname: x\ndescription: a: b\n---\n", "t"));
  assert.throws(() => parseFrontmatter('---\ndescription: "open\n---\n', "t"));
  assert.throws(() => parseFrontmatter("---\nmetadata:\n  version: 1.0\n---\n", "t"));
  assert.throws(() => parseFrontmatter("name: x\n", "t"));
  assert.deepEqual(parseFrontmatter("---\ndescription: >-\n  a\n  b\nmetadata:\n  v: \"1\"\n---\n", "t"), {
    description: "a b",
    metadata: { v: "1" },
  });
});

// Every `. "…"` / `source "…"` line in a skill's shell scripts has to land on a file inside that same
// skill directory: a skill is uploaded to claude.ai and installed on its own, so a sourced file
// anywhere else (the plugin root, a sibling skill, the newdle monolith) is missing on first use.
// The resolver understands exactly the forms these scripts use, a path built on a variable the
// script sets to `$(cd "$(dirname "${BASH_SOURCE[0]}")<rel>" && pwd)`, or on that `dirname`
// expression itself. Any other form fails the test rather than being guessed at.
const pluginDir = fileURLToPath(root);
const SOURCE_LINE = /^\s*(?:\.|source)\s+(.+?)\s*(?:#.*)?$/;
const DIR_ASSIGN = /^\s*([A-Za-z_][A-Za-z0-9_]*)="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)([^"]*)" && pwd\)"\s*$/;
const SCRIPT_DIR_EXPR = '$(dirname "${BASH_SOURCE[0]}")';

function resolveSources(src, scriptPath) {
  const here = dirname(scriptPath);
  const vars = new Map();
  const out = [];
  src.split("\n").forEach((line, i) => {
    const assign = DIR_ASSIGN.exec(line);
    if (assign) vars.set(assign[1], resolve(here + assign[2]));
    const m = SOURCE_LINE.exec(line);
    if (!m) return;
    const where = `${scriptPath}:${i + 1}`;
    const arg = m[1];
    if (!/^"[^"]*"$/.test(arg) && !arg.startsWith(`"${SCRIPT_DIR_EXPR}`)) throw new Error(`${where}: unquoted source path ${arg}`);
    const body = arg.slice(1, -1);
    let base, rest;
    if (body.startsWith(SCRIPT_DIR_EXPR)) {
      base = here;
      rest = body.slice(SCRIPT_DIR_EXPR.length);
    } else {
      const v = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(\/.*)$/.exec(body);
      if (!v || !vars.has(v[1] ?? v[2])) throw new Error(`${where}: cannot resolve ${arg}`);
      base = vars.get(v[1] ?? v[2]);
      rest = v[3];
    }
    if (rest.includes("$")) throw new Error(`${where}: cannot resolve ${arg}`);
    out.push({ where, target: resolve(base + rest) });
  });
  return out;
}

function shellScripts(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === "node_modules" ? [] : shellScripts(p);
    if (/\.(?:sh|bash)$/.test(d.name)) return [p];
    return /^#!.*\b(?:ba)?sh\b/.test(readFileSync(p, "utf8").slice(0, 64)) ? [p] : [];
  });
}

const inside = (child, parent) => child === parent || child.startsWith(parent + sep);

test("every sourced shell file resolves to a file inside its own skill directory", () => {
  const scripts = shellScripts(join(pluginDir, "skills"));
  assert.ok(scripts.length > 0, "found no shell scripts to check");
  let checked = 0;
  for (const script of scripts) {
    const skillDir = join(pluginDir, "skills", relative(join(pluginDir, "skills"), script).split(sep)[0]);
    for (const { where, target } of resolveSources(readFileSync(script, "utf8"), script)) {
      const shown = relative(pluginDir, target);
      assert.ok(inside(target, skillDir), `${relative(pluginDir, where)} sources ${shown}, outside ${relative(pluginDir, skillDir)}`);
      assert.ok(existsSync(target) && statSync(target).isFile(), `${relative(pluginDir, where)} sources ${shown}, which does not exist`);
      checked++;
    }
  }
  // triad-fanout.sh and quorum-fanout.sh each source lib/leg-runner.sh; a resolver that matched
  // nothing would pass vacuously.
  assert.ok(checked >= 2, `checked ${checked} source lines, expected at least the two leg-runner lines`);
});

test("the source resolver reports what it cannot follow", () => {
  const s = "/p/skills/x/references/t/scripts/run.sh";
  const dirLine = 'SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"';
  assert.deepEqual(resolveSources(`${dirLine}\n. "$SKILL_DIR/../../lib/a.sh"\n`, s), [
    { where: `${s}:2`, target: "/p/skills/x/lib/a.sh" },
  ]);
  assert.deepEqual(resolveSources('source "$(dirname "${BASH_SOURCE[0]}")/b.sh"\n', s), [
    { where: `${s}:1`, target: "/p/skills/x/references/t/scripts/b.sh" },
  ]);
  assert.throws(() => resolveSources('. "$UNSET_DIR/a.sh"\n', s), /cannot resolve/);
  assert.throws(() => resolveSources(". lib/a.sh\n", s), /unquoted/);
  assert.throws(() => resolveSources(`${dirLine}\n. "$SKILL_DIR/$OTHER/a.sh"\n`, s), /cannot resolve/);
});
