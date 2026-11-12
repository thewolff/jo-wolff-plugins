// parse.mjs — one line of ledger input → a command, a refused line, prose, or blank.
//
// A line is a command only when the WHOLE line matches one of these shapes (leading and
// trailing whitespace trimmed, a trailing ` # comment` dropped):
//
//   <verb>                              help, pending, log [N], config, enable, disable
//   pending --all                       every open and held question in the db, grouped by folder
//   <verb> <q-id>                       withdraw q-…, extend q-…
//   <verb> <one token> [flags]          ask <body> --options …, note <text>
//                                        (free text with spaces is quoted: ask "ship it?")
//   <word> <q-id>                       an answer: approve q-…, yes q-…, green q-…
//   answer <q-id> <reply…> [flags]      the same answer, spelled out; a reply that is not an
//                                        option is recorded as given (a free-form answer);
//                                        --nothing, --pointer <p>, --work <text> are taken out
//                                        of the reply first (what the answer sets in motion)
//   <owed verb> <ow-id> [text]          start ow-… "<pointer>", hold ow-… "<why>",
//                                        drop ow-… "<why>", done ow-… [ref], wait ow-… <q-id>|none
//   <number> <word>                     an ordinal into the `pending` list: 1 approve
//   <word>                              a bare option word, when exactly one open question offers it
//
// Resolution of `<word> <q-id>` is OPTION FIRST, except the lifecycle verbs `hold` and `reopen`,
// which always change the question's state and never answer it (`answer <q-id> hold` answers
// with a `hold` option): if the question offers the word, it is the answer (so a question whose
// option is `withdraw` can be answered `withdraw q-…`); otherwise the verb table decides
// (`withdraw q-…` withdraws, `extend q-…` moves the deadline); a word that is neither is REFUSED
// with the option list and nothing is written. A verb with an id that does not exist, or an id
// cut short (`approve q-`), is refused too, never prose. The owed verbs (start, drop, done, wait)
// alone fall through to bare-option resolution like approve and deny, so a question offering
// `done` is still answered by a bare `done`. Owed verbs and `owe` are never applied from a prompt.
//
// Anything else is PROSE: `not a command`, with `closest: <word>` when the first token is within
// edit distance 2 of a verb or of an open question's option word. Prose is never written anywhere.
//
// `lookup` is how the parser sees the store without owning it:
//   lookup.question(id)        → { id, options: string[], state } or null
//   lookup.offering(word)      → q-ids of open questions in scope that offer `word`
//   lookup.optionWords()       → every option word of every open question in scope
//   lookup.exists(id)          → whether a q-/an-/nt-/ow- id is a row

import { isId, isCutShort, prefixOf } from "./ids.mjs";

