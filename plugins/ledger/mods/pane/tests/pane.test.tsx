// pane.test.tsx — the ledger pane mod under `claude plugin test` (run from plugins/ledger).
//
// `.test.tsx`, not `.test.mjs`, so the ledger's `node --test` run leaves this file to the mods
// test kit. Every process the mod would start is answered by a stub: the query script by a JSON
// snapshot, the ledger CLI by its `--json` array. Nothing here touches a database.

import { expect, mock, test } from "claude-code/testing";

const SESSION = "s-this-window";
const Q = {
  id: "q-mw1a",
  cwd: "/Users/example/code/other",
  name: "ship",
  body: "Ship the release?",
  options: ["approve", "deny"],
  default: "approve",
  state: "open",
  asked_at: "2026-11-04T06:00:00.000Z",
  age: "3m ago",
};
const ANSWER = { id: "q-mw1z", name: "colour", body: "Which colour?", state: "answered", word: "green", via: "cli" };
const SNAPSHOT = { ok: true, since: "2026-11-04T06:00:00.000Z", elsewhere: [Q], answers: [ANSWER] };
const EMPTY = { ok: true, since: null, elsewhere: [], answers: [] };
const RECORDED = [{ line: 1, text: "answer q-mw1a approve", status: "ok", id: "an-1", message: "an-1 approve → q-mw1a (ship)" }];

