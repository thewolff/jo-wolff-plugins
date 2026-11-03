// enabled.test.mjs — the hooks are opt-in per project: `.ledger.json` found by walking up from cwd,
// `ledger enable` / `ledger disable` write it, LEDGER_ENABLED overrides it. Also `log`.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FILE, projectConfigPath } from "../lib/config.mjs";
import { hookConfig } from "../lib/store.mjs";
import { sandbox, cli, hook, apply, askQuestion, idOf } from "./helpers.mjs";

const box = sandbox();
// The sandbox env turns the hooks on; these tests want the real default, so they clear it.
const off = { LEDGER_ENABLED: "" };
const session = (cwd) => ({ session_id: "s-enabled", cwd, hook_event_name: "SessionStart", source: "startup" });

test("by default the hooks do nothing: no project file, no env → every hook prints nothing and writes nothing", () => {
  for (const name of ["session-start", "pre-tool-use", "stop", "user-prompt", "session-end"]) {
    const r = hook(box, name, { ...session(box.work), tool_name: "AskUserQuestion", tool_input: {}, prompt: "pending", last_assistant_message: "Which?", stop_hook_active: false }, { env: off });
    assert.equal(r.code, 0, `${name}: ${r.err}`);
    assert.equal(r.out, "", `${name} printed: ${r.out}`);
    assert.equal(r.err, "", `${name} complained: ${r.err}`);
  }
  assert.equal(existsSync(box.dbPath), false, "a disabled project does not even create the database");
});

