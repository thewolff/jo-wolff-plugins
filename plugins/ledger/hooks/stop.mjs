#!/usr/bin/env node
// stop.mjs — Stop: refuse (once per turn) a turn that ends while a question the human has since
// replied to has no answer recorded, that asks the human a question while the session has no
// open q- row, or that states a decision without recording a note this turn.
//
// Input read: last_assistant_message, prompt_id, stop_hook_active, session_id, cwd,
// transcript_path (hooks reference § Stop input, § Common input fields); a bounce row keeps the
// reply excerpt and the transcript path so it can be reproduced.
//
// Once per turn: a block records prompt_id in cc_sessions.last_block_prompt. A later Stop for
// the same prompt_id passes without checking, so the agent is asked at most once per turn and a
// reply that still fails cannot loop. stop_hook_active = true with no guard record of ours also
// passes (another hook's continuation), and so does any Stop with no prompt_id to key on while
// stop_hook_active is true.
//
// "The human has replied": every Stop stamps its prompt_id in cc_sessions.last_stop_prompt. A
// Stop whose prompt_id differs from the stamped one belongs to a new turn. A new turn is not proof
// the human wrote: a subagent's `<task-notification>`, a `<system-reminder>`, another session's
// message all start one (0.3.8, #340). So when the transcript (transcript_path) holds timestamped
// `user` entries, the answer rule runs only if one written after the previous Stop
// (cc_sessions.last_stop_at) is a typed prompt (lib/transcript.mjs isHumanPrompt); a transcript
// that cannot be read, or holds no such entries, falls back to the prompt_id change alone. The
// session's open questions asked at or before that Stop are due. Without a prompt_id the answer
// rule does not run.
//
// brb: while ${XDG_STATE_HOME:-~/.local/state}/brb/<session_id>/away.json exists and parses, the
// human is away by their own word: the answer rule does not run, and the ask rule asks for `ask`
// then `hold` instead of a question in plain words. Read-only; any error reads as not away.
//
// "This turn" for the decision rule runs from the previous Stop of the session (its
// cc_sessions.last_stop_at, stamped on every Stop, pass or block; the session's start before
// the first) to now: a note made in that window counts.
//
// Bounce ledger (lib/bounces.mjs): every block inserts a cc_bounces row (rule, prompt_id); every
// Stop with a session and prompt_id first marks that prompt's open Stop-rule rows `satisfied`
// when their remedy has happened since (an answer, a question asked, a note). Both are fail-open:
// a failed bounce write is logged and never changes the verdict.
//
// Forgotten work, a second once-per-prompt slot (cc_sessions.last_owed_block_prompt), run after
// the rules above pass or are spent for this prompt, and also when another hook's continuation
// set stop_hook_active: the owed rule (forcing.stopOwedRule) blocks while the session owns owed
// work no open question waits on (lib/owed.mjs blockingSet); the offer check
// (forcing.stopOfferRule) blocks on a sentence offering work that no candidate question records
// (lib/stop-rules.mjs offerSentences, unrecordedOffers), whether or not a question is open.
// Candidates: open or held questions in scope, plus every question the session owns since it
// started, in any state. One block lists both, once per prompt; no prompt_id, never. A pass lists
// the session's owed moves not yet shown, and what is still owed once the slot is spent, in its
// systemMessage. An error in this slot is logged and the Stop passes.
//
// Output on block: {"decision":"block","reason":"…"}; on pass nothing. Fail open: switch off →
// nothing; store busy/unavailable/read-only (the stamp is a write) → pass with one
// systemMessage; anything thrown → runHook's systemMessage. Never exit 2.

import { transaction } from "../lib/db.mjs";
import { runHook, noticeField, invokedDirectly, logError } from "../lib/failopen.mjs";
import { elsewhereQuestions, inScope, openQuestions, ownedBySession, sessionNotes, sessionQuestions } from "../lib/commands.mjs";
import { checkStop, offerSentences, unrecordedOffers, offerReason, offerAwayReason } from "../lib/stop-rules.mjs";
import { blockingSet, eventLine, markShown, owedListLines, unshownEvents } from "../lib/owed.mjs";
import { brbAway, humanWroteSince } from "../lib/transcript.mjs";
import { invocation } from "../lib/inject.mjs";
import { withStore, hookConfig } from "../lib/store.mjs";
import { nowIso } from "../lib/time.mjs";
import { recordBounce, satisfyBounces, stopRemedyDone, STOP_RULES } from "../lib/bounces.mjs";

/**
 * Whether `text` repeats the body of an open or held question from another folder (whitespace
 * folded, case-insensitive): the reply is relaying that question to the human, not asking one.
 */