const PANE = {
  plugin: "ledger",
  component: "Pane",
  requestId: "ledger",
  surface: "desktop",
  viewport: { columns: 100, rows: 30 },
  props: { title: "Ledger", isFocused: true, bodyColumns: 60, placement: "dock", scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const;

type Run = { argv: string[]; init: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } };

/** The stubs every test needs; `processes` collects each process the mod started. */
function stubs(on, { snapshot = SNAPSHOT, cli = RECORDED, placed = true, answer = "", openDeny = null as null | string, processRun = null as null | ((e: { argv: string[] }) => unknown) } = {}) {
  const processes: Run[] = [];
  const logs: string[] = [];
  const toasts: string[] = [];
  const opens: unknown[] = [];
  const closes: unknown[] = [];
  const clock = mock.clock(on);
  on("command.register", () => ({ value: undefined }));
  on("session.id", () => ({ value: SESSION }));
  on("session.cwd", () => ({ value: "/Users/example/code/this" }));
  on("session.start", () => ({ cwd: "/Users/example/code/this" }));
  on("turn.start", ($, e) => ({ turnId: e.turnId }));
  // The engine's default turn.complete result is `{ text: e.answer }`: Claude's whole reply.
  on("turn.complete", () => ({ text: answer }));
  on("ui.log", ($, e) => {
    logs.push(e.text);
    return { value: undefined };
  });
  on("ui.toast", ($, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.open", ($, e) => {
    opens.push(e);
    return openDeny ? { deny: openDeny } : { value: { isPlaced: placed } };
  });
  on("ui.close", ($, e) => {
    closes.push(e);
    return { value: undefined };
  });
  on("ui.panes", () => ({ value: [{ id: "ledger", isShown: placed, isFocused: false, isPlaced: placed }] }));
  on("process.run", ($, e) => {
    processes.push({ argv: e.argv, init: e.init });
    if (processRun) return processRun(e);
    const script = String(e.argv[1] ?? "");
    if (script.endsWith("mods/pane/query.mjs")) return { value: { exitCode: 0, stdout: JSON.stringify(snapshot) + "\n", stderr: "" } };
    if (script.endsWith("scripts/ledger.mjs")) return { value: { exitCode: 0, stdout: JSON.stringify(cli), stderr: "" } };
    return { deny: `unexpected process ${e.argv.join(" ")}` };
  });
  return { processes, logs, toasts, opens, closes, clock };
}

const start = ($) => $.session.start({ surface: "desktop", isInteractive: true, cwd: "/Users/example/code/this" });
const completeTurn = ($) => $.turn.complete({ turnId: "t-1", answer: "done", durationMs: 10, isAborted: false, usage: null });

test("/ledger answer <q-id> <reply> runs the ledger CLI as this session and reports the recorded line, with no model turn", async ($, on) => {
  const { processes } = stubs(on);
  await start($);
  const out = await $.command.run({ command: "ledger", args: "answer q-mw1a approve" });
  expect(out.text).toBe("ledger recorded: an-1 approve → q-mw1a (ship)");
  const cli = processes.find((p) => String(p.argv[1]).endsWith("scripts/ledger.mjs"));
  expect(cli).toBeDefined();
  expect(cli.argv.slice(0, 1)).toEqual(["node"]);
  expect(cli.argv.slice(2)).toEqual(["--json", "answer", "q-mw1a", "approve"]);
  expect(cli.init.env).toEqual({ LEDGER_SESSION_ID: SESSION });
  expect(cli.init.cwd).toBe("/Users/example/code/this");
  // The CLI's answer is followed by one fresh query so the pane shows the new state.
  const after = processes.slice(processes.indexOf(cli) + 1);
  expect(after.length).toBe(1);
  expect(String(after[0].argv[1]).endsWith("mods/pane/query.mjs")).toBe(true);
});

test("/ledger with a refused or failing CLI says so and records nothing else", async ($, on) => {
  const refused = [{ line: 1, text: "answer q-mw1a maybe", status: "refused", id: null, message: "q-mw1a (ship) takes approve or deny; maybe is not one of them" }];
  stubs(on, { cli: refused });
  await start($);
  const out = await $.command.run({ command: "ledger", args: "answer q-mw1a maybe" });
  expect(out.text).toBe("ledger refused: q-mw1a (ship) takes approve or deny; maybe is not one of them");
  expect((await $.command.run({ command: "ledger", args: "answer q-mw1a" })).text).toMatch(/needs a reply/);
  expect((await $.command.run({ command: "ledger", args: "bogus words" })).text).toMatch(/^usage: \/ledger/);
});

test("session.start: the command is registered, the query runs with this session and folder, and the pane opens because something waits", async ($, on) => {
  const { processes, opens, toasts } = stubs(on);
  await start($);
  expect(processes.length).toBe(1);
  expect(processes[0].argv.slice(2)).toEqual(["--session", SESSION, "--cwd", "/Users/example/code/this"]);
  expect(processes[0].init.timeoutMs).toBe(5000);
  expect(opens.length).toBe(1);
  expect(opens[0]).toMatchObject({ id: "ledger", title: "Ledger" });
  expect(toasts).toEqual([]);
});

test("session.start: when nothing waits the pane stays closed and no toast shows", async ($, on) => {
  const { opens, toasts } = stubs(on, { snapshot: EMPTY, placed: false });
  await start($);
  expect(opens).toEqual([]);
  expect(toasts).toEqual([]);
});

test("session.start on a narrow screen: the pane is opened but not placed, so a toast names /ledger", async ($, on) => {
  const { opens, toasts } = stubs(on, { placed: false });
  await start($);
  expect(opens.length).toBe(1);
  expect(toasts).toEqual(["1 question waiting in 1 other folder · 1 answer since your last turn · /ledger opens the pane"]);
});

/** Every string a person can read in a drawn tree: text, button labels, field labels and placeholders. */
function readable(node): string[] {
  if (typeof node === "string") return [node];
  if (!node || typeof node !== "object") return [];
  const own = ["label", "placeholder", "submitLabel"].map((k) => node.props?.[k]).filter((v) => typeof v === "string");
  return [...own, ...(node.children ?? []).flatMap(readable)];
}

/** Every Text element's own string in a drawn tree. */
function texts(node): string[] {
  if (!node || typeof node !== "object") return [];
  const own = node.type === "Text" ? [(node.children ?? []).filter((c) => typeof c === "string").join("")] : [];
  return [...own, ...(node.children ?? []).flatMap(texts)];
}

test("the pane draws the answers and the question, and a pressed option records it through the CLI", async ($, on) => {
  const { processes } = stubs(on);
  await start($);
  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ type: "Text", text: "Ship the release?" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: "Which colour?" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: "→ green" })).toBeDefined();
  // The folder is named by its last path segment.
  expect(await ui.find({ type: "Text", text: "other" })).toBeDefined();
  // The first open question is selected, so its option buttons and the Reply field are drawn.
  expect(await ui.find({ key: "opt-q-mw1a-deny" })).toBeDefined();
  expect(await ui.find({ key: "reply-q-mw1a" })).toBeDefined();
  await ui.press({ key: "opt-q-mw1a-deny" });
  const cli = processes.find((p) => String(p.argv[1]).endsWith("scripts/ledger.mjs"));
  expect(cli.argv.slice(2)).toEqual(["--json", "answer", "q-mw1a", "deny"]);
  expect(await ui.find({ type: "Text", text: "Recorded: deny" })).toBeDefined();
  await ui.unmount();
});

test("the default option is marked on its own button, and no line repeats the options as text", async ($, on) => {
  stubs(on);
  await start($);
  const ui = await $.ui.mount(PANE);
  const approve = await ui.find({ key: "opt-q-mw1a-approve" });
  expect(approve.props).toMatchObject({ label: "approve · default", variant: "primary" });
  const deny = await ui.find({ key: "opt-q-mw1a-deny" });
  expect(deny.props.label).toBe("deny");
  expect(deny.props.variant).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /options:/ })).toBeUndefined();
  await ui.unmount();
});

