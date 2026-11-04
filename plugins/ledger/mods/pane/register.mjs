// register.mjs — the ledger pane, a Claude Code mod (hooks/hooks.json `modules` points here).
//
// What it does:
//   - `/ledger` opens a pane that lists the open and held questions asked in OTHER folders (body,
//     options, default, age) and the answers recorded on this session's questions since its last
//     prompt (the same cursor the UserPromptSubmit hook moves, so the pane shows what Claude has
//     not been told yet);
//   - a digit picks a question; its option buttons, or the Reply field, record the answer through
//     the ledger CLI (`scripts/ledger.mjs --json answer <q-id> <reply>`) with this session's id,
//     and the pane redraws, all without a Claude turn;
//   - `/ledger answer <q-id> <reply>` records the same way from the prompt; `/ledger close` closes;
//   - the data refreshes at session start, at each main turn's start and end, and once a second
//     while the pane is placed, each refresh one `node mods/pane/query.mjs` run out of process;
//   - where nothing draws (`claude -p`, a pane that is not placed), `turn.complete` adds one
//     transcript line naming what waits and the command that answers it; the line replaces the
//     engine's default `{ text: <Claude's answer> }`, it never repeats the answer;
//   - once per session, one dim line `ledger pane: surface=<surface|none> placed=<true|false|null>`
//     says whether the app gave the mod a surface and placed the pane (at session start, or at the
//     first fallback turn when session start faulted before it).
//
// How it fails: every hook catches its own error, logs one dim transcript line (`$.ui.log`) and
// passes the event on with `next(e)`; `command.run` answers with the error as text; `ui.render`
// draws the error in the pane. The query script and the CLI run with a 5 s / 10 s timeout and
// their faults come back as `{ ok: false, error }` or a refused line, never a throw past here.
//
// Rules this file keeps for `claude plugin validate`: every mods API call is spelled `$.ns.method`,
// `$` is passed only to top-level functions of this file, imports are relative, no node builtins.

import { PANE_ID, USAGE, answerArgv, byFolder, emptySnapshot, fallbackLine, fingerprint, headline, optionList, parseCommand, readCliResult, readSnapshot, selectQuestion } from "./data.mjs";

const POLL_MS = 1000;
const QUERY_TIMEOUT_MS = 5000;
const CLI_TIMEOUT_MS = 10000;

let snapshot = emptySnapshot();
let selectedId = null;
let notice = null;
let lastError = null;
let inFlight = false;
let draws = false;
let surface = null;
let diagnosed = false;

function pathUnder(root, rel) {
  return `${String(root).replace(/[\\/]+$/, "")}/${rel}`;
}

function errorText(err) {
  return String(err?.message ?? err ?? "unknown error");
}

/** One dim transcript line for a fault; never throws. */
async function logFault($, where, err) {
  try {
    await $.ui.log(`ledger pane: ${where}: ${errorText(err)}`);
  } catch {
    // nowhere to log
  }
}

/** Replace the snapshot when it changed and ask for a redraw; a new error is logged once. */
function applySnapshot($, next) {
  if (fingerprint(next) !== fingerprint(snapshot)) {
    snapshot = next;
    selectedId = selectQuestion(snapshot, selectedId);
    $.ui.invalidate("ui.render");
  }
  if (!next.ok && next.error !== lastError) {
    lastError = next.error;
    logFault($, "query", next.error);
  }
  if (next.ok) lastError = null;
}

/** Run query.mjs once and apply what it printed. Concurrent calls collapse into the one in flight. */
async function refresh($) {
  if (inFlight) return snapshot;
  inFlight = true;
  try {
    const sessionId = await $.session.id();
    const cwd = await $.session.cwd();
    const script = pathUnder($.plugin.root, "mods/pane/query.mjs");
    const run = await $.process.run(["node", script, "--session", String(sessionId ?? ""), "--cwd", cwd], { cwd, timeoutMs: QUERY_TIMEOUT_MS });
    applySnapshot($, readSnapshot(run.stdout));
  } catch (err) {
    applySnapshot($, { ok: false, error: errorText(err) });
  } finally {
    inFlight = false;
  }
  return snapshot;
}

