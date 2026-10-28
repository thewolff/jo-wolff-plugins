// The Stop check's pure half (skills/ask-graham/scripts/verdict.mjs) on hand-built transcripts in
// both shapes. It lives here, not beside verdict.mjs, because vocabulary.test.mjs keeps the old
// verdict word out of scripts/ and these cases need it, and because the skill directory is copied
// on its own (a personal skill install) where ../../../fixtures does not exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BLOCK_REASON, VERDICTS, askTurns, checkStop, currentTurn, findVerdict, lastAssistantText, parseJsonl, skillUse } from "./skills/ask-graham/scripts/verdict.mjs";
import { claudeCode, omp, SKILL_BODY } from "./fixtures/transcripts.mjs";

// --- findVerdict ------------------------------------------------------------------------------

test("findVerdict reads each verdict on a Verdict line, in the forms an answer writes it", () => {
  const cases = [
    ["**Verdict:** do it now", "do it now"],
    ["**Verdict:** start now. Waiting costs the launch.", "start now"],
    ["**Verdict:** later", "later"],
    ["**Verdict:** don't build", "don't build"],
    ["**Verdict:** don’t build", "don't build"],
    ["**Verdict:** Don't build (yet). The repo is empty.", "don't build"],
    ["**Verdict**: Later", "later"],
    ["Verdict: DO IT NOW", "do it now"],
    ["**Verdict:** **start now**", "start now"],
    ["- **Verdict:** later, once the API settles", "later"],
    ["Intro line.\n\n**Verdict:** do it now (under 2 min)\n\nWhy: …", "do it now"],
  ];
  for (const [text, want] of cases) assert.equal(findVerdict(text), want, text);
});

test("findVerdict ignores a missing label, other words, and the bare phrase in prose", () => {
  const cases = [
    "**Verdict:** backlog.",
    "**Verdict:** backlog, prioritize now",
    "Verdict later",
    "**Verdict:** laterally speaking",
    "We can do it later.",
    "My verdict is: do it now",
    "",
  ];
  for (const text of cases) assert.equal(findVerdict(text), null, text);
  assert.equal(findVerdict(undefined), null);
});

test("parseJsonl skips torn and non-object lines", () => {
  assert.deepEqual(parseJsonl('{"a":1}\n{"b":\n42\n\n{"c":3}\n'), [{ a: 1 }, { c: 3 }]);
});

// --- the same scenarios on both transcript shapes --------------------------------------------

const ANSWER = "Searched the repo; nothing like it exists.";

const HARNESSES = {
  "Claude Code": {
    make: claudeCode,
    // the agent loads the skill itself, with the ask as args
    read: (t) => t.skill("ask-graham:ask-graham", "should we build a cache"),
    // the person types the command: /ask-graham <args>
    invoke: (t, args) => t.slash("ask-graham:ask-graham", args),
  },
  OMP: {
    make: omp,
    read: (t) => t.read("skill://ask-graham"),
    invoke: (t, args) => t.skillPrompt("ask-graham", args),
  },
};

