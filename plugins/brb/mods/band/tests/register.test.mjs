// register.test.mjs — mods/band/register.mjs under `node --test`, with an in-memory `$` (the mod
// imports only ./data.mjs and ./view.mjs, so Node can load it): the timers it installs (a 1 s home
// probe, a 5 s poll while away or while a checklist is up) and cancels at `session.end`; the
// band redrawn (`$.ui.invalidate`) when what it draws changes; the prompt-box suggestion; the
// fallback status line set only where the band never renders and cleared once it does; a home
// probe that throws caught inside the timer; the buttons running act.mjs; Back sending `back` as
// the person's prompt (`$.prompt.submit`, never awaited) with a toast; both session payloads
// (Desktop's `surface: null, isInteractive: false` and the terminal's). band.test.tsx covers the
// same hooks under `claude plugin test`.

import test from "node:test";
import assert from "node:assert/strict";

let fresh = 0;
/** A fresh copy of the module (its state is module-level) with its hooks by event name; a hook with a `component` or `name` matcher also as `<event>:<value>` (`ui.render` alone is the band's, the first registered). */
async function load() {
  const { register } = await import(`../register.mjs?fresh=${++fresh}`);
  const hooks = new Map();
  register((event, a, b) => {
    const tag = b ? (a?.component ?? a?.name) : undefined;
    if (tag !== undefined) hooks.set(`${event}:${tag}`, b);
    if (!hooks.has(event)) hooks.set(event, b ?? a);
  }, {});
  return hooks;
}

const SINCE = new Date(Date.now() - 40 * 60_000).toISOString();
const AWAY = { ok: true, away: true, since: SINCE, note: "", held: 2, onFire: 0, items: ["Pick the cache", "Approve the schema"] };
const HOME = { ok: true, away: false, checklist: null };
const CHECKLIST = { ok: true, away: false, checklist: { at: SINCE, since: SINCE, note: "", items: [{ text: "Pick the cache", done: false }, { text: "Approve the schema", done: false }] } };

/**
 * An in-memory `$`: `timers` by interval, `runs` each query, `acts` each action, `submits` each
 * `$.prompt.submit` input, `toasts` each toast, and what the mod set. act.mjs `back` answers with
 * the current snapshot's `away`; `submit` is the promise `$.prompt.submit` returns (default: one
 * that never settles, as a call made while the agent works).
 */
function stub({ snapshot = HOME, exists = async () => false } = {}) {
  const s = { timers: new Map(), live: new Set(), cancelled: [], runs: 0, acts: [], submits: [], toasts: [], statuses: [], logs: [], suggestions: [], invalidations: 0, invalidated: [], snapshot, exists, sessionId: "s1", hold: null, submit: () => new Promise(() => {}) };
  s.$ = {
    env: { get: async (name) => (name === "XDG_STATE_HOME" ? "/tmp/state" : name === "HOME" ? "/Users/example" : undefined) },
    clock: {
      every: (ms, fn) => {
        const handle = { ms, cancel: () => (s.live.delete(handle), s.cancelled.push(ms)) };
        s.timers.set(ms, fn);
        s.live.add(handle);
        return handle;
      },
    },
    session: { id: async () => s.sessionId },
    plugin: { root: "/p" },
    process: {
      run: async (argv) => {
        if (String(argv[1]).endsWith("mods/band/act.mjs")) {
          s.acts.push(argv.slice(4));
          return { exitCode: 0, stdout: JSON.stringify(argv[4] === "back" ? { ok: true, away: s.snapshot.away === true } : { ok: true }) + "\n", stderr: "" };
        }
        s.runs++;
        const answer = JSON.stringify(s.snapshot) + "\n";
        if (s.hold) await s.hold;
        return { exitCode: 0, stdout: answer, stderr: "" };
      },
    },
    prompt: {
      suggest: async ({ text }) => (s.suggestions.push(text), { isShown: true }),
      submit: (input) => (s.submits.push(input), s.submit()),
    },
    ui: {
      log: async (text) => s.logs.push(text),
      toast: (text) => s.toasts.push(text),
      status: (text) => s.statuses.push(text),
      invalidate: (event) => (s.invalidations++, s.invalidated.push(event)),
      resolve: () => ({
        Box: ({ children, ...props }) => ({ type: "Box", props, children: [children ?? []].flat(Infinity) }),
        Text: ({ children, ...props }) => ({ type: "Text", props, children: [children ?? []].flat(Infinity) }),
        Button: (props) => ({ type: "Button", props }),
      }),
    },
    fs: { exists: (path) => s.exists(path) },
  };
  return s;
}