test("no row id and no question slug name is drawn, before or after an answer is recorded", async ($, on) => {
  const second = { ...Q, id: "q-mw2b", name: "release-gate-approval", body: "Tag the release now?", options: ["yes", "no"], default: null, state: "held" };
  stubs(on, { snapshot: { ...SNAPSHOT, elsewhere: [Q, second], answers: [{ ...ANSWER, name: "colour-choice" }] } });
  await start($);
  const ui = await $.ui.mount(PANE);
  const ids = /\b(?:q|an)-[a-z0-9]+\b|release-gate-approval|colour-choice/;
  const before = readable(await ui.find({ type: "Box" }));
  // The scan reads the whole tree: the question texts and the second question's button are in it.
  expect(before).toContain("Tag the release now?");
  expect(before).toContain("answer");
  expect(before.filter((s) => ids.test(s))).toEqual([]);
  // The CLI's own message names the row ids; the pane's notice does not.
  await ui.press({ key: "opt-q-mw1a-approve" });
  const after = readable(await ui.find({ type: "Box" }));
  expect(after).toContain("Recorded: approve");
  expect(after.filter((s) => ids.test(s))).toEqual([]);
  await ui.unmount();
});

/** Any row id (complete or cut short) in a list of drawn strings. */
const ID_TEXT = /\b(?:q|an|nt)-(?:[a-z0-9]+\b|(?![a-z0-9]))/;

test("a question or answer with no text: the pane says the text is missing, never its name or id", async ($, on) => {
  const elsewhere = [
    { ...Q, id: "q-mw3c", name: "release-gate-slug", body: null },
    { id: "q-mw4d", cwd: "/Users/example/code/other", state: "held", options: ["yes", "no"] },
    { ...Q, id: "q-mw5e", name: "empty-body-slug", body: "" },
  ];
  const answers = [
    { id: "q-mw6f", name: "answered-slug", body: null, state: "answered", word: "approve", via: "cli" },
    { id: "q-mw7g", state: "withdrawn", word: "withdraw" },
  ];
  stubs(on, { snapshot: { ...SNAPSHOT, elsewhere, answers } });
  await start($);
  const ui = await $.ui.mount(PANE);
  const drawn = readable(await ui.find({ type: "Box" }));
  expect(drawn.filter((s) => ID_TEXT.test(s) || /slug/.test(s))).toEqual([]);
  // Three questions and two answers, each drawn with the missing-text line in place of its text.
  expect(drawn.filter((s) => s === "(question text missing)").length).toBe(5);
  await ui.unmount();
});

test("the pane's error and refusal text carries no row id", async ($, on) => {
  let queryFails = true;
  stubs(on, {
    processRun: (e) => {
      const script = String(e.argv[1] ?? "");
      if (script.endsWith("query.mjs")) return queryFails ? { deny: "no such question q-mvr3k2p9a1xq" } : { value: { exitCode: 0, stdout: JSON.stringify(SNAPSHOT), stderr: "" } };
      // Captured from the real CLI: an answer on a question another window answered first.
      return { value: { exitCode: 0, stdout: JSON.stringify([{ line: 1, status: "refused", id: null, message: "q-mw1a already answered green (an-mwcq3q4mo4i7); an answer is final" }]), stderr: "" } };
    },
  });
  await start($);
  let ui = await $.ui.mount(PANE);
  let drawn = readable(await ui.find({ type: "Box" }));
  expect(drawn).toContain("Can't read the ledger");
  expect(drawn.filter((s) => ID_TEXT.test(s))).toEqual([]);
  await ui.unmount();
  queryFails = false;
  await completeTurn($);
  ui = await $.ui.mount(PANE);
  await ui.press({ key: "opt-q-mw1a-deny" });
  drawn = readable(await ui.find({ type: "Box" }));
  expect(drawn).toContain("Not recorded");
  expect(drawn.filter((s) => ID_TEXT.test(s) || s.includes("()"))).toEqual([]);
  await ui.unmount();
});

test("no drawn line is indented with spaces; indentation is layout", async ($, on) => {
  stubs(on);
  await start($);
  const ui = await $.ui.mount(PANE);
  const lines = texts(await ui.find({ type: "Box" }));
  expect(lines.length > 0).toBe(true);
  expect(lines.filter((s) => /^\s/.test(s))).toEqual([]);
  await ui.unmount();
});

