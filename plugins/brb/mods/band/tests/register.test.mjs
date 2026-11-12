// register.test.mjs — mods/band/register.mjs under `node --test`, with an in-memory `$` (the mod
// imports only ./data.mjs and ./view.mjs, so Node can load it): the timers it installs (a 1 s home
// probe, a 5 s poll while away or while a checklist is up) and cancels at `session.end`; the
// band redrawn (`$.ui.invalidate`) when what it draws changes; the prompt-box suggestion; the
// fallback status line set only where the band never renders and cleared once it does; a home
// probe that throws caught inside the timer; the buttons sending their words after act.mjs `open`; Back sending `back` as
// the person's prompt (`$.prompt.submit`, never awaited) with a toast, at once when idle and at the
// running turn's end otherwise, only for the hold it was pressed for (a `back` typed meanwhile, or
// a new hold, drops it), one press pending at a time even across a failed query, and no word from
// an earlier conversation's press; both session payloads (Desktop's `surface: null,
// isInteractive: false` and the terminal's). band.test.tsx covers the same hooks under
// `claude plugin test`.

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
 * the current snapshot's `away` and `since`, after `actHold` when set; `submit` is the promise
 * `$.prompt.submit` returns (default: one that never settles, as a call whose turn has not
 * started); `queryFails` makes the next query throw.
 */
function stub({ snapshot = HOME, exists = async () => false } = {}) {
  const s = { timers: new Map(), live: new Set(), cancelled: [], runs: 0, acts: [], submits: [], toasts: [], statuses: [], logs: [], suggestions: [], invalidations: 0, invalidated: [], snapshot, exists, sessionId: "s1", hold: null, actHold: null, queryFails: false, submit: () => new Promise(() => {}), files: new Map(), reads: [], writes: [], readFails: null };
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
          if (s.actHold) await s.actHold;
          const away = s.snapshot.away === true;
          const list = s.snapshot.away ? null : s.snapshot.checklist;
          const answer = argv[4] === "back" ? { ok: true, away, ...(away ? { since: s.snapshot.since } : {}) } : argv[4] === "open" ? { ok: true, open: Boolean(list), ...(list ? { at: list.at } : {}) } : { ok: true };
          return { exitCode: 0, stdout: JSON.stringify(answer) + "\n", stderr: "" };
        }
        if (s.queryFails) {
          s.queryFails = false;
          throw new Error("query timed out");
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
    fs: {
      exists: (path) => s.exists(path),
      // section.json in memory: a missing file rejects as the host's read does
      read: async (path) => {
        s.reads.push(path);
        if (s.readFails) throw s.readFails;
        if (!s.files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        return s.files.get(path);
      },
      write: async (path, text) => {
        s.writes.push(path);
        s.files.set(path, text);
      },
    },
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
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};
const turnStart = (hooks, s, e = {}) => hooks.get("turn.start")(s.$, { turnId: "t1", ...e }, async () => ({}));
const turnComplete = async (hooks, s, e = {}) => {
  await hooks.get("turn.complete")(s.$, { turnId: "t1", answer: "", durationMs: 1, isAborted: false, usage: null, ...e }, async () => ({}));
  await settle();
};
/** A promise and its resolve, to hold an answer until the test lets it go. */
const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};

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

test("Back while a turn runs: a toast now, `back` sent at the turn's end, checked again first, act.mjs twice", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  await turnStart(hooks, s);
  await buttons(await render(hooks, s))[0].props.onPress();
  assert.deepEqual(s.toasts, ["brb: Back pressed, ending the hold"]);
  assert.deepEqual(s.submits, [], "nothing sent while the turn runs");
  assert.equal(texts(await render(hooks, s))[1], "Back pressed · ending the hold");
  // A subagent's turn ending is not the session going idle.
  await turnComplete(hooks, s, { agentId: "a1" });
  assert.deepEqual(s.submits, []);
  await turnComplete(hooks, s);
  assert.deepEqual(s.acts, [["back"], ["back"]]);
  assert.deepEqual(s.submits, [{ text: "back", asUser: true }]);
  assert.equal(s.toasts.length, 1);
});