const DESKTOP = { surface: null, isInteractive: false, cwd: "/work" };
const TERMINAL = { surface: "terminal", isInteractive: true, cwd: "/work" };
const start = (hooks, s, e = TERMINAL) => hooks.get("session.start")(s.$, e, async () => ({}));
const BAND = { component: "AbovePrompt", surface: "terminal", props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 } };
const render = (hooks, s, over = {}) => hooks.get("ui.render")(s.$, { ...BAND, ...over, props: { ...BAND.props, ...over.props } }, async () => null);
const texts = (tree) => (tree?.type === "Text" ? [tree.children.join("")] : (tree?.children ?? []).flatMap(texts));
const buttons = (tree) => (tree?.type === "Button" ? [tree] : (tree?.children ?? []).flatMap(buttons));
const tick = () => new Promise((r) => setImmediate(r));

for (const [where, e] of [["Desktop (surface null, not interactive)", DESKTOP], ["terminal", TERMINAL]]) {
  test(`${where}: session.start queries, installs both timers, suggests the way back, and the band draws the headline, the rows and Back`, async () => {
    const hooks = await load();
    const s = stub({ snapshot: AWAY });
    await start(hooks, s, e);
    assert.equal(s.runs, 1);
    assert.deepEqual([...s.timers.keys()].sort((a, b) => a - b), [1000, 5000]);
    assert.ok(s.invalidations >= 1, "the band was asked to redraw");
    assert.match(s.suggestions[0], /^away 4[01]m — type back$/);
    const tree = await render(hooks, s);
    const t = texts(tree);
    assert.match(t[0], /^AWAY 4[01]m · 2 held$/);
    assert.deepEqual(t.slice(1), ["1. Pick the cache", "2. Approve the schema"]);
    assert.deepEqual(buttons(tree).map((b) => b.props.key), ["back"]);
    assert.deepEqual(s.statuses, [], "no status line where the band draws");
  });
}

test("home with no checklist: the band passes (next), nothing suggested", async () => {
  const hooks = await load();
  const s = stub();
  await start(hooks, s);
  assert.equal(await hooks.get("ui.render")(s.$, BAND, async () => "theirs"), "theirs");
  assert.deepEqual(s.suggestions, []);
});

test("a survey holds the band: the hook yields to it", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  assert.equal(await hooks.get("ui.render")(s.$, { ...BAND, props: { ...BAND.props, hasSurvey: true } }, async () => "survey"), "survey");
});

test("Back: act.mjs back once, `back` submitted once as the person's prompt and not awaited, one toast; the band says the hold is ending", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  const tree = await render(hooks, s);
  // s.submit never settles: the press must still resolve.
  await buttons(tree)[0].props.onPress();
  assert.deepEqual(s.acts, [["back"]]);
  assert.deepEqual(s.submits, [{ text: "back", asUser: true }]);
  assert.deepEqual(s.toasts, ["brb: Back pressed, ending the hold"]);
  assert.deepEqual(s.logs, []);
  assert.equal(s.runs, 2, "the band was refreshed after the press");
  const after = await render(hooks, s);
  assert.equal(texts(after)[1], "Back pressed · ending the hold");
  assert.equal(buttons(after)[0].props.dimColor, true);
  // A second press while the first is on its way sends nothing.
  await buttons(after)[0].props.onPress();
  assert.deepEqual(s.acts, [["back"]]);
  assert.equal(s.submits.length, 1);
  // The hold ends (the hook ran on the submitted `back`): the next query is home, the mark goes.
  s.snapshot = CHECKLIST;
  await s.timers.get(5000)();
  assert.match(texts(await render(hooks, s))[0], /^BACK/);
});

test("Back while act.mjs finds the session home: no submit, no toast", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  const tree = await render(hooks, s);
  s.snapshot = HOME;
  await buttons(tree)[0].props.onPress();
  assert.deepEqual(s.acts, [["back"]]);
  assert.deepEqual(s.submits, []);
  assert.deepEqual(s.toasts, []);
});

