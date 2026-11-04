#!/usr/bin/env node
// i-have-audhd-stop.mjs — the enforcement half of i-have-audhd.
//
// WHAT THIS IS
//   A Stop hook. When the assistant finishes a turn, this hook reads the final message and
//   enforces the delivered rules against it. A model-graded check that runs automatically
//   inside a hook is still machinery: it fires on a trigger, it decides pass or fail, and it
//   fails open — it is a different instrument with a different error profile, not a
//   non-enforcement. The requirement, 2026-09-21: "I want the rules either enforceable by
//   machinery or an explicit it-can't-be-done." This file is the machinery answer for most of them.
//
// CONTRACT
//   stdin:  one Stop-payload JSON object — session_id, transcript_path, stop_hook_active
//           (Claude Code shape); OMP seat payloads additionally carry last_assistant_message.
//   stdout: one JSON object {"decision":"block","reason":"…"} when a block-mode rule fired,
//           plus "systemMessage" when the judge alert or a fault of this run is due; NOTHING
//           otherwise. Exit 0 on every path — a broken hook must not break a session, but it
//           must not be invisible either (errors.log plus one warning line, FAIL-OPEN below).
//
// ORDER OF OPERATIONS (each early return is exit 0, zero stdout unless it was a fault)
//   1. Kill switch — the flag file $HOME/.claude/.i-have-audhd-off, checked with
//      existsSync PER INVOCATION. Never a module-scope env read: env is frozen for the life
//      of the host process that spawns hooks, so an env switch cannot be thrown without
//      relaunching the host. The file works within one turn. Chosen silence: documented
//      here, not announced to the model. $I_HAVE_AUDHD_ENFORCE=off is a secondary
//      switch with exactly that frozen caveat — it costs a host relaunch to change. Then the
//      profile's `inject` (lib/config.mjs loadSwitches): "rules" means injection only, so
//      this hook checks nothing. The flag file is read first and wins over every value. A
//      check bound to a rule the profile's `inject.rules` switches off (lib/rules.mjs CHECKS)
//      defaults to off; its own enforcement.rules entry still wins (lib/config.mjs).
//   2. Parse the payload. Empty stdin, unparseable stdin or a non-object → a fault, exit 0.
//   3. Extract the final assistant text: last_assistant_message when it is a non-empty
//      string, else the transcript JSONL scanned backwards for the last type:"assistant"
//      entry with text content (tool-call-only entries are skipped; the message is the text).
//   4. Loop guard — stop_hook_active says this stop follows a continuation: under Claude Code
//      it is the host's flag (any Stop hook's continuation); under OMP the adapter sends true
//      only after its OWN block in this session, because OMP's flag is set by any extension.
//      If the sha256 of this text equals the hash recorded at this plugin's last block, exit
//      0: never block the same message twice, or a model that ignores the reason loops forever.
//   5. Master floor — under 200 substantive chars only handed-command runs. Short messages are
//      the false-positive population for every structural check this plugin ships; a
//      command-only handoff is short by nature, and rule 10 holds at any length.
//   6. Deterministic checks run per their configured modes; findings collect.
//   7. Judge-gated checks run only where their deterministic trigger fired and a judge
//      command is configured; a skipped one leaves a line in skipped.log naming the rule —
//      a skipped check must be inspectable, never silently dead. conclusion-first and
//      bad-news-first run per unit (checks/sections.mjs): each block-labeled section of a
//      labeled message, or the whole message when it has none. One judge job per qualifying
//      unit, one finding per rule naming every violating section; a judge that cannot answer
//      is never a pass for its section (JUDGE UNAVAILABLE below).
//   8. Harness cap — only when I_HAVE_AUDHD_HARNESS=omp (set by the OMP adapter on its
//      child, never by Claude Code): harnessCapsBlocks in lib/config.mjs turns every
//      block-mode finding into a warn one when the profile does not set enforcement.armOmp,
//      or when it does and stop_hook_active is true, which on OMP means this stop revises
//      this plugin's own block (a revision is re-checked, never blocked twice). Applied here,
//      to the one findings list every check feeds, so it covers every rule; a capped finding
//      takes the ordinary warn path in (9).
//   9. One block-mode finding is enough: emit the block, record the text hash for (4).
//      Warn-mode findings go to warnings.log AND replace the session's pending notice
//      (lib/pending.mjs), which the next turn delivers to the agent: on Claude Code through
//      hooks/i-have-audhd-prompt.mjs (UserPromptSubmit), on OMP through the adapter. A stop
//      reaching this step with no warn finding removes the notice. Block reasons follow the
//      house ruling of 2026-09-18 (identifier resolver): name the rule, say exactly what to
//      move or add, and NEVER demand a resend of the whole message — "paste the corrected
//      opening lines only" style, terse. That paste instruction is block-only: a warn arrives
//      after the message went out, so its notice asks for the fix going forward instead.
//      Every block reason ENDS with the way out (wayOut below): the kill-switch file, and the
//      profile key that makes each blocked rule warn only.
//
// FAIL-OPEN EVERYWHERE, NEVER FAIL-SILENT
//   Any fault of this run — a throw, stdin that is empty or not a JSON object, an unparseable
//   profile, a state file that cannot be written — leaves one errors.log line naming the file
//   and the reason, and ONE warning line in systemMessage (lib/state.mjs, FAULTS). A fault never
//   blocks: the hook exits 0, and whatever findings it did reach are still emitted.
//
// JUDGE UNAVAILABLE
//   A judge that times out, exits non-zero, cannot start, or answers unparseably gave no
//   verdict, so its rule was not checked; counting that as a pass would make a dead judge look
//   like a clean message. Instead each such rule becomes a "Judge unavailable" finding in the
//   rule's own mode (warn by default; block mode blocks once, and a revision of that block only
//   warns, since nothing in the message can bring the judge back). The person is told through
//   systemMessage, loud once per rule and error, again hourly while it keeps failing, and at
//   once after the rule was judged fine and then failed again (lib/alerts.mjs). The judge's
//   stderr is in judge-failures.log (judge/ask.mjs).

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkClosingAskLast } from "../checks/closing-ask-last.mjs";
import { checkNeedsYouFirst } from "../checks/needs-you-first.mjs";
import { checkNamesArtifact } from "../checks/name-the-artifact.mjs";
import { checkPluralBackReference } from "../checks/plural-back-reference.mjs";
import { checkHandedCommand } from "../checks/handed-command.mjs";
import { checkLinkTheReference } from "../checks/link-the-reference.mjs";
import { checkLinksResolve } from "../checks/links-resolve.mjs";
import { readGhCache, ghCachePath } from "../lib/gh-cache.mjs";
import { splitLabeledSections, openingWords, OPENING_WORDS } from "../checks/sections.mjs";
import { proseCharCount } from "../checks/lines.mjs";
import { loadEnforcement, loadSwitches, effectiveMode, harnessCapsBlocks, defaultProfilePath } from "../lib/config.mjs";
import { ruleRef } from "../lib/rules.mjs";
import { stateDir, killSwitchPath, lastBlockedPath, resumeMarkerPath, sha256hex, appendLog, logFault, faultWarning } from "../lib/state.mjs";
import { writePending } from "../lib/pending.mjs";
import { dueAlerts, clearAlerts } from "../lib/alerts.mjs";
import { findTrailingBatchSection, batchByLabelQuestion, batchJudgeContext } from "../triggers/batch-heading.mjs";
import { conclusionFirstApplicable, conclusionFirstQuestion } from "../triggers/conclusion-first.mjs";
import { lastIncompleteTodos, reportQuestion, todoJudgeContext } from "../triggers/todo-unfinished.mjs";
import { badNewsGate, badNewsQuestion } from "../triggers/bad-news-lexicon.mjs";
import { linksJudgeJobs } from "../triggers/links-judge.mjs";
import { askJudge } from "../judge/ask.mjs";

