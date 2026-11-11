// band.test.tsx — the brb away band under `claude plugin test` (run from plugins/brb): the
// `AbovePrompt` site mounted through the kit in both session payloads (Claude Desktop's
// `surface: null, isInteractive: false` and the terminal's), asserting the drawn tree: the
// headline, the numbered rows, the Back button while away (a press sends `back` through
// `$.prompt.submit` as the person's prompt, with a toast); BACK with Done per row and Clear
// after back; the band gone once every row is done or on Clear; the fallback status line only
// where the band never draws; the timers.
//
// `.test.tsx`, not `.test.mjs`, so brb's `node --test` run leaves this file to the mods test kit.
// Every process the mod would start is answered by a stub: the query script by a JSON snapshot,
// the action script by a change to that snapshot. `fs.exists` and `env.get` are stubbed too, so
// nothing here touches the state directory.

import { expect, mock, test } from "claude-code/testing";
import { AWAY_TEXT, HELD_LINE } from "../hide.mjs";

const SESSION = "s-this-window";
const SINCE = new Date(Date.now() - 40 * 60_000).toISOString();
const ITEMS = ["Create the read-token secret on the org?", "Billing limit on the org: raise it?", "Clear the review round"];
const AWAY = { ok: true, away: true, since: SINCE, note: "lunch", held: 3, onFire: 1, items: ITEMS };
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