test("Back whose submit is dropped: a failure toast with the reason, and the button works again", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  s.submit = async () => ({ drop: "the prompt was removed from the queue\nbefore it ran" });
  await start(hooks, s);
  await buttons(await render(hooks, s))[0].props.onPress();
  await tick();
  assert.deepEqual(s.toasts, ["brb: Back pressed, ending the hold", "brb: Back failed: the prompt was removed from the queue before it ran; type back"]);
  assert.deepEqual(s.logs, ["brb band: back: the prompt was removed from the queue\nbefore it ran"]);
  const after = await render(hooks, s);
  assert.equal(texts(after)[1], "1. Pick the cache", "the pressed line is gone");
  s.submit = () => new Promise(() => {});
  await buttons(after)[0].props.onPress();
  assert.equal(s.submits.length, 2);
});

test("after back: the checklist draws BACK with Done per row and Clear; Done and Clear run act.mjs; the poll keeps running while it is up", async () => {
  const hooks = await load();
  const s = stub({ snapshot: CHECKLIST, exists: async () => assert.fail("probed while a checklist is up") });
  await start(hooks, s);
  const tree = await render(hooks, s);
  assert.equal(texts(tree)[0], "BACK · 2 to act on");
  assert.deepEqual(buttons(tree).map((b) => b.props.label), ["Clear", "Done", "Done"]);
  await buttons(tree)[2].props.onPress();
  assert.deepEqual(s.acts, [["done", "1"]]);
  await buttons(tree)[0].props.onPress();
  assert.deepEqual(s.acts.at(-1), ["clear"]);
  const before = s.runs;
  await s.timers.get(1000)();
  await s.timers.get(5000)();
  assert.equal(s.runs, before + 1, "the 5 s poll queried while a checklist is up");
  s.snapshot = { ...CHECKLIST, checklist: { ...CHECKLIST.checklist, items: CHECKLIST.checklist.items.map((i) => ({ ...i, done: true })) } };
  await s.timers.get(5000)();
  assert.equal(await hooks.get("ui.render")(s.$, BAND, async () => "gone"), "gone", "all done: the band clears");
});

test("timers: the probe does nothing while away, the poll nothing while home; session.end cancels both", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY, exists: async () => assert.fail("probed while away") });
  await start(hooks, s);
  await s.timers.get(1000)();
  assert.equal(s.runs, 1);
  await s.timers.get(5000)();
  assert.equal(s.runs, 2);
  s.snapshot = HOME;
  await s.timers.get(5000)();
  assert.equal(s.runs, 3);
  await s.timers.get(5000)();
  assert.equal(s.runs, 3, "the 5 s poll queried while home");
  await hooks.get("session.end")(s.$, { reason: "prompt_input_exit", sessionId: "s1" }, async () => ({ sessionId: "s1" }));
  assert.deepEqual(s.cancelled.sort((a, b) => a - b), [1000, 5000]);
});

test("fallback: where the band is never asked to draw, the status line carries the hold after the first tick; the first render clears it for good", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  assert.deepEqual(s.statuses, [], "nothing before the first tick");
  await s.timers.get(5000)();
  assert.match(s.statuses.at(-1), /^away 4[01]m · 2 held · say back$/);
  await render(hooks, s);
  assert.equal(s.statuses.at(-1), undefined);
  const n = s.statuses.length;
  await s.timers.get(5000)();
  assert.equal(s.statuses.length, n, "no status line once the band has drawn");
});

test("prompt.submit refreshes after the prompt entered; the prompt's own result is untouched", async () => {
  const hooks = await load();
  const s = stub();
  await start(hooks, s);
  s.snapshot = AWAY;
  const out = await hooks.get("prompt.submit")(s.$, { text: "brb" }, async () => ({ text: "brb" }));
  await tick();
  assert.deepEqual(out, { text: "brb" });
  assert.equal(s.runs, 2);
});

test("a home probe that rejects is caught in the timer: no rejection, one `brb band: probe:` line per distinct message", async () => {
  const hooks = await load();
  let message = "network location refused";
  const s = stub({ exists: async () => { throw new Error(message); } });
  await start(hooks, s);
  await assert.doesNotReject(async () => s.timers.get(1000)());
  await assert.doesNotReject(async () => s.timers.get(1000)());
  assert.deepEqual(s.logs, ["brb band: probe: network location refused"]);
  message = "another refusal";
  await s.timers.get(1000)();
  assert.deepEqual(s.logs, ["brb band: probe: network location refused", "brb band: probe: another refusal"]);
  s.exists = async () => true;
  s.snapshot = AWAY;
  await s.timers.get(1000)();
  assert.match(texts(await render(hooks, s))[0], /^AWAY /);
});

