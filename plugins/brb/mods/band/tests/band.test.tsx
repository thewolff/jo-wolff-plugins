// band.test.tsx — the brb away band under `claude plugin test` (run from plugins/brb): the
// `AbovePrompt` site mounted through the kit in both session payloads (Claude Desktop's
// `surface: null, isInteractive: false` and the terminal's), asserting the drawn tree: the
// headline, the numbered rows, the Back button while away; BACK with Done per row and Clear
// after back; the band gone once every row is done or on Clear; the fallback status line only
// where the band never draws; the timers.
//
// `.test.tsx`, not `.test.mjs`, so brb's `node --test` run leaves this file to the mods test kit.
// Every process the mod would start is answered by a stub: the query script by a JSON snapshot,
// the action script by a change to that snapshot. `fs.exists` and `env.get` are stubbed too, so
// nothing here touches the state directory.

import { expect, mock, test } from "claude-code/testing";

const SESSION = "s-this-window";
const SINCE = new Date(Date.now() - 40 * 60_000).toISOString();
const ITEMS = ["Create the read-token secret on the org?", "Billing limit on the org: raise it?", "Clear the review round"];
const AWAY = { ok: true, away: true, since: SINCE, note: "lunch", held: 3, onFire: 1, items: ITEMS, backRequested: false };
const HOME = { ok: true, away: false, checklist: null };
const CHECKLIST = { ok: true, away: false, checklist: { at: SINCE, since: SINCE, note: "lunch", items: ITEMS.map((text) => ({ text, done: false })) } };
const HEADLINE = /^AWAY 4[01]m · 3 held · lunch$/;
const PROBE = `/tmp/state/brb/${SESSION}/away.json`;
const THEIRS = "drawn by Claude Code";

const BAND = {
  plugin: "brb",
  component: "AbovePrompt",
  requestId: "brb-band",
  viewport: { columns: 100, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 15, bodyColumns: 100, scroll: { offset: 0, bodyRows: 14 } },
} as const;

type Item = { text: string; done: boolean };
type Checklist = { at: string; since: string; note: string; items: Item[] };
/** What query.mjs prints, loose enough for every test's snapshot. */
type Snapshot = { ok: boolean; away: boolean; checklist?: Checklist | null } & Record<string, unknown>;

/** The stubs every test needs; `acts` collects each action argv tail, `statuses` each status-line call, `suggestions` each prompt-box text. */
function stubs(on, { snapshot = AWAY as Snapshot, exists = false } = {}) {
  const acts: string[][] = [];
  const statuses: (string | undefined)[] = [];
  const suggestions: string[] = [];
  const logs: string[] = [];
  const probes: string[] = [];
  const queries: string[][] = [];
  const state: { snapshot: Snapshot; exists: boolean; session: string } = { snapshot, exists, session: SESSION };
  const clock = mock.clock(on);
  on("session.id", () => ({ value: state.session }));
  on("classic.SessionStart", () => ({}));
  on("session.start", () => ({ cwd: "/Users/example/code/this" }));
  on("session.end", ($, e) => ({ sessionId: e.sessionId }));
  on("turn.start", ($, e) => ({ turnId: e.turnId }));
  on("turn.complete", () => ({ text: "" }));
  on("prompt.submit", ($, e) => ({ text: e.text }));
  on("prompt.suggest", ($, e) => {
    suggestions.push(e.text);
    return { isShown: true };
  });
  on("ui.render", () => ({ type: "Text", props: {}, children: [THEIRS] }));
  on("env.get", ($, e) => ({ value: e.name === "XDG_STATE_HOME" ? "/tmp/state" : e.name === "HOME" ? "/Users/example" : undefined }));
  on("fs.exists", ($, e) => {
    probes.push(e.path);
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
    const script = String(e.argv[1] ?? "");
    if (script.endsWith("mods/band/query.mjs")) {
      queries.push(e.argv.slice(2).concat(state.session === SESSION ? [] : ["@" + state.session]));
      return { value: { exitCode: 0, stdout: JSON.stringify(state.snapshot) + "\n", stderr: "" } };
    }
    if (script.endsWith("mods/band/act.mjs")) {
      const [verb, index] = e.argv.slice(4);
      acts.push(e.argv.slice(4));
      const s = state.snapshot;
      if (verb === "back") state.snapshot = { ...s, backRequested: true };
      if (verb === "clear") state.snapshot = HOME;
      if (verb === "done" && s.checklist) {
        const items = s.checklist.items.map((it, i) => (i === Number(index) ? { ...it, done: !it.done } : it));
        state.snapshot = items.every((it) => it.done) ? HOME : { ...s, checklist: { ...s.checklist, items } };
      }
      return { value: { exitCode: 0, stdout: '{"ok":true}\n', stderr: "" } };
    }
    return { deny: `unexpected process ${e.argv.join(" ")}` };
  });
  return { acts, statuses, suggestions, logs, probes, queries, state, clock };
}