test("a question that is not selected has one button, its digit, which selects it and shows its options", async ($, on) => {
  const second = { ...Q, id: "q-mw2b", name: "tag", body: "Tag the release now?", options: ["yes", "no"], default: null };
  stubs(on, { snapshot: { ...SNAPSHOT, elsewhere: [Q, second] } });
  await start($);
  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ key: "opt-q-mw2b-yes" })).toBeUndefined();
  const pick = await ui.find({ key: "pick-q-mw2b" });
  expect(pick.props).toMatchObject({ hotkey: "2", label: "answer" });
  await ui.press({ key: "pick-q-mw2b" });
  expect(await ui.find({ key: "opt-q-mw2b-yes" })).toBeDefined();
  expect(await ui.find({ key: "reply-q-mw2b" })).toBeDefined();
  expect(await ui.find({ key: "opt-q-mw1a-approve" })).toBeUndefined();
  await ui.unmount();
});

test("the Reply field records free text for the selected question; an empty reply records nothing", async ($, on) => {
  const { processes } = stubs(on);
  await start($);
  const ui = await $.ui.mount(PANE);
  await ui.input({ key: "reply-q-mw1a", text: "   " });
  expect(processes.filter((p) => String(p.argv[1]).endsWith("scripts/ledger.mjs")).length).toBe(0);
  await ui.input({ key: "reply-q-mw1a", text: "ship it after the demo" });
  const cli = processes.find((p) => String(p.argv[1]).endsWith("scripts/ledger.mjs"));
  expect(cli.argv.slice(2)).toEqual(["--json", "answer", "q-mw1a", "ship it after the demo"]);
  await ui.unmount();
});

test("the pane with nothing waiting says so, and /ledger close closes it", async ($, on) => {
  const { closes } = stubs(on, { snapshot: EMPTY });
  await start($);
  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ type: "Text", text: /^Nothing waiting/ })).toBeDefined();
  await ui.unmount();
  expect(await $.command.run({ command: "ledger", args: "close" })).toEqual({});
  expect(closes.length).toBe(1);
  expect(closes[0]).toMatchObject({ id: "ledger" });
});

test("turn.complete adds the fallback line to the transcript when the pane is not placed, and nothing when it is", async ($, on) => {
  stubs(on, { placed: false });
  await start($);
  const out = await completeTurn($);
  expect(out.text).toBe(
    [
      "answered since your last turn: colour → green (via cli)",
      "open q-mw1a in /Users/example/code/other: Ship the release? · approve (default) · deny",
      "answer with /ledger answer <q-id> <reply>, or /ledger to open the pane",
    ].join("\n"),
  );
});

test("turn.complete returns the fallback line alone, never Claude's answer joined to it", async ($, on) => {
  stubs(on, { placed: false, answer: "Here is Claude's whole reply.\nAlpha or beta?" });
  await start($);
  const out = await completeTurn($);
  expect(out.text).not.toContain("Claude's whole reply");
  expect(out.text).toMatch(/^answered since your last turn: colour → green \(via cli\)\n/);
});

test("one placement line per session: surface and isPlaced at session start, not repeated per turn", async ($, on) => {
  const { logs } = stubs(on, { placed: false });
  await start($);
  await completeTurn($);
  await completeTurn($);
  expect(logs.filter((l) => l.startsWith("ledger pane: surface="))).toEqual(["ledger pane: surface=desktop placed=false"]);
});

test("surface null (Claude Desktop runs Code headless): the placement line says surface=none and reports the pane placed", async ($, on) => {
  const { logs } = stubs(on);
  await $.session.start({ surface: null, isInteractive: false, cwd: "/Users/example/code/this" });
  await completeTurn($);
  expect(logs.filter((l) => l.startsWith("ledger pane: surface="))).toEqual(["ledger pane: surface=none placed=true"]);
});

test("turn.complete with the pane placed leaves the result alone", async ($, on) => {
  stubs(on, { placed: true });
  await start($);
  expect(await completeTurn($)).toEqual({ text: "" });
});

for (const session of [
  { surface: null, isInteractive: false, cwd: "/Users/example/code/this" },
  { surface: "terminal", isInteractive: true, cwd: "/Users/example/code/this" },
]) {
  test(`surface ${session.surface === null ? "null (Desktop)" : session.surface}: the query runs, the pane opens, the poll ticks, and turn.complete leaves a placed pane alone`, async ($, on) => {
    const { opens, processes, clock } = stubs(on);
    await $.session.start(session);
    expect(processes.length).toBe(1);
    expect(opens.length).toBe(1);
    expect(opens[0]).toMatchObject({ id: "ledger", title: "Ledger" });
    await clock.advance(2000);
    expect(processes.length).toBe(3);
    expect(await completeTurn($)).toEqual({ text: "" });
  });
}

