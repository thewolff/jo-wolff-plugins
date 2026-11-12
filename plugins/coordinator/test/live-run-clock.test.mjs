import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { clockLine } from "../hooks/clock.mjs";

// The canary's step 2 must match the hook's own hook_response, not the phrase wherever it lands.
const SCRIPT = readFileSync(fileURLToPath(new URL("../e2e/live-run.sh", import.meta.url)), "utf8");
const CLOCK_RE = /^CLOCK_RE='(.*)'$/m.exec(SCRIPT)?.[1];

/** Run the script's own pipeline (hook_response → UserPromptSubmit → clock regex) over `stream`. */
function step2(stream) {
  const body = /if ! (grep '"subtype":"hook_response"'.*-qE "\$CLOCK_RE"); then/.exec(SCRIPT)?.[1];
  assert.ok(CLOCK_RE && body, "live-run.sh no longer has the CLOCK_RE pipeline this test reads");
  return spawnSync("bash", ["-c", `CLOCK_RE='${CLOCK_RE}'; OUT="$1"; ${body}`, "bash", stream], { encoding: "utf8" }).status === 0;
}

function withStream(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), "coordinator-liverun-"));
  const file = join(dir, "run.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LINE = clockLine(new Date("2026-11-11T22:07:41Z"), "UTC");

test("the hook's hook_response carrying the full clock line passes", () => {
  const ev = { type: "system", subtype: "hook_response", hook_event: "UserPromptSubmit", output: JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: LINE } }) };
  assert.equal(withStream([ev], step2), true);
});

test("the phrase in the model's reply or a bare mention does not pass", () => {
  const hook = { type: "system", subtype: "hook_response", hook_event: "UserPromptSubmit", output: "{}" };
  const reply = { type: "assistant", message: { content: [{ type: "text", text: "The system clock reads something I made up" }] } };
  assert.equal(withStream([hook, reply], step2), false);
  const mention = { type: "system", subtype: "hook_response", hook_event: "UserPromptSubmit", output: "The system clock reads" };
  assert.equal(withStream([mention], step2), false);
});

test("the full clock line inside an assistant message does not pass either", () => {
  const hook = { type: "system", subtype: "hook_response", hook_event: "UserPromptSubmit", output: "{}" };
  const reply = { type: "assistant", message: { content: [{ type: "text", text: LINE }] } };
  assert.equal(withStream([hook, reply], step2), false);
});

// The canary's session check: e2e/session-check.mjs over lib/live-run.mjs's sessionProblem.
const CHECK = fileURLToPath(new URL("../e2e/session-check.mjs", import.meta.url));
const HELPER = fileURLToPath(new URL("../lib/live-run.mjs", import.meta.url));
const hookEv = { type: "system", subtype: "hook_response", hook_event: "UserPromptSubmit", output: "{}" };
const check = (events, code = 0) => withStream(events, (f) => spawnSync(process.execPath, [CHECK, HELPER, f, String(code)], { encoding: "utf8" }));

test("a stream that ends in a successful result event completes", () => {
  const r = check([hookEv, { type: "result", subtype: "success", is_error: false, terminal_reason: "completed" }]);
  assert.equal(r.status, 0, r.stdout);
});

test("a clock hook response followed by an API error is a failure, not a pass", () => {
  const r = check([hookEv, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "error", result: "API Error: 500 internal server error" }]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /terminal_reason error/);
});

test("a credential or rate-limit ending is classified unavailable (exit 2)", () => {
  const r = check([hookEv, { type: "result", subtype: "error", is_error: true, terminal_reason: "error", result: "Invalid API key. Please run /login" }]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /credentials, network or rate limit/);
});

test("a stream with no result event is a failure", () => {
  const r = check([hookEv]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no result event/);
});

test("the script fails, not skips, when the live-run helper is missing", () => {
  assert.match(SCRIPT, /fail: no live-run helper[\s\S]*?exit 1\nfi/);
  assert.doesNotMatch(SCRIPT, /hook scenarios skipped/);
});

// The non-zero-exit branch: a rate limit or an overload is unavailable (75), never a fail.
const UNAVAILABLE_RE = /^ {2}UNAVAILABLE_RE='(.*)'$/m.exec(SCRIPT)?.[1];
const unavailable = (text) => spawnSync("grep", ["-qiE", UNAVAILABLE_RE], { input: text, encoding: "utf8" }).status === 0;

test("a non-zero exit naming a rate limit or an overload is classified unavailable", () => {
  assert.ok(UNAVAILABLE_RE, "live-run.sh no longer has the UNAVAILABLE_RE this test reads");
  assert.equal(unavailable('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"..."}}'), true);
  assert.equal(unavailable('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), true);
  assert.equal(unavailable("Rate limit reached"), true);
  assert.equal(unavailable('API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'), false);
  assert.match(SCRIPT, /if \[ "\$CODE" -ne 0 \]; then[\s\S]*?session-check\.mjs[\s\S]*?-eq 2 \][\s\S]*?exit 75/);
});

test("the live run loads no user, project or local settings", () => {
  assert.match(SCRIPT, /claude -p \\\n {2}--setting-sources "" \\/);
});
