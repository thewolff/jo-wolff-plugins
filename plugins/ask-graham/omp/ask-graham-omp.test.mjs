import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import askGrahamOmp from "./ask-graham-omp.ts";
import { NUDGE } from "../skills/ask-graham/scripts/intensity.mjs";

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ask-graham-omp-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const xdg = join(base, "xdg");
  const repo = join(base, "repo");
  mkdirSync(join(xdg, "ask-graham"), { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  const handlers = {};
  const sent = [];
  const pi = {
    on: (event, h) => { handlers[event] = h; },
    sendMessage: (message, options) => sent.push({ message, options }),
  };
  askGrahamOmp(pi, { env: { XDG_CONFIG_HOME: xdg }, home: base });
  const input = (source = "interactive") => handlers.input({ text: "what if we built a thing", source }, { cwd: repo });
  return { xdg, repo, sent, input, handlers };
}

test("registers only an input handler", (t) => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(f.handlers), ["input"]);
});

test("at ask nothing is sent", (t) => {
  const f = fixture(t);
  assert.equal(f.input(), undefined);
  assert.deepEqual(f.sent, []);
});

test("at every-idea the nudge goes to the turn as hidden context, input untouched", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.xdg, "ask-graham", "config"), "intensity=every-idea\n");
  assert.equal(f.input("interactive"), undefined);
  assert.equal(f.input("rpc"), undefined);
  assert.deepEqual(f.sent, [
    { message: { customType: "ask-graham", content: NUDGE, display: false }, options: { deliverAs: "nextTurn" } },
    { message: { customType: "ask-graham", content: NUDGE, display: false }, options: { deliverAs: "nextTurn" } },
  ]);
});

test("text another extension injected gets no nudge", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.xdg, "ask-graham", "config"), "intensity=every-idea\n");
  f.input("extension");
  assert.deepEqual(f.sent, []);
});

test("a repo file at ask wins over a user file at every-idea", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.xdg, "ask-graham", "config"), "intensity=every-idea\n");
  writeFileSync(join(f.repo, ".ask-graham"), "intensity=ask\n");
  f.input();
  assert.deepEqual(f.sent, []);
});