test("Back while a turn runs, then `back` typed: the hold ended, so the turn's end sends nothing and the band shows the checklist", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  await turnStart(hooks, s);
  await buttons(await render(hooks, s))[0].props.onPress();
  // `back` typed: the prompt hook ends the hold at Enter.
  s.snapshot = CHECKLIST;
  await turnComplete(hooks, s);
  assert.deepEqual(s.submits, []);
  assert.deepEqual(s.toasts, ["brb: Back pressed, ending the hold"], "no failure toast either");
  assert.match(texts(await render(hooks, s))[0], /^BACK/);
});

test("Back while a turn runs, then `back` typed and a new `brb`: the press was for the old hold, so nothing is sent", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  await turnStart(hooks, s);
  await buttons(await render(hooks, s))[0].props.onPress();
  s.snapshot = { ...AWAY, since: new Date().toISOString(), held: 0, items: [] };
  await turnComplete(hooks, s);
  assert.deepEqual(s.submits, []);
  const tree = await render(hooks, s);
  assert.notEqual(texts(tree)[1], "Back pressed · ending the hold", "the new hold's band is live");
  // A press now is for the new hold, and goes.
  await buttons(tree)[0].props.onPress();
  assert.deepEqual(s.submits, [{ text: "back", asUser: true }]);
});

test("Back whose act.mjs answer comes after a typed `back` started a turn: it waits, checks again, sends nothing", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  const held = gate();
  s.actHold = held.p;
  const press = buttons(await render(hooks, s))[0].props.onPress();
  await settle();
  // act.mjs read away.json before `back` was typed; its answer (still away) arrives after the
  // typed prompt started a turn.
  await turnStart(hooks, s);
  held.open();
  s.actHold = null;
  await press;
  assert.deepEqual(s.submits, [], "a turn is running: the press waits");
  s.snapshot = CHECKLIST;
  await turnComplete(hooks, s);
  assert.deepEqual(s.submits, []);
});

test("Back whose first act.mjs read comes after `back` typed and a new `brb`: the press was for the drawn hold, so nothing is sent and the new hold stays", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  const held = gate();
  s.actHold = held.p;
  // act.mjs is held before it reads away.json.
  const press = buttons(await render(hooks, s))[0].props.onPress();
  await settle();
  // `back` typed (the turn it starts runs and ends), then a new `brb`: a replacement hold.
  s.snapshot = { ...AWAY, since: new Date(Date.now() - 60_000).toISOString(), held: 0, items: [] };
  held.open();
  s.actHold = null;
  await press;
  await turnComplete(hooks, s);
  assert.deepEqual(s.submits, [], "the old click never reaches the new hold");
  assert.deepEqual(s.toasts, [], "dropped without a word");
  const tree = await render(hooks, s);
  assert.notEqual(texts(tree)[1], "Back pressed · ending the hold", "the new hold's band is live");
});

test("Back with no hold drawn does nothing", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  const tree = await render(hooks, s);
  // The hold ended and the band drew home before the stale button was pressed.
  s.snapshot = HOME;
  await s.timers.get(5000)();
  await buttons(tree)[0].props.onPress();
  assert.deepEqual(s.acts, []);
  assert.deepEqual(s.submits, []);
});

test("Back in a mod loaded mid-turn (no turn event yet, the band drawn with isWorking): it waits for the turn's end", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  await buttons(await render(hooks, s, { props: { isWorking: true } }))[0].props.onPress();
  assert.deepEqual(s.submits, [], "a turn is running by the band's own isWorking");
  // `back` typed while it runs: the turn's end finds the hold gone and sends nothing.
  s.snapshot = CHECKLIST;
  await turnComplete(hooks, s);
  assert.deepEqual(s.submits, []);
});