function relaysElsewhere(db, cwd, text) {
  const hay = String(text ?? "").replace(/\s+/g, " ").toLowerCase();
  if (!hay) return false;
  for (const questions of elsewhereQuestions(db, cwd).values()) {
    for (const q of questions) if (hay.includes(q.body.replace(/\s+/g, " ").trim().toLowerCase())) return true;
  }
  return false;
}

/** Questions an offer may already be recorded in: open or held in scope, and every question the session owns since it started. */
function offerCandidates(db, { sessionId, cwd, since }) {
  return db
    .prepare("SELECT id, cwd, about, body, state, session_id, asked_at FROM cc_questions")
    .all()
    .filter((q) => ((q.state === "open" || q.state === "held") && inScope(cwd, q.cwd)) || (sessionId && ownedBySession(q, { sessionId, cwd, since })));
}

/** The owed rule's block text for `items`. */
export function owedReason(items, { now = Date.now(), cli = "ledger" } = {}) {
  return [
    "ledger: work the human approved is still owed, and this turn is ending without it started:",
    ...owedListLines(items, { now, cli }),
    `For each one: start it now (dispatch the agent or run the command, then \`${cli} start <ow-id> "<agent id, session or command>"\`), or \`${cli} hold <ow-id> "<why, and until when>"\`, or \`${cli} drop <ow-id> "<why>"\`. If it waits on the human, ask through the ledger, then \`${cli} wait <ow-id> <q-id>\`. If it is already finished, \`${cli} done <ow-id> [ref]\`. Then tell the human in plain words what you did. Do not show the ids.`,
  ].join("\n");
}

const MAX_LINES = 8;