/** Every verb, who usually says it, and the one-line help entry. Order = `help` order. */
export const VERBS = Object.freeze([
  { verb: "ask", who: "agent", usage: 'ask "<body>" --name <short> --options a,b[,c] [--default a] [--deadline 2h|<ISO>] [--kind question|approval|plan] [--allows "a: …; b: …"] [--ceiling <usd>] [--about "<what it concerns>"]', help: "ask the human a question (prints q-… and the line to answer with); repeating an open one returns its id" },
  { verb: "answer", who: "human", usage: 'answer <q-id> <reply> [--nothing | --pointer "<p>"] [--work "<text>"]   (a reply after a bare -- is taken literally; or just: <word> <q-id>)', help: "record the human's answer: an option word as that option, any other reply (up to 200 characters) as given, a free-form answer; `withdraw` withdraws. The answer also records the approved work as owed (body: --work, else the option's allows text, else `<name>: <reply>`); --nothing records that it set nothing in motion, --pointer that it started at once; `deny` on an approval and `cancel` on a plan create nothing unless --work is given. The short form and a prompt take options only" },
  { verb: "approve", who: "human", usage: "approve <q-id>", help: "the answer `approve`, when the question offers it" },
  { verb: "deny", who: "human", usage: "deny <q-id>", help: "the answer `deny`, when the question offers it" },
  { verb: "withdraw", who: "either", usage: "withdraw <q-id>", help: "take a question back; nothing was decided" },
  { verb: "extend", who: "human", usage: "extend <q-id>", help: "move the question's deadline by its original span (or the answer `extend`, when offered)" },
  { verb: "hold", who: "agent", usage: 'hold <q-id> · hold <ow-id> "<why, and until when>"', help: "defer an open question for the human without putting it to them: held, still unresolved, listed under Waiting on you; with an ow- id and a reason, defer owed work (it stops blocking)" },
  { verb: "reopen", who: "agent", usage: "reopen <q-id>", help: "put a held question to the human: open again, asked now" },
  { verb: "owe", who: "agent", usage: 'owe "<the work>" [--pointer "<p>"]', help: "record work you owe that no ledger answer recorded (an order given in passing); it blocks the end of a turn until started, held, dropped or done (prints ow-…)" },
  { verb: "start", who: "agent", usage: 'start <ow-id> "<agent id, session or command>"', help: "owed or deferred work is now being done; the pointer says by what" },
  { verb: "drop", who: "agent", usage: 'drop <ow-id> "<why>"', help: "owed, started or deferred work will not be done; final" },
  { verb: "done", who: "agent", usage: "done <ow-id> [ref]", help: "owed, started or deferred work is finished; ref is a PR URL, commit or path; final" },
  { verb: "wait", who: "agent", usage: "wait <ow-id> <q-id> · wait <ow-id> none", help: "owed work waits on the human's answer to one of this session's open questions: it stops blocking until that question is answered or withdrawn; `none` removes the link" },
  { verb: "note", who: "agent", usage: 'note "<text>"', help: "record a decision or assumption made without asking (prints nt-…)" },
  { verb: "outcome", who: "agent", usage: 'outcome <ref> [q-id] "<text>"', help: "record what a decision or an answered question produced; ref is a PR URL, commit or path (prints nt-…)" },
  { verb: "pending", who: "either", usage: "pending [--all]", help: "the paste-ready block: one `<default> <q-id>  # …` line per open question here, then the held ones, then owed, started and deferred work (`owed <ow-id>  # …`); `--all`: every open and held question and all owed, started and deferred work in the db, grouped under its folder" },
  { verb: "log", who: "either", usage: "log [N]", help: "the last N notes, questions and answers for this folder across sessions (default 20)" },
  { verb: "enable", who: "human", usage: "enable", help: "turn the hooks on for this folder: writes `\"enabled\": true` to .ledger.json here" },
  { verb: "disable", who: "human", usage: "disable", help: "turn the hooks off for this folder: sets `\"enabled\": false` in .ledger.json here (never deletes it)" },
  { verb: "config", who: "either", usage: "config", help: "the effective settings and where each came from" },
  { verb: "doctor", who: "either", usage: "doctor", help: "check the store, schema, config layers, hooks, errors.log and open bounces; each line ok, warn or fail; exit 1 on any fail; never writes" },
  { verb: "bounces", who: "either", usage: "bounces [--since <N>d|<N>h]", help: "the hooks' bounces since then (default 7d): per rule fired, satisfied, bypassed and open counts, then the last 20" },
  { verb: "review", who: "agent", usage: 'review [--base <ref>] [--labs a,b] [--force-round] · review status · review addressed "<why>" · review waive "<why>" · review judge <key>', help: "cross-lab review of the branch's diff (default base: merge-base with origin/main, else main or master, else HEAD~1), one row per lab for HEAD, numbered as a round of review.maxRounds; `status` the branch's rounds and HEAD's rows; `addressed` overrides an earlier commit's findings, each checked by the judge; `waive` lets HEAD through with the human's reason; `judge <key>` shows a cached judge answer with the passage it was given" },
  { verb: "canary", who: "human", usage: 'canary run [--repo <path>] [--plugins a,b] [--timeout <s>] · canary runs [N] · canary grade <id> biting|silent|fine ["<note>"] · canary prune [--days N] · canary install', help: "the nightly canary: run every plugin's e2e/live-run.sh headless and record one cc_canary_runs row each (pass, fail, unavailable); `runs` lists them; `grade` records a reading of one; `prune` removes transcripts older than 30 days; `install` writes the launchd plist and prints the bootstrap line" },
  { verb: "report", who: "either", usage: "report [--since 7d]", help: "the feedback report: per rule, bounces in the window with a mechanical grade (biting, silent, fine) and the judge's when it answers; canary runs; waived reviews; judge answers" },
  { verb: "digest", who: "human", usage: "digest [--dry-run] [--force] · digest install", help: "post the weekly report as a comment on the digest issue (refuses a second post within 24h unless --force; --dry-run prints it and records nothing); `install` writes the Monday 09:00 launchd plist" },
  { verb: "gate", who: "either", usage: "gate check [--plugins a,b] [--base <ref>]", help: "the plugin push gate's six checks (can't break the session; failures visible; text says what to do when it can't; behaviour proved by evals; state declared and pruned; a version bump written down in CHANGELOG.md and README.md, with the plugin named in the root README) on every plugin of this repository with a change since the base, recorded for HEAD; a failed or missing check denies the push until rerun or `review waive`" },
  { verb: "help", who: "either", usage: "help", help: "this table, the id grammar and the batch rule" },
]);

