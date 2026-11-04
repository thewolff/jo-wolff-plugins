// register.test.mjs — mods/badge/register.mjs under `node --test`, with an in-memory `$` (the mod
// imports only ./data.mjs, so Node can load it): the timers it installs (a 1 s home probe, a 5 s
// away query), and a home probe that throws (`$.fs.exists` rejecting, as the mods types allow for a
// network location) caught inside the timer callback, clearing the badge and logged once per
// distinct message. badge.test.tsx covers the same hooks under `claude plugin test`.

import test from "node:test";
import assert from "node:assert/strict";

let fresh = 0;
/** A fresh copy of the module (its badge state is module-level) with its hooks by event name. */
async function load() {
  const { register } = await import(`../register.mjs?fresh=${++fresh}`);
  const hooks = new Map();
  register((event, fn) => hooks.set(event, fn));
  return hooks;
}

const SINCE = new Date(Date.now() - 40 * 60_000).toISOString();
const AWAY = { ok: true, away: true, since: SINCE, note: "", held: 12, onFire: 0 };
const HOME = { ok: true, away: false };

/** An in-memory `$`: `timers` by interval, `runs` each query, `statuses` and `logs` as set. */
function stub({ snapshot = HOME, exists = async () => false } = {}) {
  const s = { timers: new Map(), runs: 0, statuses: [], logs: [], snapshot, exists };
  s.$ = {
    env: { get: async (name) => (name === "XDG_STATE_HOME" ? "/tmp/state" : name === "HOME" ? "/Users/example" : undefined) },
    clock: { every: (ms, fn) => (s.timers.set(ms, fn), { cancel() {} }) },
    session: { id: async () => "s1" },
    plugin: { root: "/p" },
    process: { run: async () => (s.runs++, { exitCode: 0, stdout: JSON.stringify(s.snapshot) + "\n", stderr: "" }) },
    ui: { log: async (text) => s.logs.push(text), status: (text) => s.statuses.push(text) },
    fs: { exists: (path) => s.exists(path) },
  };
  return s;
}

const start = (hooks, s) => hooks.get("session.start")(s.$, { surface: "desktop" }, async () => ({}));

test("timers: a home probe every 1000 ms and an away query every 5000 ms; the probe does nothing while away, the away query nothing while home", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY, exists: async () => assert.fail("probed while away") });
  await start(hooks, s);
  assert.deepEqual([...s.timers.keys()].sort((a, b) => a - b), [1000, 5000]);
  assert.equal(s.runs, 1);
  await s.timers.get(1000)();
  assert.equal(s.runs, 1, "the 1 s probe queried while away");
  await s.timers.get(5000)();
  assert.equal(s.runs, 2);
  assert.match(s.statuses.at(-1), /^away 4[01]m · 12 held · say back$/);
  s.snapshot = HOME;
  await s.timers.get(5000)();
  assert.equal(s.runs, 3);
  assert.equal(s.statuses.at(-1), undefined);
  await s.timers.get(5000)();
  assert.equal(s.runs, 3, "the 5 s poll queried while home");
});

test("a home probe that rejects is caught in the timer: no rejection, the badge cleared, one `brb badge: probe:` line per distinct message", async () => {
  const hooks = await load();
  let message = "network location refused";
  const s = stub({ exists: async () => { throw new Error(message); } });
  await start(hooks, s);
  await assert.doesNotReject(async () => s.timers.get(1000)());
  await assert.doesNotReject(async () => s.timers.get(1000)());
  assert.deepEqual(s.logs, ["brb badge: probe: network location refused"]);
  assert.deepEqual(s.statuses, []);
  message = "another refusal";
  await s.timers.get(1000)();
  assert.deepEqual(s.logs, ["brb badge: probe: network location refused", "brb badge: probe: another refusal"]);
  // Once the probe answers again and a query succeeds, the badge returns and a later fault is new.
  s.exists = async () => true;
  s.snapshot = AWAY;
  await s.timers.get(1000)();
  assert.match(s.statuses.at(-1), /^away 4[01]m · 12 held · say back$/);
});

test("a session id that rejects inside the probe takes the same path", async () => {
  const hooks = await load();
  const s = stub();
  await start(hooks, s);
  s.$.session.id = async () => { throw new Error("no session"); };
  await assert.doesNotReject(async () => s.timers.get(1000)());
  assert.deepEqual(s.logs, ["brb badge: probe: no session"]);
});