export function handle(input, { env = process.env, now = Date.now() } = {}) {
  const ready = hookConfig(env, input, "stop");
  if (!ready) return null;
  const { cfg, cwd } = ready;
  return withStore({ env, now, notices: cfg.notices, cwd, cfg, hook: "Stop" }, "the ledger stop check did not run", (store) => {
    const db = store.db;
    const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
    const promptId = typeof input.prompt_id === "string" && input.prompt_id ? input.prompt_id : null;
    const iso = nowIso(now);
    const pass = () => noticeField(store.notices);

    const session = sessionId ? db.prepare("SELECT started_at, last_block_prompt, last_stop_at, last_stop_prompt, last_owed_block_prompt FROM cc_sessions WHERE id = ?").get(sessionId) : null;
    const stamp = (verdict) => {
      if (!sessionId) return;
      transaction(
        db,
        () => {
          db.prepare(
            "INSERT INTO cc_sessions (id, cwd, started_at, last_stop_at, last_stop_prompt, last_block_prompt, last_block_rule) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_stop_at = excluded.last_stop_at, last_stop_prompt = coalesce(excluded.last_stop_prompt, last_stop_prompt), last_block_prompt = coalesce(excluded.last_block_prompt, last_block_prompt), last_block_rule = coalesce(excluded.last_block_rule, last_block_rule)",
          ).run(sessionId, cwd, iso, iso, promptId, verdict ? promptId : null, verdict?.rule ?? null);
        },
        store.dbPath,
      );
    };
    if (sessionId && promptId) {
      satisfyBounces(store, { sessionId, promptId, rules: STOP_RULES, now, env, hook: "Stop", check: (row) => stopRemedyDone(db, row, { sessionId, cwd }) });
    }
    const sharedSpent = Boolean(promptId && session?.last_block_prompt === promptId);
    const otherHook = input.stop_hook_active === true && (!promptId || !session?.last_block_prompt);
    const away = brbAway(sessionId, env);
    let verdict = null;
    if (!sharedSpent && !otherHook) {
      const newTurn = Boolean(promptId && session?.last_stop_prompt && session.last_stop_prompt !== promptId && session.last_stop_at);
      // Only a transcript that shows a typed prompt since the last Stop is evidence the human
      // wrote; an unreadable or unrecognised transcript (null) is no evidence, so no answer nag.
      const humanWrote = newTurn && !away && humanWroteSince(input.transcript_path, session.last_stop_at) === true;
      // The session's own open questions drive the answer rule and the decision rule's "asked this
      // turn" count. The ask rule stands down on any open question in scope for the folder (its
      // own, or one an earlier session left in this cwd or a parent): a leftover row is still a
      // question to the human, and a rule that ignored it sent every reply back with no way out.
      // It also stands down when the reply relays a question open in ANOTHER folder (its body
      // appears in the reply): SessionStart asks the model to tell the human about those, and
      // relaying one is not asking a new question (0.3.3, live session 708406d0).
      const open = sessionId ? sessionQuestions(db, { sessionId, cwd }) : [];
      const inScopeOpen = openQuestions(db, cwd, { below: false });
      const relayed = inScopeOpen.length || open.length ? false : relaysElsewhere(db, cwd, input.last_assistant_message);
      const turnSince = session?.last_stop_at ?? session?.started_at ?? null;
      verdict = checkStop(input.last_assistant_message, {
        dueQuestions: humanWrote ? sessionQuestions(db, { sessionId, cwd, askedBy: session.last_stop_at }) : [],
        sessionHasOpenQuestion: open.length > 0 || inScopeOpen.length > 0 || relayed,
        // A question asked this turn: its stated default ("if you don't answer, I'll go with alpha")
        // is not a decision, so the decision rule stands down for this reply.
        turnQuestions: sessionId ? open.filter((q) => !turnSince || q.asked_at > turnSince).length : 0,
        turnNotes: sessionNotes(db, { sessionId, cwd, after: turnSince }).length,
        forcing: store.config.forcing,
        cli: invocation(),
        away,
      });
    }
    if (verdict) {
      stamp(verdict);
      recordBounce(store, { sessionId, rule: verdict.rule, promptId, text: input.last_assistant_message, transcriptPath: input.transcript_path, now, env, hook: "Stop" });
      return { ...noticeField(store.notices), decision: "block", reason: verdict.reason };
    }
    if (!otherHook) stamp(null);

    let lines = [];
    try {
      const forcing = store.config.forcing ?? {};
      const cli = invocation();
      const owedSpent = Boolean(promptId && session?.last_owed_block_prompt === promptId);
      if (sessionId && promptId && !owedSpent && (forcing.stopOwedRule !== false || forcing.stopOfferRule !== false)) {
        const owed = forcing.stopOwedRule !== false ? blockingSet(db, { sessionId, cwd }) : [];
        const since = session?.started_at ?? null;
        const offers = forcing.stopOfferRule !== false ? unrecordedOffers(offerSentences(input.last_assistant_message), offerCandidates(db, { sessionId, cwd, since })) : [];
        if (owed.length || offers.length) {
          transaction(
            db,
            () => {
              db.prepare("INSERT INTO cc_sessions (id, cwd, started_at, last_owed_block_prompt) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_owed_block_prompt = excluded.last_owed_block_prompt").run(sessionId, cwd, iso, promptId);
            },
            store.dbPath,
          );
          const reasons = [];
          if (owed.length) {
            recordBounce(store, { sessionId, rule: "stopOwedRule", promptId, text: input.last_assistant_message, transcriptPath: input.transcript_path, now, env, hook: "Stop" });
            reasons.push(owedReason(owed, { now, cli }));
          }
          if (offers.length) {
            recordBounce(store, { sessionId, rule: "stopOfferRule", promptId, text: input.last_assistant_message, transcriptPath: input.transcript_path, now, env, hook: "Stop" });
            reasons.push(away ? offerAwayReason(offers, cli) : offerReason(offers, cli));
          }
          return { ...noticeField(store.notices), decision: "block", reason: reasons.join("\n\n") };
        }
      }
      const events = unshownEvents(db, { sessionId, cwd });
      lines = events.map(eventLine);
      if (owedSpent && forcing.stopOwedRule !== false) {
        for (const i of blockingSet(db, { sessionId, cwd })) lines.push(`ledger: still owed after one reminder, and the turn ended: ${i.body}`);
      }
      if (lines.length > MAX_LINES) {
        // Events come first; a cut event stays unstamped and shows at a later Stop, while a cut
        // still-owed line names an open item, which `pending --all` lists.
        const cutEvents = Math.max(0, events.length - MAX_LINES);
        const cutOwed = lines.length - MAX_LINES - cutEvents;
        const parts = [];
        if (cutEvents) parts.push(cutEvents === 1 ? "1 more event; it shows at a later Stop" : `${cutEvents} more events; they show at a later Stop`);
        if (cutOwed) parts.push(`${cutOwed} more still owed; run \`${cli} pending --all\``);
        lines = [...lines.slice(0, MAX_LINES), `… and ${parts.join(" · ")}`];
      }
      // Only the events whose lines were printed are stamped; the rest show on a later Stop.
      const shown = events.slice(0, MAX_LINES);
      if (shown.length) transaction(db, () => markShown(db, shown.map((e) => e.id), iso), store.dbPath);
    } catch (err) {
      logError("Stop", `the forgotten-work check did not run: ${err.message}`, env);
      lines = [];
    }
    const notices = [...store.notices, ...lines];
    return notices.length ? { systemMessage: notices.join("\n") } : pass();
  });
}

if (invokedDirectly(import.meta.url)) {
  runHook("Stop", (input) => handle(input));
}
