// rules.test.mjs — node --test
//
// lib/rules.mjs is the one definition of the eleven rules and the checks bound to them, so the
// first tests pin it to SKILL.md: a heading renamed in the skill and not here fails. Then
// compileCore, effectiveMode's rule binding, and loadSwitches' inject / linkTheReference shapes.
// loadSwitches logs through lib/state.mjs under $HOME, so HOME is a temp dir for this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES, RULE_IDS, CHECKS, CHECK_IDS, ruleRef, compileCore } from "./rules.mjs";
import { effectiveMode, loadSwitches } from "./config.mjs";
import { DEFAULT_KINDS } from "../checks/link-the-reference.mjs";

const SKILL = readFileSync(fileURLToPath(new URL("../skills/i-have-audhd/SKILL.md", import.meta.url)), "utf8");
const START = "\n<!-- inject:start -->\n";
const SPAN = SKILL.slice(SKILL.indexOf(START) + START.length, SKILL.indexOf("\n<!-- inject:end -->")).trim();

test("RULES matches SKILL.md's numbered headings and the injected rule list, in order", () => {
  const headings = [...SKILL.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => ({ number: Number(m[1]), heading: m[2] }));
  assert.deepEqual(headings, RULES.map(({ number, heading }) => ({ number, heading })));
  const listed = [...SPAN.matchAll(/^- (\d+)\. (.+)$/gm)].map((m) => ({ number: Number(m[1]), heading: m[2] }));
  assert.deepEqual(listed, headings);
  assert.equal(new Set(RULE_IDS).size, 11);
});

test("every core block in the injected span names a rule RULES knows", () => {
  for (const m of SPAN.matchAll(/^\*\*([^*]+) \(rule (\d+)\)\.\*\*/gm)) {
    assert.ok(RULES.some((r) => r.number === Number(m[2])), m[0]);
  }
});

test("every check is bound to a rule id, and ruleRef cites number and heading", () => {
  assert.equal(CHECK_IDS.length, 11);
  for (const [check, rule] of Object.entries(CHECKS)) assert.ok(RULE_IDS.includes(rule), check);
  assert.equal(ruleRef("link-the-reference"), "i-have-audhd rule 11, Machinery anchors");
  assert.equal(ruleRef("handed-command"), "i-have-audhd rule 10, Commands handed to the user");
  assert.equal(ruleRef("no-such-check"), "");
});

test("compileCore with nothing disabled returns the span unchanged", () => {
  assert.equal(compileCore(SPAN, new Set()), SPAN);
  assert.equal(compileCore(SPAN, undefined), SPAN);
});

test("compileCore drops a disabled rule's core block and its list line, and nothing else", () => {
  const out = compileCore(SPAN, new Set(["commands"]));
  assert.doesNotMatch(out, /\(rule 10\)/);
  assert.doesNotMatch(out, /Hand over only what you cannot run yourself/);
  assert.doesNotMatch(out, /^- 10\. /m);
  assert.match(out, /\*\*Machinery anchors \(rule 11\)\.\*\*/);
  assert.match(out, /^- 11\. Machinery anchors$/m);
  assert.match(out, /^- 9\. Durable means written$/m);
});

test("compileCore drops a multi-paragraph block whole: rule 1 takes every paragraph up to rule 4", () => {
  const out = compileCore(SPAN, new Set(["skeleton"]));
  assert.doesNotMatch(out, /Skeleton \(rule 1\)/);
  assert.doesNotMatch(out, /Break complex work into manageable steps/);
  assert.doesNotMatch(out, /the closing ask ends/);
  assert.match(out, /^\*\*Options \(rule 4\)\.\*\*/m);
  assert.match(out, /^\*\*Load the full `i-have-audhd` skill/);
});

test("a rule with no core block (rule 2) loses only its list line", () => {
  const out = compileCore(SPAN, new Set(["layer"]));
  assert.doesNotMatch(out, /^- 2\. Layer$/m);
  assert.equal(out.split("\n").length, SPAN.split("\n").length - 1);
});