export const VERB_SET = new Set(VERBS.map((v) => v.verb));

/** Verbs whose argument is free text (a body, a note); never applied from a prompt. */
export const FREE_TEXT_VERBS = new Set(["ask", "note", "outcome", "owe"]);

/** Verbs that move owed work (an ow- id); never applied from a prompt. */
export const OWED_VERBS = new Set(["start", "drop", "done", "wait", "hold"]);

const WHO = Object.fromEntries(VERBS.map((v) => [v.verb, v.who]));
export const whoSays = (verb) => WHO[verb] ?? "either";

/**
 * Split on whitespace, honouring double and single quotes and backslash escapes. Returns the
 * tokens, which of them were quoted (by index), and whether a quote was left open.
 */
export function tokenizeLine(text) {
  const tokens = [];
  const quoted = new Set();
  let cur = "";
  let quote = null;
  let had = false;
  const push = () => {
    if (had) quoted.add(tokens.length);
    tokens.push(cur);
    cur = "";
    had = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && i + 1 < text.length && text[i + 1] === quote) cur += text[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      had = true;
    } else if (/\s/.test(c)) {
      if (cur.length || had) push();
    } else {
      cur += c;
    }
  }
  if (cur.length || had) push();
  return { tokens, quoted, unterminated: quote !== null };
}

/** The tokens alone. */
export function tokenize(text) {
  return tokenizeLine(text).tokens;
}

/** Drop a trailing ` # comment` (a `#` preceded by whitespace and outside quotes, or a whole-line comment). */
export function stripComment(text) {
  const t = text.trim();
  if (t.startsWith("#")) return "";
  let quote = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quote) {
      if (c === "\\" && t[i + 1] === quote) i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && i > 0 && /\s/.test(t[i - 1])) {
      return t.slice(0, i).trim();
    }
  }
  return t;
}

/** Levenshtein distance, early-exit above `max`. */
export function editDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The verb or open option word within edit distance 2 of `word`, or null. Exact matches excluded. */
export function closestWord(word, candidates) {
  let best = null;
  let bestD = 3;
  for (const c of candidates) {
    if (c === word) continue;
    const d = editDistance(word, c, 2);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** `a, b, c (or withdraw)`, without repeating withdraw when it is already an option. */
export function optionList(options) {
  return options.includes("withdraw") ? options.join(", ") : `${options.join(", ")} (or withdraw)`;
}

/** `--key value [value…]` flags from a token list; positionals returned separately. */
export function splitFlags(tokens) {
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.startsWith("--") && t.length > 2) {
      const key = t.slice(2);
      const eq = key.indexOf("=");
      if (eq > 0) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
        i++;
        continue;
      }
      const values = [];
      i++;
      while (i < tokens.length && !tokens[i].startsWith("--")) values.push(tokens[i++]);
      flags[key] = values.length ? values.join(" ") : true;
    } else {
      positional.push(t);
      i++;
    }
  }
  return { flags, positional };
}

