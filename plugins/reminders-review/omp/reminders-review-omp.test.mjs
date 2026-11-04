// The OMP adapter against a fake `pi`, with the fake remindctl from test/helpers.mjs on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import remindersReviewOmp, { MESSAGE_TYPE } from "./reminders-review-omp.ts";
import { THROTTLE_MS } from "../lib/due.mjs";
import { NOW, TZ, sandbox } from "../test/helpers.mjs";

function fakePi() {
  const handlers = new Map();
  return { on: (event, fn) => handlers.set(event, fn), fire: (event, payload, ctx) => handlers.get(event)?.(payload, ctx) };
}

const ctxFor = (id, extra = {}) => {
  const notes = [];
  return { cwd: "/tmp", hasUI: true, ui: { notify: (m, t) => notes.push([m, t]) }, sessionManager: { getSessionId: () => id }, notes, ...extra };
};

test("session_start → the block rides every before_agent_start until a context event carries it", async () => {
  const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb" } });
  try {
    let t = NOW;
    const pi = fakePi();
    remindersReviewOmp(pi, { env: box.env, now: () => t, timeZone: TZ });
    const ctx = ctxFor("omp-1");
    await pi.fire("session_start", {}, ctx);
    const a = await pi.fire("before_agent_start", {}, ctx);
    assert.equal(a.message.customType, MESSAGE_TYPE);
    assert.equal(a.message.display, false);
    assert.ok(a.message.content.startsWith("Due (list Plumb): Nov 3 9:00 AM Renew the domain; 10:00 AM "));
    const again = await pi.fire("before_agent_start", {}, ctx);
    assert.equal(again.message.details.delivery, a.message.details.delivery, "a re-run of the chain gets the same message");
    await pi.fire("context", { messages: [{ role: "user" }, { customType: MESSAGE_TYPE, details: { delivery: a.message.details.delivery } }] }, ctx);
    assert.equal(await pi.fire("before_agent_start", {}, ctx), undefined, "delivered, and within the hour");
    t = NOW + THROTTLE_MS;
    const hourly = await pi.fire("before_agent_start", {}, ctx);
    assert.notEqual(hourly.message.details.delivery, a.message.details.delivery);
    assert.deepEqual(ctx.notes, []);
  } finally {
    box.release();
  }
});

test("a failing remindctl is a UI warning naming the fix and no message; subagent sessions are skipped", async () => {
  const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb", STUB_REMINDCTL: "fail" } });
  try {
    const pi = fakePi();
    remindersReviewOmp(pi, { env: box.env, now: () => NOW, timeZone: TZ });
    const ctx = ctxFor("omp-2");
    await pi.fire("session_start", {}, ctx);
    assert.equal(await pi.fire("before_agent_start", {}, ctx), undefined);
    assert.equal(ctx.notes.length, 1);
    assert.match(ctx.notes[0][0], /fix: `remindctl authorize`/);
    assert.equal(ctx.notes[0][1], "warning");
    assert.equal(readFileSync(join(box.stateDir, "errors.log"), "utf8").trim().split("\n").length, 1);

    const sub = ctxFor("omp-sub", { agent: { kind: "sub" } });
    await pi.fire("session_start", {}, sub);
    assert.equal(await pi.fire("before_agent_start", {}, sub), undefined);
    assert.equal(existsSync(join(box.stateDir, "sessions", "omp-sub.json")), false);
  } finally {
    box.release();
  }
});

test("unconfigured: nothing on any event", async () => {
  const box = sandbox();
  try {
    const pi = fakePi();
    remindersReviewOmp(pi, { env: box.env });
    const ctx = ctxFor("omp-3");
    await pi.fire("session_start", {}, ctx);
    assert.equal(await pi.fire("before_agent_start", {}, ctx), undefined);
    assert.equal(existsSync(box.calls), false);
  } finally {
    box.release();
  }
});

// Session isolation (Codex review RR-01): a pending block belongs to the session that produced it.
const EMPTY = join(import.meta.dirname, "..", "test", "fixtures", "remindctl-show-empty.json");

for (const [what, next] of [
  ["empty", { STUB_OVERDUE: EMPTY, STUB_TODAY: EMPTY }],
  ["failing", { STUB_REMINDCTL: "fail" }],
  ["unconfigured", { REMINDERS_REVIEW_WATCH: "" }],
]) {
  test(`switching to a session whose check is ${what} drops the old session's undelivered block`, async () => {
    const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb" } });
    try {
      const env = { ...box.env };
      const pi = fakePi();
      remindersReviewOmp(pi, { env, now: () => NOW, timeZone: TZ });
      const a = ctxFor("omp-A");
      await pi.fire("session_start", {}, a);
      assert.ok((await pi.fire("before_agent_start", {}, a)).message, "A has its block, never acknowledged");
      Object.assign(env, next);
      const b = ctxFor("omp-B");
      await pi.fire("session_switch", {}, b);
      assert.equal(await pi.fire("before_agent_start", {}, b), undefined, "B never sees A's block");
    } finally {
      box.release();
    }
  });
}

test("a new session id without a switch event never receives another session's block", async () => {
  const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb" } });
  try {
    const env = { ...box.env };
    const pi = fakePi();
    remindersReviewOmp(pi, { env, now: () => NOW, timeZone: TZ });
    const a = ctxFor("omp-A");
    await pi.fire("session_start", {}, a);
    const first = await pi.fire("before_agent_start", {}, a);
    Object.assign(env, { STUB_OVERDUE: EMPTY, STUB_TODAY: EMPTY });
    assert.equal(await pi.fire("before_agent_start", {}, ctxFor("omp-C")), undefined);
    assert.equal(await pi.fire("before_agent_start", {}, a), undefined, "dropped, not parked for A");
    assert.ok(first.message);
  } finally {
    box.release();
  }
});

test("a subagent never receives a pending block, whatever its session id", async () => {
  const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb" } });
  try {
    const pi = fakePi();
    remindersReviewOmp(pi, { env: box.env, now: () => NOW, timeZone: TZ });
    const main = ctxFor("omp-A");
    await pi.fire("session_start", {}, main);
    const delivered = await pi.fire("before_agent_start", {}, main);
    assert.ok(delivered.message);
    assert.equal(await pi.fire("before_agent_start", {}, ctxFor("omp-A", { agent: { kind: "sub" } })), undefined);
    assert.equal(await pi.fire("before_agent_start", {}, ctxFor("omp-sub", { agent: { kind: "sub" } })), undefined);
    const again = await pi.fire("before_agent_start", {}, main);
    assert.equal(again.message.details.delivery, delivered.message.details.delivery, "the main session still has it");
  } finally {
    box.release();
  }
});

test("a check still running when the session switches cannot land its block in the new session", async () => {
  const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb" } });
  try {
    const env = { ...box.env, STUB_REMINDCTL: "delay", STUB_DELAY: "0.6" };
    const pi = fakePi();
    remindersReviewOmp(pi, { env, now: () => NOW, timeZone: TZ });
    const a = ctxFor("omp-A");
    const slow = pi.fire("session_start", {}, a); // remindctl is already running, for A
    delete env.STUB_REMINDCTL;
    Object.assign(env, { STUB_OVERDUE: EMPTY, STUB_TODAY: EMPTY });
    const b = ctxFor("omp-B");
    await pi.fire("session_switch", {}, b);
    await slow;
    assert.equal(await pi.fire("before_agent_start", {}, b), undefined);
    assert.deepEqual(a.notes, []);
  } finally {
    box.release();
  }
});