// restate-resumed-thread's judge question. Static per rule — variable data rides in the context
// (the verdict cache keys on the whole prompt either way).
const restateQuestion =
  "Rule 'restate the resumed thread': when a session resumes an earlier thread, the first " +
  "message restates the thread's subject and what is pending before continuing it — naming " +
  "the thread is not restating it. This IS the first assistant message after a resume. " +
  "violation=true when the message continues the thread without restating subject and pending " +
  "work. A message that itself summarizes or hands off (naming subject and status) is " +
  "compliant. When unsure, answer violation=false.";

// The skill rule each check enforces is declared once, in lib/rules.mjs CHECKS. Every warn and
// block reason names it, so a finding points at text the model has or can load.
// "<Check name> (<skill rule>)" — the head of every reason this hook emits.
const cite = (name, rule) => (ruleRef(rule) ? `${name} (${ruleRef(rule)})` : name);

const MASTER_FLOOR = 200;

// The block-only half of a reason. A block holds the turn open, so it asks for the corrected
// lines; a warn arrives after the message was sent (lib/pending.mjs), so it never carries this.
const paste = (what) => `Paste the corrected ${what} only; never resend the whole message.`;

// The way out of a block, last line of every block reason: the kill switch, and the profile key
// that turns each blocked rule down to warn (lib/config.mjs reads enforcement.rules).
const wayOut = (blocks) => {
  const rules = [...new Set(blocks.map((b) => b.rule))];
  const keys = rules.map((r) => `"${r}": "warn"`).join(", ");
  return `Way out: \`touch ~/.claude/.i-have-audhd-off\` turns the check off; or set {"enforcement": {"rules": {${keys}}}} in ~/.claude/i-have-audhd.json to warn instead of block.`;
};

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// The final assistant text: OMP seats put it in the payload; Claude Code requires reading the
// transcript. Returns "" whenever anything is missing or unparseable — no text, no opinion.
export function extractText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = payload.last_assistant_message;
  if (typeof direct === "string" && direct.trim()) return direct;

  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (!transcriptPath) return "";
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/);
  } catch {
    return "";
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn line in a JSONL transcript is not this hook's failure
    }
    if (!entry || typeof entry !== "object" || entry.type !== "assistant") continue;
    const content = entry.message?.content ?? entry.content;
    if (typeof content === "string" && content.trim()) return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (text.trim()) return text;
    // An assistant entry with only tool calls is not the message; keep scanning backwards.
  }
  return "";
}

