// Every row of the fail-open table (README § Fail-open) against every hook. Each case asserts the
// one thing that matters: exit 0, and the "allow" shape of the output (no deny, no block).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { sandbox, hook, cli, openDb, HOOKS } from "./helpers.mjs";

const hookCli = (box, args) => cli(box, args).out;

const HOOK_NAMES = Object.keys(HOOKS);
const LONG_Q = "I looked through the code and found two viable designs for the cache. Should I use A or B?";

/** A payload for each hook that WOULD deny/block/inject if the store were healthy. */
function payloads(box) {
  const base = { session_id: "s-fo", cwd: box.work };
  return {
    "session-start": { ...base, hook_event_name: "SessionStart", source: "startup" },
    "session-end": { ...base, hook_event_name: "SessionEnd", reason: "other" },
    "pre-tool-use": { ...base, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [] } },
    stop: { ...base, hook_event_name: "Stop", prompt_id: "p", stop_hook_active: false, last_assistant_message: LONG_Q },
    "user-prompt": { ...base, hook_event_name: "UserPromptSubmit", prompt: "approve q-nope" },
  };
}

function assertAllow(name, r, { expectSystemMessage, notInjected = true }) {
  assert.equal(r.code, 0, `${name}: exit ${r.code} ${r.err}`);
  assert.notEqual(r.json, undefined, `${name}: stdout is not JSON: ${r.out}`);
  const j = r.json ?? {};
  assert.notEqual(j.hookSpecificOutput?.permissionDecision, "deny", `${name} denied`);
  assert.notEqual(j.hookSpecificOutput?.permissionDecision, "ask", `${name} asked`);
  assert.notEqual(j.decision, "block", `${name} blocked`);
  if (notInjected) assert.equal(j.hookSpecificOutput?.additionalContext, undefined, `${name} injected`);
  if (expectSystemMessage) assert.match(j.systemMessage ?? "", expectSystemMessage, `${name}: ${r.out}`);
  if (expectSystemMessage === null) assert.equal(r.out, "", `${name} printed ${r.out}`);
}

test("row: DB file missing → every hook creates dirs + DB, migrates, and proceeds normally", () => {
  const box = sandbox();
  const env = { LEDGER_DB: join(box.root, "fresh", "dir", "ledger.db") };
  const p = payloads(box);
  const s = hook(box, "session-start", p["session-start"], { env });
  assert.ok(existsSync(env.LEDGER_DB));
  assert.match(s.json.hookSpecificOutput.additionalContext, /^ledger: questions to the human/);
  const pre = hook(box, "pre-tool-use", p["pre-tool-use"], { env });
  assert.equal(pre.json.hookSpecificOutput.permissionDecision, "deny", "the gate works on a fresh db");
  assert.equal(hook(box, "stop", p.stop, { env }).json.decision, "block");
  assert.match(hook(box, "user-prompt", p["user-prompt"], { env }).json.hookSpecificOutput.additionalContext, /refused no such question/);
  assert.equal(hook(box, "session-end", p["session-end"], { env }).out, "");
  assert.ok(!existsSync(box.errorsLog));
});