const NULL_LOOKUP = {
  question: () => null,
  offering: () => [],
  optionWords: () => [],
  exists: () => false,
};

const NEEDS = { withdraw: "withdraw <q-id>", extend: "extend <q-id>", approve: "approve <q-id>", deny: "deny <q-id>", hold: "hold <q-id>", reopen: "reopen <q-id>", start: 'start <ow-id> "<pointer>"', drop: 'drop <ow-id> "<why>"', done: "done <ow-id> [ref]", wait: "wait <ow-id> <q-id>" };
const FALL_THROUGH = new Set(["approve", "deny", "start", "drop", "done", "wait"]);

/**
 * `--nothing`, `--pointer <v>` and `--work <v>` taken out of an answer's reply tokens (anywhere in
 * the tail; a value is the next token, whatever it is, and runs on to the next `--` token). Any
 * other `--x` token stays in the reply.
 * `quoted` holds the indices (into `tokens`) that were quoted: a quoted token is never a flag and
 * never ends a value. An unquoted bare `--` ends the flags; every token after it is reply text.
 */
export function takeAnswerFlags(tokens, quoted = new Set()) {
  const tail = [];
  const answerFlags = {};
  const isFlagLike = (j) => !quoted.has(j) && tokens[j].startsWith("--");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (quoted.has(i)) {
      tail.push(t);
      continue;
    }
    if (t === "--") {
      tail.push(...tokens.slice(i + 1));
      break;
    }
    const m = /^--(nothing|pointer|work)(?:=(.*))?$/.exec(t);
    if (!m) {
      tail.push(t);
      continue;
    }
    if (m[2] !== undefined) {
      answerFlags[m[1]] = m[2];
      continue;
    }
    if (m[1] === "nothing") {
      answerFlags.nothing = true;
      continue;
    }
    // The first token after --work/--pointer is always the value: argv arrives with its shell
    // quotes already removed, so `--work "--nothing"` is indistinguishable from `--work --nothing`.
    const values = i + 1 < tokens.length && tokens[i + 1] !== "--" ? [tokens[++i]] : [];
    while (values.length && i + 1 < tokens.length && !isFlagLike(i + 1)) values.push(tokens[++i]);
    answerFlags[m[1]] = values.length ? values.join(" ") : true;
  }
  return { tail, answerFlags };
}

const prose = (text, closest, hint) => ({ kind: "prose", text, closest: closest ?? null, hint: hint ?? null });
const refused = (text, reason) => ({ kind: "refused", text, reason });
const command = (text, fields) => ({ kind: "command", text, ...fields });

/**
 * Parse one line. `tokens` may be passed directly (argv mode) so shell quoting is honoured; the
 * `text` is then only used for echoing.
 */