// The deterministic checks, wired one by one. Each returns findings for the emit stage.
function runDeterministicChecks(text, config, switches) {
  const findings = [];

  // needs-you-first — needs you first. Calls the EXISTING check; not a fork, not a copy.
  if (effectiveMode(config, "needs-you-first") !== "off") {
    const r = checkNeedsYouFirst(text);
    if (r.flagged) {
      findings.push({
        rule: "needs-you-first",
        mode: effectiveMode(config, "needs-you-first"),
        text:
          `${cite("Needs you first", "needs-you-first")} — ${r.prosePrecedingChars} chars of substantive prose precede the Needs-you marker ` +
          `(line ${r.markerLine}). Move what needs the reader above the body.`,
        paste: paste("opening lines"),
      });
    }
  }

  // closing-ask-last — one closing ask, and it goes last.
  if (effectiveMode(config, "closing-ask-last") !== "off") {
    const r = checkClosingAskLast(text);
    if (r.flagged) {
      const detail =
        r.reason === "multiple-markers"
          ? `${r.markerCount} closing-ask markers (first at line ${r.markerLine}). Keep exactly one and fold the others into it.`
          : `${r.proseAfterChars} chars of substantive prose follow the closing-ask marker (line ${r.markerLine}). ` +
            `Move that prose above the ask so the ask is the last substantive thing.`;
      findings.push({
        rule: "closing-ask-last",
        mode: effectiveMode(config, "closing-ask-last"),
        text: `${cite("One closing ask", "closing-ask-last")} — ${detail}`,
        paste: paste("ending lines"),
      });
    }
  }

  // name-the-artifact — name the artifact. WARN by default (a vocabulary check, labeled as one); the
  // built-in default lives in lib/config.mjs, overridable per-rule or globally.
  if (effectiveMode(config, "name-the-artifact") !== "off") {
    const r = checkNamesArtifact(text);
    if (r.flagged) {
      findings.push({
        rule: "name-the-artifact",
        mode: effectiveMode(config, "name-the-artifact"),
        text:
          `${cite("Name the artifact", "name-the-artifact")} — this report-shaped message (${r.proseChars} chars, "${r.matchedVerb}" language) ` +
          `names no file, path, command, or URL. Add the artifact for the work described so the claim can be ` +
          `checked and resumed. (Vocabulary check; warn mode by default.)`,
      });
    }
  }

  // Plural back-reference in the closing ask — warn by default like every rule; the check is
  // applicable only when a closing-ask marker exists.
  if (effectiveMode(config, "plural-back-reference") !== "off") {
    const r = checkPluralBackReference(text);
    if (r.flagged) {
      const words = [...new Set(r.hits.map((h) => `"${h.word}"`))].join(", ");
      findings.push({
        rule: "plural-back-reference",
        mode: effectiveMode(config, "plural-back-reference"),
        text:
          `${cite("Plural back-reference", "plural-back-reference")} — the closing ask (line ${r.markerLine}) uses ` +
          `${words} with no referent in the same sentence. Restore the nouns so the ask reads alone.`,
        paste: paste("ask"),
      });
    }
  }

  // link-the-reference — a named PR, issue, file, artifact or branch carries its link. The
  // profile's linkTheReference.kinds picks which of the four kinds run.
  if (effectiveMode(config, "link-the-reference") !== "off") {
    const r = checkLinkTheReference(text, { kinds: switches.linkKinds });
    if (r.flagged) {
      const shown = r.findings.slice(0, 5).map((f) => `${f.where} \`${f.excerpt}\` (${f.kind})`).join("; ");
      const more = r.findings.length > 5 ? `; and ${r.findings.length - 5} more line(s)` : "";
      findings.push({
        rule: "link-the-reference",
        mode: effectiveMode(config, "link-the-reference"),
        text:
          `${cite("Link the reference", "link-the-reference")} — ${shown}${more} name something the reader cannot open ` +
          `from the line. Add the link on the same line: a PR or issue gets its https://github.com/…/pull/N or ` +
          `/issues/N URL; a file gets its absolute or ~/ path; "the report", "the plan" and the like get the path ` +
          `or URL in the same sentence; a branch gets its PR URL or its checkout's absolute path.`,
        paste: paste("lines"),
      });
    }
  }

  // handed-command — a command handed to the reader is one script line. The profile's
  // handedCommand.allow globs extend the passing shape; handedCommand.scriptRoots says where
  // a script may live.
  findings.push(...handedCommandFindings(text, config, switches));

  return findings;
}

