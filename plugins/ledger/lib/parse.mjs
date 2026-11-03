// parse.mjs — one line of ledger input → a command, a refused line, prose, or blank.
//
// A line is a command only when the WHOLE line matches one of these shapes (leading and
// trailing whitespace trimmed, a trailing ` # comment` dropped):
//
//   <verb>                              help, pending, stale [N], config
//   <verb> <id>                         withdraw q-…, halt wl-…, extend wl-…, extend q-…, open wl-…
//   <verb> <id> <free text>             close wl-… <reason>, park wl-… <reason>
//   <verb> <one token> [flags]          open <title>, ask <body> --options …, decide <text>
//                                        (free text with spaces is quoted: open "fix the login")
//   <word> <q-id>                       an answer: approve q-…, yes q-…, green q-…
//   answer <q-id> <word>                the same answer, spelled out
//   <number> <word>                     an ordinal into the `pending` list: 1 approve
//   ceiling <usd> [<hours>] <wl-id>     hours and id in either order; $60 and 8h are accepted
//   <word>                              a bare option word, when exactly one open question offers it
//
// Resolution of `<word> <q-id>` is OPTION FIRST: if the question offers the word, it is the
// answer (so a question whose option is `withdraw` can be answered `withdraw q-…`); otherwise the
// verb table decides (`withdraw q-…` withdraws, `extend q-…` moves the deadline); a word that is
// neither is REFUSED with the option list and nothing is written. A verb with an id that does
// not exist, or an id cut short (`approve q-`), is refused too, never prose.
//
// Anything else is PROSE: `not a command`, with `closest: <word>` when the first token is within
// edit distance 2 of a verb or of an open question's option word. Prose is never written anywhere.
//
// `lookup` is how the parser sees the store without owning it:
//   lookup.question(id)        → { id, options: string[], state, workloadStatus } or null
//   lookup.offering(word)      → q-ids of open questions in scope that offer `word`
//   lookup.optionWords()       → every option word of every open question in scope
//   lookup.exists(id)          → whether a wl-/q-/an-/de-/ce- id is a row

import { isId, isCutShort, prefixOf } from "./ids.mjs";

/** Every verb, who usually says it, and the one-line help entry. Order = `help` order. */
export const VERBS = Object.freeze([
  { verb: "open", who: "agent", usage: 'open "<title>" [--stakes throwaway|normal|production] | open <wl-id>', help: "open a workload bound to this folder (prints wl-…); `open wl-…` resumes a parked or halted one" },
  { verb: "close", who: "either", usage: "close <wl-id> <reason>", help: "close a workload; the reason is required, nothing else is; open questions on it are withdrawn" },
  { verb: "park", who: "either", usage: "park <wl-id> <reason>", help: "set a workload aside; the gate treats it as closed until `open wl-…`" },
  { verb: "ask", who: "agent", usage: 'ask "<body>" --name <short> --options a,b[,c] [--default a] [--deadline 2h|<ISO>] [--kind question|approval|plan] [--allows "a: …; b: …"] [--wl <id>]', help: "ask the human a question on the open workload (prints q-…); repeating an open one returns its id" },
  { verb: "answer", who: "human", usage: "answer <q-id> <word>   (or just: <word> <q-id>)", help: "record a one-word answer; the word must be one of the question's options, or `withdraw`" },
  { verb: "approve", who: "human", usage: "approve <q-id>", help: "the answer `approve`, when the question offers it" },
  { verb: "deny", who: "human", usage: "deny <q-id>", help: "the answer `deny`, when the question offers it" },
  { verb: "withdraw", who: "either", usage: "withdraw <q-id> | withdraw <wl-id>", help: "take a question back, or close a workload with reason `withdrawn` (refused while it has open questions)" },
  { verb: "halt", who: "human", usage: "halt <wl-id>", help: "stop a workload; the gate denies until `open wl-…`" },
  { verb: "ceiling", who: "human", usage: "ceiling <usd> [<hours>] <wl-id>", help: "set the workload's ceiling; the first one sets the size of an `extend` block" },
  { verb: "extend", who: "human", usage: "extend <wl-id> | extend <q-id>", help: "workload: ceiling + one block; question: deadline + its original span (or the answer `extend` when offered)" },
  { verb: "decide", who: "agent", usage: 'decide "<text>" [--wl <id>]', help: "record a decision made without asking (prints de-…)" },
  { verb: "pending", who: "either", usage: "pending", help: "the paste-ready block: one `<default> <q-id>  # …` line per open question" },
  { verb: "stale", who: "either", usage: "stale [N]", help: "open or parked workloads untouched for N days (default from config), with the line that clears each" },
  { verb: "config", who: "either", usage: "config", help: "the effective settings and where each came from" },
  { verb: "help", who: "either", usage: "help", help: "this table, the id grammar and the batch rule" },
]);