/** Record `reply` on question `id` through the ledger CLI, as this session; then refresh. */
async function record($, id, reply) {
  let result;
  try {
    const sessionId = await $.session.id();
    const cwd = await $.session.cwd();
    const cli = pathUnder($.plugin.root, "scripts/ledger.mjs");
    const run = await $.process.run(["node", cli, ...answerArgv(id, reply)], { cwd, env: { LEDGER_SESSION_ID: String(sessionId ?? "") }, timeoutMs: CLI_TIMEOUT_MS });
    result = readCliResult(run);
  } catch (err) {
    result = { status: "error", message: errorText(err) };
  }
  notice = result.status === "ok" ? `recorded: ${result.message}` : `${result.status}: ${result.message}`;
  $.ui.invalidate("ui.render");
  await refresh($);
  return result;
}

/** Whether the pane is placed on screen: true, false, or null when the app cannot say. */
async function paneIsPlaced($) {
  try {
    const panes = await $.ui.panes();
    const pane = Array.isArray(panes) ? panes.find((p) => p && p.id === PANE_ID) : null;
    return pane ? pane.isPlaced !== false : false;
  } catch {
    return null;
  }
}

/** Open the pane; `{ isPlaced }` when the app reports it, else `{ isPlaced: null }`. */
async function openPane($, focus) {
  const args = focus ? { id: PANE_ID, title: "Ledger", focus: true } : { id: PANE_ID, title: "Ledger" };
  const result = await $.ui.open(args);
  return { isPlaced: result && typeof result.isPlaced === "boolean" ? result.isPlaced : null };
}

/** The once-per-session placement line; never throws. */
async function diagnose($, placed) {
  if (diagnosed) return;
  diagnosed = true;
  try {
    await $.ui.log(`ledger pane: surface=${surface ?? "none"} placed=${placed}`);
  } catch {
    // nowhere to log
  }
}

/** The poll: only while the pane is placed, never while a refresh is in flight. */
async function tick($) {
  if (inFlight) return;
  const placed = await paneIsPlaced($);
  if (placed === false) return;
  await refresh($);
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    diagnosed = false;
    try {
      await $.command.register({ name: "ledger", description: "Ledger: questions waiting in other folders, answers since your last turn; answer <q-id> <reply> records without a turn", argumentHint: "[answer <q-id> <reply> | close]", immediate: true });
      surface = e.surface ?? null;
      draws = surface !== null;
      let placed = false;
      if (draws) {
        $.clock.every(POLL_MS, () => tick($));
        await refresh($);
        if (snapshot.ok && (snapshot.elsewhere.length || snapshot.answers.length)) {
          const opened = await openPane($, false);
          placed = opened.isPlaced;
          if (opened.isPlaced === false) await $.ui.toast(`${headline(snapshot)} · /ledger opens the pane`);
        } else {
          placed = await paneIsPlaced($);
        }
      }
      await diagnose($, placed);
    } catch (err) {
      await logFault($, "session.start", err);
    }
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    try {
      if (draws && e.agentId === undefined) refresh($);
    } catch (err) {
      await logFault($, "turn.start", err);
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    let line = null;
    try {
      if (e.agentId === undefined) {
        await refresh($);
        const placed = draws ? await paneIsPlaced($) : false;
        if (placed !== true) {
          line = fallbackLine(snapshot);
          await diagnose($, placed);
        }
      }
    } catch (err) {
      await logFault($, "turn.complete", err);
    }
    const result = await next(e);
    if (!line) return result;
    // The engine's default result is `{ text: e.answer }`; returning it joined to the line showed
    // Claude's whole answer a second time under the hop label. The line goes alone.
    return { ...(result ?? {}), text: line };
  });

  on("command.run", { command: "ledger" }, async ($, e) => {
    try {
      const cmd = parseCommand(e.args);
      if (cmd.kind === "usage") return { text: cmd.text };
      if (cmd.kind === "close") {
        await $.ui.close({ id: PANE_ID });
        return {};
      }
      if (cmd.kind === "answer") {
        const result = await record($, cmd.id, cmd.reply);
        return { text: `ledger ${result.status === "ok" ? "recorded" : result.status}: ${result.message}` };
      }
      await refresh($);
      if (!draws) return { text: fallbackLine(snapshot) ?? headline(snapshot) };
      const opened = await openPane($, true);
      if (opened.isPlaced === false) return { text: fallbackLine(snapshot) ?? headline(snapshot) };
      return {};
    } catch (err) {
      await logFault($, "command", err);
      return { text: `ledger pane: ${errorText(err)}\n${USAGE}` };
    }
  }).catch(async ($, e, next) => {
    // The hook threw past its own try/catch or timed out: answer with text, never leave /ledger silent.
    if (next.called) return next(e);
    return { text: `ledger pane: the command failed (${next.error?.kind ?? "error"}); nothing recorded. ${USAGE}` };
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e);
    const { Box, Text, Button, Input } = $.ui.resolve(e);
    try {
      return drawPane($, { Box, Text, Button, Input });
    } catch (err) {
      await logFault($, "render", err);
      return Text({ children: [`ledger pane: ${errorText(err)}`] });
    }
  });
}

