// fault-tolerance.test.mjs — node --test
//
// Every hook in hooks.json, spawned as Claude Code spawns it, against the faults the repo test bar
// names: empty stdin, malformed JSON, a payload that is not an object, an unwritable state
// directory, a missing or malformed profile, a throw inside the hook, and a 5 s budget. Each must
// exit 0 and allow (no decision, the turn goes on); each fault leaves one errors.log line naming
// the file and the reason, and the hook's reply carries ONE warning line (lib/state.mjs, FAULTS).
//
// Every spawn has a 5 s timeout; a hook that hangs fails here, it is never skipped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hook = (name) => fileURLToPath(new URL(`./i-have-audhd-${name}.mjs`, import.meta.url));
const STOP = hook("stop");
const PROMPT = hook("prompt");
const INJECT = hook("inject");
const PRELOAD = fileURLToPath(new URL("./fixtures/throw-preload.mjs", import.meta.url));
const BUDGET_MS = 5_000;

const body = (n) => "This sentence is ordinary body prose carrying findings and context. ".repeat(n);
// Violates plural-back-reference (warn by default): the closing ask leans on "those".
const vagueAsk = `${body(6)}\n\n## Closing ask\n\nShould I merge those?`;

// The JSON Claude Code sends on stdin for each event.
const PAYLOADS = {
  stop: (sid, extra = {}) => ({ session_id: sid, cwd: "/tmp", stop_hook_active: false, transcript_path: "/nonexistent.jsonl", ...extra }),
  prompt: (sid) => ({ session_id: sid, cwd: "/tmp", prompt: "next" }),
  inject: (sid, source = "startup") => ({ session_id: sid, cwd: "/tmp", source }),
};

function mkhome() {
  const home = mkdtempSync(join(tmpdir(), "audhd-fault-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}
const stateDir = (home) => join(home, ".claude", ".i-have-audhd-state");
const errorsLog = (home) => {
  const p = join(stateDir(home), "errors.log");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
};
// A state "directory" that is a regular file: every mkdir and write under it fails, even as root.
const blockStateDir = (home) => writeFileSync(stateDir(home), "not a directory");

// Spawns `file` with `input` (a string is sent raw), asserting the budget, the exit code, and that
// stdout is empty or one JSON object. Returns { out, ms }.
function run(file, input, home, { env = {}, preload } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [...(preload ? ["--import", PRELOAD] : []), file], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      I_HAVE_AUDHD_ENFORCE: "",
      I_HAVE_AUDHD_PROFILE: "",
      I_HAVE_AUDHD_HARNESS: "",
      I_HAVE_AUDHD_INJECT: "",
      AUDHD_TEST_THROW: "",
      ...env,
    },
    timeout: BUDGET_MS,
  });
  const ms = Date.now() - started;
  assert.equal(r.error, undefined, `spawn failed or exceeded ${BUDGET_MS}ms: ${r.error}`);
  assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);
  assert.ok(ms < BUDGET_MS, `${file} took ${ms}ms`);
  return { out: r.stdout.trim() ? JSON.parse(r.stdout) : {}, ms };
}

// The fault contract: allowed (no block), one warning line naming the hook and the reason, and
// errors.log lines naming the file and the reason.
function assertFault(out, home, hookFile, reason, { logged = true } = {}) {
  assert.equal(out.decision, undefined, "a hook's own fault never blocks");
  const warning = String(out.systemMessage ?? "").split("\n").find((l) => l.startsWith("i-have-audhd hooks/"));
  assert.ok(warning, `no warning line in ${JSON.stringify(out)}`);
  assert.ok(warning.startsWith(`i-have-audhd ${hookFile} failed open`), warning);
  assert.match(warning, reason);
  if (logged) {
    assert.match(warning, /logged to .*errors\.log\)$/);
    assert.ok(errorsLog(home).some((l) => reason.test(l)), `errors.log: ${errorsLog(home).join(" | ")}`);
  } else {
    assert.match(warning, /could not be logged to .*errors\.log either\)$/);
  }
}

const HOOKS = [
  ["stop", STOP, "hooks/i-have-audhd-stop.mjs"],
  ["prompt", PROMPT, "hooks/i-have-audhd-prompt.mjs"],
  ["inject", INJECT, "hooks/i-have-audhd-inject.mjs"],
];

// ─── stdin faults, every hook ───────────────────────────────────────────────────────────────────