const SESSIONS = [
  ["Desktop (surface null, not interactive)", { surface: null, isInteractive: false, cwd: "/Users/example/code/this" }, "desktop"],
  ["terminal (surface terminal, interactive)", { surface: "terminal", isInteractive: true, cwd: "/Users/example/code/this" }, "terminal"],
] as const;

/** Whether row `n` (`n. …`) is drawn. */
const row = (ui, n: number) => ui.find({ type: "Text", text: new RegExp(`^${n}\\. `) });

for (const [where, payload, surface] of SESSIONS) {
  test(`${where}: away draws the headline, the on-fire line, one row per held item and a Back button; the prompt box suggests the way back`, async ($, on) => {
    const { queries, suggestions, statuses } = stubs(on);
    await $.session.start(payload);
    expect(queries[0]).toEqual(["--session", SESSION]);
    const ui = await $.ui.mount({ ...BAND, surface });
    expect(await ui.find({ type: "Text", text: HEADLINE })).toBeDefined();
    expect(await ui.find({ type: "Text", text: "1 on fire came through · the rest wait for you" })).toBeDefined();
    expect(await row(ui, 1)).toBeDefined();
    expect(await row(ui, 3)).toBeDefined();
    expect(await row(ui, 4)).toBeUndefined();
    expect(await ui.find({ type: "Text", text: `1. ${ITEMS[0]}` })).toBeDefined();
    expect(await ui.find({ key: "back" })).toBeDefined();
    expect(await ui.find({ key: "clear" })).toBeUndefined();
    expect(suggestions[0]).toMatch(/^away 4[01]m — type back$/);
    expect(statuses).toEqual([]);
    await ui.unmount();
  });

  test(`${where}: Back runs the action, suggests \`back\`, and the band says the next prompt ends the hold`, async ($, on) => {
    const { acts, suggestions, clock } = stubs(on);
    await $.session.start(payload);
    const ui = await $.ui.mount({ ...BAND, surface });
    await ui.press({ key: "back" });
    await clock.settle();
    expect(acts).toEqual([["back"]]);
    expect(suggestions.at(-1)).toBe("back");
    await ui.unmount();
    const again = await $.ui.mount({ ...BAND, surface });
    expect(await again.find({ type: "Text", text: /^Back pressed · the next prompt ends the hold/ })).toBeDefined();
    await again.unmount();
  });

  test(`${where}: after back the band is a checklist: BACK headline, Done per row, Clear; Done strikes a row and persists; all done clears the band`, async ($, on) => {
    const { acts, clock } = stubs(on, { snapshot: CHECKLIST });
    await $.session.start(payload);
    let ui = await $.ui.mount({ ...BAND, surface });
    expect(await ui.find({ type: "Text", text: "BACK · 3 to act on" })).toBeDefined();
    expect(await ui.find({ key: "clear" })).toBeDefined();
    expect(await ui.find({ key: "done-1" })).toBeDefined();
    expect(await ui.find({ key: "done-3" })).toBeDefined();
    expect(await ui.find({ key: "done-4" })).toBeUndefined();
    expect(await ui.find({ key: "back" })).toBeUndefined();

    await ui.press({ key: "done-2" });
    await clock.settle();
    expect(acts).toEqual([["done", "1"]]);
    await ui.unmount();
    ui = await $.ui.mount({ ...BAND, surface });
    expect(await ui.find({ type: "Text", text: "BACK · 2 to act on" })).toBeDefined();
    const struck = await ui.find({ type: "Text", text: `2. ${ITEMS[1]}` });
    expect(struck?.props.strikethrough).toBe(true);
    expect((await ui.find({ key: "done-2" }))?.props.label).toBe("Undo");

    await ui.press({ key: "done-1" });
    await ui.press({ key: "done-3" });
    await clock.settle();
    await ui.unmount();
    ui = await $.ui.mount({ ...BAND, surface });
    expect(await ui.find({ type: "Text", text: /^BACK/ })).toBeUndefined();
    expect(await ui.find({ type: "Text", text: THEIRS })).toBeDefined();
    await ui.unmount();
  });

  test(`${where}: Clear removes the checklist and the band`, async ($, on) => {
    const { acts, clock } = stubs(on, { snapshot: CHECKLIST });
    await $.session.start(payload);
    let ui = await $.ui.mount({ ...BAND, surface });
    await ui.press({ key: "clear" });
    await clock.settle();
    expect(acts).toEqual([["clear"]]);
    await ui.unmount();
    ui = await $.ui.mount({ ...BAND, surface });
    expect(await ui.find({ type: "Text", text: /^BACK/ })).toBeUndefined();
    await ui.unmount();
  });
}