test("`ledger enable` writes .ledger.json in cwd and the hooks come on; `ledger disable` turns them off again", () => {
  const r = cli(box, ["enable"], { env: off });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^enabled the ledger hooks for ${box.work}\\nwrote ${box.work}/${PROJECT_FILE}:\\n`));
  assert.deepEqual(JSON.parse(readFileSync(join(box.work, PROJECT_FILE), "utf8")), { enabled: true });
  const on = hook(box, "session-start", session(box.work), { env: off });
  assert.equal(on.code, 0, on.err);
  assert.equal(on.json?.hookSpecificOutput?.hookEventName, "SessionStart");
  assert.match(on.json.hookSpecificOutput.additionalContext, /ledger/);

  const d = cli(box, ["disable"], { env: off });
  assert.equal(d.code, 0, d.err);
  assert.match(d.out, /^disabled the ledger hooks for .*\nupdated .*\.ledger\.json:\n/);
  assert.deepEqual(JSON.parse(readFileSync(join(box.work, PROJECT_FILE), "utf8")), { enabled: false });
  const offAgain = hook(box, "session-start", session(box.work), { env: off });
  assert.equal(offAgain.out, "");
});

test("the project file is found by walking up from cwd; a sibling folder is not covered; other keys in it apply too", () => {
  const b = sandbox();
  writeFileSync(join(b.root, PROJECT_FILE), JSON.stringify({ enabled: true, inject: { notes: 1 } }));
  const nested = join(b.work, "a", "b");
  mkdirSync(nested, { recursive: true });
  assert.equal(projectConfigPath(nested), join(b.root, PROJECT_FILE));
  assert.equal(projectConfigPath(join(b.root, "..")), null);
  const env = { ...b.env, LEDGER_ENABLED: "" };
  const deep = hookConfig(env, { cwd: nested }, "sessionStart");
  assert.ok(deep, "enabled from the ancestor file");
  assert.equal(deep.cfg.config.inject.notes, 1);
  assert.equal(deep.cfg.sources["inject.notes"], "project file");
  // The sibling is under the same root, so it is covered too; outside the root it is not.
  assert.ok(hookConfig(env, { cwd: b.sibling }, "sessionStart"));
  assert.equal(hookConfig({ ...env, LEDGER_CWD: "/" }, { cwd: nested }, "sessionStart"), null);
});

test("enable/disable only touch the `enabled` key and keep the rest of an existing file; an unparsable file is refused, not overwritten", () => {
  const b = sandbox();
  writeFileSync(join(b.work, PROJECT_FILE), JSON.stringify({ inject: { notes: 2 }, custom: "kept" }));
  const r = cli(b, ["enable"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(readFileSync(join(b.work, PROJECT_FILE), "utf8")), { inject: { notes: 2 }, custom: "kept", enabled: true });
  writeFileSync(join(b.work, PROJECT_FILE), "{ not json");
  const bad = cli(b, ["disable"]);
  assert.equal(bad.code, 1, bad.err);
  assert.match(bad.out, /^refused .*\.ledger\.json exists but could not be read \(.*\); fix or remove it first/);
  assert.equal(readFileSync(join(b.work, PROJECT_FILE), "utf8"), "{ not json");
});

test("LEDGER_ENABLED overrides the files both ways; `enable`/`disable` are never applied from a prompt", () => {
  const b = sandbox();
  writeFileSync(join(b.work, PROJECT_FILE), JSON.stringify({ enabled: true }));
  assert.equal(hookConfig({ ...b.env, LEDGER_ENABLED: "0" }, { cwd: b.work }, "sessionStart"), null);
  assert.ok(hookConfig({ ...b.env, LEDGER_ENABLED: "true" }, { cwd: b.sibling }, "sessionStart"));
  const sw = hookConfig({ ...b.env, LEDGER_ENABLED: "1" }, { cwd: b.work }, "stop");
  assert.ok(sw);
  b.writeConfig({ hooks: { stop: false } });
  assert.equal(hookConfig({ ...b.env, LEDGER_ENABLED: "1" }, { cwd: b.work }, "stop"), null, "a hook switch still turns one hook off");
  // `enable` is not id-bearing, so a prompt carrying it (alone or next to an id) is left alone entirely.
  const q = askQuestion(b, { name: "pe", options: "approve,deny", cwd: b.sibling });
  for (const prompt of ["enable", `enable\napprove ${q}`]) {
    const r = hook(b, "user-prompt", { session_id: "s", cwd: b.sibling, prompt });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "", prompt);
  }
  assert.equal(existsSync(join(b.sibling, PROJECT_FILE)), false);
  // The batch guard behind the hook refuses it too, should a line ever get that far.
  const guarded = apply(b, ["enable"], { via: "prompt-hook", cwd: b.sibling, onlyPromptApplicable: true });
  assert.equal(guarded.results[0].status, "not a command");
  assert.equal(existsSync(join(b.sibling, PROJECT_FILE)), false);
});

test("`log [N]` lists notes, questions and answers for the folder, newest first, N capped; `log` alone shows 20", () => {
  const b = sandbox();
  const q = askQuestion(b, { name: "lg", options: "approve,deny", now: Date.parse("2026-11-03T10:00:00Z") });
  const nt = idOf(apply(b, [{ tokens: ["note", "went with sqlite"], text: "" }], { now: Date.parse("2026-11-03T10:01:00Z") }));
  apply(b, [`approve ${q}`], { now: Date.parse("2026-11-03T10:02:00Z") });
  const r = cli(b, ["log"]);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 3, r.out);
  assert.match(lines[0], new RegExp(`^an-[a-z0-9]+ .* answered: approve → ${q} \\(lg\\)$`));
  assert.equal(lines[1].slice(0, nt.length), nt);
  assert.match(lines[1], / note: went with sqlite$/);
  assert.match(lines[2], new RegExp(`^${q} .* agent asked: lg · Which way \\(lg\\)\\?$`));
  const two = cli(b, ["log", "2"]);
  assert.equal(two.out.trim().split("\n").length, 2);
  const none = cli(b, ["log"], { cwd: b.sibling });
  assert.match(none.out, /^no notes, questions or answers for /);
  const bad = cli(b, ["log", "many"]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /not a command/);
});