test("every rule disabled leaves the opening line and no rule list", () => {
  const out = compileCore(SPAN, new Set(RULE_IDS));
  assert.doesNotMatch(out, /\(rule \d+\)/);
  assert.doesNotMatch(out, /Every rule, by heading/);
  assert.match(out, /^\*\*Load the full `i-have-audhd` skill/);
});

test("effectiveMode: a check bound to a disabled rule is off; its own rules entry wins; enforcement.mode does not", () => {
  const disabledRules = new Set(["commands"]);
  assert.equal(effectiveMode({ rules: {}, mode: null, disabledRules }, "handed-command"), "off");
  assert.equal(effectiveMode({ rules: {}, mode: "block", disabledRules }, "handed-command"), "off");
  assert.equal(effectiveMode({ rules: { "handed-command": "block" }, mode: null, disabledRules }, "handed-command"), "block");
  assert.equal(effectiveMode({ rules: {}, mode: null, disabledRules }, "needs-you-first"), "warn");
  assert.equal(effectiveMode({ rules: {}, mode: null }, "handed-command"), "warn", "no disabledRules: unchanged");
});

// ─── loadSwitches ────────────────────────────────────────────────────────────

const home = mkdtempSync(join(tmpdir(), "audhd-rules-"));
mkdirSync(join(home, ".claude"), { recursive: true });
process.env.HOME = home;
const errorsLog = join(home, ".claude", ".i-have-audhd-state", "errors.log");
const errorLines = () => (existsSync(errorsLog) ? readFileSync(errorsLog, "utf8").trim().split("\n").filter(Boolean) : []);

function switchesFor(profile) {
  const path = join(home, `profile-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(profile));
  const before = errorLines().length;
  const s = loadSwitches(path);
  return { ...s, logged: errorLines().slice(before) };
}

test("inject string form: the mode, every rule on, nothing logged", () => {
  for (const mode of ["full", "rules", "none"]) {
    const s = switchesFor({ inject: mode });
    assert.equal(s.inject, mode);
    assert.equal(s.disabledRules.size, 0);
    assert.deepEqual(s.logged, []);
  }
});

test("inject object form: mode defaults to full, false rules are disabled, true rules stay on", () => {
  const s = switchesFor({ inject: { rules: { commands: false, layer: true, "machinery-anchors": false } } });
  assert.equal(s.inject, "full");
  assert.deepEqual([...s.disabledRules].sort(), ["commands", "machinery-anchors"]);
  assert.deepEqual(s.logged, []);
  const n = switchesFor({ inject: { mode: "none", rules: { resume: false } } });
  assert.equal(n.inject, "none");
  assert.deepEqual([...n.disabledRules], ["resume"]);
});

test("a malformed inject is one errors.log line and the defaults: full, every rule on", () => {
  const bad = [
    7,
    ["full"],
    null,
    { mode: "some" },
    { mode: "full", rules: ["commands"] },
    { rules: { commands: "no" } },
    { rules: { "rule-10": false } },
    { rules: { commands: false }, extra: 1 },
    { rules: { commands: false, layer: "x", nope: true } },
  ];
  for (const inject of bad) {
    const s = switchesFor({ inject });
    assert.equal(s.inject, "full", JSON.stringify(inject));
    assert.equal(s.disabledRules.size, 0, JSON.stringify(inject));
    assert.equal(s.logged.length, 1, JSON.stringify(inject));
    assert.match(s.logged[0], /lib\/config\.mjs inject: .*full with every rule on applies$/);
  }
});

test("linkTheReference.kinds overrides kinds one by one; a malformed value is one line and the defaults", () => {
  const on = switchesFor({ linkTheReference: { kinds: { artifact: true } } });
  assert.deepEqual(on.linkKinds, { ...DEFAULT_KINDS, artifact: true });
  assert.deepEqual(on.logged, []);
  for (const linkTheReference of [true, { kinds: { artifact: "yes" } }, { kinds: { nope: true } }, { kind: {} }]) {
    const s = switchesFor({ linkTheReference });
    assert.deepEqual(s.linkKinds, DEFAULT_KINDS, JSON.stringify(linkTheReference));
    assert.equal(s.logged.length, 1, JSON.stringify(linkTheReference));
    assert.match(s.logged[0], /linkTheReference is not/);
  }
});
