// test/model-routing.test.mjs — the routing table (lib/model-routing.json through
// lib/model-routing.mjs) and the spawn gate's warn-only model line, the hook spawned end-to-end
// through lib/hook-runner.mjs. The line is never a deny, and the heading and receipt refusals
// are what they were whatever the model says.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { box, gitRepo, runHook, setConfig, skippedLog, spawnPayload, HOW_ONLY, PLUGIN_ROOT } from "./helpers.mjs";
import { checkTable, loadTable, modelFamily, routingOutcome, routingWarning, TABLE_URL } from "../lib/model-routing.mjs";
import { HOW_IT_FAILS_SECTION, SPIRAL_BOUND_SECTION } from "../lib/brief.mjs";

const deny = (r) => (r.out?.hookSpecificOutput?.permissionDecision === "deny" ? r.out.hookSpecificOutput.permissionDecisionReason : null);
const line = (r) => r.out?.hookSpecificOutput?.additionalContext ?? null;

function repoWithReceipt(env, session = "s-test-1") {
  const repo = gitRepo(join(env.HOME, "repo"), env);
  mkdirSync(join(repo, ".pattern-check"), { recursive: true });
  writeFileSync(join(repo, ".pattern-check", `${session}.md`), "# receipt\n");
  return repo;
}

// ---- lib/model-routing.mjs ----

test("the shipped table loads, ranks haiku < sonnet < opus < fable, and lists every agent this plugin ships with its model at or under its ceiling", () => {
  const { table, fault } = loadTable();
  assert.equal(fault, null);
  assert.deepEqual(table.order, ["haiku", "sonnet", "opus", "fable"]);
  for (const name of ["auditor", "builder", "changelog", "checker", "debugger", "planner", "reader", "research", "scout", "storyteller", "summarizer"]) {
    const row = table.agents[name];
    assert.ok(row, `${name} is not in the table`);
    assert.ok(table.order.indexOf(row.model) <= table.order.indexOf(row.ceiling), name);
  }
  assert.deepEqual(table.agents.reader, { model: "sonnet", ceiling: "sonnet" });
  assert.ok(TABLE_URL.pathname.endsWith("/lib/model-routing.json"));
});

test("the reader agent's definition pins the table's model for reader (the pilot)", () => {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(join(PLUGIN_ROOT, "agents", "reader.md"), "utf8"))[1];
  assert.match(fm, new RegExp(`^model: ${loadTable().table.agents.reader.model}$`, "m"));
});

test("loadTable and checkTable never throw: a missing file, text that is not JSON and each malformed shape is a fault and no table", (t) => {
  const { root } = box(t);
  // Every load fault names the file, so the skipped.log line says which file to repair.
  const at = (name) => join(root, name);
  assert.equal(loadTable(pathToFileURL(at("nope.json"))).fault, `the routing table ${at("nope.json")} cannot be read (ENOENT)`);
  writeFileSync(at("bad.json"), "{ nope");
  const bad = loadTable(pathToFileURL(at("bad.json")));
  assert.equal(bad.table, null);
  assert.ok(bad.fault.startsWith(`the routing table ${at("bad.json")} is not JSON (`), bad.fault);
  writeFileSync(at("shape.json"), JSON.stringify({ order: ["haiku"], agents: { scout: { model: "opus", ceiling: "opus" } } }));
  const shape = loadTable(pathToFileURL(at("shape.json")));
  assert.equal(shape.table, null);
  assert.equal(shape.fault, `the routing table ${at("shape.json")}: agents.scout needs a \`model\` and a \`ceiling\` from \`order\``);
  writeFileSync(at("good.json"), JSON.stringify({ order: ["haiku"], agents: { scout: { model: "haiku", ceiling: "haiku" } } }));
  assert.deepEqual(loadTable(pathToFileURL(at("good.json"))), { table: { order: ["haiku"], agents: { scout: { model: "haiku", ceiling: "haiku" } } }, fault: null });
  const order = ["haiku", "sonnet"];
  for (const [shape, why] of [
    [null, /not a JSON object/],
    [[], /not a JSON object/],
    [{ agents: {} }, /`order` must be/],
    [{ order: [], agents: {} }, /`order` must be/],
    [{ order: ["Haiku"], agents: {} }, /`order` must be/],
    [{ order: ["haiku", "haiku"], agents: {} }, /twice/],
    [{ order }, /`agents` must be an object/],
    [{ order, agents: { scout: "haiku" } }, /agents\.scout needs/],
    [{ order, agents: { scout: { model: "haiku", ceiling: "opus" } } }, /agents\.scout needs/],
    [{ order, agents: { scout: { model: "sonnet", ceiling: "haiku" } } }, /above its ceiling/],
  ]) {
    const r = checkTable(shape);
    assert.equal(r.table, null, JSON.stringify(shape));
    assert.match(r.fault, why, JSON.stringify(shape));
  }
  assert.deepEqual(checkTable({ order, agents: { " Scout ": { model: "haiku", ceiling: "sonnet", note: "x" } } }).table.agents, { scout: { model: "haiku", ceiling: "sonnet" } });
});