test("a failed query while a press is pending keeps it pending: a press after recovery sends nothing more", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  await buttons(await render(hooks, s))[0].props.onPress();
  assert.equal(s.submits.length, 1);
  s.queryFails = true;
  await s.timers.get(5000)();
  assert.deepEqual(s.logs, ["brb band: query: query timed out"]);
  // Recovery: the home probe finds away.json and queries again; the hold is still on.
  s.exists = async () => true;
  await s.timers.get(1000)();
  const tree = await render(hooks, s);
  assert.equal(texts(tree)[1], "Back pressed · ending the hold");
  await buttons(tree)[0].props.onPress();
  assert.equal(s.submits.length, 1);
  assert.deepEqual(s.acts, [["back"]]);
});

test("a press from an earlier conversation that fails late says nothing in the new one", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  const late = gate();
  s.submit = () => late.p;
  await start(hooks, s);
  await buttons(await render(hooks, s))[0].props.onPress();
  await hooks.get("session.end")(s.$, {}, async () => ({}));
  await hooks.get("classic.SessionStart")(s.$, { source: "clear" }, async () => ({}));
  late.open({ drop: "old conversation drop" });
  await settle();
  assert.deepEqual(s.toasts, ["brb: Back pressed, ending the hold"]);
  assert.deepEqual(s.logs, []);
});

test("after back: BACK with Show and Done per row and Clear; each press sends its prompt as the person's own (`brb item N`, `brb done N`, `brb clear`) after act.mjs `open`; the poll keeps running while it is up", async () => {
  const hooks = await load();
  const s = stub({ snapshot: CHECKLIST, exists: async () => assert.fail("probed while a checklist is up") });
  await start(hooks, s);
  const tree = await render(hooks, s);
  assert.equal(texts(tree)[0], "BACK · 2 to act on");
  assert.deepEqual(buttons(tree).map((b) => b.props.key), ["clear", "item-1", "done-1", "item-2", "done-2"]);
  const press = async (key) => buttons(tree).find((b) => b.props.key === key).props.onPress();
  await press("item-2");
  await press("done-1");
  await press("clear");
  assert.deepEqual(s.submits, [{ text: `brb item 2 @${SINCE}`, asUser: true }, { text: `brb done 1 @${SINCE}`, asUser: true }, { text: `brb clear @${SINCE}`, asUser: true }], "each word carries the list's `at`");
  assert.deepEqual(s.acts, [["open"], ["open"], ["open"]], "only read-only checks; nothing written by the band");
  assert.deepEqual(s.toasts, []);
  const before = s.runs;
  await s.timers.get(1000)();
  await s.timers.get(5000)();
  assert.equal(s.runs, before + 1, "the 5 s poll queried while a checklist is up");
  s.snapshot = { ...CHECKLIST, checklist: { ...CHECKLIST.checklist, items: CHECKLIST.checklist.items.map((i) => ({ ...i, done: true })) } };
  await s.timers.get(5000)();
  assert.equal(await hooks.get("ui.render")(s.$, BAND, async () => "gone"), "gone", "all done: the band clears");
});

test("a band press while a turn runs: a toast now, the prompt at the turn's end; one press at a time; a list closed or replaced meanwhile drops it", async () => {
  const hooks = await load();
  const s = stub({ snapshot: CHECKLIST });
  await start(hooks, s);
  await turnStart(hooks, s);
  const tree = await render(hooks, s);
  const press = async (key) => buttons(tree).find((b) => b.props.key === key).props.onPress();
  await press("done-2");
  assert.deepEqual(s.toasts, ["brb: brb done 2 goes when this turn ends"]);
  await press("item-1");
  assert.equal(s.toasts.length, 1, "a second press while one waits sends nothing");
  assert.deepEqual(s.submits, []);
  await turnComplete(hooks, s);
  assert.deepEqual(s.submits, [{ text: `brb done 2 @${SINCE}`, asUser: true }]);

  await turnStart(hooks, s);
  await press("clear");
  s.snapshot = { ...CHECKLIST, checklist: { ...CHECKLIST.checklist, at: new Date().toISOString() } };
  await turnComplete(hooks, s);
  assert.equal(s.submits.length, 1, "another list since the press: dropped");
  await turnStart(hooks, s);
  await buttons(await render(hooks, s)).find((b) => b.props.key === "clear").props.onPress();
  s.snapshot = HOME;
  await turnComplete(hooks, s);
  assert.equal(s.submits.length, 1, "the list closed since the press: dropped");
  assert.deepEqual(s.logs, []);
});