for (const [name, file, hookFile] of HOOKS) {
  test(`${name}: empty stdin exits 0, allows, and warns once`, () => {
    const home = mkhome();
    const { out } = run(file, "", home);
    assertFault(out, home, hookFile, /stdin was empty/);
    assert.equal(errorsLog(home).length, 1);
    assert.ok(errorsLog(home)[0].includes(`${hookFile} stdin was empty`));
  });

  test(`${name}: malformed JSON exits 0, allows, and warns once`, () => {
    const home = mkhome();
    const { out } = run(file, '{"session_id": "x", ', home);
    assertFault(out, home, hookFile, /payload did not parse/);
    assert.equal(errorsLog(home).length, 1);
  });

  test(`${name}: a JSON payload that is not an object exits 0, allows, and warns once`, () => {
    for (const input of ["[]", "null", "42"]) {
      const home = mkhome();
      const { out } = run(file, input, home);
      assertFault(out, home, hookFile, /payload is not a JSON object/);
    }
  });
}

test("inject: a stdin fault still injects the rules; only the resume marker is lost", () => {
  const home = mkhome();
  const { out } = run(INJECT, "not json", home);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /i-have-audhd rules/);
});

// ─── an unwritable state directory ───────────────────────────────────────────────────────────────

test("stop: unwritable state dir, warn finding → exit 0, no block, one warning saying nothing could be logged", () => {
  const home = mkhome();
  blockStateDir(home);
  const { out } = run(STOP, PAYLOADS.stop("u1", { last_assistant_message: vagueAsk }), home);
  assertFault(out, home, "hooks/i-have-audhd-stop.mjs", /could not write pending warning for u1/, { logged: false });
  assert.match(out.systemMessage, /lib\/state\.mjs could not write .*warnings\.log/);
  assert.equal(out.systemMessage.split("\n").length, 1, "one warning line");
});

test("stop: unwritable state dir in block mode still blocks, and the lost loop-guard hash is a warning", () => {
  const home = mkhome();
  writeFileSync(join(home, ".claude", "i-have-audhd.json"), JSON.stringify({ enforcement: { mode: "block" } }));
  blockStateDir(home);
  const { out } = run(STOP, PAYLOADS.stop("u2", { last_assistant_message: vagueAsk }), home);
  assert.equal(out.decision, "block", "a block-mode rule still blocks; the fault only adds a warning");
  assert.match(out.reason, /Plural back-reference/);
  assert.match(out.systemMessage, /^i-have-audhd hooks\/i-have-audhd-stop\.mjs failed open .*could not record loop-guard hash for u2/);
});

test("stop: every block reason ends with the way out: the kill-switch file and the profile key per blocked rule", () => {
  const home = mkhome();
  writeFileSync(join(home, ".claude", "i-have-audhd.json"), JSON.stringify({ enforcement: { mode: "block" } }));
  const { out } = run(STOP, PAYLOADS.stop("w1", { last_assistant_message: vagueAsk }), home);
  assert.equal(out.decision, "block");
  const last = out.reason.split("\n\n").at(-1);
  assert.equal(
    last,
    'Way out: `touch ~/.claude/.i-have-audhd-off` turns the check off; or set {"enforcement": {"rules": {"plural-back-reference": "warn"}}} in ~/.claude/i-have-audhd.json to warn instead of block.',
  );
  assert.equal(out.reason.split("\n\n").filter((p) => p.startsWith("Way out:")).length, 1, "once, not per finding");
});

test("prompt: unwritable state dir has nothing pending → exit 0, silent", () => {
  const home = mkhome();
  blockStateDir(home);
  const { out } = run(PROMPT, PAYLOADS.prompt("u3"), home);
  assert.deepEqual(out, {});
});

test("inject: unwritable state dir on resume → rules still injected, the lost marker is a warning", () => {
  const home = mkhome();
  writeFileSync(join(home, ".claude", "i-have-audhd.json"), JSON.stringify({ enforcement: { judgeCommand: null } }));
  blockStateDir(home);
  const { out } = run(INJECT, PAYLOADS.inject("u4", "resume"), home);
  assert.match(out.hookSpecificOutput.additionalContext, /i-have-audhd rules/);
  assertFault(out, home, "hooks/i-have-audhd-inject.mjs", /could not write resume marker for u4/, { logged: false });
});

// ─── missing and malformed profile ─────────────────────────────────────────────────────────────

test("stop: a missing profile is the normal case → defaults (warn), no warning line, no errors.log", () => {
  const home = mkhome();
  const { out } = run(STOP, PAYLOADS.stop("m1", { last_assistant_message: vagueAsk }), home, {
    env: { I_HAVE_AUDHD_PROFILE: join(home, "nope.json") },
  });
  assert.deepEqual(out, {});
  assert.deepEqual(errorsLog(home), []);
  assert.ok(existsSync(join(stateDir(home), "pending-warn-m1.json")), "the warn finding is still delivered");
});

test("stop: a malformed profile → defaults (warn), one errors.log line and one warning line from lib/config.mjs", () => {
  const home = mkhome();
  writeFileSync(join(home, ".claude", "i-have-audhd.json"), "{ nope");
  const { out } = run(STOP, PAYLOADS.stop("m2", { last_assistant_message: vagueAsk }), home);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /^i-have-audhd hooks\/i-have-audhd-stop\.mjs failed open .*lib\/config\.mjs enforcement: profile at .* does not parse/);
  assert.equal(errorsLog(home).length, 1);
  assert.ok(existsSync(join(stateDir(home), "pending-warn-m2.json")));
});

