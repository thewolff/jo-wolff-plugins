// The verdict words are the skill's contract with whoever reads its answer, and the Stop check
// matches on them. SKILL.md's table and Output template must name exactly VERDICTS, and the old
// word "backlog" must not come back, except where Graham himself said "back log".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { VERDICTS } from "./skills/ask-graham/scripts/verdict.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const skill = read("./skills/ask-graham/SKILL.md");
const GRAHAM_4 = "its a task in the back log";

test("the step 5 table's verdicts are VERDICTS, in order", () => {
  const step5 = skill.split("### 5. Pick the verdict")[1].split("### 6.")[0];
  const cells = [...step5.matchAll(/^\| \*\*(.+?)\*\* \|/gm)].map((m) => m[1]);
  assert.deepEqual(cells, [...VERDICTS]);
});

test("the Output template's Verdict line names exactly VERDICTS", () => {
  const line = skill.match(/^\*\*Verdict:\*\* <one of the four verdicts: (.+?)>/m);
  assert.ok(line, "no **Verdict:** line in the Output template");
  assert.deepEqual(line[1].split(", "), [...VERDICTS]);
});

test("no 'backlog' in the skill, README, manifests, marketplace entries or scripts", () => {
  const scripts = readdirSync(new URL("./skills/ask-graham/scripts/", import.meta.url)).map(
    (f) => `./skills/ask-graham/scripts/${f}`,
  );
  const files = [
    "./skills/ask-graham/SKILL.md",
    "./README.md",
    "./package.json",
    "./.claude-plugin/plugin.json",
    "./.omp-plugin/plugin.json",
    ...scripts,
  ];
  for (const f of files) assert.doesNotMatch(read(f), /backlog/i, f);

  // The repository's two marketplace files list this plugin too; their entry is what a person
  // reads before installing. It names the four verdicts, and a version, if listed, is the plugin's.
  const { version } = JSON.parse(read("./.claude-plugin/plugin.json"));
  for (const f of ["../../.claude-plugin/marketplace.json", "../../.omp-plugin/marketplace.json"]) {
    const entry = JSON.parse(read(f)).plugins.find((p) => p.name === "ask-graham");
    assert.ok(entry, `${f}: no ask-graham entry`);
    assert.doesNotMatch(JSON.stringify(entry), /backlog/i, f);
    for (const v of VERDICTS) assert.ok(entry.description.includes(v), `${f}: description lacks "${v}"`);
    if ("version" in entry) assert.equal(entry.version, version, f);
  }
});

test("Graham's verbatim 'back log' stays in his answers and the skill's quote", () => {
  assert.ok(read("./skills/ask-graham/references/graham-answers.md").includes(GRAHAM_4));
  assert.ok(skill.includes(GRAHAM_4));
});