test("home with no checklist: the band passes to what Claude Code draws, and nothing is suggested", async ($, on) => {
  const { suggestions } = stubs(on, { snapshot: HOME });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/Users/example/code/this" });
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /^AWAY/ })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: THEIRS })).toBeDefined();
  expect(suggestions).toEqual([]);
  await ui.unmount();
});

test("more than 10 held items: 10 rows and `+N more`", async ($, on) => {
  const items = Array.from({ length: 14 }, (_, i) => `held item ${i + 1}`);
  stubs(on, { snapshot: { ...AWAY, held: 14, onFire: 0, items } });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/Users/example/code/this" });
  const ui = await $.ui.mount({ ...BAND, surface: "terminal", props: { ...BAND.props, maxRows: 40 } });
  expect(await row(ui, 10)).toBeDefined();
  expect(await row(ui, 11)).toBeUndefined();
  expect(await ui.find({ type: "Text", text: "+4 more" })).toBeDefined();
  await ui.unmount();
});

test("fallback: where the band is never drawn, the status line carries the hold after the first tick; once it draws, the line is cleared", async ($, on) => {
  const { statuses, clock } = stubs(on);
  await $.session.start({ surface: null, isInteractive: false, cwd: "/Users/example/code/this" });
  expect(statuses).toEqual([]);
  await clock.advance(5000);
  expect(statuses.at(-1)).toMatch(/^away 4[01]m · lunch · 3 held · say back$/);
  const ui = await $.ui.mount({ ...BAND, surface: "desktop" });
  expect(statuses.at(-1)).toBe(undefined);
  const n = statuses.length;
  await clock.advance(5000);
  expect(statuses.length).toBe(n);
  await ui.unmount();
});

test("the poll: a query every 5 s while away; while home only an fs.exists probe once a second, and a query when away.json appears; session.end stops both", async ($, on) => {
  const { queries, probes, state, clock } = stubs(on);
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/Users/example/code/this" });
  expect(queries.length).toBe(1);
  await clock.advance(15000);
  expect(queries.length).toBe(4);
  expect(probes).toEqual([]);
  state.snapshot = HOME;
  await clock.advance(5000);
  expect(queries.length).toBe(5);
  const before = probes.length;
  await clock.advance(3000);
  expect(queries.length).toBe(5);
  expect(probes.slice(before)).toEqual([PROBE, PROBE, PROBE]);
  state.exists = true;
  state.snapshot = AWAY;
  await clock.advance(1000);
  expect(queries.length).toBe(6);
  await $.session.end({ reason: "prompt_input_exit", sessionId: SESSION });
  await clock.advance(20000);
  expect(queries.length).toBe(6);
});

