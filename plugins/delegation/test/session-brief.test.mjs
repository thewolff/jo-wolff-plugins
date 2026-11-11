// test/session-brief.test.mjs — the pure half of the session-brief gate (lib/brief.mjs):
// which of the five headings a `start_session` prompt lacks, and the deny and warn texts.

import test from "node:test";
import assert from "node:assert/strict";
import { ACCEPTANCE, CHANGE, HOW_IT_FAILS, HOW_IT_FAILS_SECTION, missingSessionHeadings, SESSION_HEADINGS, sessionHeadingReason, sessionHeadingWarning, SPIRAL_BOUND, SPIRAL_BOUND_SECTION, START_SESSION_TOOL, TARGET, TARGET_SECTION, TEMPLATE } from "../lib/brief.mjs";

export const FULL_SESSION_BRIEF = "# Target\nthe repo\n\n# Change\n1. do it\n\n# Acceptance\n`node --test` green\n\n## How it fails\n- it breaks\n\n## Spiral bound\n- one retry\n";

test("missingSessionHeadings: a full brief lacks nothing; each heading removed in turn is the one reported", () => {
  assert.deepEqual(SESSION_HEADINGS, [TARGET, CHANGE, ACCEPTANCE, HOW_IT_FAILS, SPIRAL_BOUND]);
  assert.deepEqual(missingSessionHeadings(FULL_SESSION_BRIEF), []);
  for (const h of SESSION_HEADINGS) {
    const without = FULL_SESSION_BRIEF.split("\n").filter((l) => !l.endsWith(` ${h}`)).join("\n");
    assert.deepEqual(missingSessionHeadings(without), [h], h);
  }
});

test("missingSessionHeadings: any level, any case, a parenthetical or trailing colon count; text on the heading line, a bold label, a fenced heading and a plural do not", () => {
  assert.deepEqual(missingSessionHeadings("## target\n### CHANGE:\n# Acceptance (parent)\n## How it fails (builder)\n#### Spiral bound ##\n"), []);
  assert.deepEqual(missingSessionHeadings(FULL_SESSION_BRIEF.replace("# Target\n", "# Target: the delegation plugin\n")), [TARGET]);
  assert.deepEqual(missingSessionHeadings(FULL_SESSION_BRIEF.replace("# Target\n", "**Target**: x\n")), [TARGET]);
  assert.deepEqual(missingSessionHeadings(FULL_SESSION_BRIEF.replace("# Target\n", "# Targets\n")), [TARGET]);
  assert.deepEqual(missingSessionHeadings(FULL_SESSION_BRIEF.replace("# Target\n", "```\n# Target\n```\n")), [TARGET]);
});

test("missingSessionHeadings: a non-string prompt lacks all five and never throws", () => {
  for (const v of [undefined, null, 42, {}, ["# Target"]]) assert.deepEqual(missingSessionHeadings(v), [...SESSION_HEADINGS]);
});

test("sessionHeadingReason: starts `Session start refused:`, names the tool and the missing headings, says the heading line is bare, and carries each missing section in order", () => {
  const r = sessionHeadingReason([TARGET, HOW_IT_FAILS]);
  assert.match(r, /^Session start refused: the prompt lacks the heading lines "## Target", "## How it fails"\. /);
  assert.ok(r.includes(`\`${START_SESSION_TOOL}\``));
  assert.ok(r.includes("Each heading line holds the heading alone, as `## Target` with the repository on the line under it."));
  assert.ok(r.includes("re-issue it as an offer"));
  assert.ok(r.includes(TEMPLATE));
  assert.ok(r.endsWith(`\n\n${TARGET_SECTION}\n\n${HOW_IT_FAILS_SECTION}`), r);
  assert.ok(!r.includes(SPIRAL_BOUND_SECTION));
  assert.match(sessionHeadingReason([SPIRAL_BOUND]), /lacks the heading line "## Spiral bound"\. .* plus the section below/);
});

test("a prompt whose only heading had text on its line passes once the refusal's section is added", () => {
  const thin = "# Target: the repo\nfix it";
  const missing = missingSessionHeadings(thin);
  assert.deepEqual(missing, [...SESSION_HEADINGS]);
  const rebuilt = `${thin}\n\n${sessionHeadingReason(missing).split("\n\n").slice(1).join("\n\n")}`;
  assert.deepEqual(missingSessionHeadings(rebuilt), []);
});

test("sessionHeadingWarning: names the tool and the missing headings, says the call goes ahead and what the repair is", () => {
  const w = sessionHeadingWarning([HOW_IT_FAILS, SPIRAL_BOUND]);
  assert.match(w, /^delegation: this `mcp__ccd_session__start_session` prompt lacks the heading lines "## How it fails", "## Spiral bound"\. The session start goes ahead;/);
  assert.ok(w.includes(TEMPLATE));
});