test("a failed action is logged and the band redrawn from the query; a failed Back also toasts and submits nothing", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  s.$.process.run = async (argv) => (String(argv[1]).endsWith("act.mjs") ? { exitCode: 0, stdout: '{"ok":false,"error":"locked"}\n', stderr: "" } : (s.runs++, { exitCode: 0, stdout: JSON.stringify(s.snapshot), stderr: "" }));
  await start(hooks, s);
  const tree = await render(hooks, s);
  await buttons(tree)[0].props.onPress();
  assert.deepEqual(s.logs, ["brb band: back: locked"]);
  assert.deepEqual(s.toasts, ["brb: Back failed: locked; type back"]);
  assert.deepEqual(s.submits, []);
  assert.equal(s.runs, 2);
});

const CLASSIC = (source) => ({ source, sessionId: "s2", hookEventName: "SessionStart" });
const end = (hooks, s, reason) => hooks.get("session.end")(s.$, { reason, sessionId: s.sessionId }, async () => ({}));
const classic = (hooks, s, source) => hooks.get("classic.SessionStart")(s.$, CLASSIC(source), async () => ({}));

for (const [where, e] of [["Desktop (surface null, not interactive)", DESKTOP], ["terminal", TERMINAL]]) {
  for (const source of ["clear", "resume", "fork"]) {
    test(`R1 B1 ${where}, ${source}: session.end then classic.SessionStart restarts exactly one poll and probe, drops the last conversation's band, and re-arms the fallback`, async () => {
      const hooks = await load();
      const s = stub({ snapshot: CHECKLIST });
      await start(hooks, s, e);
      assert.match(texts(await render(hooks, s))[0], /^BACK/);
      await end(hooks, s, source === "fork" ? "resume" : source);
      assert.equal(s.live.size, 0, "session.end cancels both timers");
      s.sessionId = "s2";
      s.snapshot = HOME;
      await classic(hooks, s, source);
      assert.equal(s.live.size, 2, "exactly the probe and the poll again");
      assert.equal(await hooks.get("ui.render")(s.$, BAND, async () => "gone"), "gone", "no stale band");
      s.snapshot = AWAY;
      s.exists = async () => true;
      await s.timers.get(1000)();
      assert.match(texts(await render(hooks, s))[0], /^AWAY /, "the new conversation draws");
    });
  }

  test(`R1 B1 ${where}: after /clear the fallback line is armed again until this conversation's band draws`, async () => {
    const hooks = await load();
    const s = stub({ snapshot: AWAY });
    await start(hooks, s, e);
    await render(hooks, s);
    await end(hooks, s, "clear");
    s.sessionId = "s2";
    await classic(hooks, s, "clear");
    await s.timers.get(5000)();
    assert.match(s.statuses.at(-1), /^away 4[01]m · 2 held · say back$/);
    await render(hooks, s);
    assert.equal(s.statuses.at(-1), undefined);
  });
}

test("R1 B1: classic.SessionStart at startup or compact changes nothing (no second poll, the band stays)", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  const runs = s.runs;
  await classic(hooks, s, "startup");
  await classic(hooks, s, "compact");
  assert.equal(s.live.size, 2);
  assert.equal(s.runs, runs);
  assert.match(texts(await render(hooks, s))[0], /^AWAY /);
});

test("R1 B1: a query answer from the last conversation that lands after the new one began is dropped", async () => {
  const hooks = await load();
  const s = stub({ snapshot: HOME });
  await start(hooks, s);
  let release;
  s.hold = new Promise((r) => (release = r));
  s.snapshot = CHECKLIST;
  const late = s.timers.get(1000) && hooks.get("turn.complete")(s.$, { turnId: "t" }, async () => ({}));
  await tick();
  s.hold = null;
  await end(hooks, s, "clear");
  s.sessionId = "s2";
  s.snapshot = HOME;
  await classic(hooks, s, "clear");
  release();
  await late;
  assert.equal(await hooks.get("ui.render")(s.$, BAND, async () => "gone"), "gone", "the old checklist did not come back");
});