test("stop: a profile value of the wrong shape → that value ignored, one warning naming it", () => {
  const home = mkhome();
  writeFileSync(join(home, ".claude", "i-have-audhd.json"), JSON.stringify({ enforcement: { mode: "loud", judgeCommand: 7 } }));
  const { out } = run(STOP, PAYLOADS.stop("m3", { last_assistant_message: vagueAsk }), home);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /mode "loud" is not block\|warn\|off; ignored; lib\/config\.mjs enforcement: judgeCommand 7/);
  assert.equal(errorsLog(home).length, 2);
});

test("prompt: the profile is never read, so a malformed one changes nothing", () => {
  const home = mkhome();
  writeFileSync(join(home, ".claude", "i-have-audhd.json"), "{ nope");
  run(STOP, PAYLOADS.stop("m4", { last_assistant_message: vagueAsk }), home); // leaves a notice (and a fault of its own)
  const { out } = run(PROMPT, PAYLOADS.prompt("m4"), home);
  assert.match(out.hookSpecificOutput.additionalContext, /Plural back-reference/);
  assert.doesNotMatch(out.systemMessage, /failed open/);
});

test("inject: a missing profile is normal → rules injected, no fault", () => {
  const home = mkhome();
  const { out } = run(INJECT, PAYLOADS.inject("m5"), home, { env: { I_HAVE_AUDHD_PROFILE: join(home, "nope.json") } });
  assert.match(out.hookSpecificOutput.additionalContext, /No reader profile is configured/);
  assert.doesNotMatch(out.systemMessage ?? "", /failed open/);
  assert.deepEqual(errorsLog(home), []);
});

test("inject: a malformed profile → rules injected without traits, one errors.log line and one warning line", () => {
  const home = mkhome();
  writeFileSync(join(home, ".claude", "i-have-audhd.json"), "{ nope");
  const { out } = run(INJECT, PAYLOADS.inject("m6"), home);
  assert.match(out.hookSpecificOutput.additionalContext, /did not parse/);
  assertFault(out, home, "hooks/i-have-audhd-inject.mjs", /reader profile at .* did not parse/);
  assert.equal(errorsLog(home).length, 1);
});

// ─── a throw inside the hook ────────────────────────────────────────────────────────────────────

test("stop: a throw inside the hook → exit 0, no block, one errors.log line with the stack, one warning line", () => {
  const home = mkhome();
  writeFileSync(join(home, ".claude", "i-have-audhd.json"), JSON.stringify({ enforcement: { mode: "block" } }));
  const { out } = run(STOP, PAYLOADS.stop("t1", { last_assistant_message: vagueAsk }), home, {
    preload: true,
    env: { AUDHD_TEST_THROW: "createHash" },
  });
  assertFault(out, home, "hooks/i-have-audhd-stop.mjs", /threw and failed open: Error: injected createHash failure/);
  assert.equal(out.systemMessage.split("\n").length, 1);
});

test("prompt: a throw inside the hook → exit 0, one errors.log line, one warning line", () => {
  const home = mkhome();
  const { out } = run(PROMPT, PAYLOADS.prompt("t2"), home, { preload: true, env: { AUDHD_TEST_THROW: "pending-exists" } });
  assertFault(out, home, "hooks/i-have-audhd-prompt.mjs", /threw and failed open: Error: injected existsSync failure/);
  assert.equal(out.hookSpecificOutput, undefined);
});

test("inject: a throw inside the hook → exit 0, a could-not-load context line, one errors.log line, one warning line", () => {
  const home = mkhome();
  const { out } = run(INJECT, PAYLOADS.inject("t3"), home, { preload: true, env: { AUDHD_TEST_THROW: "skill-read" } });
  assert.equal(out.hookSpecificOutput.additionalContext, "The i-have-audhd core could not load this session.");
  assertFault(out, home, "hooks/i-have-audhd-inject.mjs", /threw and failed open: Error: injected SKILL\.md read failure/);
});

// ─── the 5 s budget on the ordinary path ─────────────────────────────────────────────────────────

test("every hook answers a real payload inside the 5 s budget", () => {
  const home = mkhome();
  for (const [file, payload] of [
    [INJECT, PAYLOADS.inject("b1")],
    [STOP, PAYLOADS.stop("b1", { last_assistant_message: vagueAsk })],
    [PROMPT, PAYLOADS.prompt("b1")],
  ]) {
    const { ms } = run(file, payload, home);
    assert.ok(ms < BUDGET_MS, `${file}: ${ms}ms`);
  }
});