test("row: DB locked → CLI-side proven in db.test; every hook allows with one busy line (SessionEnd: log only)", () => {
  const box = sandbox();
  const holder = openDb(box);
  holder.exec("BEGIN IMMEDIATE");
  try {
    const p = payloads(box);
    // Reads are not blocked by a writer in WAL mode, so SessionStart still injects (with the busy note). The gate
    // would deny and tell the agent to `ask`, which cannot write right now, so it passes with the busy line instead.
    const s = hook(box, "session-start", p["session-start"]);
    assert.match(s.json.systemMessage, /^ledger: database busy at .*; this session was not recorded/);
    assert.match(s.json.hookSpecificOutput.additionalContext, /^ledger: questions to the human/);
    assertAllow("pre-tool-use", hook(box, "pre-tool-use", p["pre-tool-use"]), { expectSystemMessage: /^ledger: database busy at .*; the ledger gate is not enforced for this call$/ });
    assertAllow("stop", hook(box, "stop", p.stop), { expectSystemMessage: /database busy at .*; the ledger stop check did not run$/ });
    // Every command line runs in a write transaction, so a held lock means "not applied", never a silent skip.
    const b2 = sandbox();
    const holder2 = openDb(b2);
    const q = /q-[a-z0-9]+/.exec(hookCli(b2, ["ask", "Lock me?", "--name", "lock", "--options", "approve,deny"]))[0];
    holder2.exec("BEGIN IMMEDIATE");
    try {
      const up2 = hook(b2, "user-prompt", { ...p["user-prompt"], cwd: b2.work, prompt: `approve ${q}` });
      assert.match(up2.json.systemMessage, /^ledger: database busy at .*; the lines marked not applied were not applied\n/);
      assert.match(up2.json.hookSpecificOutput.additionalContext, /1: not applied \(database busy\)/);
      assert.equal(up2.json.decision, undefined);
    } finally {
      holder2.exec("ROLLBACK");
      holder2.close();
    }
    assertAllow("session-end", hook(box, "session-end", p["session-end"]), { expectSystemMessage: null });
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
  const log = readFileSync(box.errorsLog, "utf8");
  assert.match(log, /SessionEnd ledger: database busy/);
});

test("row: DB corrupt at the default path → every hook moves it aside, names the move, and does its job on a fresh db", () => {
  for (const name of HOOK_NAMES) {
    const box = sandbox();
    // No LEDGER_DB and no `db` in any file: the plugin's own default path under XDG_DATA_HOME.
    const dataDir = join(box.root, "data", "ledger");
    const env = { LEDGER_DB: "", XDG_DATA_HOME: join(box.root, "data") };
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "ledger.db"), "junk ".repeat(2000));
    const r = hook(box, name, payloads(box)[name], { env });
    assert.equal(r.code, 0, `${name}: ${r.err}`);
    assert.ok(existsSync(join(dataDir, "ledger.db")), name);
    const aside = globalThis.process.getBuiltinModule("node:fs").readdirSync(dataDir).filter((f) => f.startsWith("ledger.db.corrupt-"));
    assert.equal(aside.length, 1, `${name}: ${aside}`);
    if (name === "session-end") {
      assert.equal(r.out, "");
      assert.match(readFileSync(box.errorsLog, "utf8"), /SessionEnd ledger: moved corrupt database aside to /);
    } else {
      assert.match(r.json.systemMessage, /^ledger: moved corrupt database aside to .*\.corrupt-/, name);
      if (name === "pre-tool-use") assert.equal(r.json.hookSpecificOutput.permissionDecision, "deny");
      if (name === "stop") assert.equal(r.json.decision, "block");
      if (name === "session-start") assert.match(r.json.hookSpecificOutput.additionalContext, /^ledger: questions to the human/);
      if (name === "user-prompt") assert.match(r.json.hookSpecificOutput.additionalContext, /refused no such question/);
    }
  }
});

test("row: config unparsable / wrong type → every hook runs on defaults and names the file once", () => {
  for (const name of HOOK_NAMES) {
    const box = sandbox();
    box.writeConfig("{");
    const r = hook(box, name, payloads(box)[name]);
    assert.equal(r.code, 0, `${name}: ${r.err}`);
    if (name === "session-end") {
      assert.equal(r.out, "");
      assert.match(readFileSync(box.errorsLog, "utf8"), /SessionEnd ledger: config .*config\.json ignored/);
    } else {
      assert.match(r.json.systemMessage, /^ledger: config .*config\.json ignored: /, `${name}: ${r.out}`);
      if (name === "pre-tool-use") assert.equal(r.json.hookSpecificOutput.permissionDecision, "deny", "defaults still enforce the gate");
    }
    const wrong = sandbox();
    wrong.writeConfig({ hooks: { stop: "yes" }, forcing: { denyAskWithoutRow: 1 } });
    const w = hook(wrong, name, payloads(wrong)[name]);
    assert.equal(w.code, 0);
    if (name !== "session-end") assert.match(w.json.systemMessage, /must be boolean; ignoring it/, `${name}: ${w.out}`);
  }
});

test("row: unknown config key → silently ignored by every hook, no systemMessage", () => {
  for (const name of HOOK_NAMES) {
    const box = sandbox();
    box.writeConfig({ brandNew: true, hooks: { later: 1 } });
    const r = hook(box, name, payloads(box)[name]);
    assert.equal(r.code, 0);
    assert.ok(!/ledger: config/.test(r.json?.systemMessage ?? ""), `${name}: ${r.out}`);
  }
});