test("a band press waiting for the turn to end is dropped by a new hold, even when the same list is open again by the turn's end", async () => {
  const hooks = await load();
  const s = stub({ snapshot: CHECKLIST });
  await start(hooks, s);
  await turnStart(hooks, s);
  const tree = await render(hooks, s);
  await buttons(tree).find((b) => b.props.key === "done-1").props.onPress();
  assert.deepEqual(s.toasts, ["brb: brb done 1 goes when this turn ends"]);
  // `brb` typed: the poll sees the new hold.
  s.snapshot = AWAY;
  await s.timers.get(5000)();
  // A hold that held nothing ended: the same list (same `at`) is open again when the turn ends.
  s.snapshot = CHECKLIST;
  await turnComplete(hooks, s);
  assert.deepEqual(s.submits, [], "the press made before the hold is not sent");
});

test("a band press whose prompt is dropped: a toast with the way out, and the next press works", async () => {
  const hooks = await load();
  const s = stub({ snapshot: CHECKLIST });
  s.submit = async () => ({ drop: "queue full" });
  await start(hooks, s);
  const tree = await render(hooks, s);
  await buttons(tree).find((b) => b.props.key === "item-1").props.onPress();
  await settle();
  assert.deepEqual(s.toasts, ["brb: brb item 1 failed: queue full; type it instead"]);
  s.submit = () => new Promise(() => {});
  await buttons(tree).find((b) => b.props.key === "item-1").props.onPress();
  assert.equal(s.submits.length, 2);
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
    await turnComplete(hooks, s);
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
    await turnComplete(hooks, s);
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
  await turnComplete(hooks, s);
  assert.equal(await rowOf(hooks, s, "terminal", ...said("a1")), DRAWN, "fail open: the mod cannot tell, so it hides nothing");
  s.snapshot = AWAY;
  await turnComplete(hooks, s);
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
  await turnComplete(hooks, s);
  const away = await section(hooks, s, "env_info_simple", "cwd: /w");
  assert.equal(away.breakPromptCache, true);
  assert.ok(away.text.includes("cwd: /w") && away.text.includes(AWAY_TEXT));
  assert.equal((await section(hooks, s, "env_info_simple", "cwd: /w")).breakPromptCache, undefined, "asked again while away: no second break");
  s.snapshot = HOME;
  await turnComplete(hooks, s);
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

test("Back pressed mid-turn while rows are hidden: one turn.complete both keeps the rows hidden and sends `back`; the query that sees home redraws them", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  await turnStart(hooks, s);
  assert.notEqual(await rowOf(hooks, s, "terminal", ...said("a1")), DRAWN);
  await buttons(await render(hooks, s))[0].props.onPress();
  await turnComplete(hooks, s);
  assert.deepEqual(s.submits, [{ text: "back", asUser: true }], "the drain ran on the same turn.complete");
  assert.notEqual(await rowOf(hooks, s, "terminal", ...said("a1")), DRAWN, "still away until a query says otherwise");
  // the submitted `back` ends the hold; the next query sees home
  s.snapshot = CHECKLIST;
  const before = s.invalidated.length;
  await turnComplete(hooks, s);
  assert.ok(s.invalidated.slice(before).includes("ui.render"));
  assert.equal(await rowOf(hooks, s, "terminal", ...said("a1")), DRAWN);
  assert.equal(await rowOf(hooks, s, "terminal", "UserMessage", "u-back", { text: "back" }), DRAWN);
});

// ---- 0.5.0 R1: another hook's cache break, two section names, the hideRows switch ----

const sectionWith = (hooks, s, name, answer) => hooks.get(`prompt.section:${name}`)(s.$, { name, text: "cwd: /w" }, async () => answer);

test("R1 B1: a cache break asked for by the answer under brb's section hook survives, home and away", async () => {
  const hooks = await load();
  const s = stub({ snapshot: HOME });
  await start(hooks, s);
  const theirs = { text: "OTHER MOD UPDATED THIS", breakPromptCache: true };
  const home = await sectionWith(hooks, s, "env_info_simple", theirs);
  assert.equal(home.breakPromptCache, true, "home");
  assert.equal(home.text, "OTHER MOD UPDATED THIS");
  s.snapshot = AWAY;
  await turnComplete(hooks, s);
  await sectionWith(hooks, s, "env_info_simple", { text: "cwd: /w" }); // brb's own transition, spent
  const away = await sectionWith(hooks, s, "env_info_simple", theirs);
  assert.equal(away.breakPromptCache, true, "away, with brb's state unchanged since the last answer");
  assert.ok(away.text.startsWith("OTHER MOD UPDATED THIS") && away.text.includes(AWAY_TEXT));
});

for (const order of [["env_info_simple", "env_info_static"], ["env_info_static", "env_info_simple"]]) {
  test(`R1 S1: each section name breaks the cache once at brb and once at back, asked ${order.join(" then ")}`, async () => {
    const hooks = await load();
    const s = stub({ snapshot: HOME });
    await start(hooks, s);
    const ask = async (name) => (await sectionWith(hooks, s, name, { text: "cwd: /w" })).breakPromptCache === true;
    for (const name of order) assert.equal(await ask(name), false, `${name} home`);
    s.snapshot = AWAY;
    await turnComplete(hooks, s);
    for (const name of order) assert.equal(await ask(name), true, `${name} at brb`);
    for (const name of order) assert.equal(await ask(name), false, `${name} asked again away`);
    s.snapshot = HOME;
    await turnComplete(hooks, s);
    for (const name of [...order].reverse()) assert.equal(await ask(name), true, `${name} at back`);
    for (const name of order) assert.equal(await ask(name), false, `${name} asked again home`);
  });
}

test("R1 kill switch: hideRows off draws every row as is while away; switching it on hides only rows first drawn after, off again redraws", async () => {
  const hooks = await load();
  const s = stub({ snapshot: { ...AWAY, hideRows: false } });
  await start(hooks, s);
  assert.equal(await rowOf(hooks, s, "terminal", ...said("off-1")), DRAWN, "off: drawn as Claude Code draws it");
  assert.equal(await rowOf(hooks, s, "terminal", ...ran("off-2")), DRAWN);
  s.snapshot = AWAY;
  const before = s.invalidated.length;
  await turnComplete(hooks, s);
  assert.ok(s.invalidated.slice(before).includes("ui.render"), "the switch flipping redraws the rows");
  assert.equal(await rowOf(hooks, s, "terminal", ...said("off-1")), DRAWN, "a row shown while off stays shown");
  assert.notEqual(await rowOf(hooks, s, "terminal", ...said("on-1")), DRAWN, "on: a new row of the hold is hidden");
  s.snapshot = { ...AWAY, hideRows: false };
  const flip = s.invalidated.length;
  await turnComplete(hooks, s);
  assert.ok(s.invalidated.slice(flip).includes("ui.render"));
  assert.equal(await rowOf(hooks, s, "terminal", ...said("on-1")), DRAWN, "off again: the hidden row is drawn");
});

test("R2 B1: switching hiding off retires the hold's hidden rows at once: a row not drawn while off is shown after on again; a new row still hides", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  assert.notEqual(await rowOf(hooks, s, "terminal", ...said("old")), DRAWN, "hidden while on");
  s.snapshot = { ...AWAY, hideRows: false };
  const off = s.invalidated.length;
  await turnComplete(hooks, s);
  assert.ok(s.invalidated.slice(off).includes("ui.render"), "switching off redraws the rows");
  // the old row is not drawn while off (unmounted, off screen)
  s.snapshot = AWAY;
  await turnComplete(hooks, s);
  assert.equal(await rowOf(hooks, s, "terminal", ...said("old")), DRAWN, "on again: the row hidden before the switch stays shown");
  assert.notEqual(await rowOf(hooks, s, "terminal", ...said("new")), DRAWN, "a row first drawn after on still hides");
});

