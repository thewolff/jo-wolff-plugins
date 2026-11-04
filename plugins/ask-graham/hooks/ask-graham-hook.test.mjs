import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NUDGE } from "../skills/ask-graham/scripts/intensity.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "ask-graham-hook.mjs");

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ask-graham-hook-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const xdg = join(base, "xdg");
  const repo = join(base, "repo");
  mkdirSync(join(xdg, "ask-graham"), { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, XDG_STATE_HOME: join(base, "state"), HOME: base };
  const run = (payload) =>
    spawnSync(process.execPath, [HOOK], { input: typeof payload === "string" ? payload : JSON.stringify(payload), env, encoding: "utf8", timeout: 5000 });
  return { xdg, repo, run };
}

const PROMPT = (cwd) => ({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd, prompt: "what if we built a thing" });

test("at ask the hook prints nothing and exits 0", (t) => {
  const f = fixture(t);
  const r = f.run(PROMPT(f.repo));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("at every-idea the hook adds the nudge as UserPromptSubmit context", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.xdg, "ask-graham", "config"), "intensity=every-idea\n");
  const r = f.run(PROMPT(f.repo));
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: NUDGE } });
});

test("at every-idea with a sources file, one line per source follows the nudge; missing or unparseable adds nothing and no warning", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.xdg, "ask-graham", "config"), "intensity=every-idea\n");
  const sourcesFile = join(f.xdg, "ask-graham", "sources.md");
  writeFileSync(sourcesFile, '- **Old tickets:** `todo-cli list -- "<the ask>"`\n- **Held decisions:** /tmp/fixture/HELD.md\n- no label\n');
  const r = f.run(PROMPT(f.repo));
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `${NUDGE}\nask-graham source: **Old tickets:** \`todo-cli list -- "<the ask>"\`\nask-graham source: **Held decisions:** /tmp/fixture/HELD.md`,
    },
  });
  writeFileSync(sourcesFile, "prose only, no list\n");
  assert.deepEqual(JSON.parse(f.run(PROMPT(f.repo)).stdout), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: NUDGE } });
});

test("a repo file at ask silences a user file at every-idea", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.xdg, "ask-graham", "config"), "intensity=every-idea\n");
  writeFileSync(join(f.repo, ".ask-graham"), "intensity=ask\n");
  const r = f.run(PROMPT(f.repo));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("garbage on stdin still exits 0 with no nudge", (t) => {
  const f = fixture(t);
  const r = f.run("not json");
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput, undefined);
});

test("the nudge names new ideas, the structure check for new structures in a project, and silence otherwise", () => {
  assert.match(NUDGE, /If this message proposes a new idea that doesn't exist yet \(not a ticket, bug, or task in an existing project\), run the ask-graham check/);
  assert.match(NUDGE, /If it is a task in an existing project that creates a new table, a new column on an existing table, a new top-level module, or a new service, run the ask-graham structure check \(findings only, no verdict\) before writing it\./);
  assert.match(NUDGE, /Otherwise ignore this\.$/);
});