// ---- 0.5.0: the hold's transcript rows, the away section, the mid-turn reminder ----

const { AWAY_TEXT, HELD_LINE } = await import("../hide.mjs");
const DRAWN = { type: "Text", props: {}, children: ["drawn by Claude Code"] };
const rowOf = (hooks, s, surface, component, requestId, props) =>
  hooks.get(`ui.render:${component}`)(s.$, { component, surface, requestId, props }, async () => DRAWN);
const said = (id, text = "ran the migration") => ["AssistantMessage", id, { text, isFirstOfReply: true }];
const ran = (id, component = "ToolUse") => [component, id, { tool_use_id: id, tool: "Bash", input: {}, isRunning: false, isErrored: false, isInterrupted: false }];
const complete = (hooks, s) => hooks.get("turn.complete")(s.$, { turnId: "t" }, async () => ({}));
const turnStart = (hooks, s, e = {}) => hooks.get("turn.start")(s.$, { turnId: "t", ...e }, async () => ({}));
const toolCall = (hooks, s, e, answer = { result: { stdout: "" }, text: "", ref: 1 }) => hooks.get("tool.call")(s.$, { tool: "Bash", input: {}, ...e }, async () => answer);
const section = (hooks, s, name, text) => hooks.get(`prompt.section:${name}`)(s.$, { name, text }, async (e) => ({ text: e.text }));

for (const [where, e, surface] of [["Desktop (surface null, not interactive)", DESKTOP, "desktop"], ["terminal", TERMINAL, "terminal"]]) {
  test(`${where}: while away the hold's rows draw one dim line then nothing, older rows and fires as drawn; back redraws every row as drawn`, async () => {
    const hooks = await load();
    const s = stub({ snapshot: HOME });
    await start(hooks, s, e);
    assert.equal(await rowOf(hooks, s, surface, ...said("m-before")), DRAWN);
    assert.equal(await rowOf(hooks, s, surface, ...ran("t-before")), DRAWN);

    s.snapshot = AWAY;
    const before = s.invalidated.length;
    await complete(hooks, s);
    assert.ok(s.invalidated.slice(before).includes("ui.render"), "the rows were asked to draw again at brb");
    assert.ok(s.invalidated.slice(before).includes("prompt.section"), "the section was asked again at brb");

    assert.equal(await rowOf(hooks, s, surface, ...said("m-before")), DRAWN, "a row from before the hold stays");
    assert.equal(await rowOf(hooks, s, surface, ...ran("t-before")), DRAWN);
    const first = await rowOf(hooks, s, surface, ...said("m-away"));
    assert.notEqual(first, DRAWN);
    assert.deepEqual(texts(first), [HELD_LINE]);
    assert.equal(first.props.dimColor, true);
    const rest = await rowOf(hooks, s, surface, ...ran("t-away"));
    assert.deepEqual(texts(rest), [], "the rest of the run draws nothing");
    assert.deepEqual(texts(await rowOf(hooks, s, surface, ...ran("t-away", "ToolResult"))), []);
    assert.equal(await rowOf(hooks, s, surface, ...said("m-fire", "on fire: main is red since 4bd1e2")), DRAWN, "a fire is drawn");
    assert.equal(await rowOf(hooks, s, surface, "UserMessage", "u1", { text: "status?" }), DRAWN, "Jo's prompt is drawn");

    s.snapshot = CHECKLIST;
    const atBack = s.invalidated.length;
    await complete(hooks, s);
    assert.ok(s.invalidated.slice(atBack).includes("ui.render"), "back asks every row to draw again");
    assert.equal(await rowOf(hooks, s, surface, ...said("m-away")), DRAWN, "the hidden reply is back");
    assert.equal(await rowOf(hooks, s, surface, ...ran("t-away")), DRAWN, "the hidden tool row is back");
    assert.equal(await rowOf(hooks, s, surface, ...ran("t-away", "ToolResult")), DRAWN);
  });
}