test("a prompt is refreshed after it entered: `brb` brings the band at once; the prompt's own result is untouched", async ($, on) => {
  const { state, clock } = stubs(on, { snapshot: HOME });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/Users/example/code/this" });
  state.snapshot = AWAY;
  const entered = await $.prompt.submit({ text: "brb lunch" });
  expect(entered.text).toBe("brb lunch");
  await clock.settle();
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: HEADLINE })).toBeDefined();
  await ui.unmount();
});

for (const [where, payload, surface] of SESSIONS) {
  for (const source of ["clear", "resume", "fork"] as const) {
    test(`R1 B1 ${where}, ${source}: after session.end and classic.SessionStart the last conversation's band is gone, one poll runs again, and the new conversation draws`, async ($, on) => {
      const { queries, statuses, state, clock } = stubs(on, { snapshot: CHECKLIST });
      await $.session.start(payload);
      let ui = await $.ui.mount({ ...BAND, surface });
      expect(await ui.find({ type: "Text", text: "BACK · 3 to act on" })).toBeDefined();
      await ui.unmount();
      await $.session.end({ reason: source === "fork" ? "resume" : source, sessionId: SESSION });
      state.session = "s-next";
      state.snapshot = HOME;
      await $.classic.SessionStart({ source, sessionId: "s-next", hookEventName: "SessionStart" });
      await clock.settle();
      ui = await $.ui.mount({ ...BAND, surface });
      expect(await ui.find({ type: "Text", text: /^BACK/ })).toBeUndefined();
      expect(await ui.find({ type: "Text", text: THEIRS })).toBeDefined();
      await ui.unmount();
      const before = queries.length;
      state.snapshot = AWAY;
      state.exists = true;
      await clock.advance(1000);
      expect(queries.length).toBe(before + 1);
      expect(queries.at(-1)).toEqual(["--session", "s-next", "@s-next"]);
      await clock.advance(5000);
      expect(queries.length).toBe(before + 2);
      ui = await $.ui.mount({ ...BAND, surface });
      expect(await ui.find({ type: "Text", text: HEADLINE })).toBeDefined();
      await ui.unmount();
      expect(statuses.at(-1)).toBe(undefined);
    });
  }
}

test("R1 B1: classic.SessionStart at startup and compact leaves the band and the poll as they were", async ($, on) => {
  const { queries, clock } = stubs(on);
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/Users/example/code/this" });
  await $.classic.SessionStart({ source: "startup", sessionId: SESSION, hookEventName: "SessionStart" });
  await $.classic.SessionStart({ source: "compact", sessionId: SESSION, hookEventName: "SessionStart" });
  expect(queries.length).toBe(1);
  await clock.advance(5000);
  expect(queries.length).toBe(2);
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: HEADLINE })).toBeDefined();
  await ui.unmount();
});

test("R1 S1: 11 checklist rows with the first 10 done: row 11 shows with its Done button and `10 done` sums the rest", async ($, on) => {
  const items = Array.from({ length: 11 }, (_, i) => ({ text: `item ${i + 1}`, done: i < 10 }));
  const { acts, clock } = stubs(on, { snapshot: { ...CHECKLIST, checklist: { ...CHECKLIST.checklist, items } } });
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/Users/example/code/this" });
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: "11. item 11" })).toBeDefined();
  expect((await ui.find({ key: "done-11" }))?.props.label).toBe("Done");
  expect(await ui.find({ type: "Text", text: "10 done" })).toBeDefined();
  await ui.press({ key: "done-11" });
  await clock.settle();
  expect(acts).toEqual([["done", "10"]]);
  await ui.unmount();
});
