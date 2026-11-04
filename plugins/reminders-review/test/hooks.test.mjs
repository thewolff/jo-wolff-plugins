// The hooks as spawned processes (AGENTS.md item 2): stdin JSON in, stdout JSON out, exit 0
// always, never a block. A fake remindctl sits on the sandbox's PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_DIR, sandbox } from "./helpers.mjs";
import { sessionStampPath, THROTTLE_MS } from "../lib/due.mjs";

const HOOKS = { SessionStart: "session-start.mjs", UserPromptSubmit: "user-prompt-submit.mjs" };

function runHook(event, env, { stdin, session = "s-test" } = {}) {
  const input = stdin ?? JSON.stringify({ session_id: session, hook_event_name: event, cwd: PLUGIN_DIR, source: "startup", prompt: "hi" });
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(PLUGIN_DIR, "hooks", HOOKS[event])], { env, input, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  assert.notEqual(out?.decision, "block");
  assert.notEqual(out?.continue, false);
  return { out, ms: Date.now() - started };
}

const errorsLog = (box) => (existsSync(join(box.stateDir, "errors.log")) ? readFileSync(join(box.stateDir, "errors.log"), "utf8").trim().split("\n").filter(Boolean) : []);

test("SessionStart with a due item injects the block (config file `watch`)", () => {
  const box = sandbox();
  try {
    mkdirSync(box.configDir, { recursive: true });
    writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ lists: ["Errands"], watch: ["Plumb"] }));
    const { out } = runHook("SessionStart", box.env);
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    const block = out.hookSpecificOutput.additionalContext;
    // The hook runs on the real clock, so today's items carry a date on any day but the fixtures'.
    assert.match(block, /^Due \(list Plumb\): Nov 3 9:00 AM Renew the domain; (Nov 4 )?10:00 AM Test tonight's plugin ships/);
    assert.equal(out.systemMessage, undefined);
    assert.deepEqual(errorsLog(box), []);
    assert.deepEqual(readFileSync(box.calls, "utf8").trim().split("\n").sort(), ["show overdue --list Plumb --json", "show today --list Plumb --json"]);
  } finally {
    box.release();
  }
});

test("nothing due → silent", () => {
  const empty = join(PLUGIN_DIR, "test", "fixtures", "remindctl-show-empty.json");
  const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb", STUB_OVERDUE: empty, STUB_TODAY: empty } });
  try {
    assert.equal(runHook("SessionStart", box.env).out, null);
    assert.equal(runHook("UserPromptSubmit", box.env, { session: "fresh" }).out, null);
    assert.deepEqual(errorsLog(box), []);
  } finally {
    box.release();
  }
});

test("unconfigured install → silent on both hooks, remindctl never run, nothing written", () => {
  const box = sandbox();
  try {
    assert.equal(runHook("SessionStart", box.env).out, null);
    assert.equal(runHook("UserPromptSubmit", box.env).out, null);
    assert.equal(existsSync(box.calls), false);
    assert.equal(existsSync(box.stateDir), false);
  } finally {
    box.release();
  }
});