for (const [name, h] of Object.entries(HARNESSES)) {
  // One turn: a prompt, a skill read, and a final reply.
  const turn = (reply) => {
    const t = h.make();
    const opener = t.prompt("should we build a cache?");
    h.read(t);
    t.say(reply);
    return { t, opener };
  };

  test(`${name}: a skill read and a reply with each verdict passes`, () => {
    for (const v of ["do it now", "start now", "later", "don't build", "don’t build"]) {
      const { t } = turn(`${ANSWER}\n\n**Verdict:** ${v}`);
      assert.equal(checkStop({ entries: t.entries }).pass, "verdict", v);
    }
  });

  test(`${name}: waiting for the comparables answer passes without a verdict`, () => {
    const { t, opener } = turn(`${ANSWER}\n\nDo you want me to research and see if something comparable exists?`);
    assert.deepEqual(checkStop({ entries: t.entries }), { pass: "comparables-question", opener });
  });

  test(`${name}: the comparables answer turn reloads the skill and requires a verdict`, () => {
    for (const answer of ["yes", "no"]) {
      const { t, opener } = turn(`${ANSWER}\n\nDo you want me to research and see if something comparable exists?`);
      assert.deepEqual(checkStop({ entries: t.entries }), { pass: "comparables-question", opener });

      const resumed = t.prompt(answer);
      // The skill's resume instruction is the bridge to the existing per-turn checker.
      // Check that instruction too: a fixture reload alone would pass before the fix.
      h.read(t);
      assert.equal(skillUse(currentTurn(t.entries)).read, true);
      t.say("Here is the result for the same ask.");
      assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener: resumed });
      t.say("**Verdict:** later. Nothing gets worse while it waits.");
      assert.deepEqual(checkStop({ entries: t.entries }), { pass: "verdict", opener: resumed });
    }

    const skill = readFileSync(new URL("./skills/ask-graham/SKILL.md", import.meta.url), "utf8");
    assert.match(skill, /When the answer arrives, reload this skill through the host’s Skill or Read tool, then resume step 2 for the same ask\./);
  });

  test(`${name}: mentioning the comparables question does not excuse a missing verdict`, () => {
    for (const reply of [
      'The question was "Do you want me to research and see if something comparable exists?"',
      "> Do you want me to research and see if something comparable exists?",
      "Do you want me to research and see if something comparable exists?\nThe user said no; here is the result.",
    ]) {
      const { t } = turn(reply);
      assert.ok(checkStop({ entries: t.entries }).block, reply);
    }
  });

  // Every way a turn declares a structure check on this host (SKILL.md "When it runs").
  const DECLARE = {
    "Claude Code": {
      "Skill args": (t) => t.skill("ask-graham:ask-graham", "structure-check a new chart table"),
      "slash args": (t) => t.slash("ask-graham:ask-graham", "structure-check a new chart table"),
      "marker Read": (t) => { t.read("/p/ask-graham/structure-check.md"); t.read("/p/ask-graham/SKILL.md"); },
    },
    OMP: {
      "skill prompt args": (t) => t.skillPrompt("ask-graham", "structure-check a new chart table"),
      "marker read": (t) => { t.read("skill://ask-graham/structure-check.md"); t.read("skill://ask-graham"); },
    },
  }[name];
  const STRUCTURE_REPLY = "**Structure check:** dataviz_chart_decisions table\n\nParent search: found story_revisions.featured_quote_id.\n\n**Red flags:** a second pattern where one exists fires.";
  // A user-typed declaration (slash or skill prompt) opens its own turn, so the opener is read back.
  const structureTurn = (declare, reply) => {
    const t = h.make();
    t.prompt("add the chart table from the approved plan");
    declare(t);
    t.say(reply);
    return { t, opener: currentTurn(t.entries).id };
  };

  test(`${name}: a declared structure check passes without a verdict`, () => {
    for (const [how, declare] of Object.entries(DECLARE)) {
      const { t, opener } = structureTurn(declare, STRUCTURE_REPLY);
      assert.equal(skillUse(currentTurn(t.entries)).structureCheck, true, how);
      assert.deepEqual(checkStop({ entries: t.entries }), { pass: "structure-check", opener }, how);
    }
  });

  test(`${name}: an ordinary run that prints a structure check line still needs its verdict`, () => {
    for (const reply of [STRUCTURE_REPLY, "**Structure check:** cache"]) {
      const { t, opener } = turn(reply);
      assert.equal(skillUse(currentTurn(t.entries)).structureCheck, false);
      assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener }, reply);
    }
  });

  test(`${name}: a declared structure check plus an ordinary invocation in the same turn is an ordinary run`, () => {
    // The ordinary invocation first (a user-typed one opens the turn), then a marker read declares.
    const marker = name === "OMP" ? (u) => u.read("skill://ask-graham/structure-check.md") : (u) => u.read("/p/ask-graham/structure-check.md");
    const ordinary = name === "OMP" ? [(u) => h.invoke(u, "should we build a cache")] : [h.read, (u) => h.invoke(u, "should we build a cache")];
    for (const first of ordinary) {
      const { t, opener } = structureTurn((u) => { first(u); marker(u); }, STRUCTURE_REPLY);
      assert.equal(skillUse(currentTurn(t.entries)).structureCheck, false);
      assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener });
    }
  });

  const readSkill = name === "OMP" ? (u) => u.read("skill://ask-graham") : (u) => u.read("/p/ask-graham/SKILL.md");
  const readMarker = name === "OMP" ? (u) => u.read("skill://ask-graham/structure-check.md") : (u) => u.read("/p/ask-graham/structure-check.md");
  const WAIT = "Searched locally.\n\nDo you want me to research and see if something comparable exists?";

  test(`${name}: a full check loaded by reading SKILL.md cannot become a structure check by reading the marker`, () => {
    const t = h.make();
    const opener = t.prompt("should we build a cache?");
    readSkill(t);
    readMarker(t);
    t.say(STRUCTURE_REPLY);
    assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener });
  });

  test(`${name}: a full check's comparables continuation cannot become a structure check`, () => {
    const t = h.make();
    const first = t.prompt("should we build a cache?");
    readSkill(t);
    t.say(WAIT);
    assert.deepEqual(checkStop({ entries: t.entries }), { pass: "comparables-question", opener: first });
    const resumed = t.prompt("no");
    readMarker(t);
    readSkill(t);
    t.say(STRUCTURE_REPLY);
    assert.equal(askTurns(t.entries).length, 2);
    assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener: resumed });
  });

  test(`${name}: a structure check's comparables continuation stays one after reloading SKILL.md`, () => {
    for (const answer of ["no", "Yes", "yes please", "No, thanks.", "ok!"]) {
      const t = h.make();
      t.prompt("add the chart table from the approved plan");
      readMarker(t);
      readSkill(t);
      t.say(WAIT);
      const resumed = t.prompt(answer);
      readSkill(t);
      t.say(STRUCTURE_REPLY);
      assert.equal(askTurns(t.entries).length, 2, answer);
      assert.deepEqual(checkStop({ entries: t.entries }), { pass: "structure-check", opener: resumed }, answer);
    }
  });

  test(`${name}: a new topic after a structure check's comparables question is a new full check`, () => {
    for (const prompt of ["Forget the chart task. Should we build a new cache service instead?", "no, should we build a cache instead?"]) {
      const t = h.make();
      t.prompt("add the chart table from the approved plan");
      readMarker(t);
      readSkill(t);
      t.say(WAIT);
      const next = t.prompt(prompt);
      readSkill(t);
      t.say(STRUCTURE_REPLY);
      assert.equal(askTurns(t.entries).length, 1, prompt);
      assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener: next }, prompt);
    }
  });

  test(`${name}: a new structure task after a full check's comparables question is its own structure check`, () => {
    const t = h.make();
    t.prompt("should we build a cache?");
    readSkill(t);
    t.say(WAIT);
    const next = t.prompt("Forget the cache. Add the chart table from the approved plan.");
    readMarker(t);
    readSkill(t);
    t.say(STRUCTURE_REPLY);
    assert.equal(askTurns(t.entries).length, 1);
    assert.deepEqual(checkStop({ entries: t.entries }), { pass: "structure-check", opener: next });
  });

  test(`${name}: a turn after a verdict starts a new ask`, () => {
    const t = h.make();
    t.prompt("add the chart table from the approved plan");
    readMarker(t);
    t.say("**Verdict:** later");
    const next = t.prompt("now the cache");
    readSkill(t);
    t.say(STRUCTURE_REPLY);
    assert.equal(askTurns(t.entries).length, 1);
    assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener: next });
  });

  test(`${name}: in a declared structure check, the label must open the reply, bold, with text after it`, () => {
    for (const reply of [
      "**Structure check:**",
      "> **Structure check:** a new table",
      "This was not a **Structure check:** run.",
      "Structure check: a new table",
      "Normal check result.\n\n**Structure check:** cache\nNo verdict.",
      "Example output:\n```text\n**Structure check:** new table\n```\nNo verdict.",
      "```text\n**Structure check:** new table\n```",
    ]) {
      for (const [how, declare] of Object.entries(DECLARE)) {
        const { t, opener } = structureTurn(declare, reply);
        assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener }, `${how}: ${reply}`);
      }
    }
  });

  test(`${name}: a skill read and no verdict blocks, naming the four verdicts and the Verdict line`, () => {
    const { t, opener } = turn(ANSWER);
    const r = checkStop({ entries: t.entries });
    assert.deepEqual(r, { block: BLOCK_REASON, opener });
    for (const v of VERDICTS) assert.ok(r.block.includes(v), v);
    assert.ok(r.block.includes("**Verdict:**"));
  });

  test(`${name}: **Verdict:** backlog blocks`, () => {
    const { t } = turn(`${ANSWER}\n\n**Verdict:** backlog`);
    assert.ok(checkStop({ entries: t.entries }).block);
  });

  test(`${name}: a turn with no skill read passes`, () => {
    const t = h.make();
    t.prompt("fix the login bug");
    t.say("Fixed.");
    assert.equal(checkStop({ entries: t.entries }).pass, "no-skill-read");
  });

  test(`${name}: a settings invocation (intensity or stop-check) passes`, () => {
    for (const args of ["intensity", "intensity every-idea", "intensity ask --here", "stop-check", "stop-check off", "stop-check on --here"]) {
      const t = h.make();
      h.invoke(t, args);
      t.bash("node /plugins/ask-graham/skills/ask-graham/scripts/intensity.mjs");
      t.say("Intensity is ask (default).");
      assert.equal(checkStop({ entries: t.entries }).pass, "settings", args);
    }
  });

  test(`${name}: an ordinary invocation that also runs intensity.mjs still blocks`, () => {
    const t = h.make();
    const opener = h.invoke(t, "should we build a cache");
    t.bash("node /plugins/ask-graham/skills/ask-graham/scripts/intensity.mjs");
    t.say(ANSWER);
    assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener });
  });

  test(`${name}: an invoked check passes with its verdict`, () => {
    const t = h.make();
    h.invoke(t, "should we build a cache");
    t.say(`${ANSWER}\n\n**Verdict:** later`);
    assert.equal(checkStop({ entries: t.entries }).pass, "verdict");
  });

  test(`${name}: a skill read in an earlier turn does not flag this turn`, () => {
    const { t } = turn(ANSWER);
    const opener = t.prompt("thanks, now fix the login bug");
    t.say("Fixed.");
    assert.deepEqual(checkStop({ entries: t.entries }), { pass: "no-skill-read", opener });
  });

  test(`${name}: a skill read on an abandoned branch does not flag this turn`, () => {
    const t = h.make();
    t.prompt("hello");
    const fork = t.say("Hi.");
    t.prompt("should we build a cache?");
    h.read(t);
    t.say(ANSWER);
    t.at(fork); // the person rewinds to before that prompt and sends another
    const opener = t.prompt("fix the login bug instead");
    t.say("Fixed.");
    assert.deepEqual(checkStop({ entries: t.entries }), { pass: "no-skill-read", opener });
  });

  test(`${name}: the second stop in a turn after its own block passes; the next turn is checked again`, () => {
    const { t, opener } = turn(ANSWER);
    const first = checkStop({ entries: t.entries });
    assert.equal(first.opener, opener);
    assert.ok(first.block);
    // The agent's continuation still has no verdict: it passes, so the check cannot loop.
    if (name === "OMP") t.continuation(first.block);
    else t.stopSummary();
    t.say("Still thinking about it.");
    assert.deepEqual(checkStop({ entries: t.entries, blockedOpener: first.opener }), { pass: "already-blocked", opener });
    // A new turn that reads the skill again is blocked again.
    const next = t.prompt("and should we build a queue?");
    h.read(t);
    t.say(ANSWER);
    assert.deepEqual(checkStop({ entries: t.entries, blockedOpener: first.opener }), { block: BLOCK_REASON, opener: next });
  });

  test(`${name}: a stop after another hook's continuation, with no own block, still blocks`, () => {
    const { t, opener } = turn(ANSWER);
    if (name === "OMP") t.continuation("another extension's reason");
    else t.stopSummary();
    t.say("Done with the other hook's ask.");
    assert.deepEqual(checkStop({ entries: t.entries, blockedOpener: null }), { block: BLOCK_REASON, opener });
  });

  test(`${name}: the final text is the last assistant text on the turn unless given`, () => {
    const { t } = turn(`${ANSWER}\n\n**Verdict:** later`);
    assert.equal(checkStop({ entries: t.entries }).pass, "verdict");
    assert.ok(checkStop({ entries: t.entries, text: ANSWER }).block);
    assert.equal(checkStop({ entries: t.entries, text: "**Verdict:** start now" }).pass, "verdict");
  });

  test(`${name}: an empty transcript passes`, () => {
    assert.equal(checkStop({ entries: [] }).pass, "no-turn");
    assert.equal(checkStop({}).pass, "no-turn");
  });
}