// links-resolve — a link the message hands the reader opens: local paths exist, GitHub URLs
// have the shape of a page, and the sentence's word (PR/issue) matches the URL. GitHub
// existence and kind come from the local cache only (lib/gh-cache.mjs); the keys it cannot
// answer come back as `lookups` for the detached helper, the links it could as `links` for
// the judge stage. Returns { findings, lookups, links }.
const LINK_PROBLEM = {
  "missing-path": (f) => `no such file: ${f.path}`,
  "gh-shape": (f) => `GitHub has no /${f.segment}/ page; use /issues/N or /pull/N`,
  "gh-word": (f) => `the sentence says ${f.word} but the URL is /${f.urlKind === "pr" ? "pull" : "issues"}/`,
  "gh-missing": (f) => `GitHub answered 404 for ${f.key}`,
  "gh-kind": (f) => `${f.key} is ${f.actualKind === "pr" ? "a pull request" : "an issue"}, the URL says /${f.urlKind === "pr" ? "pull" : "issues"}/`,
};
function linksResolveFindings(text, config) {
  const mode = effectiveMode(config, "links-resolve");
  if (mode === "off") return { findings: [], lookups: [], links: [] };
  // The cache file is read only when a line names github.com: a corrupt cache costs a fault
  // notice on the stops that could use it, not on every stop.
  const r = checkLinksResolve(text, { ghCache: text.includes("github.com") ? readGhCache() : null });
  if (!r.flagged) return { findings: [], lookups: r.lookups, links: r.links };
  const shown = r.findings.slice(0, 5).map((f) => `${f.where} \`${f.excerpt}\` (${LINK_PROBLEM[f.kind](f)})`).join("; ");
  const more = r.findings.length > 5 ? `; and ${r.findings.length - 5} more` : "";
  return {
    findings: [
      {
        rule: "links-resolve",
        mode,
        text:
          `${cite("Links resolve", "links-resolve")} — ${shown}${more}. A link the reader cannot open is worse than none: ` +
          `fix the path or URL, or say in the same sentence that the file is still to come.`,
        paste: paste("lines"),
      },
    ],
    lookups: r.lookups,
    links: r.links,
  };
}

// The detached helper that fills the GitHub cache for `keys` (scripts/gh-cache-fill.mjs):
// its own process group, stdio ignored, unref'd, never awaited — this hook exits without
// it. Whether the host lets it outlive the hook is not proven under Claude Code; a cache
// that never fills only keeps the GitHub sub-checks silent. A spawn failure is one
// errors.log line.
const GH_FILL = fileURLToPath(new URL("../scripts/gh-cache-fill.mjs", import.meta.url));
function spawnGhCacheFill(keys) {
  if (!keys.length || process.env.I_HAVE_AUDHD_NO_GH_FILL === "1") return;
  try {
    const child = spawn(process.execPath, [GH_FILL, ghCachePath(), ...keys], { detached: true, stdio: "ignore" });
    child.on("error", (err) => logFault(HOOK_FILE, `gh-cache-fill could not start (${err.message}); GitHub links stay unknown`));
    child.unref();
  } catch (err) {
    logFault(HOOK_FILE, `gh-cache-fill could not start (${err.message}); GitHub links stay unknown`);
  }
}

// The handed-command finding, alone: the Stop hook also runs it under the master floor, where
// a command-only handoff is short by nature.
function handedCommandFindings(text, config, switches) {
  const mode = effectiveMode(config, "handed-command");
  if (mode === "off") return [];
  const r = checkHandedCommand(text, { allow: switches.handedCommandAllow, scriptRoots: switches.handedCommandScriptRoots });
  if (!r.flagged) return [];
  const [first, ...more] = r.findings;
  const others = more.length ? ` (and ${more.length} more: line${more.length > 1 ? "s" : ""} ${more.map((f) => f.line).join(", ")})` : "";
  const where =
    first.problem === "in-checkout"
      ? `, a script inside the git checkout ${first.checkout}`
      : first.problem === "outside-script-roots"
        ? `, a script outside every scratch root (${first.roots.join(", ")}; the profile's handedCommand.scriptRoots)`
        : first.problem === "unresolvable-path"
          ? `, a script path that does not resolve (${first.error}), so nothing shows it sits outside every git checkout`
          : "";
  return [
    {
      rule: "handed-command",
      mode,
      text:
        `${cite("Handed command", "handed-command")} — line ${first.line} hands the reader \`${first.command}\`${where}${others}. ` +
        `Rule 10: more than one command, or any interactive input, is a script file in a scratch directory outside ` +
        `every git repository; the reader types one line, \`zsh /path/to/script.sh\`, that stays byte-identical, and ` +
        `fixes edit the file. Put the command in a script and hand that one line.`,
      paste: paste("command line"),
    },
  ];
}

// A unit of a labeled message tells the judge what it is looking at: one section, judged alone.
function unitFraming(unit) {
  return unit.label
    ? `The message below is one labeled section (**${unit.label}**, line ${unit.line}) of a longer ` +
        "message; the reader reads each labeled section as its own message, so judge it alone."
    : "The message below is the unlabeled opening of a longer message, the text before its first " +
        "labeled section; the reader reads each section as its own message, so judge it alone.";
}