test("throttle: a second prompt within the hour is silent; after the hour it fires again", () => {
  const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb" } });
  try {
    const first = runHook("UserPromptSubmit", box.env, { session: "s-throttle" }).out;
    assert.equal(first.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.ok(first.hookSpecificOutput.additionalContext.startsWith("Due (list Plumb): "));
    assert.equal(runHook("UserPromptSubmit", box.env, { session: "s-throttle" }).out, null);
    // Move the stamp back an hour: the next prompt checks again.
    const stamp = sessionStampPath("s-throttle", box.env);
    const { checkedAt } = JSON.parse(readFileSync(stamp, "utf8"));
    writeFileSync(stamp, JSON.stringify({ checkedAt: checkedAt - THROTTLE_MS }));
    assert.ok(runHook("UserPromptSubmit", box.env, { session: "s-throttle" }).out.hookSpecificOutput);
  } finally {
    box.release();
  }
});

test("SessionStart stamps the throttle: the session's first prompt stays quiet", () => {
  const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb" } });
  try {
    assert.ok(runHook("SessionStart", box.env, { session: "s-a" }).out.hookSpecificOutput);
    assert.equal(runHook("UserPromptSubmit", box.env, { session: "s-a" }).out, null);
  } finally {
    box.release();
  }
});

test("remindctl exits 1 → no injection, one errors.log line, SessionStart names `remindctl authorize`", () => {
  const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb", STUB_REMINDCTL: "fail" } });
  try {
    const { out } = runHook("SessionStart", box.env);
    assert.equal(out.hookSpecificOutput, undefined);
    assert.match(out.systemMessage, /^reminders-review: due reminders not checked: list Plumb \(.*access denied.*\); fix: `remindctl authorize`/);
    const lines = errorsLog(box);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\S+ SessionStart list Plumb: unauthorized: remindctl show (overdue|today) exited 1/);
    // The prompt hook logs and stays silent.
    assert.equal(runHook("UserPromptSubmit", box.env, { session: "s-other" }).out, null);
    assert.equal(errorsLog(box).length, 2);
  } finally {
    box.release();
  }
});

test("remindctl absent from PATH → fails open with the install line", () => {
  const box = sandbox({ withStub: false, extra: { REMINDERS_REVIEW_WATCH: "Plumb" } });
  try {
    const { out } = runHook("SessionStart", box.env);
    assert.equal(out.hookSpecificOutput, undefined);
    assert.match(out.systemMessage, /remindctl not found\); fix: install it: `brew install steipete\/tap\/remindctl`/);
    assert.equal(errorsLog(box).length, 1);
  } finally {
    box.release();
  }
});

test("a slow remindctl is cut at 2 s and the hook still answers inside the runner's 4 s", () => {
  const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb", STUB_REMINDCTL: "slow" } });
  try {
    const { out, ms } = runHook("SessionStart", box.env);
    assert.match(out.systemMessage, /no answer within 2000 ms.*`remindctl doctor`/);
    assert.ok(ms < 4_000, `took ${ms} ms`);
  } finally {
    box.release();
  }
});

test("remindctl answers text that is not JSON → no injection, logged, named", () => {
  const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb", STUB_REMINDCTL: "badjson" } });
  try {
    const { out } = runHook("SessionStart", box.env);
    assert.equal(out.hookSpecificOutput, undefined);
    assert.match(out.systemMessage, /not JSON.*`remindctl doctor`/);
    assert.equal(errorsLog(box).length, 1);
  } finally {
    box.release();
  }
});

test("fault inputs: empty stdin, malformed JSON, unknown event, unwritable state — exit 0, never a block", () => {
  const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb" } });
  try {
    for (const event of Object.keys(HOOKS)) {
      runHook(event, box.env, { stdin: "" });
      const bad = runHook(event, box.env, { stdin: "{not json" }).out;
      assert.match(bad.systemMessage, /failed open: stdin not JSON/);
      runHook(event, box.env, { stdin: JSON.stringify({ hook_event_name: "NoSuchEvent" }) });
    }
    assert.ok(errorsLog(box).some((l) => l.includes("stdin not JSON")));
    // Unwritable state: the stamp cannot be written; the check still runs and the block still comes.
    mkdirSync(join(box.stateDir, "sessions"), { recursive: true });
    chmodSync(join(box.stateDir, "sessions"), 0o555);
    try {
      const { out } = runHook("UserPromptSubmit", box.env, { session: "s-ro" });
      assert.ok(out.hookSpecificOutput.additionalContext.startsWith("Due (list Plumb): "));
      assert.ok(errorsLog(box).some((l) => l.includes("throttle stamp not written")));
    } finally {
      chmodSync(join(box.stateDir, "sessions"), 0o755);
    }
  } finally {
    box.release();
  }
});