test("row: stdin not JSON → every hook exits 0; `failed open` systemMessage except SessionEnd; one errors.log line each", () => {
  for (const name of HOOK_NAMES) {
    const box = sandbox();
    const r = hook(box, name, "{not json");
    assert.equal(r.code, 0, name);
    if (name === "session-end") assert.equal(r.out, "");
    else assert.deepEqual(r.json, { systemMessage: `ledger ${eventName(name)} failed open: stdin not JSON` });
    const log = readFileSync(box.errorsLog, "utf8").trim().split("\n");
    assert.equal(log.length, 1);
    assert.match(log[0], new RegExp(` ${eventName(name)} stdin not JSON: `));
  }
});

test("row: hook script throws → exit 0, `failed open: <msg>`, one errors.log line (forced by an unwritable db dir)", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, () => {
  for (const name of HOOK_NAMES) {
    const box = sandbox();
    const dir = join(box.root, "ro");
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    try {
      const r = hook(box, name, payloads(box)[name], { env: { LEDGER_DB: join(dir, "sub", "ledger.db") } });
      assertAllow(name, r, { expectSystemMessage: name === "session-end" ? null : /^ledger: database unavailable at / });
    } finally {
      chmodSync(dir, 0o700);
    }
    // A thrown error of any other kind: feed a payload whose cwd is not a string so resolveCwd/realpath throws
    // deep inside, and confirm the wrapper still prints the allow shape.
    const b2 = sandbox();
    const r2 = hook(b2, name, { ...payloads(b2)[name], cwd: { not: "a string" } });
    assert.equal(r2.code, 0, `${name}: ${r2.err}`);
    assert.notEqual(r2.json?.hookSpecificOutput?.permissionDecision, "deny");
    assert.notEqual(r2.json?.decision, "block");
  }
});

test("row: switch off in config → every hook exits 0 before the db is touched", () => {
  const keys = { "session-start": "sessionStart", "session-end": "sessionEnd", "pre-tool-use": "preToolUse", stop: "stop", "user-prompt": "userPromptCommands" };
  for (const name of HOOK_NAMES) {
    const box = sandbox();
    box.writeConfig({ hooks: { [keys[name]]: false } });
    const r = hook(box, name, payloads(box)[name]);
    assert.equal(r.code, 0);
    assert.equal(r.out, "", `${name}: ${r.out}`);
    assert.ok(!existsSync(box.dbPath), `${name} opened the db`);
  }
});

test("row: DB file read-only → reads still work, writes fail open: SessionStart injects with a read-only line, PreToolUse enforces, Stop allows, prompt lines are `not applied`, SessionEnd logs", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, () => {
  const box = sandbox();
  const q = /q-[a-z0-9]+/.exec(hookCli(box, ["ask", "Read only?", "--name", "ro", "--options", "approve,deny"]))[0];
  chmodSync(box.dbPath, 0o444);
  try {
    const p = payloads(box);
    const s = hook(box, "session-start", p["session-start"]);
    assert.match(s.json.systemMessage, /^ledger: database read-only at .*; this session was not recorded/);
    assert.ok(s.json.hookSpecificOutput.additionalContext.includes(q), "the open question is still injected");
    assertAllow("pre-tool-use", hook(box, "pre-tool-use", p["pre-tool-use"]), { expectSystemMessage: null });
    // With no open question in scope the gate would deny; `ask` cannot write to this file, so it passes and says why.
    assertAllow("pre-tool-use", hook(box, "pre-tool-use", { ...p["pre-tool-use"], cwd: box.sibling }), { expectSystemMessage: /^ledger: database read-only at .*; the ledger gate is not enforced for this call$/ });
    // Turning the hooks off never needs the database.
    const off = cli(box, ["disable"], { cwd: box.sibling });
    assert.equal(off.code, 0, off.err);
    assert.match(off.out, /^disabled the ledger hooks for /);
    assertAllow("stop", hook(box, "stop", { ...p.stop, last_assistant_message: LONG_Q }), { expectSystemMessage: /database read-only at .*; the ledger stop check did not run$/ });
    const up = hook(box, "user-prompt", { ...p["user-prompt"], prompt: `approve ${q}` });
    assert.match(up.json.systemMessage, /^ledger: database read-only at .*; the lines marked not applied were not applied\n/);
    assert.match(up.json.hookSpecificOutput.additionalContext, /1: not applied \(database read-only\)/);
    assert.equal(up.json.decision, undefined);
    assertAllow("session-end", hook(box, "session-end", p["session-end"]), { expectSystemMessage: null });
    assert.match(readFileSync(box.errorsLog, "utf8"), /SessionEnd ledger: database read-only at /);
  } finally {
    chmodSync(box.dbPath, 0o644);
  }
  const db = openDb(box);
  assert.equal(db.prepare("SELECT state FROM cc_questions WHERE id = ?").get(q).state, "open");
  db.close();
});

