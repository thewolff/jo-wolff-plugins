// communication-rules-inject.test.mjs — node --test
//
// The injector is tested as a subprocess with an isolated $HOME because its R6 half writes a
// state marker next to the profile it already reads. The emission half is regression cover:
// the marker work must never disturb the session text.
//
// Run: node --test plugins/communication-rules/hooks/

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INJECTOR = fileURLToPath(new URL("./communication-rules-inject.mjs", import.meta.url));

function mkhome() {
  const home = mkdtempSync(join(tmpdir(), "commrules-inj-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

function runInject(payload, home) {
  return spawnSync(process.execPath, [INJECTOR], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, HOME: home, COMMUNICATION_RULES_INJECT: "", COMMUNICATION_RULES_PROFILE: "" },
    cwd: join(INJECTOR, ".."),
    timeout: 30_000,
  });
}

const markerPath = (home, sid) => join(home, ".claude", ".communication-rules-state", `resume-${sid}`);

// ─── emission regression ─────────────────────────────────────────────────────

test("a plain startup still emits the skill core and exits 0, and writes no marker", () => {
  const home = mkhome();
  const r = runInject({ session_id: "s1", source: "startup" }, home);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /Needs you first/);
  assert.ok(!existsSync(markerPath(home, "s1")));
});

test("no stdin at all still emits and exits 0", () => {
  const home = mkhome();
  const r = spawnSync(process.execPath, [INJECTOR], {
    input: "",
    encoding: "utf8",
    env: { ...process.env, HOME: home, COMMUNICATION_RULES_INJECT: "", COMMUNICATION_RULES_PROFILE: "" },
    timeout: 30_000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /additionalContext/);
});

// ─── the R6 marker ───────────────────────────────────────────────────────────

test("source=resume writes a one-shot marker for the session", () => {
  const home = mkhome();
  const r = runInject({ session_id: "res1", source: "resume" }, home);
  assert.equal(r.status, 0);
  assert.ok(existsSync(markerPath(home, "res1")), "marker file written");
  assert.match(readFileSync(markerPath(home, "res1"), "utf8"), /\d{4}-\d{2}-\d{2}T/); // timestamped
  assert.match(r.stdout, /additionalContext/); // the session text is unaffected
});

test("source=compact writes the marker", () => {
  const home = mkhome();
  runInject({ session_id: "cmp1", source: "compact" }, home);
  assert.ok(existsSync(markerPath(home, "cmp1")));
});

test("source=clear with a compact reason writes the marker; plain clear does not", () => {
  const home = mkhome();
  runInject({ session_id: "cl1", source: "clear", reason: "context compacted by /compact" }, home);
  assert.ok(existsSync(markerPath(home, "cl1")));

  const home2 = mkhome();
  runInject({ session_id: "cl2", source: "clear", reason: "user ran /clear" }, home2);
  assert.ok(!existsSync(markerPath(home2, "cl2")));
});

test("no session_id means no marker — there is nothing to key it to", () => {
  const home = mkhome();
  runInject({ source: "resume" }, home);
  assert.ok(!existsSync(join(home, ".claude", ".communication-rules-state")));
});

test("unparseable stdin is fail-open: emit, exit 0, no marker", () => {
  const home = mkhome();
  const r = spawnSync(process.execPath, [INJECTOR], {
    input: "not json",
    encoding: "utf8",
    env: { ...process.env, HOME: home, COMMUNICATION_RULES_INJECT: "", COMMUNICATION_RULES_PROFILE: "" },
    timeout: 30_000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /additionalContext/);
  assert.ok(!existsSync(join(home, ".claude", ".communication-rules-state")));
});