/** The stubs every test needs; `acts` collects each action argv tail, `statuses` each status-line call, `suggestions` each prompt-box text, `submits` each prompt the mod submits, `toasts` each toast. */
function stubs(on, { snapshot = AWAY as Snapshot, exists = false } = {}) {
  const acts: string[][] = [];
  const statuses: (string | undefined)[] = [];
  const suggestions: string[] = [];
  const logs: string[] = [];
  const probes: string[] = [];
  const queries: string[][] = [];
  const submits: { text: string; origin?: unknown }[] = [];
  const toasts: string[] = [];
  const state: { snapshot: Snapshot; exists: boolean; session: string } = { snapshot, exists, session: SESSION };
  const clock = mock.clock(on);
  on("session.id", () => ({ value: state.session }));
  on("classic.SessionStart", () => ({}));
  on("session.start", () => ({ cwd: "/Users/example/code/this" }));
  on("session.end", ($, e) => ({ sessionId: e.sessionId }));
  on("turn.start", ($, e) => ({ turnId: e.turnId }));
  on("turn.complete", () => ({ text: "" }));
  // Every prompt arrives here: one the test types (`$.prompt.submit`, no origin) and the mod's own
  // (origin plugin). `back` while away stands for the prompt hook ending the hold (the checklist);
  // `submits` collects only the mod's.
  on("prompt.submit", ($, e) => {
    if (e.origin?.kind === "plugin") submits.push({ text: e.text, origin: e.origin });
    if (e.text === "back" && state.snapshot.away) state.snapshot = CHECKLIST;
    return { text: e.text };
  });
  on("ui.toast", ($, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
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
      if (verb === "back") return { value: { exitCode: 0, stdout: JSON.stringify(s.away ? { ok: true, away: true, since: s.since } : { ok: true, away: false }) + "\n", stderr: "" } };
      if (verb === "clear") state.snapshot = HOME;
      if (verb === "done" && s.checklist) {
        const items = s.checklist.items.map((it, i) => (i === Number(index) ? { ...it, done: !it.done } : it));
        state.snapshot = items.every((it) => it.done) ? HOME : { ...s, checklist: { ...s.checklist, items } };
      }
      return { value: { exitCode: 0, stdout: '{"ok":true}\n', stderr: "" } };
    }
    return { deny: `unexpected process ${e.argv.join(" ")}` };
  });
  return { acts, statuses, suggestions, logs, probes, queries, submits, toasts, state, clock };
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

  test(`${where}: Back sends \`back\` as the person's prompt once, with one toast, and the band turns into the checklist`, async ($, on) => {
    const { acts, submits, toasts, clock } = stubs(on);
    await $.session.start(payload);
    const ui = await $.ui.mount({ ...BAND, surface });
    await ui.press({ key: "back" });
    await clock.settle();
    expect(acts).toEqual([["back"]]);
    expect(submits).toEqual([{ text: "back", origin: { kind: "plugin", name: "brb", asUser: true } }]);
    expect(toasts).toEqual(["brb: Back pressed, ending the hold"]);
    await ui.unmount();
    await $.turn.complete({ turnId: "t-back", answer: "", durationMs: 1, isAborted: false, usage: null });
    const again = await $.ui.mount({ ...BAND, surface });
    expect(await again.find({ type: "Text", text: "BACK · 3 to act on" })).toBeDefined();
    expect(await again.find({ key: "back" })).toBeUndefined();
    await again.unmount();
  });

  test(`${where}: Back pressed while a turn runs waits for its end; \`back\` typed meanwhile ends the hold, and the press sends nothing`, async ($, on) => {
    const { acts, submits, toasts, clock } = stubs(on);
    await $.session.start(payload);
    await $.turn.start({ turnId: "t-work" });
    const ui = await $.ui.mount({ ...BAND, surface });
    await ui.press({ key: "back" });
    await clock.settle();
    expect(toasts).toEqual(["brb: Back pressed, ending the hold"]);
    expect(submits).toEqual([]);
    await ui.unmount();
    await $.prompt.submit({ text: "back" });
    await $.turn.complete({ turnId: "t-work", answer: "", durationMs: 1, isAborted: false, usage: null });
    await clock.settle();
    expect(acts).toEqual([["back"], ["back"]]);
    expect(submits).toEqual([]);
    expect(toasts).toEqual(["brb: Back pressed, ending the hold"]);
    const again = await $.ui.mount({ ...BAND, surface });
    expect(await again.find({ type: "Text", text: "BACK · 3 to act on" })).toBeDefined();
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

// ---- 0.5.0: the hold's transcript rows, the away section, the mid-turn reminder ----
// Each row site is mounted as the surface draws it; the core stub above draws every row as
// THEIRS, so a row the mod leaves alone shows THEIRS and a hidden one shows the mod's tree.

const said = (requestId: string, text = "ran the migration") => ({ plugin: "brb", component: "AssistantMessage", requestId, props: { text, isFirstOfReply: true } }) as const;
const ran = (id: string, component: "ToolUse" | "ToolResult" = "ToolUse") =>
  component === "ToolUse"
    ? ({ plugin: "brb", component, requestId: id, props: { tool_use_id: id, tool: "Bash", input: { command: "ls" }, isRunning: false, isErrored: false, isInterrupted: false } } as const)
    : ({ plugin: "brb", component, requestId: id, props: { tool_use_id: id, tool: "Bash", output: { stdout: "", stderr: "", interrupted: false }, isErrored: false } } as const);
const turnDone = ($) => $.turn.complete({ turnId: "t", answer: "", durationMs: 1, isAborted: false, usage: null });

for (const [where, payload, surface] of SESSIONS) {
  test(`${where}: while away the hold's rows are replaced (one dim line, then nothing); rows from before, fires and Jo's prompts draw as Claude Code draws them; after back every row draws as before`, async ($, on) => {
    const { state, clock } = stubs(on, { snapshot: HOME });
    await $.session.start(payload);
    const before = await $.ui.mount({ ...said("m-before"), surface });
    expect(await before.find({ type: "Text", text: THEIRS })).toBeDefined();

    state.snapshot = AWAY;
    await turnDone($);
    await clock.settle();
    expect(await before.find({ type: "Text", text: THEIRS })).toBeDefined();

    const reply = await $.ui.mount({ ...said("m-away"), surface });
    expect(await reply.find({ type: "Text", text: THEIRS })).toBeUndefined();
    const line = await reply.find({ type: "Text", text: HELD_LINE });
    expect(line?.props.dimColor).toBe(true);
    const call = await $.ui.mount({ ...ran("t-away"), surface });
    expect(await call.find({ type: "Text", text: THEIRS })).toBeUndefined();
    expect(await call.find({ type: "Text", text: HELD_LINE })).toBeUndefined();
    // the rest of the run is an empty Box: the surface's table accepts it (mount would reject)
    expect(await call.drawn()).toMatchObject({ type: "Box" });
    expect(await call.findAll({ type: "Text" })).toHaveLength(0);
    const result = await $.ui.mount({ ...ran("t-away", "ToolResult"), surface });
    expect(await result.find({ type: "Text", text: THEIRS })).toBeUndefined();
    const fire = await $.ui.mount({ ...said("m-fire", "on fire: main is red since 4bd1e2"), surface });
    expect(await fire.find({ type: "Text", text: THEIRS })).toBeDefined();
    const prompt = await $.ui.mount({ plugin: "brb", component: "UserMessage", requestId: "u1", props: { text: "status?", origin: { kind: "composer" }, isExpanded: false }, surface });
    expect(await prompt.find({ type: "Text", text: THEIRS })).toBeDefined();

    // back: the mounted rows draw again, as Claude Code draws them
    state.snapshot = CHECKLIST;
    await turnDone($);
    await clock.settle();
    expect(await reply.find({ type: "Text", text: THEIRS })).toBeDefined();
    expect(await reply.find({ type: "Text", text: HELD_LINE })).toBeUndefined();
    expect(await call.find({ type: "Text", text: THEIRS })).toBeDefined();
    expect(await result.find({ type: "Text", text: THEIRS })).toBeDefined();
    for (const ui of [before, reply, call, result, fire, prompt]) await ui.unmount();
  });

  test(`${where}: the away text joins the environment section with breakPromptCache at brb and leaves it at back`, async ($, on) => {
    const { state, clock } = stubs(on, { snapshot: HOME });
    on("prompt.section", ($, e) => ({ text: e.text }));
    await $.session.start(payload);
    expect(await $.prompt.section({ name: "env_info_simple", text: "cwd: /w" })).toEqual({ text: "cwd: /w" });
    state.snapshot = AWAY;
    await turnDone($);
    await clock.settle();
    const away = await $.prompt.section({ name: "env_info_simple", text: "cwd: /w" });
    expect(away.text).toContain("cwd: /w");
    expect(away.text).toContain(AWAY_TEXT);
    expect(away.breakPromptCache).toBe(true);
    state.snapshot = HOME;
    await turnDone($);
    await clock.settle();
    expect((await $.prompt.section({ name: "env_info_simple", text: "cwd: /w" })).text).toBe("cwd: /w");
  });
}

test("a turn begun home: once brb lands, the next tool result carries the away text once", async ($, on) => {
  const { state, clock } = stubs(on, { snapshot: HOME });
  on("tool.call", () => ({ result: { stdout: "ok", stderr: "", interrupted: false } }));
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/Users/example/code/this" });
  await $.turn.start({ turnId: "t1" });
  expect((await $.tool.call({ tool: "Bash", input: { command: "ls" } })).context).toBeUndefined();
  state.snapshot = AWAY;
  await $.prompt.submit({ text: "brb" });
  await clock.settle();
  expect((await $.tool.call({ tool: "Bash", input: { command: "ls" } })).context).toEqual([AWAY_TEXT]);
  expect((await $.tool.call({ tool: "Bash", input: { command: "ls" } })).context).toBeUndefined();
});

// ---- 0.5.0 R1: the hideRows switch and another hook's cache break ----

for (const [where, payload, surface] of SESSIONS) {
  test(`${where}: hideRows off in config.json draws the hold's rows as Claude Code draws them; on again hides only new rows`, async ($, on) => {
    const { state, clock } = stubs(on, { snapshot: { ...AWAY, hideRows: false } });
    await $.session.start(payload);
    await clock.settle();
    const reply = await $.ui.mount({ ...said("m-off"), surface });
    expect(await reply.find({ type: "Text", text: THEIRS })).toBeDefined();
    expect(await reply.find({ type: "Text", text: HELD_LINE })).toBeUndefined();
    state.snapshot = AWAY;
    await turnDone($);
    await clock.settle();
    expect(await reply.find({ type: "Text", text: THEIRS })).toBeDefined();
    const fresh = await $.ui.mount({ ...said("m-on"), surface });
    expect(await fresh.find({ type: "Text", text: HELD_LINE })).toBeDefined();
    state.snapshot = { ...AWAY, hideRows: false };
    await turnDone($);
    await clock.settle();
    expect(await fresh.find({ type: "Text", text: THEIRS })).toBeDefined();
    for (const ui of [reply, fresh]) await ui.unmount();
  });
}

test("a later section hook's breakPromptCache passes through brb's section hook while home", async ($, on) => {
  stubs(on, { snapshot: HOME });
  on("prompt.section", () => ({ text: "OTHER MOD UPDATED THIS", breakPromptCache: true }));
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/Users/example/code/this" });
  const answer = await $.prompt.section({ name: "env_info_simple", text: "cwd: /w" });
  expect(answer.breakPromptCache).toBe(true);
  expect(answer.text).toBe("OTHER MOD UPDATED THIS");
});