test("surface null with the pane not placed (claude -p): /ledger prints the fallback text and turn.complete carries it", async ($, on) => {
  const { opens, toasts } = stubs(on, { placed: false });
  await $.session.start({ surface: null, isInteractive: false, cwd: "/Users/example/code/this" });
  expect(opens.length).toBe(1);
  expect(toasts).toEqual(["1 question waiting in 1 other folder · 1 answer since your last turn · /ledger opens the pane"]);
  const out = await $.command.run({ command: "ledger", args: "" });
  expect(out.text).toMatch(/^answered since your last turn: colour → green \(via cli\)\n/);
  expect((await completeTurn($)).text).toMatch(/^answered since your last turn/);
});

test("the poll runs once a second while the pane is placed and not at all once it is closed", async ($, on) => {
  const processes: Run[] = [];
  let placed = true;
  const clock = mock.clock(on);
  on("command.register", () => ({ value: undefined }));
  on("session.id", () => ({ value: SESSION }));
  on("session.cwd", () => ({ value: "/Users/example/code/this" }));
  on("session.start", () => ({ cwd: "/Users/example/code/this" }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.panes", () => ({ value: placed ? [{ id: "ledger", isShown: true, isFocused: false, isPlaced: true }] : [] }));
  on("ui.log", () => ({ value: undefined }));
  on("process.run", ($, e) => {
    processes.push({ argv: e.argv, init: e.init });
    return { value: { exitCode: 0, stdout: JSON.stringify(SNAPSHOT), stderr: "" } };
  });
  await start($);
  expect(processes.length).toBe(1);
  await clock.advance(3000);
  expect(processes.length).toBe(4);
  placed = false;
  await clock.advance(3000);
  expect(processes.length).toBe(4);
});

test("fault: the query process is denied → the pane shows the error, one dim log line, nothing thrown", async ($, on) => {
  const { logs } = stubs(on, { processRun: () => ({ deny: "no process for you" }) });
  await start($);
  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ type: "Text", text: /no process for you/ })).toBeDefined();
  expect(logs.filter((l) => l.startsWith("ledger pane: query:")).length).toBe(1);
  await ui.unmount();
  // A second refresh with the same error logs nothing new.
  await completeTurn($);
  expect(logs.filter((l) => l.startsWith("ledger pane: query:")).length).toBe(1);
});

test("fault: the query prints garbage → the pane names it; the CLI prints garbage → the command names it", async ($, on) => {
  stubs(on, {
    processRun: (e) => {
      const script = String(e.argv[1] ?? "");
      if (script.endsWith("query.mjs")) return { value: { exitCode: 0, stdout: "<<not json>>", stderr: "" } };
      return { value: { exitCode: 1, stdout: "", stderr: "TypeError: boom\n    at ledger.mjs:1" } };
    },
  });
  await start($);
  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ type: "Text", text: "query printed no JSON" })).toBeDefined();
  await ui.unmount();
  const out = await $.command.run({ command: "ledger", args: "answer q-mw1a approve" });
  expect(out.text).toBe("ledger error: TypeError: boom");
});

test("fault: the CLI exits 2 with a store line on stdout → the command carries the line", async ($, on) => {
  stubs(on, {
    processRun: (e) => {
      const script = String(e.argv[1] ?? "");
      if (script.endsWith("query.mjs")) return { value: { exitCode: 0, stdout: JSON.stringify(EMPTY), stderr: "" } };
      return { value: { exitCode: 2, stdout: "ledger: database busy at /Users/example/ledger.db; nothing applied\n", stderr: "" } };
    },
  });
  await start($);
  const out = await $.command.run({ command: "ledger", args: "approve q-mw1a" });
  expect(out.text).toBe("ledger error: ledger: database busy at /Users/example/ledger.db; nothing applied");
});

test("fault: ui.open is denied → /ledger answers with text instead of a pane", async ($, on) => {
  const { logs } = stubs(on, { openDeny: "no panes here", placed: false });
  await start($);
  expect(logs).toEqual(["ledger pane: session.start: ledger: $.ui.open: no panes here"]);
  // The placement line waits for the first fallback turn when session start faulted before it.
  await completeTurn($);
  expect(logs.filter((l) => l.startsWith("ledger pane: surface="))).toEqual(["ledger pane: surface=desktop placed=false"]);
  const out = await $.command.run({ command: "ledger", args: "" });
  expect(out.text).toMatch(/^ledger pane: ledger: \$\.ui\.open: no panes here\nusage: \/ledger/);
});