test("a failed query while away draws every row as is; the next answered query hides the hold's rows again", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  assert.notEqual(await rowOf(hooks, s, "terminal", ...said("a1")), DRAWN);
  s.snapshot = { ok: false, error: "query: node not found" };
  await complete(hooks, s);
  assert.equal(await rowOf(hooks, s, "terminal", ...said("a1")), DRAWN, "fail open: the mod cannot tell, so it hides nothing");
  s.snapshot = AWAY;
  await complete(hooks, s);
  assert.notEqual(await rowOf(hooks, s, "terminal", ...said("a1")), DRAWN, "the failure did not end the hold's ledger");
});

test("a row hook that faults draws the row as Claude Code would and logs once", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  s.$.ui.resolve = () => {
    throw new Error("resolve refused");
  };
  assert.equal(await rowOf(hooks, s, "terminal", ...said("a1")), DRAWN);
  assert.equal(await rowOf(hooks, s, "terminal", ...said("a2")), DRAWN);
  assert.equal(s.logs.filter((l) => l.includes("resolve refused")).length, 1);
});

test("session.end while away: rows draw as is again and the section is asked again", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  assert.notEqual(await rowOf(hooks, s, "terminal", ...said("a1")), DRAWN);
  const before = s.invalidated.length;
  await end(hooks, s, "clear");
  assert.ok(s.invalidated.slice(before).includes("prompt.section"));
  assert.ok(s.invalidated.slice(before).includes("ui.render"));
  assert.equal(await rowOf(hooks, s, "terminal", ...said("a1")), DRAWN);
});

test("prompt.section: home passes core's text; away appends the away text and breaks the cache once; back breaks it once more", async () => {
  const hooks = await load();
  const s = stub({ snapshot: HOME });
  await start(hooks, s);
  for (const name of ["env_info_simple", "env_info_static"]) assert.ok(hooks.has(`prompt.section:${name}`), name);
  assert.deepEqual(await section(hooks, s, "env_info_simple", "cwd: /w"), { text: "cwd: /w" });
  s.snapshot = AWAY;
  await complete(hooks, s);
  const away = await section(hooks, s, "env_info_simple", "cwd: /w");
  assert.equal(away.breakPromptCache, true);
  assert.ok(away.text.includes("cwd: /w") && away.text.includes(AWAY_TEXT));
  assert.equal((await section(hooks, s, "env_info_simple", "cwd: /w")).breakPromptCache, undefined, "asked again while away: no second break");
  s.snapshot = HOME;
  await complete(hooks, s);
  assert.deepEqual(await section(hooks, s, "env_info_simple", "cwd: /w"), { text: "cwd: /w", breakPromptCache: true });
});

test("tool.call: a turn begun home gets the away text once after the first tool result once brb lands; a turn begun away, a subagent, a deny get none", async () => {
  const hooks = await load();
  const s = stub({ snapshot: HOME });
  await start(hooks, s);
  await turnStart(hooks, s);
  const home = await toolCall(hooks, s, { tool_use_id: "c1" });
  assert.equal(home.context, undefined);
  // `brb` typed mid-turn: the prompt hook writes the hold inside `next`, the mod refreshes after
  s.snapshot = AWAY;
  await hooks.get("prompt.submit")(s.$, { text: "brb", turnId: "t" }, async (p) => ({ text: p.text }));
  await tick();
  assert.equal((await toolCall(hooks, s, { tool_use_id: "c2", agentId: "sub-1" })).context, undefined, "a subagent's call: none");
  assert.deepEqual((await toolCall(hooks, s, { tool_use_id: "c3" }, { deny: "no" })), { deny: "no" }, "a deny passes untouched");
  const first = await toolCall(hooks, s, { tool_use_id: "c4" }, { result: { stdout: "ok" }, text: "ok", ref: 7, context: ["another hook's"] });
  assert.deepEqual(first.context, ["another hook's", AWAY_TEXT]);
  assert.equal(first.ref, 7, "core's result is kept");
  assert.equal((await toolCall(hooks, s, { tool_use_id: "c5" })).context, undefined, "once per turn");
  await turnStart(hooks, s);
  assert.equal((await toolCall(hooks, s, { tool_use_id: "c6" })).context, undefined, "a turn begun away has the section and the prompt hook");
  // the tool row of c1 (called home) first draws now: it predates the hold
  assert.equal(await rowOf(hooks, s, "terminal", ...ran("c1")), DRAWN);
  assert.notEqual(await rowOf(hooks, s, "terminal", ...ran("c4")), DRAWN);
});