// ---- 0.5.0 R3: section.json carries the section's away state across a resume or a restart ----

const SECTION_FILE = "/tmp/state/brb/s1/section.json";
const breaks = async (hooks, s, name = "env_info_simple") => (await sectionWith(hooks, s, name, { text: "cwd: /w" })).breakPromptCache === true;
/** A restarted Claude Code: a fresh module and stub over the same files. */
async function restart(from, snapshot) {
  const hooks = await load();
  const s = stub({ snapshot });
  s.files = from.files;
  await start(hooks, s);
  return { hooks, s };
}

test("R3: a session saved away and resumed home breaks the cache once, records home, and the next resume does not break", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  assert.equal(await breaks(hooks, s), true, "brb: the away text is added");
  assert.deepEqual(JSON.parse(s.files.get(SECTION_FILE)), { env_info_simple: true }, "saved away");
  // Claude Code restarts; the hold ended meanwhile; the conversation is resumed home
  const one = await restart(s, HOME);
  assert.equal(await breaks(one.hooks, one.s), true, "the first answer drops the saved away text");
  assert.equal(await breaks(one.hooks, one.s), false, "once");
  assert.deepEqual(JSON.parse(one.s.files.get(SECTION_FILE)), { env_info_simple: false }, "home recorded");
  const two = await restart(one.s, HOME);
  assert.equal(await breaks(two.hooks, two.s), false, "a second resume finds home saved: no break");
});