// The per-unit question for conclusion-first and bad-news-first: the rule's question, the
// framing when the message is labeled, then the unit's opening window — all outside the judged
// message, so the judge reads the unit verbatim and does not have to count words.
function unitQuestion(question, unit, sectioned) {
  const window = openingWords(unit.text);
  const count = window ? window.split(" ").length : 0;
  return [
    question,
    ...(sectioned ? [unitFraming(unit)] : []),
    `The reader's first ${count} words here are: "${window}".`,
  ].join(" ");
}

// One judge job per unit of `text` that passes `gate`. Unlabeled: one unit, the whole text.
function unitJobs(rule, question, units, gate) {
  const sectioned = units.some((u) => u.label);
  return units
    .filter((unit) => gate(unit.text).applicable)
    .map((unit) => ({
      rule,
      question: unitQuestion(question, unit, sectioned),
      contextText: unit.text,
      unit: sectioned ? unit : null,
    }));
}

// "**CLAIM** at line 12" — how a finding names a section of a labeled message.
const sectionName = (unit) =>
  unit.label ? `**${unit.label}** at line ${unit.line}` : "the opening before the first label, at line 1";

// House reason format for judge findings: rule named, what to move or add, judge's one-liner
// carried; the block-only paste instruction rides separately (see `paste`). `hits` is every
// violating job of ONE rule with its verdict, in job order (line order for sections); one
// builder per rule id. Only conclusion-first and bad-news-first can carry more than one hit:
// one per labeled section. Returns { text, paste }.
function judgeReason(hits) {
  const [{ job, verdict }] = hits;
  if (job.unit) {
    const where = hits.map((h) => `${sectionName(h.job.unit)} — judge: ${h.verdict.reason}`).join("; ");
    const count = hits.length === 1 ? "one section" : `${hits.length} sections`;
    if (job.rule === "conclusion-first") {
      return {
        text:
          `${cite("Conclusion first", job.rule)} — judged per labeled section, the point arrives after the opening ` +
          `${OPENING_WORDS} words in ${count}: ${where}. Move each named section's point into its opening ` +
          `${OPENING_WORDS} words and let the rest earn it.`,
        paste: paste("opening lines of each named section"),
      };
    }
    return {
      text:
        `${cite("Bad news first", job.rule)} — judged per labeled section, bad news arrives after the opening ` +
        `${OPENING_WORDS} words in ${count}: ${where}. Move the bad news into the opening ${OPENING_WORDS} words ` +
        `of each named section; the explanation goes second.`,
      paste: paste("opening lines of each named section"),
    };
  }
  switch (job.rule) {
    case "do-not-batch-by-label":
      return {
        text:
          `${cite("Do not batch by label", job.rule)} — the trailing "${job.heading}" section is judged a batched dump ` +
          `(judge: ${verdict.reason}). Move each item next to the thing it is about; a lead needs-you ` +
          `section pulling decisions to the top stays compliant.`,
        paste: paste("sections"),
      };
    case "conclusion-first":
      return {
        text:
          `${cite("Conclusion first", job.rule)} — the opening ${OPENING_WORDS} words are judged setup while the verdict arrives ` +
          `later (judge: ${verdict.reason}). Move the decision into the opening ${OPENING_WORDS} words and let the rest earn it.`,
        paste: paste("opening lines"),
      };
    case "restate-resumed-thread":
      return {
        text:
          `${cite("Restate the resumed thread", job.rule)} — this is the first message after a resume and it is judged to ` +
          `continue without restating the thread's subject and pending work (judge: ${verdict.reason}). ` +
          `Add a short restatement of subject and pending work at the top.`,
        paste: paste("opening lines"),
      };
    case "report-what-you-did-not-do":
      return {
        text:
          `${cite("Report what you did not do", job.rule)} — the last todo list had unfinished item(s) whose status this ` +
          `message is judged not to report (judge: ${verdict.reason}). Add one line per unfinished item: ` +
          `done, or not done with why.`,
        paste: "Paste the added lines only; never resend the whole message.",
      };
    case "bad-news-first":
      return {
        text:
          `${cite("Bad news first", job.rule)} — the message is judged to carry bad news that its opening ` +
          `${OPENING_WORDS} words neither state nor point to (judge: ${verdict.reason}). Move the bad news into the ` +
          `opening ${OPENING_WORDS} words; the explanation goes second.`,
        paste: paste("opening lines"),
      };
    case "links-judge": {
      const where = hits.map((h) => `line ${h.job.line} \`${h.job.link.href}\` — judge: ${h.verdict.reason}`).join("; ");
      return {
        text:
          `${cite("Links judge", job.rule)} — the thing behind the link is judged not to be what the sentence says ` +
          `it is: ${where}. Point the sentence at the right artifact, or describe the one it points at.`,
        paste: paste("lines"),
      };
    }
    default:
      return { text: `${cite(job.rule, job.rule)} — judge: ${verdict.reason}.`, paste: paste("lines") };
  }
}

// The command that re-tests the judge, named in every judge-unavailable message.
const SETUP_COMMAND = `node ${fileURLToPath(new URL("../tools/setup.mjs", import.meta.url))}`;