// --- Claude Code specifics ---------------------------------------------------------------------

test("Claude Code: a Skill call by personal or plugin name counts, another skill does not", () => {
  for (const [skill, read] of [["ask-graham", true], ["ask-graham:ask-graham", true], ["other:ask-graham", true], ["ask-graham-lite", false], ["newdle:newdle", false]]) {
    const t = claudeCode();
    t.prompt("should we build a cache?");
    t.skill(skill);
    assert.equal(skillUse(currentTurn(t.entries)).read, read, skill);
  }
});

test("Claude Code: a /ask-graham slash command opens the turn; its isMeta skill body does not", () => {
  const t = claudeCode();
  const opener = t.slash("ask-graham", "should we build a cache");
  t.say(ANSWER);
  const turn = currentTurn(t.entries);
  assert.equal(turn.id, opener);
  assert.deepEqual(skillUse(turn), { read: true, settingsOnly: false, structureCheck: false });

  // the args are the slash command's: intensity args make the turn intensity-only
  const u = claudeCode();
  u.slash("ask-graham", "intensity every-idea");
  u.say("Intensity is every-idea.");
  assert.deepEqual(skillUse(currentTurn(u.entries)), { read: true, settingsOnly: true, structureCheck: false });
});

test("Claude Code: a Skill call with intensity args passes", () => {
  const t = claudeCode();
  t.prompt("/ask-graham intensity, please");
  t.skill("ask-graham:ask-graham", "intensity");
  t.say("Intensity is ask.");
  assert.equal(checkStop({ entries: t.entries }).pass, "settings");
});

