import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import askGrahamOmp from "./ask-graham-omp.ts";
import { NUDGE } from "../skills/ask-graham/scripts/intensity.mjs";

const EXPECTED = { message: { customType: "ask-graham", content: NUDGE, display: false } };

function fixture(t, env) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ask-graham-omp-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const xdg = join(base, "xdg");
  const repo = join(base, "repo");
  mkdirSync(join(xdg, "ask-graham"), { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  const handlers = {};
  const pi = { on: (event, h) => { handlers[event] = h; } };
  askGrahamOmp(pi, { env: env ?? { XDG_CONFIG_HOME: xdg }, home: base });
  const start = () =>
    handlers.before_agent_start(
      { type: "before_agent_start", prompt: "what if we built a thing", systemPrompt: [] },
      { cwd: repo },
    );
  return { xdg, repo, start, handlers };
}

test("registers only a before_agent_start handler", (t) => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(f.handlers), ["before_agent_start"]);
});

test("at ask the turn gets no message", (t) => {
  const f = fixture(t);
  assert.equal(f.start(), undefined);
});

test("at every-idea the turn gets the nudge as one hidden message, the same on a re-run", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.xdg, "ask-graham", "config"), "intensity=every-idea\n");
  const first = f.start();
  assert.deepEqual(first, EXPECTED);
  // OMP may run the chain more than once for one submission; each run must give the same message.
  assert.deepEqual(f.start(), first);
});

test("a repo file at ask wins over a user file at every-idea", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.xdg, "ask-graham", "config"), "intensity=every-idea\n");
  writeFileSync(join(f.repo, ".ask-graham"), "intensity=ask\n");
  assert.equal(f.start(), undefined);
});

test("a setting that cannot be resolved fails open with no message", (t) => {
  const env = {
    get XDG_CONFIG_HOME() {
      throw new Error("environment unreadable");
    },
  };
  const f = fixture(t, env);
  assert.equal(f.start(), undefined);
});