// The finding for a rule whose judge gave no verdict for `misses` (its unavailable jobs, each
// with its result). It names the rule, the cause(s), the unchecked sections, the evidence and
// the next step, and says outright that this is not a pass.
function unavailableFinding(rule, misses) {
  const errors = [...new Set(misses.map((m) => `${m.verdict.error}, ${m.verdict.cause ?? "other"}`))].join("; ");
  const sections = misses.filter((m) => m.job.unit).map((m) => sectionName(m.job.unit));
  const where = sections.length ? ` for ${sections.join("; ")}` : "";
  return {
    text:
      `Judge unavailable (${rule}) — the judge gave no verdict${where} (${errors}), so this rule was not checked; ` +
      `that is not a pass. The judge's stderr is in ${join(stateDir(), "judge-failures.log")}; ` +
      `\`${SETUP_COMMAND}\` re-tests the judge command.`,
    paste: "Nothing in the message can bring the judge back; a revision is only warned.",
  };
}

// What the person does about each cause (judge/ask.mjs CAUSES). `model` is the judge
// command's model, the thing a credential is for; `profile` the judge's own profile, when its
// stderr named one (judgeProfileOf), so a credential alert says where the credential lives.
function causeFix(cause, model, budgetMs, profile) {
  switch (cause) {
    case "credential-revoked":
      return `the credential for ${model} was revoked${profile ? ` in profile ${profile}` : ""}; log the judge's CLI in again (its own login command), then \`${SETUP_COMMAND}\` re-tests it`;
    case "no-credential":
      return `no credential for ${model} in ${profile ? `the judge's profile ${profile}` : "the judge's profile"}; add one through the judge's CLI, or pick a judge that has one with \`${SETUP_COMMAND}\``;
    case "rate-limited":
      return `${model} is rate-limiting the judge; it heals by itself, or \`${SETUP_COMMAND} --judge omp --model <a quieter model>\` moves it`;
    case "judge-self-abort":
      return `the judge aborted its own request before answering (its client-side timeout or a dropped connection); a faster model via \`${SETUP_COMMAND}\`, or a longer judge-side timeout`;
    case "hook-deadline":
      return `${model} did not answer inside the ${Math.round(budgetMs / 1000)} s budget; a faster model via \`${SETUP_COMMAND}\` (haiku-class answers in 2–4 s)`;
    case "bad-json":
      return `the judge printed no {"violation": …, "reason": …} object; run the command by hand on the prompt file the log names and read what it prints`;
    default:
      return `the judge exited without a known cause; the stderr tail is on the log line, and \`${SETUP_COMMAND}\` re-tests the command`;
  }
}

// The judge's profile named in its stderr ("no credential for x in profile agent-system-2"),
// or null.
const judgeProfileOf = (stderr) => /\bin profile ['"`]?([\w.@/-]*\w)/.exec(String(stderr ?? ""))?.[1] ?? null;

// The person-facing systemMessage for the judge-unavailable alerts due now ({key, since} from
// lib/alerts.mjs, key "judge-unavailable:<rule>:<cause>"); "" when none is due. `detail` maps a
// key to the { model, budgetMs, profile } its failure carried.
function unavailableAlert(due, detail) {
  if (!due.length) return "";
  const parts = due.map(({ key, since }) => {
    const [, rule, cause] = key.split(":");
    const d = detail.get(key) ?? { model: "unknown", budgetMs: 0, profile: null };
    return `${rule}: ${cause} — ${causeFix(cause, d.model, d.budgetMs, d.profile)}${since ? ` (still failing since ${since})` : ""}`;
  });
  return (
    `i-have-audhd: judge unavailable. ${parts.join(". ")}. Those rules were not checked, ` +
    `which is not a pass. Evidence: ${join(stateDir(), "judge-failures.log")}.`
  );
}
function recordBlock(sessionId, textHash, rules) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(lastBlockedPath(sessionId), JSON.stringify({ sha256: textHash, rules, at: new Date().toISOString() }));
  } catch (err) {
    logFault(HOOK_FILE, `could not record loop-guard hash for ${sessionId}: ${err.message}`);
  }
}

// This hook's name in errors.log lines and in its warning line.
const HOOK_FILE = "hooks/i-have-audhd-stop.mjs";