test("row: DB corrupt at a configured path → nothing is renamed, recreated or written; PreToolUse allows with the notice, SessionEnd logs it", () => {
  for (const [name, tail] of [
    ["pre-tool-use", "the ledger gate is not enforced for this call"],
    ["session-end", null],
  ]) {
    const box = sandbox();
    // `db` from the user file, the way a shared database (another tool's file) is configured.
    const path = join(box.root, "shared", "other-tool.db");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "junk ".repeat(2000));
    box.writeConfig({ db: path });
    const before = createHash("sha256").update(readFileSync(path)).digest("hex");
    const r = hook(box, name, payloads(box)[name], { env: { LEDGER_DB: "" } });
    assert.equal(r.code, 0, `${name}: ${r.err}`);
    assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), before, name);
    assert.deepEqual(readdirSync(dirname(path)), ["other-tool.db"], name);
    if (name === "session-end") {
      assert.equal(r.out, "");
      assert.match(readFileSync(box.errorsLog, "utf8"), new RegExp(`SessionEnd ledger: database corrupt at ${path}: .*not a database`));
    } else {
      assert.equal(r.json.hookSpecificOutput, undefined, "allow: no deny");
      assert.equal(r.json.systemMessage, `ledger: database corrupt at ${path}: file is not a database; ${tail}`);
    }
  }
});

test("row: database unavailable → `enable`, `disable` and `help` still work (exit 0), other verbs exit 2", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, () => {
  const box = sandbox();
  const dir = join(box.root, "ro");
  mkdirSync(dir);
  chmodSync(dir, 0o500);
  try {
    const env = { LEDGER_DB: join(dir, "sub", "ledger.db") };
    const on = cli(box, ["enable"], { env });
    assert.equal(on.code, 0, on.err);
    assert.match(on.out, /^enabled the ledger hooks for /);
    assert.equal(cli(box, ["help"], { env }).code, 0);
    const other = cli(box, ["pending"], { env });
    assert.equal(other.code, 2);
    assert.match(other.err, /^ledger: database unavailable at /);
    const off = cli(box, ["disable"], { env });
    assert.equal(off.code, 0, off.err);
    assert.deepEqual(JSON.parse(readFileSync(join(box.work, ".ledger.json"), "utf8")), { enabled: false });
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("row: project disabled (`\"enabled\": false` in .ledger.json) → every hook exits 0 with no output and no db, whatever the payload", () => {
  for (const name of HOOK_NAMES) {
    const box = sandbox();
    writeFileSync(join(box.work, ".ledger.json"), JSON.stringify({ enabled: false }));
    const r = hook(box, name, payloads(box)[name], { env: { LEDGER_ENABLED: "" } });
    assert.equal(r.code, 0);
    assert.equal(r.out, "", `${name}: ${r.out}`);
    assert.ok(!existsSync(box.dbPath), `${name} opened the db`);
  }
});

test("row: hook times out → Claude Code's behaviour (cited in the README); the plugin's part is SessionEnd finishing well inside 1.5 s", () => {
  const box = sandbox();
  const t0 = performance.now();
  hook(box, "session-end", payloads(box)["session-end"]);
  assert.ok(performance.now() - t0 < 1000);
});

test("no hook ever exits 2 or writes to stderr on the fail-open paths above", () => {
  const box = sandbox();
  for (const name of HOOK_NAMES) {
    const r = hook(box, name, "garbage");
    assert.equal(r.code, 0);
    assert.equal(r.err, "", `${name} wrote to stderr: ${r.err}`);
  }
});

function eventName(name) {
  return { "session-start": "SessionStart", "session-end": "SessionEnd", "pre-tool-use": "PreToolUse", stop: "Stop", "user-prompt": "UserPromptSubmit" }[name];
}