export function parseLine(text, lookup = NULL_LOOKUP, tokens = null) {
  const fromArgv = tokens !== null;
  const body = fromArgv ? null : stripComment(text);
  let quoted = new Set();
  if (!fromArgv) {
    if (!body) return { kind: "blank", text };
    const split = tokenizeLine(body);
    if (split.unterminated) return refused(body, "unterminated quote; close it and try again");
    tokens = split.tokens;
    quoted = split.quoted;
    if (!tokens.length) return { kind: "blank", text };
  } else if (!tokens.length) {
    return { kind: "blank", text };
  }
  const shown = fromArgv ? tokens.map((t) => (/\s/.test(t) || t === "" ? JSON.stringify(t) : t)).join(" ") : body;
  const [t0raw, ...rest] = tokens;
  const t0 = t0raw.toLowerCase();
  const isVerb = VERB_SET.has(t0);
  // argv carries no quote marks, so the body of a free-text verb (`ledger note 'q-1'`) is taken
  // as quoted: it is text, never an id to dispatch on or a cut-short id to refuse (codex review).
  if (fromArgv && FREE_TEXT_VERBS.has(t0) && rest.length) quoted = new Set([1]);

  // <number> <word>: an ordinal into the pending list.
  if (/^\d+$/.test(t0) && rest.length === 1 && !isId(rest[0])) {
    return command(shown, { verb: "answer", ordinal: Number(t0), word: rest[0].toLowerCase() });
  }

  // A cut-short id (`approve q-`, `extend q- more`) is refused, never prose, when it sits where
  // an id would: unquoted, on a line that starts with a verb or is a two-token `<word> <id>`.
  // Quoted text (`note "q-"`) and longer prose (`please explain q-`) are left alone.
  if (isVerb || tokens.length === 2) {
    const cut = tokens.find((t, i) => !quoted.has(i) && isCutShort(t));
    if (cut) return refused(shown, `id cut short: ${cut} (an id looks like ${cut}mvr3k2p9a1xq)`);
  }

  // start|drop|done|wait|hold <ow-id> …: owed work. The rest of the line is the pointer, the
  // reason, the ref, or the question id (wait).
  if (OWED_VERBS.has(t0) && rest.length >= 1 && !quoted.has(1) && prefixOf(rest[0]) === "ow") {
    const id = rest[0];
    const text = rest.slice(1).join(" ").trim();
    if (!lookup.exists(id)) return refused(shown, `no such owed item ${id}`);
    if (t0 === "wait") {
      if (rest.length !== 2 || !(rest[1] === "none" || prefixOf(rest[1]) === "q")) return refused(shown, `wait needs a question id: wait ${id} <q-id> (or wait ${id} none)`);
      return command(shown, { verb: "wait", id, questionId: rest[1] });
    }
    if (t0 === "done") {
      if (rest.length > 2) return prose(shown, null, `usage: done ${id} [ref]`);
      return command(shown, { verb: "done", id, arg: text || null });
    }
    if (!text) return refused(shown, t0 === "start" ? `start needs a pointer: start ${id} "<agent id, session or command>"` : `${t0} needs a reason: ${t0} ${id} "<why>"`);
    return command(shown, { verb: t0, id, arg: text });
  }

  // <word> <q-id> (or any other id): option first, then verb table. A quoted id is text.
  if (rest.length === 1 && isId(rest[0]) && !quoted.has(1)) {
    const id = rest[0];
    const prefix = prefixOf(id);
    if (prefix === "q") {
      // `hold` and `reopen` change a question's state and never answer it, even when a question
      // lists that word as an option (0.3.8, #340: `hold q-…` on a question with a `hold` option
      // recorded the answer "hold"). `answer <q-id> hold` still answers with that option.
      if (t0 === "hold" || t0 === "reopen") return command(shown, { verb: t0, id });
      const q = lookup.question(id);
      if (q && q.options.includes(t0)) return command(shown, { verb: "answer", id, word: t0 });
      if (t0 === "withdraw") return command(shown, { verb: "withdraw", id });
      if (t0 === "extend") return command(shown, { verb: "extend", id });
      if (t0 === "outcome") return refused(shown, 'outcome needs a ref first: outcome <ref> [q-id] "<what it produced>"');
      if (t0 === "answer") return refused(shown, `answer needs a word: answer ${id} <word>`);
      if (["pending", "log", "help", "config", "enable", "disable", "ask", "note", "doctor", "bounces", "owe"].includes(t0)) return refused(shown, `${t0} does not take an id`);
      if (["start", "drop", "done", "wait"].includes(t0) && !(q && q.options.includes(t0))) return refused(shown, `${t0} takes an owed id (ow-…), not ${id}`);
      if (!q) {
        if (isVerb) return refused(shown, `no such question ${id}`);
        // A non-verb word on an unknown question: a typo of a verb reads as prose (#313), else refused.
        const near = closestWord(t0, [...VERB_SET]);
        return near ? prose(shown, near) : refused(shown, `no such question ${id}`);
      }
      // A near-miss of a verb or option (`aprove q-…`) is prose with `closest`, never a write (#313);
      // any other word that is not an option is refused with the option list (#315 #316 #320).
      if (!isVerb) {
        const near = closestWord(t0, [...VERB_SET, ...q.options, "withdraw"]);
        if (near) return prose(shown, near);
      }
      return refused(shown, `${t0} is not an option of ${id}; options: ${optionList(q.options)}`);
    }
    if (isVerb) return refused(shown, `${t0} takes a question id (q-…), not ${id}`);
    return refused(shown, `${id} is a ${prefix}- row; nothing to do with it`);
  }

  // answer <q-id> <reply…>: `reply` is the text as given, for a free-form answer when it is not
  // an option; `word` is its lowercased form for matching the options.
  if (t0 === "answer") {
    if (rest.length >= 2 && isId(rest[0]) && prefixOf(rest[0]) === "q") {
      // rest.slice(1) starts at token 2; shift the quoted indices to match.
      const tailQuoted = new Set([...quoted].filter((i) => i >= 2).map((i) => i - 2));
      const { tail, answerFlags } = takeAnswerFlags(rest.slice(1), tailQuoted);
      if (!tail.length) return refused(shown, `answer needs a reply: answer ${rest[0]} <reply>`);
      const reply = tail.join(" ");
      return command(shown, { verb: "answer", id: rest[0], word: reply.toLowerCase(), reply, answerFlags });
    }
    if (rest.length === 2 && isId(rest[1]) && prefixOf(rest[1]) === "q") {
      return command(shown, { verb: "answer", id: rest[1], word: rest[0].toLowerCase(), reply: rest[0] });
    }
    return rest.length === 0 ? refused(shown, "answer needs a question id and a reply: answer <q-id> <reply>") : prose(shown, null, "usage: answer <q-id> <reply>");
  }

  // No-argument verbs.
  if (t0 === "pending" && rest.length === 1 && rest[0] === "--all") return command(shown, { verb: "pending", all: true });
  if (["pending", "help", "config", "enable", "disable", "doctor"].includes(t0)) {
    if (rest.length) return prose(shown, null, `usage: ${t0 === "pending" ? "pending [--all]" : t0}`);
    return command(shown, { verb: t0 });
  }
  if (t0 === "bounces") {
    if (!rest.length) return command(shown, { verb: "bounces", since: null });
    const spec = rest[0] === "--since" && rest.length === 2 ? rest[1] : rest.length === 1 && rest[0].startsWith("--since=") ? rest[0].slice(8) : null;
    if (spec !== null && /^\d+[dh]$/.test(spec)) return command(shown, { verb: "bounces", since: spec });
    return prose(shown, null, "usage: bounces [--since <N>d|<N>h]");
  }
  if (t0 === "canary" || t0 === "report" || t0 === "digest" || t0 === "gate") return command(shown, { verb: t0, args: rest });
  if (t0 === "review") {
    const usage = 'usage: review [--base <ref>] [--labs a,b] [--force-round] | review status | review addressed "<why>" | review waive "<why>" | review judge <key>';
    if (rest[0] === "status") return rest.length === 1 ? command(shown, { verb: "review", action: "status" }) : prose(shown, null, usage);
    if (rest[0] === "addressed" || rest[0] === "waive") return command(shown, { verb: "review", action: rest[0], reason: rest.slice(1).join(" ").trim() });
    if (rest[0] === "judge") return rest.length === 2 ? command(shown, { verb: "review", action: "judge", key: rest[1] }) : prose(shown, null, usage);
    const out = { verb: "review", action: "run", base: null, labs: null, forceRound: false };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--force-round") {
        out.forceRound = true;
        continue;
      }
      const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, null];
      const value = inline ?? rest[++i];
      if (!value || !["--base", "--labs"].includes(flag)) return prose(shown, null, usage);
      if (flag === "--base") out.base = value;
      else out.labs = value.split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
    }
    return command(shown, out);
  }
  if (t0 === "log") {
    if (!rest.length) return command(shown, { verb: "log", count: null });
    if (rest.length === 1 && /^\d+$/.test(rest[0])) return command(shown, { verb: "log", count: Number(rest[0]) });
    return prose(shown, null, "usage: log [N]");
  }

  // outcome <ref> [q-id] "<text>"
  if (t0 === "outcome") {
    const [ref, ...after] = rest;
    if (!ref) return refused(shown, 'outcome needs a ref and text: outcome <ref> [q-id] "<what it produced>"');
    let questionId = null;
    let body = after;
    if (after.length && !quoted.has(2) && isId(after[0]) && prefixOf(after[0]) === "q") {
      questionId = after[0];
      body = after.slice(1);
    }
    if (body.length === 0) return refused(shown, 'outcome needs text: outcome <ref> [q-id] "<what it produced>"');
    if (body.length > 1) return prose(shown, null, `outcome takes one quoted text: outcome ${ref}${questionId ? ` ${questionId}` : ""} "${body.join(" ")}"`);
    return command(shown, { verb: "outcome", ref, questionId, textArg: body[0], flags: {} });
  }

  // Free-text verbs: ask "<body>" --flags, note "<text>".
  if (FREE_TEXT_VERBS.has(t0)) {
    const { flags, positional } = splitFlags(rest);
    if (positional.length === 0) {
      return refused(shown, t0 === "ask" ? 'ask needs a body: ask "<question>" --name <short> --options a,b' : t0 === "owe" ? 'owe needs the work: owe "<the work, one line>"' : 'note needs text: note "<what was decided or assumed>"');
    }
    if (positional.length > 1) {
      // Several unquoted words: a sentence that starts with a verb, not a command (#197).
      return prose(shown, null, `${t0} takes one quoted argument: ${t0} "${positional.join(" ")}"`);
    }
    return command(shown, { verb: t0, textArg: positional[0], flags });
  }

  // Verbs that reached here have the wrong shape.
  if (isVerb) {
    if (rest.length === 0) {
      // approve/deny and the owed verbs alone fall through to bare-word resolution below when a
      // question offers them (a question with a `done` option is answered by a bare `done`).
      if (!FALL_THROUGH.has(t0)) return refused(shown, `${t0} needs an id: ${NEEDS[t0]}`);
    } else {
      const usage = VERBS.find((v) => v.verb === t0).usage;
      return prose(shown, null, `usage: ${usage}`);
    }
  }

  // Bare option word (§ 3.4): applies when exactly one open question in scope offers it.
  if (rest.length === 0) {
    const offering = lookup.offering(t0);
    if (offering.length === 1) return command(shown, { verb: "answer", id: offering[0], word: t0 });
    if (offering.length > 1) return refused(shown, `which one? ${offering.length} open questions offer ${t0}: ${offering.join(", ")}`);
    if (t0 === "approve" || t0 === "deny") return refused(shown, `${t0} needs a question id: ${t0} <q-id>`);
    if (FALL_THROUGH.has(t0)) return refused(shown, `${t0} needs an id: ${NEEDS[t0]}`);
  }

  const candidates = [...VERB_SET, ...lookup.optionWords()];
  return prose(shown, closestWord(t0, candidates));
}

/** True for a parsed command the prompt hook may apply: it carries an id, an ordinal, or is a read-only verb. */
export function promptApplicable(parsed) {
  if (parsed.kind !== "command") return false;
  if (FREE_TEXT_VERBS.has(parsed.verb)) return false;
  // Owed work is the agent's to move: `drop ow-…` typed into a prompt applies nothing.
  if (OWED_VERBS.has(parsed.verb) && parsed.verb !== "hold") return false;
  if (parsed.id && prefixOf(parsed.id) === "ow") return false;
  if (["config", "enable", "disable", "doctor", "review"].includes(parsed.verb)) return false;
  if (["pending", "log", "help", "bounces"].includes(parsed.verb)) return true;
  return Boolean(parsed.id) || parsed.ordinal !== undefined;
}
