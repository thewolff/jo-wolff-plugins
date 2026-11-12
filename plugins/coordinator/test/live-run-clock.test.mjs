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
