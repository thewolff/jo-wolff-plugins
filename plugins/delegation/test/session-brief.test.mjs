// test/session-brief.test.mjs — the pure half of the session-brief gate (lib/brief.mjs):
// which of the five headings a `start_session` prompt lacks, and the deny and warn texts; then
// hooks/session-brief-gate.mjs spawned on the captured desktop payload (test/fixtures/start-session.json).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { box, runHook, setConfig, skippedLog, PLUGIN_ROOT } from "./helpers.mjs";
import { ACCEPTANCE, CHANGE, HOW_IT_FAILS, HOW_IT_FAILS_SECTION, missingSessionHeadings, SESSION_HEADINGS, sessionHeadingReason, sessionHeadingWarning, SPIRAL_BOUND, SPIRAL_BOUND_SECTION, START_SESSION_TOOL, TARGET, TARGET_SECTION, TEMPLATE } from "../lib/brief.mjs";

const FULL_SESSION_BRIEF = "# Target\nthe repo\n\n# Change\n1. do it\n\n# Acceptance\n`node --test` green\n\n## How it fails\n- it breaks\n\n## Spiral bound\n- one retry\n";

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

// ---- the hook, spawned end-to-end through lib/hook-runner.mjs ----

const fixture = () => JSON.parse(readFileSync(join(PLUGIN_ROOT, "test", "fixtures", "start-session.json"), "utf8"));
const withInput = (patch) => {
  const p = fixture();
  delete p.$comment;
  p.tool_input = { ...p.tool_input, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete p.tool_input[k];
  return p;
};
const denyOf = (r) => (r.out?.hookSpecificOutput?.permissionDecision === "deny" ? r.out.hookSpecificOutput.permissionDecisionReason : null);

test("session-brief-gate: the captured thin prompt is denied, the reason lists all five headings and carries their sections", (t) => {
  const { env } = box(t);
  const r = runHook("session-brief-gate", withInput({}), env);
  assert.equal(r.status, 0);
  assert.equal(r.out.hookSpecificOutput.hookEventName, "PreToolUse");
  const reason = denyOf(r);
  assert.match(reason ?? "", /^Session start refused: the prompt lacks the heading lines "## Target", "## Change", "## Acceptance", "## How it fails", "## Spiral bound"\./);
  assert.ok(reason.endsWith(SPIRAL_BOUND_SECTION));
  assert.ok(r.ms < 4000, `took ${r.ms} ms`);
});

test("session-brief-gate: a full brief is silent; text on a heading line is denied for that heading alone", (t) => {
  const { env } = box(t);
  assert.equal(runHook("session-brief-gate", withInput({ prompt: FULL_SESSION_BRIEF }), env).out, null);
  const r = denyOf(runHook("session-brief-gate", withInput({ prompt: FULL_SESSION_BRIEF.replace("# Target\n", "# Target: the repo\n") }), env));
  assert.match(r, /lacks the heading line "## Target"\./);
  assert.equal(skippedLog(env), "");
});

test("session-brief-gate: proposal_id with no prompt (starting an offered card) is silent, with no skipped.log line", (t) => {
  const { env } = box(t);
  const p = fixture();
  p.tool_input = { proposal_id: "task_fixture1" };
  assert.equal(runHook("session-brief-gate", p, env).out, null);
  assert.equal(skippedLog(env), "");
});

test("session-brief-gate: a non-string or missing prompt, or no tool_input, is allowed with one skipped.log line each", (t) => {
  const { env } = box(t);
  for (const prompt of [42, null, { text: "x" }]) assert.equal(runHook("session-brief-gate", withInput({ prompt }), env).out, null, String(prompt));
  assert.equal(runHook("session-brief-gate", withInput({ prompt: undefined }), env).out, null);
  const none = fixture();
  delete none.tool_input;
  assert.equal(runHook("session-brief-gate", none, env).out, null);
  const lines = skippedLog(env).split("\n").filter(Boolean);
  assert.equal(lines.length, 5, lines.join("\n"));
  for (const l of lines) assert.match(l, /session-brief-gate tool mcp__ccd_session__start_session: tool_input\.prompt is not a string; session start allowed unchecked/);
});

test("session-brief-gate: checks warn gives one additionalContext line and no deny; off and off:true are silence; another tool is ignored", (t) => {
  const { env } = box(t);
  setConfig(env, { checks: { "session-brief-gate": "warn" } });
  const w = runHook("session-brief-gate", withInput({}), env);
  assert.equal(w.out.hookSpecificOutput.permissionDecision, undefined);
  assert.match(w.out.hookSpecificOutput.additionalContext, /^delegation: this `mcp__ccd_session__start_session` prompt lacks the heading lines/);
  setConfig(env, { checks: { "session-brief-gate": "off" } });
  assert.equal(runHook("session-brief-gate", withInput({}), env).out, null);
  setConfig(env, { off: true });
  assert.equal(runHook("session-brief-gate", withInput({}), env).out, null);
  setConfig(env, {});
  assert.equal(runHook("session-brief-gate", { ...withInput({}), tool_name: "Agent" }, env).out, null);
});

test("session-brief-gate: a malformed config still denies on the defaults and says so in a systemMessage", (t) => {
  const { env } = box(t, { config: "{ nope" });
  const r = runHook("session-brief-gate", withInput({}), env);
  assert.ok(denyOf(r));
  assert.match(r.out.systemMessage, /delegation session-brief-gate: config ignored: .*config\.json is not JSON/);
});