test("Claude Code: /ask-graham intensity then an ordinary or arg-less Skill call blocks", () => {
  for (const args of ["should we build a cache", undefined]) {
    const t = claudeCode();
    const opener = t.slash("ask-graham", "intensity");
    t.skill("ask-graham:ask-graham", args);
    t.say(ANSWER);
    assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener }, String(args));
  }
});

test("Claude Code: an ordinary /ask-graham then a Skill call with intensity args blocks", () => {
  const t = claudeCode();
  const opener = t.slash("ask-graham", "should we build a cache");
  t.skill("ask-graham:ask-graham", "intensity");
  t.say(ANSWER);
  assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener });
});

test("Claude Code: /ask-graham intensity then a Read of SKILL.md blocks", () => {
  const t = claudeCode();
  const opener = t.slash("ask-graham", "intensity");
  t.read("/plugins/ask-graham/skills/ask-graham/SKILL.md");
  t.say(ANSWER);
  assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener });
});

test("Claude Code: /ask-graham intensity then a Skill call with intensity args still passes", () => {
  const t = claudeCode();
  const opener = t.slash("ask-graham", "intensity");
  t.skill("ask-graham:ask-graham", "intensity every-idea");
  t.say("Intensity is every-idea.");
  assert.deepEqual(checkStop({ entries: t.entries }), { pass: "settings", opener });
});