function drawPane($, { Box, Text, Button, Input }) {
  const rows = [Text({ bold: true, children: [headline(snapshot)] })];
  if (notice) rows.push(Text({ children: [notice] }));

  if (snapshot.ok && snapshot.answers.length) {
    rows.push(Text({ dimColor: true, children: ["Answered since your last turn"] }));
    for (const a of snapshot.answers) {
      rows.push(Text({ children: [`  ${a.name} ${a.state === "withdrawn" ? "withdrawn" : `→ ${a.word}`} (via ${a.via})`] }));
    }
  }

  if (snapshot.ok && snapshot.elsewhere.length) {
    let n = 0;
    for (const group of byFolder(snapshot)) {
      rows.push(Text({ dimColor: true, children: [group.cwd] }));
      for (const q of group.questions) {
        n += 1;
        const isSelected = q.id === selectedId;
        const pick = { key: `pick-${q.id}`, label: q.name, plain: true, onPress: () => select($, q.id) };
        if (n <= 9) pick.hotkey = String(n);
        rows.push(
          Box({
            flexDirection: "row",
            columnGap: 1,
            children: [Button(pick), Text({ dimColor: true, children: [`${q.state === "held" ? "held · " : ""}${q.age}${isSelected ? " · selected" : ""}`] })],
          }),
        );
        rows.push(Text({ wrap: "wrap", children: [`  ${q.body}`] }));
        rows.push(Text({ dimColor: true, children: [`  options: ${optionList(q)}`] }));
        if (isSelected) {
          rows.push(
            Box({
              flexDirection: "row",
              columnGap: 1,
              children: q.options.map((o) => Button({ key: `opt-${q.id}-${o}`, label: o, onPress: () => record($, q.id, o) })),
            }),
          );
          rows.push(
            Input({
              key: `reply-${q.id}`,
              label: "Reply",
              placeholder: "an option word or free text, Enter records",
              value: "",
              submitLabel: "record",
              autoFocus: true,
              onSubmit: (value) => {
                const reply = String(value ?? "").trim();
                if (reply) return record($, q.id, reply);
                return undefined;
              },
            }),
          );
        }
      }
    }
  } else if (snapshot.ok) {
    rows.push(Text({ dimColor: true, children: ["No questions waiting in other folders."] }));
  }

  rows.push(Text({ dimColor: true, children: ["/ledger answer <q-id> <reply> records without a turn · Esc returns to the prompt · Ctrl+X X closes"] }));
  return Box({ flexDirection: "column", children: rows });
}

function select($, id) {
  selectedId = id;
  $.ui.invalidate("ui.render");
}