test("modelFamily reads an alias, a full model id and a suffixed alias; anything else is null", () => {
  const order = ["haiku", "sonnet", "opus", "fable"];
  assert.equal(modelFamily("sonnet", order), "sonnet");
  assert.equal(modelFamily("claude-opus-5-5", order), "opus");
  assert.equal(modelFamily("Sonnet[1m]", order), "sonnet");
  for (const m of ["inherit", "", "gpt-9", "opus-or-sonnet", 7, null, undefined, {}]) assert.equal(modelFamily(m, order), null, String(m));
});

test("routingWarning: at or under the ceiling is nothing, above it and a missing model are one line each, an unlisted type and an unreadable model are nothing", () => {
  const { table } = loadTable();
  const none = { warning: null, skipped: null };
  assert.deepEqual(routingWarning(table, "reader", "sonnet"), none);
  assert.deepEqual(routingWarning(table, "reader", "haiku"), none);
  assert.deepEqual(routingWarning(table, "builder", "claude-opus-5-5"), none);
  assert.equal(routingWarning(table, "plugin:Reader", "opus").warning, 'delegation model routing (warn-only): this "plugin:Reader" spawn asks for opus; the routing table\'s ceiling for reader is sonnet. The spawn proceeds.');
  assert.match(routingWarning(table, "builder", "claude-fable-5-2").warning, /asks for claude-fable-5-2; the routing table's ceiling for builder is opus\./);
  for (const m of [undefined, null, "", "  "]) {
    assert.equal(routingWarning(table, "reader", m).warning, 'delegation model routing (warn-only): this "reader" spawn sets no model; the routing table\'s model for reader is sonnet. The spawn proceeds on the model its agent definition pins.');
  }
  for (const type of ["general-purpose", "reviewer-codex", undefined, "", "constructor", "__proto__"]) {
    assert.deepEqual(routingWarning(table, type, "fable"), none, String(type));
    assert.deepEqual(routingWarning(table, type, undefined), none, String(type));
  }
  const odd = routingWarning(table, "reader", "inherit");
  assert.equal(odd.warning, null);
  assert.match(odd.skipped, /model "inherit" for "reader" names no single family/);
  assert.match(routingWarning(table, "reader", 5).skipped, /model 5 for "reader"/);
  for (const r of [routingWarning(table, "reader", "opus"), routingWarning(table, "reader", undefined)]) assert.equal(r.warning.includes("\n"), false, "one line");
});

test("routingOutcome: the outcome follows the warning's kind, not its text (a type name containing ' sets no model;' above the ceiling is warned-above)", () => {
  const { table } = loadTable();
  assert.equal(routingOutcome(table, "x sets no model;:scout", "opus").outcome, "warned-above");
  assert.equal(routingOutcome(table, "x sets no model;:scout", undefined).outcome, "no-model");
  assert.equal(routingOutcome(table, "scout", "haiku").outcome, "match");
});

// ---- hooks/spawn-gate.mjs, spawned ----

test("spawn-gate: a model at its type's ceiling, or under it, is allowed in silence", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(env);
  for (const [subagent_type, model] of [["reader", "sonnet"], ["reader", "haiku"], ["builder", "opus"], ["scout", "haiku"], ["delegation:research", "claude-opus-5-5"]]) {
    const r = runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type, model }), env);
    assert.equal(r.status, 0);
    assert.equal(r.out, null, `${subagent_type} on ${model}: ${r.stdout}`);
  }
  assert.equal(skippedLog(env), "");
});