// Returns the stdout object, {} for silence.
async function main() {
  const raw = readStdin();

  // 1. Kill switch — per invocation, from the file. Zero output is the documented behavior.
  if (existsSync(killSwitchPath())) return {};
  // Secondary env switch. Caveat, documented: env is frozen per host process, so changing
  // this one means relaunching the host — the flag file above is the fast control.
  if (String(process.env.I_HAVE_AUDHD_ENFORCE || "").toLowerCase() === "off") return {};
  // The profile's inject switch: "rules" is injection only, so no check runs here.
  const switches = loadSwitches();
  if (switches.inject === "rules") return {};

  // 2. Payload. The host always sends a JSON object, so anything else is a fault.
  if (!raw.trim()) {
    logFault(HOOK_FILE, "stdin was empty; no Stop payload, nothing checked");
    return {};
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    logFault(HOOK_FILE, `stop payload did not parse (${err.message}); nothing checked`);
    return {};
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    logFault(HOOK_FILE, "stop payload is not a JSON object; nothing checked");
    return {};
  }
  const sessionId = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : "no-session";

  // 3. Text.
  const text = extractText(payload);
  if (!text.trim()) return {};

  // 4. Loop guard.
  const textHash = sha256hex(text);
  if (payload.stop_hook_active === true) {
    try {
      const prev = JSON.parse(readFileSync(lastBlockedPath(sessionId), "utf8"));
      if (prev && prev.sha256 === textHash) return {}; // same message, second pass: let it through
    } catch {
      /* no recorded hash = nothing to compare */
    }
  }

  // 5. Master floor. proseCharCount is lines.mjs's rule-free count over the same line
  // classification every check uses, so no rule's check runs to measure the floor — a rule the
  // profile switched off never executes. Under it only handed-command runs: a command-only
  // handoff is short by nature, and the rule holds at any length.
  const belowFloor = proseCharCount(text) < MASTER_FLOOR;

  // 6–7. Checks per configured modes.
  const harness = process.env.I_HAVE_AUDHD_HARNESS;
  // The profile's inject.rules: a check bound to a switched-off rule defaults to off.
  const config = { ...loadEnforcement(harness), disabledRules: switches.disabledRules };
  const findings = belowFloor ? handedCommandFindings(text, config, switches) : [...runDeterministicChecks(text, config, switches)];
  // links-resolve runs above the floor like every structural check; its GitHub unknowns go to
  // the detached helper right away, so the lookups run while the judge (if any) is asked.
  const linksResolved = belowFloor ? { findings: [], lookups: [], links: [] } : linksResolveFindings(text, config);
  findings.push(...linksResolved.findings);
  spawnGhCacheFill(linksResolved.lookups);
  if (belowFloor && !findings.length) return {};
  // A judge rule runs above the floor only.
  const judged = (rule) => !belowFloor && effectiveMode(config, rule) !== "off";

  // Judge-gated rules: deterministic trigger first; the judge runs only where a trigger fired
  // AND a judge command is configured. A skipped judge rule leaves a line in skipped.log —
  // inspectable, never silently dead. Judge jobs run in parallel so slow verdicts share
  // the harness-specific deadline rather than adding their waits together.
  const judgeJobs = [];

  // restate-resumed-thread — restate the resumed thread. The injector left a one-shot marker at session start
  // when the session came from resume/compact; THIS stop is the first substantive message
  // after it. Consuming the marker before dispatch means the judgment is one-shot even when
  // no judge is configured (the skip is logged) — a marker that survives a fired trigger
  // would re-judge every message in the session.
  if (judged("restate-resumed-thread") && existsSync(resumeMarkerPath(sessionId))) {
    try {
      rmSync(resumeMarkerPath(sessionId), { force: true });
      judgeJobs.push({ rule: "restate-resumed-thread", question: restateQuestion, contextText: text });
    } catch (err) {
      logFault(HOOK_FILE, `could not consume resume marker for ${sessionId}: ${err.message}`);
    }
  }

  if (judged("do-not-batch-by-label")) {
    const t = findTrailingBatchSection(text);
    if (t.applicable) {
      judgeJobs.push({
        rule: "do-not-batch-by-label",
        question: batchByLabelQuestion,
        contextText: batchJudgeContext(text, t),
        heading: t.heading,
      });
    }
  }

  // conclusion-first and bad-news-first judge each unit: every block-labeled section of a
  // labeled message on its own, or the whole message when it has no labels.
  const units = splitLabeledSections(text);

  // conclusion-first — conclusion first: 400 prose chars per unit; below that the judge would
  // only be guessing at "setup".
  if (judged("conclusion-first")) {
    judgeJobs.push(...unitJobs("conclusion-first", conclusionFirstQuestion, units, conclusionFirstApplicable));
  }

  // report-what-you-did-not-do — report what you did not do. Needs the transcript: the trigger reads the session's
  // LAST todo list (Claude Code's TodoWrite call, or OMP's todo tool result; the OMP adapter passes
  // its session file as transcript_path). A payload with no transcript has no todo data, and the
  // boundary is documented: with no tracked plan the violation is silence.
  if (judged("report-what-you-did-not-do") && typeof payload.transcript_path === "string") {
    let transcriptRaw = "";
    try {
      transcriptRaw = readFileSync(payload.transcript_path, "utf8");
    } catch {
      transcriptRaw = ""; // unreadable transcript: not applicable, same as none
    }
    const todos = lastIncompleteTodos(transcriptRaw);
    if (todos.applicable) {
      judgeJobs.push({
        rule: "report-what-you-did-not-do",
        question: reportQuestion,
        contextText: todoJudgeContext(text, todos),
      });
    }
  }

  // bad-news-first — bad news first: the lexicon gate decides applicability only, per unit.
  // "Fixed the error" trips the gate and is exactly the message the judge must acquit.
  if (judged("bad-news-first")) {
    judgeJobs.push(...unitJobs("bad-news-first", badNewsQuestion, units, badNewsGate));
  }

  // links-judge — is the linked artifact what the sentence says it is? Off until the profile
  // names it; the word-overlap prefilter (triggers/links-judge.mjs) keeps it to the links whose
  // sentence shares no word with the target, at most MAX_JOBS per stop.
  if (judged("links-judge")) {
    judgeJobs.push(...linksJudgeJobs(linksResolved.links));
  }
  let judgeAlert = "";
  if (judgeJobs.length) {
    if (!config.judgeCommand) {
      for (const job of judgeJobs) {
        appendLog("skipped.log", `rule=${job.rule} reason=no-judge-command profile=${defaultProfilePath()} session=${sessionId}`);
      }
    } else {
      const verdicts = await Promise.all(
        judgeJobs.map((job) =>
          askJudge(job.rule, job.question, job.contextText, config, {
            meta: { session: sessionId, section: job.unit ? `${job.unit.label ?? "opening"}@${job.unit.line}` : "whole" },
          }),
        ),
      );
      // One finding per rule: a rule judged per section collects every violating section, and
      // every section its judge could not answer for (JUDGE UNAVAILABLE in the header).
      const hitsByRule = new Map();
      const missesByRule = new Map();
      const answered = new Set();
      for (let i = 0; i < judgeJobs.length; i++) {
        const v = verdicts[i];
        const rule = judgeJobs[i].rule;
        const into = v.unavailable ? missesByRule : v.violation ? hitsByRule : null;
        if (!v.unavailable) answered.add(rule);
        if (!into) continue;
        if (!into.has(rule)) into.set(rule, []);
        into.get(rule).push({ job: judgeJobs[i], verdict: v });
      }
      for (const [rule, hits] of hitsByRule) {
        findings.push({ rule, mode: effectiveMode(config, rule), ...judgeReason(hits) });
      }
      const failing = [];
      const detail = new Map();
      for (const [rule, misses] of missesByRule) {
        const mode = effectiveMode(config, rule);
        // A dead judge blocks once; the revision of that block is only warned.
        const capped = mode === "block" && payload.stop_hook_active === true ? "warn" : mode;
        findings.push({ rule, mode: capped, unavailable: true, ...unavailableFinding(rule, misses) });
        for (const m of misses) {
          const key = `judge-unavailable:${rule}:${m.verdict.cause ?? "other"}`;
          if (!detail.has(key)) {
            failing.push(key);
            detail.set(key, { model: m.verdict.model ?? "unknown", budgetMs: m.verdict.budgetMs ?? 0, profile: judgeProfileOf(m.verdict.stderr) });
          }
        }
      }
      // A rule whose judge answered and did not also fail this stop has healed.
      for (const rule of answered) {
        if (!missesByRule.has(rule)) clearAlerts(`judge-unavailable:${rule}:`);
      }
      judgeAlert = unavailableAlert(dueAlerts(failing), detail);
    }
  }

  // 8. Harness cap. Every finding, deterministic or judge-gated, is in `findings` by now, so
  // this one pass covers every rule. Without the omp tag harnessCapsBlocks is false and
  // nothing here runs.
  if (harnessCapsBlocks(config, harness, payload.stop_hook_active)) {
    for (const f of findings) {
      if (f.mode === "block") f.mode = "warn";
    }
  }

  // 9. Emit. Warn findings go to warnings.log (the record) and to the session's pending notice
  // (the delivery: the agent reads it on its next turn, lib/pending.mjs); a stop with none
  // clears an older notice, so the next turn hears about this message only.
  const warns = findings.filter((f) => f.mode === "warn");
  for (const f of warns) appendLog("warnings.log", `rule=${f.rule} ${f.text}`);
  writePending(sessionId, warns);
  const blocks = findings.filter((f) => f.mode === "block");
  const out = {};
  if (blocks.length) {
    recordBlock(sessionId, textHash, blocks.map((b) => b.rule).join(","));
    out.decision = "block";
    out.reason = [...blocks.map((b) => `${b.text} ${b.paste ?? ""}`.trim()), wayOut(blocks)].join("\n\n");
  }
  // The person hears about a dead judge here, once per key (lib/alerts.mjs); the agent hears
  // through the warn notice or the block reason above.
  if (judgeAlert) out.systemMessage = judgeAlert;
  return out;
}

// The one write to stdout: main's object, plus the fault warning line when this run had a fault.
function emit(out) {
  const warning = faultWarning(HOOK_FILE);
  if (warning) out.systemMessage = out.systemMessage ? `${out.systemMessage}\n${warning}` : warning;
  if (Object.keys(out).length) process.stdout.write(JSON.stringify(out));
}

// Real paths on both sides: node resolves the main module through symlinks (macOS's /var/folders
// is one), and a string compare against the raw argv would make this hook a silent no-op there.
const invokedDirectly = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (invokedDirectly) {
  main().then(emit, (err) => {
    // Fail open, and say so: errors.log and the warning line. A throw blocks nothing.
    logFault(HOOK_FILE, `threw and failed open: ${err?.stack || String(err)}`);
    emit({});
  });
}