test("Claude Code: a Read of SKILL.md counts, a look-alike path does not", () => {
  for (const [path, read] of [
    ["/Users/me/.claude/skills/ask-graham/SKILL.md", true],
    ["/plugins/ask-graham/skills/ask-graham/SKILL.md", true],
    ["/plugins/x/skills/not-ask-graham/SKILL.md", false],
    ["/plugins/ask-graham/skills/ask-graham/references/graham-answers.md", false],
  ]) {
    const t = claudeCode();
    t.prompt("should we build a cache?");
    t.read(path);
    assert.equal(skillUse(currentTurn(t.entries)).read, read, path);
  }
});

test("Claude Code: a skill read in a parallel tool call off the leaf's chain still counts", () => {
  const t = claudeCode();
  const opener = t.prompt("should we build a cache?");
  t.parallel({ name: "Bash", input: { command: "ls" } }, { name: "Read", input: { file_path: "/p/ask-graham/SKILL.md" } });
  t.say(ANSWER);
  assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener });
});

test("Claude Code: a reply written in several entries of one response is read whole", () => {
  const t = claudeCode();
  t.prompt("should we build a cache?");
  t.skill();
  t.sayInParts("**Verdict:** start now", "Waiting costs the launch.");
  assert.equal(lastAssistantText(currentTurn(t.entries)), "**Verdict:** start now\nWaiting costs the launch.");
  assert.equal(checkStop({ entries: t.entries }).pass, "verdict");
});

test("Claude Code: sidechain entries are not the leaf", () => {
  const t = claudeCode();
  const opener = t.prompt("should we build a cache?");
  t.skill();
  t.say(ANSWER);
  t.entries.push({ uuid: "side-1", parentUuid: null, isSidechain: true, type: "user", message: { role: "user", content: "subagent task" } });
  assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener });
});

// --- OMP specifics -------------------------------------------------------------------------------

test("OMP: a mid-prompt /skill:ask-graham counts as the turn's opener and invocation", () => {
  const t = omp();
  const opener = t.skillPrompt("ask-graham", "should we build a cache", "should we build /skill:ask-graham a cache");
  t.say(ANSWER);
  assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener });
});