test("R3: a session never away, resumed home, never breaks and writes nothing", async () => {
  const hooks = await load();
  const s = stub({ snapshot: HOME });
  await start(hooks, s);
  assert.equal(await breaks(hooks, s), false);
  const again = await restart(s, HOME);
  assert.equal(await breaks(again.hooks, again.s), false);
  assert.equal(again.s.writes.length + s.writes.length, 0, "no file for a session never away");
});

test("R3: a session saved away and resumed still away does not break (the saved prompt has the text)", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  await breaks(hooks, s);
  const again = await restart(s, AWAY);
  assert.equal(await breaks(again.hooks, again.s), false);
});

test("R3: each section name is saved and dropped on its own", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  await breaks(hooks, s, "env_info_static");
  const again = await restart(s, HOME);
  assert.equal(await breaks(again.hooks, again.s, "env_info_simple"), false, "never saved away");
  assert.equal(await breaks(again.hooks, again.s, "env_info_static"), true, "saved away");
});

test("R3: /resume in the same process to a session saved away breaks once at its first answer", async () => {
  const hooks = await load();
  const s = stub({ snapshot: HOME });
  s.files.set("/tmp/state/brb/s2/section.json", JSON.stringify({ env_info_simple: true }));
  await start(hooks, s);
  assert.equal(await breaks(hooks, s), false, "s1: never away");
  await end(hooks, s, "resume");
  s.sessionId = "s2";
  await start(hooks, s);
  assert.equal(await breaks(hooks, s), true, "s2's saved away text is dropped");
  assert.equal(await breaks(hooks, s), false);
});

for (const [what, prepare] of [
  ["missing", () => {}],
  ["not JSON", (s) => s.files.set(SECTION_FILE, "{ env_info_simple: tr")],
  ["an array", (s) => s.files.set(SECTION_FILE, "[true]")],
  ["a string where a boolean goes", (s) => s.files.set(SECTION_FILE, JSON.stringify({ env_info_simple: "true" }))],
  ["unreadable", (s) => (s.readFails = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))],
]) {
  test(`R3: section.json ${what}: home answers without a break and without throwing`, async () => {
    const hooks = await load();
    const s = stub({ snapshot: HOME });
    prepare(s);
    await start(hooks, s);
    assert.deepEqual(await sectionWith(hooks, s, "env_info_simple", { text: "cwd: /w" }), { text: "cwd: /w" });
  });
}

test("R3: a save the host refuses is logged; the answer still carries the away text and the break", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  s.$.fs.write = async () => {
    throw new Error("EROFS: read-only file system");
  };
  await start(hooks, s);
  const answer = await sectionWith(hooks, s, "env_info_simple", { text: "cwd: /w" });
  assert.equal(answer.breakPromptCache, true);
  assert.ok(answer.text.includes(AWAY_TEXT));
  assert.equal(s.logs.filter((l) => l.includes("EROFS")).length, 1);
});