test("spawn-gate: a model above its type's ceiling draws one line naming the type, the model and the ceiling, and the spawn is still allowed", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(env);
  const r = runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "reader", prompt: HOW_ONLY, model: "opus" }), env);
  assert.equal(r.status, 0);
  assert.equal(deny(r), null, r.stdout);
  assert.deepEqual(r.out, { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: 'delegation model routing (warn-only): this "reader" spawn asks for opus; the routing table\'s ceiling for reader is sonnet. The spawn proceeds.' } });
  const b = runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "builder", model: "fable", tool_name: "Task" }), env);
  assert.equal(deny(b), null);
  assert.equal(b.out.hookSpecificOutput.permissionDecision, undefined);
  assert.match(line(b), /this "builder" spawn asks for fable; the routing table's ceiling for builder is opus\./);
});

test("spawn-gate: a listed type with no model draws one line naming the table's model, and the spawn is still allowed", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(env);
  const r = runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "reader", prompt: HOW_ONLY, model: null }), env);
  assert.equal(r.status, 0);
  assert.equal(deny(r), null);
  assert.equal(line(r), 'delegation model routing (warn-only): this "reader" spawn sets no model; the routing table\'s model for reader is sonnet. The spawn proceeds on the model its agent definition pins.');
});

test("spawn-gate: an agent type the table does not list is silent, with a model far above everything or with none", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(env);
  for (const model of ["fable", null]) {
    assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "reviewer-codex", prompt: HOW_ONLY, model }), env).out, null, `reviewer-codex ${model}`);
    assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "general-purpose", model }), env).out, null, `general-purpose ${model}`);
    const noType = spawnPayload({ cwd: repo, model });
    delete noType.tool_input.subagent_type;
    assert.equal(runHook("spawn-gate", noType, env).out, null, `no type ${model}`);
  }
  assert.equal(skippedLog(env), "");
});

test("spawn-gate: a model string naming no family is allowed in silence with one skipped.log line", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(env);
  const r = runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "reader", prompt: HOW_ONLY, model: "inherit" }), env);
  assert.equal(r.out, null, r.stdout);
  assert.match(skippedLog(env), /^\S+ spawn-gate model not checked: model "inherit" for "reader" names no single family in the routing table; not judged; spawn allowed\n$/);
});

test("spawn-gate: the How-it-fails, Spiral-bound and receipt refusals still fire, unchanged, whatever the model; a refusal carries no model line", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(env);
  for (const model of ["fable", "haiku", null]) {
    const how = runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "reader", prompt: "Read it.", model }), env);
    assert.match(deny(how), /^Spawn refused: the prompt has no "## How it fails" heading\./, String(model));
    assert.ok(deny(how).endsWith(`\n\n${HOW_IT_FAILS_SECTION}`));
    assert.equal(line(how), null);
    assert.doesNotMatch(how.stdout, /model routing/);
    const spiral = runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "builder", prompt: HOW_ONLY, model }), env);
    assert.match(deny(spiral), /^Spawn refused: builder-class "builder" needs a "## Spiral bound" heading too\./, String(model));
    assert.ok(deny(spiral).endsWith(`\n\n${SPIRAL_BOUND_SECTION}`));
    assert.doesNotMatch(spiral.stdout, /model routing/);
    const receipt = runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "builder", session_id: "s-none", model }), env);
    assert.match(deny(receipt), /needs a pattern-check receipt for this session/, String(model));
    assert.doesNotMatch(receipt.stdout, /model routing/);
  }
});

test("spawn-gate: warnModelRouting false turns the line off and leaves the gates on; off turns everything off; a config fault rides beside the line", (t) => {
  const { env } = box(t, { config: { warnModelRouting: false } });
  const repo = repoWithReceipt(env);
  assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "reader", prompt: HOW_ONLY, model: "opus" }), env).out, null);
  assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "reader", prompt: HOW_ONLY, model: null }), env).out, null);
  assert.ok(deny(runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "reader", prompt: "x", model: "opus" }), env)));
  setConfig(env, { off: true });
  assert.equal(runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "reader", prompt: HOW_ONLY, model: "opus" }), env).out, null);
  setConfig(env, { warnModelRouting: "no" });
  const r = runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "reader", prompt: HOW_ONLY, model: "opus" }), env);
  assert.match(line(r), /ceiling for reader is sonnet/);
  assert.match(r.out.systemMessage, /warnModelRouting must be true or false/);
});