test("OMP: a namespaced skill prompt counts; its args come from details or the User: line", () => {
  const t = omp();
  t.skillPrompt("ns/ask-graham", "intensity");
  t.say("Intensity is ask.");
  assert.equal(checkStop({ entries: t.entries }).pass, "settings");

  const u = omp();
  const id = u.skillPrompt("ask-graham", "intensity every-idea");
  delete u.entries.find((e) => e.id === id).details.args;
  assert.deepEqual(skillUse(currentTurn(u.entries)), { read: true, settingsOnly: true, structureCheck: false });
});

test("OMP: /skill:ask-graham intensity then a read of the skill file blocks", () => {
  for (const path of ["skill://ask-graham", "/Users/me/.omp/skills/ask-graham/SKILL.md"]) {
    const t = omp();
    const opener = t.skillPrompt("ask-graham", "intensity");
    t.read(path);
    t.say(ANSWER);
    assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener }, path);
  }
});

// A typed /skill: opens its own turn on OMP, so currentTurn never holds two invocations; the
// every-use rule is checked on the invocations' entries directly.
test("OMP: skillUse is intensity-only only when every invocation is an intensity one", () => {
  for (const [first, second, settingsOnly] of [
    ["intensity", "should we build a cache", false],
    ["should we build a cache", "intensity", false],
    ["intensity", "", false],
    ["intensity", "intensity every-idea", true],
  ]) {
    const t = omp();
    t.skillPrompt("ask-graham", first);
    t.skillPrompt("ask-graham", second);
    assert.deepEqual(skillUse({ entries: t.entries }), { read: true, settingsOnly, structureCheck: false }, `${first} / ${second}`);
  }
});

test("OMP: an ordinary /skill:ask-graham after an intensity one is checked in its own turn", () => {
  const t = omp();
  t.skillPrompt("ask-graham", "intensity");
  t.say("Intensity is ask.");
  const opener = t.skillPrompt("ask-graham", "should we build a cache");
  t.say(ANSWER);
  assert.deepEqual(checkStop({ entries: t.entries }), { block: BLOCK_REASON, opener });
});

test("OMP: read paths that count and ones that do not", () => {
  for (const [path, read] of [
    ["skill://ask-graham", true],
    ["skill://ns/ask-graham", true],
    ["skill://ask-graham/SKILL.md", true],
    ["skill://ask-graham:1-40", true],
    ["/Users/me/.omp/skills/ask-graham/SKILL.md", true],
    ["skill://ask-graham-extra", false],
    ["skill://ask-graham/references/graham-answers.md", false],
    ["skill://paired-coding", false],
  ]) {
    const t = omp();
    t.prompt("should we build a cache?");
    t.read(path);
    assert.equal(skillUse(currentTurn(t.entries)).read, read, path);
  }
});

test("OMP: a skill body pasted into a prompt, or injected by the agent, is not a read", () => {
  const t = omp();
  t.prompt(`[IMPORTANT: User invoked the "ask-graham" skill; follow its instructions.]\n\n${SKILL_BODY}`);
  t.say(ANSWER);
  assert.equal(checkStop({ entries: t.entries }).pass, "no-skill-read");

  const u = omp();
  const opener = u.prompt("should we build a cache?");
  u.agentSkillPrompt("ask-graham");
  u.say(ANSWER);
  assert.deepEqual(checkStop({ entries: u.entries }), { pass: "no-skill-read", opener });
});

test("SKILL.md states the structure check's trigger, its no-verdict output, and the Stop check contract", () => {
  const skill = readFileSync(new URL("./skills/ask-graham/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /a new table, a new top-level module, or a new service, run step 2 \(with its parent search\) and step 4 only/);
  assert.match(skill, /under a first line `\*\*Structure check:\*\* <the new structure>`, with no verdict/);
  assert.match(skill, /The ask's first use of this skill declares it: loading this skill with the args `structure-check <the new structure>`, or reading \[`structure-check\.md`\]\(structure-check\.md\) before this file\./);
  assert.match(skill, /An ask whose first use was anything else \(reading this file, or invoking the skill with other args or none\) is a full check, and stays one through its comparables continuation\./);
  assert.match(skill, /The continuation is only a plain yes or no to the comparables question; any other prompt starts a new ask\./);
  assert.match(skill, /The Stop check accepts that first line in place of a verdict only in a structure check, and only when no ask-graham invocation in the ask had other args; a full check still needs its verdict\./);
  assert.match(skill, /A task inside a decided project that creates none of these three still gets no ask-graham output\. \(Skill\)/);
  assert.match(skill, /\*\*a second pattern where one exists\.\*\*[^\n]*\(Skill\)/);
});