// ---- 0.5.0 R4: section state belongs to one conversation ----

for (const [what, marker] of [
  ["missing", undefined],
  ["corrupt", "{"],
  ["saved home", JSON.stringify({ env_info_simple: false })],
]) {
  test(`R4 S1: an ordinary home resume with a ${what} marker after an away predecessor does not break and writes nothing for it`, async () => {
    const hooks = await load();
    const s = stub({ snapshot: AWAY });
    await start(hooks, s);
    assert.equal(await breaks(hooks, s), true, "A: brb's own break");
    await end(hooks, s, "resume");
    s.sessionId = "s2";
    s.snapshot = HOME;
    if (marker !== undefined) s.files.set("/tmp/state/brb/s2/section.json", marker);
    const writesBefore = s.writes.length;
    await start(hooks, s);
    assert.equal(await breaks(hooks, s), false, "B's first answer is seeded only by B's own marker");
    assert.equal(s.writes.slice(writesBefore).filter((p) => p.includes("/s2/")).length, 0);
  });
}

test("R4 S1: the same sequence with B saved away still breaks once for B", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  await start(hooks, s);
  await breaks(hooks, s);
  await end(hooks, s, "resume");
  s.sessionId = "s2";
  s.snapshot = HOME;
  s.files.set("/tmp/state/brb/s2/section.json", JSON.stringify({ env_info_simple: true }));
  await start(hooks, s);
  assert.equal(await breaks(hooks, s), true);
  assert.equal(await breaks(hooks, s), false);
});

test("R4 B1: an old conversation's section read that finishes after /resume touches nothing of the new one; the new one breaks once and records home", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  s.files.set("/tmp/state/brb/s1/section.json", JSON.stringify({ env_info_simple: true }));
  s.files.set("/tmp/state/brb/s2/section.json", JSON.stringify({ env_info_simple: true }));
  const read = s.$.fs.read;
  let release;
  let started;
  const readStarted = new Promise((r) => (started = r));
  s.$.fs.read = async (path) => {
    if (path.includes("/s1/")) {
      started();
      return new Promise((r) => (release = r));
    }
    return read(path);
  };
  await start(hooks, s);
  const old = sectionWith(hooks, s, "env_info_simple", { text: "cwd: /w" });
  await readStarted;
  await end(hooks, s, "resume");
  s.sessionId = "s2";
  s.snapshot = HOME;
  await start(hooks, s);
  release(JSON.stringify({ env_info_simple: true }));
  const oldAnswer = await old;
  assert.equal(oldAnswer.breakPromptCache, undefined, "the abandoned answer is core's, untouched");
  assert.equal(JSON.parse(s.files.get("/tmp/state/brb/s1/section.json")).env_info_simple, true, "A's marker is not rewritten by the stale hook");
  assert.equal(await breaks(hooks, s), true, "B's own first answer breaks");
  assert.deepEqual(JSON.parse(s.files.get("/tmp/state/brb/s2/section.json")), { env_info_simple: false }, "only B's own answer records B home");
  assert.equal(await breaks(hooks, s), false);
});

test("R4 B1: an answer whose core `next` resolves after /resume records nothing either", async () => {
  const hooks = await load();
  const s = stub({ snapshot: AWAY });
  s.files.set("/tmp/state/brb/s2/section.json", JSON.stringify({ env_info_simple: true }));
  await start(hooks, s);
  let release;
  const old = hooks.get("prompt.section:env_info_simple")(s.$, { name: "env_info_simple", text: "cwd: /w" }, () => new Promise((r) => (release = r)));
  await end(hooks, s, "resume");
  s.sessionId = "s2";
  s.snapshot = HOME;
  await start(hooks, s);
  release({ text: "cwd: /w" });
  assert.deepEqual(await old, { text: "cwd: /w" });
  assert.equal(await breaks(hooks, s), true);
});
