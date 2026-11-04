// badge.test.tsx — the brb away badge mod under `claude plugin test` (run from plugins/brb).
//
// `.test.tsx`, not `.test.mjs`, so brb's `node --test` run leaves this file to the mods test kit.
// Every process the mod would start is answered by a stub: the query script by a JSON snapshot.
// `fs.exists` and `env.get` are stubbed too, so nothing here touches the state directory.

import { expect, mock, test } from "claude-code/testing";

const SESSION = "s-this-window";
const SINCE_MS = Date.now() - 40 * 60_000;
const AWAY = { ok: true, away: true, since: new Date(SINCE_MS).toISOString(), note: "", held: 12, onFire: 0 };
const HOME = { ok: true, away: false };
const BADGE = /^away 4[01]m · 12 held · say back$/;
const PROBE = `/tmp/state/brb/${SESSION}/away.json`;

type Run = { argv: string[]; init: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } };

/** The stubs every test needs; `processes` collects each process the mod started, `statuses` each status-line call. */
function stubs(on, { snapshot = AWAY as unknown, exists = false, answer = "", processRun = null as null | ((e: { argv: string[] }) => unknown) } = {}) {
  const processes: Run[] = [];
  const statuses: (string | undefined)[] = [];
  const logs: string[] = [];
  const probes: string[] = [];
  const state = { snapshot, exists, existsDeny: null as null | string, stdout: null as null | string };
  const clock = mock.clock(on);
  on("session.id", () => ({ value: SESSION }));
  on("session.start", () => ({ cwd: "/Users/example/code/this" }));
  on("turn.start", ($, e) => ({ turnId: e.turnId }));
  // The engine's default turn.complete result is `{ text: e.answer }`: Claude's whole reply.
  on("turn.complete", () => ({ text: answer }));
  on("prompt.submit", ($, e) => ({ text: e.text }));
  on("env.get", ($, e) => ({ value: e.name === "XDG_STATE_HOME" ? "/tmp/state" : e.name === "HOME" ? "/Users/example" : undefined }));
  on("fs.exists", ($, e) => {
    probes.push(e.path);
    if (state.existsDeny) return { deny: state.existsDeny };
    return { value: state.exists };
  });
  on("ui.status", ($, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on("ui.log", ($, e) => {
    logs.push(e.text);
    return { value: undefined };
  });
  on("process.run", ($, e) => {
    processes.push({ argv: e.argv, init: e.init });
    if (processRun) return processRun(e);
    const script = String(e.argv[1] ?? "");
    if (script.endsWith("mods/badge/query.mjs")) return { value: { exitCode: 0, stdout: state.stdout ?? JSON.stringify(state.snapshot) + "\n", stderr: "" } };
    return { deny: `unexpected process ${e.argv.join(" ")}` };
  });
  return { processes, statuses, logs, probes, state, clock };
}

const start = ($) => $.session.start({ surface: "terminal", isInteractive: true, cwd: "/Users/example/code/this" });
// Claude Desktop runs Claude Code headless (`--input-format stream-json`): no surface, not interactive.
const startDesktop = ($) => $.session.start({ surface: null, isInteractive: false, cwd: "/Users/example/code/this" });
const completeTurn = ($, over = {}) => $.turn.complete({ turnId: "t-1", answer: "done", durationMs: 10, isAborted: false, usage: null, ...over });

test("session.start while away: the query runs with this session, and the status line reads the badge", async ($, on) => {
  const { processes, statuses } = stubs(on);
  await start($);
  expect(processes.length).toBe(1);
  expect(processes[0].argv[0]).toBe("node");
  expect(String(processes[0].argv[1]).endsWith("mods/badge/query.mjs")).toBe(true);
  expect(processes[0].argv.slice(2)).toEqual(["--session", SESSION]);
  expect(processes[0].init.timeoutMs).toBe(5000);
  expect(statuses.length).toBe(1);
  expect(statuses[0]).toMatch(BADGE);
});

test("session.start while home: no status line is pinned, and nothing is logged", async ($, on) => {
  const { processes, statuses, logs } = stubs(on, { snapshot: HOME });
  await start($);
  expect(processes.length).toBe(1);
  expect(statuses).toEqual([]);
  expect(logs).toEqual([]);
});

test("a prompt is refreshed after it entered: `brb` pins the badge, `back` clears it; the prompt's own result is untouched", async ($, on) => {
  const { statuses, state, clock } = stubs(on, { snapshot: HOME });
  await start($);
  state.snapshot = AWAY;
  const entered = await $.prompt.submit({ text: "brb" });
  expect(entered.text).toBe("brb");
  await clock.settle();
  expect(statuses.length).toBe(1);
  expect(statuses[0]).toMatch(BADGE);
  state.snapshot = HOME;
  await $.prompt.submit({ text: "back" });
  await clock.settle();
  expect(statuses.length).toBe(2);
  expect(statuses[1]).toBe(undefined);
});

test("the status line is set once per distinct text: a refresh that changes nothing calls nothing", async ($, on) => {
  const { statuses } = stubs(on);
  await start($);
  await completeTurn($);
  await completeTurn($);
  expect(statuses.length).toBe(1);
});

test("turn.start and turn.complete refresh for the main conversation only; the turn's result is Claude's own", async ($, on) => {
  const { processes, clock } = stubs(on, { answer: "Here is the reply." });
  await start($);
  expect(processes.length).toBe(1);
  await $.turn.start({ turnId: "t-1", origin: { kind: "person" } });
  await clock.settle();
  expect(processes.length).toBe(2);
  const out = await completeTurn($);
  expect(out).toEqual({ text: "Here is the reply." });
  expect(processes.length).toBe(3);
  await $.turn.start({ turnId: "t-2", agentId: "a-1", origin: { kind: "person" } });
  await completeTurn($, { turnId: "t-2", agentId: "a-1" });
  await clock.settle();
  expect(processes.length).toBe(3);
});

test("the poll: a query every 5 s while away; while home only an fs.exists probe on away.json once a second, and a query when it appears", async ($, on) => {
  const { processes, probes, state, clock } = stubs(on);
  await start($);
  expect(processes.length).toBe(1);
  await clock.advance(4000);
  expect(processes.length).toBe(1);
  await clock.advance(11000);
  expect(processes.length).toBe(4);
  expect(probes).toEqual([]);
  state.snapshot = HOME;
  await clock.advance(5000);
  expect(processes.length).toBe(5);
  // At 20 s both timers fire; whether that probe ran depends on their order, so count from here.
  const before = probes.length;
  await clock.advance(3000);
  expect(processes.length).toBe(5);
  expect(probes.slice(before)).toEqual([PROBE, PROBE, PROBE]);
  state.exists = true;
  state.snapshot = AWAY;
  await clock.advance(1000);
  expect(processes.length).toBe(6);
});

test("Desktop (surface null, not interactive): the status line is set at start, the poll runs, and `back` clears it", async ($, on) => {
  const { processes, statuses, state, clock } = stubs(on);
  await startDesktop($);
  expect(processes.length).toBe(1);
  expect(statuses.length).toBe(1);
  expect(statuses[0]).toMatch(BADGE);
  await clock.advance(5000);
  expect(processes.length).toBe(2);
  state.snapshot = HOME;
  await $.prompt.submit({ text: "back" });
  await clock.settle();
  expect(statuses.length).toBe(2);
  expect(statuses[1]).toBe(undefined);
});

test("terminal (surface terminal): the status line is set at start", async ($, on) => {
  const { processes, statuses } = stubs(on);
  await start($);
  expect(processes.length).toBe(1);
  expect(statuses.length).toBe(1);
  expect(statuses[0]).toMatch(BADGE);
});

test("fault: the query process is denied → no badge, one dim log line, the same error not logged twice", async ($, on) => {
  const { statuses, logs } = stubs(on, { processRun: () => ({ deny: "no process for you" }) });
  await start($);
  expect(statuses).toEqual([]);
  expect(logs.filter((l) => l.startsWith("brb badge: query:")).length).toBe(1);
  expect(logs[0]).toMatch(/no process for you/);
  await completeTurn($);
  expect(logs.filter((l) => l.startsWith("brb badge: query:")).length).toBe(1);
});

test("fault: the query prints garbage while the badge shows → the badge is cleared and the fault named once", async ($, on) => {
  const { statuses, logs, state } = stubs(on);
  await start($);
  expect(statuses.length).toBe(1);
  state.stdout = "<<not json>>";
  await completeTurn($);
  expect(statuses.length).toBe(2);
  expect(statuses[1]).toBe(undefined);
  expect(logs).toEqual(["brb badge: query: query printed no JSON"]);
});

test("fault: the home probe is refused → caught inside the timer, no badge, one `brb badge: probe:` line per distinct message", async ($, on) => {
  const { statuses, logs, state, clock } = stubs(on, { snapshot: HOME });
  await start($);
  state.existsDeny = "network location refused";
  await clock.advance(3000);
  expect(statuses).toEqual([]);
  expect(logs.filter((l) => l.startsWith("brb badge: probe:")).length).toBe(1);
  expect(logs[0]).toMatch(/network location refused/);
  state.existsDeny = null;
  state.exists = true;
  state.snapshot = AWAY;
  await clock.advance(1000);
  expect(statuses.length).toBe(1);
  expect(statuses[0]).toMatch(BADGE);
});