export const VERB_SET = new Set(VERBS.map((v) => v.verb));

/** Verbs whose argument is free text (a title, a body, a decision); never applied from a prompt. */
export const FREE_TEXT_VERBS = new Set(["open", "ask", "decide"]);

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
      if (c === quote) quote = null;
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

const prose = (text, closest, hint) => ({ kind: "prose", text, closest: closest ?? null, hint: hint ?? null });
const refused = (text, reason) => ({ kind: "refused", text, reason });
const command = (text, fields) => ({ kind: "command", text, ...fields });

const moneyRe = /^\$?(\d+(?:\.\d+)?)$/;
const hoursRe = /^(\d+(?:\.\d+)?)h$/i;
const plainNumRe = /^\d+(?:\.\d+)?$/;

function parseCeiling(text, rest) {
  let usd = null;
  let hours = null;
  let id = null;
  for (const t of rest) {
    if (isId(t)) {
      if (prefixOf(t) !== "wl") return refused(text, `ceiling takes a workload id, not ${t}`);
      if (id) return refused(text, "ceiling takes one workload id");
      id = t;
    } else if (hoursRe.test(t)) {
      if (hours !== null) return refused(text, "ceiling takes one hours value");
      hours = Number(hoursRe.exec(t)[1]);
    } else if (moneyRe.test(t)) {
      const n = Number(moneyRe.exec(t)[1]);
      if (usd === null) usd = n;
      else if (hours === null && plainNumRe.test(t)) hours = n;
      else return refused(text, "ceiling takes one usd and at most one hours value");
    } else if (isCutShort(t)) {
      return refused(text, `id cut short: ${t}`);
    } else {
      return prose(text, null, "usage: ceiling <usd> [<hours>] <wl-id>");
    }
  }
  if (!id) return refused(text, "ceiling needs a workload id (wl-…)");
  if (usd === null || !(usd > 0)) return refused(text, "ceiling needs a usd amount above 0");
  if (hours !== null && !(hours > 0)) return refused(text, "ceiling hours must be above 0");
  return command(text, { verb: "ceiling", id, usd, hours });
}

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

  // <number> <word>: an ordinal into the pending list.
  if (/^\d+$/.test(t0) && rest.length === 1 && !isId(rest[0])) {
    return command(shown, { verb: "answer", ordinal: Number(t0), word: rest[0].toLowerCase() });
  }

  // A cut-short id (`approve q-`, `close wl- reason`) is refused, never prose, when it sits where
  // an id would: unquoted, on a line that starts with a verb or is a two-token `<word> <id>`.
  // Quoted text (`decide "q-"`) and longer prose (`please explain q-`) are left alone.
  if (isVerb || tokens.length === 2) {
    const cut = tokens.find((t, i) => !quoted.has(i) && isCutShort(t));
    if (cut) return refused(shown, `id cut short: ${cut} (an id looks like ${cut}mvr3k2p9a1xq)`);
  }

  // <word> <q-id> or <word> <wl-id>: option first, then verb table.
  if (rest.length === 1 && isId(rest[0])) {
    const id = rest[0];
    const prefix = prefixOf(id);
    if (prefix === "q") {
      const q = lookup.question(id);
      if (q && q.options.includes(t0)) return command(shown, { verb: "answer", id, word: t0 });
      if (t0 === "withdraw") return command(shown, { verb: "withdraw", id });
      if (t0 === "extend") return command(shown, { verb: "extend", id });
      if (t0 === "answer") return refused(shown, `answer needs a word: answer ${id} <word>`);
      if (["halt", "close", "park", "ceiling", "open"].includes(t0)) return refused(shown, `${t0} takes a workload id (wl-…), not ${id}`);
      if (["pending", "stale", "help", "config", "ask", "decide"].includes(t0)) return refused(shown, `${t0} does not take an id`);
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
    if (prefix === "wl") {
      switch (t0) {
        case "open":
          return command(shown, { verb: "open", id });
        case "halt":
          return command(shown, { verb: "halt", id });
        case "extend":
          return command(shown, { verb: "extend", id });
        case "withdraw":
          return command(shown, { verb: "withdraw", id });
        case "close":
        case "park":
          return refused(shown, `${t0} needs a reason: ${t0} ${id} <reason>`);
        case "approve":
        case "deny":
          return refused(shown, `${t0} takes a question id (q-…), not ${id}`);
        case "ceiling":
          return refused(shown, "ceiling needs an amount: ceiling <usd> [<hours>] " + id);
        default:
          if (isVerb) return refused(shown, `${t0} does not take a workload id`);
          return refused(shown, `${t0} is not a command on a workload; options: open, close <reason>, park <reason>, halt, withdraw, extend, ceiling <usd>`);
      }
    }
    if (isVerb) return refused(shown, `${t0} does not take ${prefix}- ids`);
    return refused(shown, `${id} is a ${prefix}- row; nothing to do with it`);
  }

  // answer <q-id> <word>
  if (t0 === "answer") {
    if (rest.length === 2 && isId(rest[0]) && prefixOf(rest[0]) === "q") {
      return command(shown, { verb: "answer", id: rest[0], word: rest[1].toLowerCase() });
    }
    if (rest.length === 2 && isId(rest[1]) && prefixOf(rest[1]) === "q") {
      return command(shown, { verb: "answer", id: rest[1], word: rest[0].toLowerCase() });
    }
    return rest.length === 0 ? refused(shown, "answer needs a question id and a word: answer <q-id> <word>") : prose(shown, null, "usage: answer <q-id> <word>");
  }

  // <verb> <id> <free text>: close, park
  if ((t0 === "close" || t0 === "park") && rest.length >= 2 && isId(rest[0])) {
    if (prefixOf(rest[0]) !== "wl") return refused(shown, `${t0} takes a workload id (wl-…), not ${rest[0]}`);
    return command(shown, { verb: t0, id: rest[0], reason: rest.slice(1).join(" ") });
  }

  if (t0 === "ceiling") {
    if (!rest.length) return refused(shown, "ceiling needs an amount and a workload id: ceiling <usd> [<hours>] <wl-id>");
    return parseCeiling(shown, rest);
  }

  // No-argument verbs.
  if (["pending", "help", "config"].includes(t0)) {
    if (rest.length) return prose(shown, null, `usage: ${t0}`);
    return command(shown, { verb: t0 });
  }
  if (t0 === "stale") {
    if (!rest.length) return command(shown, { verb: "stale", days: null });
    if (rest.length === 1 && /^\d+$/.test(rest[0])) return command(shown, { verb: "stale", days: Number(rest[0]) });
    return prose(shown, null, "usage: stale [N]");
  }

  // Free-text verbs: open "<title>", ask "<body>" --flags, decide "<text>".
  if (FREE_TEXT_VERBS.has(t0)) {
    const { flags, positional } = splitFlags(rest);
    if (positional.length === 0) {
      return refused(shown, t0 === "open" ? 'open needs a title: open "<title>"' : t0 === "ask" ? 'ask needs a body: ask "<question>" --name <short> --options a,b' : 'decide needs text: decide "<what was decided>"');
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
      const needs = { withdraw: "withdraw <q-id> | withdraw <wl-id>", halt: "halt <wl-id>", extend: "extend <wl-id> | extend <q-id>", close: "close <wl-id> <reason>", park: "park <wl-id> <reason>", approve: "approve <q-id>", deny: "deny <q-id>" };
      // approve/deny alone fall through to bare-word resolution below when a question offers them.
      if (t0 !== "approve" && t0 !== "deny") return refused(shown, `${t0} needs an id: ${needs[t0]}`);
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
  }

  const candidates = [...VERB_SET, ...lookup.optionWords()];
  return prose(shown, closestWord(t0, candidates));
}

/** True for a parsed command the prompt hook may apply: it carries an id, an ordinal, or is a read-only verb. */
export function promptApplicable(parsed) {
  if (parsed.kind !== "command") return false;
  if (FREE_TEXT_VERBS.has(parsed.verb)) return false;
  if (parsed.verb === "config") return false;
  if (["pending", "stale", "help"].includes(parsed.verb)) return true;
  return Boolean(parsed.id) || parsed.ordinal !== undefined;
}
