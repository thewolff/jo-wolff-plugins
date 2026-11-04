// test/hook-contract.test.mjs — the repository's hook bar (AGENTS.md: can't break the session,
// failures visible) for every hook in hooks/hooks.json, each run as a spawned process on the
// five fault inputs: empty stdin, malformed JSON, an unknown event, an unwritable state
// directory, and no config (an empty HOME). Each exits 0 inside 5 s with no deny, block or
// `continue: false`; malformed JSON leaves one errors.log line and a systemMessage (SessionEnd
// has no reader for the message, so its log line is the trace). `ledger gate check` runs the
// same inputs before a push; this test is the one you run locally.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")).name;
const BUDGET_MS = 5_000;
const hooksJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
// Six hooks share three events, so each runs under its script name (`spawn-gate`, not
// `PreToolUse`): that is the name in its errors.log line and its failed-open systemMessage.
const HOOKS = Object.entries(hooksJson.hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({ event, name: /\/([a-z-]+)\.mjs"?$/.exec(h.command)[1], command: h.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT) }))));

/** An empty HOME and XDG directories under a temp root, with a writable errors.log already there. */
function box() {
  const root = mkdtempSync(join(tmpdir(), `${PLUGIN}-contract-`));
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), TMPDIR: join(root, "tmp") };
  for (const d of Object.values(env).slice(1)) mkdirSync(d, { recursive: true });
  mkdirSync(join(env.XDG_STATE_HOME, PLUGIN), { recursive: true });
  writeFileSync(join(env.XDG_STATE_HOME, PLUGIN, "errors.log"), "");
  const release = () => {
    for (const d of [join(env.XDG_STATE_HOME, PLUGIN), env.XDG_DATA_HOME]) chmodSync(d, 0o755);
    rmSync(root, { recursive: true, force: true });
  };
  return { root, env, errorsLog: join(env.XDG_STATE_HOME, PLUGIN, "errors.log"), release };
}
const input = (event, cwd) => JSON.stringify({ session_id: "s-contract", cwd, hook_event_name: event, tool_name: "Bash", tool_input: { command: "ls" }, prompt: "carry on", stop_hook_active: false, last_assistant_message: "Done.", source: "startup", reason: "exit" });

function run(b, hook, stdin, { readOnly = false } = {}) {
  if (readOnly) for (const d of [join(b.env.XDG_STATE_HOME, PLUGIN), b.env.XDG_DATA_HOME]) chmodSync(d, 0o555);
  const started = Date.now();
  try {
    const r = spawnSync("/bin/sh", ["-c", hook.command], { cwd: b.root, env: b.env, input: stdin, encoding: "utf8", timeout: BUDGET_MS, killSignal: "SIGKILL" });
    return { ...r, ms: Date.now() - started };
  } finally {
    if (readOnly) for (const d of [join(b.env.XDG_STATE_HOME, PLUGIN), b.env.XDG_DATA_HOME]) chmodSync(d, 0o755);
  }
}

function assertAllowed(r, what) {
  assert.equal(r.error, undefined, `${what}: ${r.error?.message}`);
  assert.equal(r.status, 0, `${what}: exit ${r.status} ${r.stderr}`);
  assert.ok(r.ms < BUDGET_MS, `${what}: took ${r.ms} ms`);
  if (!r.stdout.trim()) return null;
  const json = JSON.parse(r.stdout);
  assert.notEqual(json.hookSpecificOutput?.permissionDecision, "deny", `${what}: denied`);
  assert.notEqual(json.decision, "block", `${what}: blocked`);
  assert.notEqual(json.continue, false, `${what}: stopped the session`);
  return json;
}

test("hooks.json names at least one hook, each through CLAUDE_PLUGIN_ROOT with a timeout inside the budget", () => {
  assert.ok(HOOKS.length > 0, "no hooks in hooks/hooks.json");
  for (const groups of Object.values(hooksJson.hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        assert.match(h.command, /\$\{CLAUDE_PLUGIN_ROOT\}/, h.command);
        assert.ok((h.timeout ?? 60) <= 5, `${h.command}: timeout ${h.timeout} is over the 5 s budget`);
      }
    }
  }
});

for (const hook of HOOKS) {
  test(`${hook.event} ${hook.name}: the five fault inputs exit 0 inside ${BUDGET_MS} ms with no deny or block`, () => {
    const b = box();
    try {
      assertAllowed(run(b, hook, ""), `${hook.event} on empty stdin`);
      assertAllowed(run(b, hook, "{not json"), `${hook.event} on malformed JSON`);
      assertAllowed(run(b, hook, input("NoSuchEvent", b.root)), `${hook.event} on an unknown event`);
      assertAllowed(run(b, hook, input(hook.event, b.root), { readOnly: true }), `${hook.event} on an unwritable state`);
      assertAllowed(run(b, hook, input(hook.event, b.root)), `${hook.event} with no config`);
    } finally {
      b.release();
    }
  });

  test(`${hook.event} ${hook.name}: malformed JSON is visible: one errors.log line${hook.event === "SessionEnd" ? "" : " and a systemMessage"}`, () => {
    const b = box();
    try {
      const json = assertAllowed(run(b, hook, "{not json"), `${hook.event} on malformed JSON`);
      const lines = readFileSync(b.errorsLog, "utf8").split("\n").filter(Boolean);
      assert.equal(lines.length, 1, lines.join("\n"));
      assert.match(lines[0], new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+ ${hook.name} stdin not JSON`));
      if (hook.event !== "SessionEnd") assert.match(json?.systemMessage ?? "", new RegExp(`^${PLUGIN} ${hook.name} failed open: stdin not JSON`));
    } finally {
      b.release();
    }
  });
}
