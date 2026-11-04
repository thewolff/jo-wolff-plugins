// config.mjs — the enforcement object inside the operator profile.
//
// The profile at ~/.claude/i-have-audhd.json (or $I_HAVE_AUDHD_PROFILE) already
// carries `reader` and `traits` for the session-start injection. Enforcement settings live in
// the SAME file under an optional `enforcement` object, so an operator configures one file:
//
//   {
//     "reader": "…", "traits": ["…"],
//     "enforcement": {
//       "mode": "block",                       // block | warn | off; unset = every rule warns (measured)
//       "judgeCommand": "codex exec --skip-git-repo-check -",
//       "rules": { "name-the-artifact": "warn", "bad-news-first": "warn" },
//       "armOmp": false                        // true = OMP seats may block too (see below)
//     }
//   }
//
// PRECEDENCE, from strongest to weakest:
//   1. the kill-switch file (handled by the hook, before any of this is read)
//   2. enforcement.rules[rule]                  — a per-rule mode
//   3. enforcement.mode, WHEN THE OPERATOR SET IT — an explicit global override
//   4. the measured default                      — warn, for every rule
//   5. the harness cap, applied LAST to whatever 2-4 produced. It runs only when the hook's
//      env carries I_HAVE_AUDHD_HARNESS=omp (the OMP adapter sets it on its child;
//      Claude Code never does, so Claude behavior is untouched). Under that tag:
//        (a) enforcement.armOmp !== true      → every block becomes warn: OMP seats warn
//            unless the profile explicitly arms them;
//        (b) armOmp === true and stop_hook_active === true → every block becomes warn: a
//            revision that follows a block is re-checked but never blocked a second time.
//            On OMP the hook does not see the host's flag. OMP sets that flag after ANY
//            extension's continuation, so the adapter sends true only when the host flag is
//            true and its own previous result for the session was a block: (b) fires on a
//            revision after THIS plugin's block, never after another extension's.
//      The hook's same-text loop guard runs before any check, so an identical repeat still
//      passes untouched. See harnessCapsBlocks below and the hook's emit stage.
//      armOmp is read, and a malformed value logged, only under the omp tag: an untagged
//      Claude Code run never looks at the field, so it never logs about it either.
//
// WHY EVERY RULE DEFAULTS TO WARN (measured 2026-09-21, 304-message house corpus, full
// adjudication): needs-you-first 16/18 flags false-positive (89%), closing-ask-last 17/18
// (94%), conclusion-first 3/3 violations FP at a 92% trigger rate, bad-news-first 10/15
// (67%), do-not-batch-by-label 0 triggers in 50 (unexercised), name-the-artifact 0/4 FP.
// No rule's measured rate supports block-by-default: the cheapest way to satisfy a guard
// that fires on correct output is to stop writing the thing it misreads. Block arms by
// EXPLICIT configuration — enforcement.mode: "block", or enforcement.rules[rule]: "block"
// — and stays one flip away. Findings still land in warnings.log at the default, so the
// signal is collected without the teeth.
//
// A missing file or field is normal and silent. A file that exists but does not parse, or a
// value of the wrong shape, falls back to defaults AND leaves one line in errors.log — a
// config failure reads exactly like a working config otherwise.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logFault } from "./state.mjs";
import { DEFAULT_SCRIPT_ROOTS } from "../checks/handed-command.mjs";
import { KINDS as LINK_KINDS, DEFAULT_KINDS as LINK_DEFAULT_KINDS } from "../checks/link-the-reference.mjs";
import { RULE_IDS, ruleOf } from "./rules.mjs";

const MODES = new Set(["block", "warn", "off"]);

// Built-in per-rule modes. EMPTY of block entries since the 2026-09-21 corpus measurement
// (header): no rule's false-positive rate supports block-by-default, so block arms only by
// explicit config. The one entry is a rule that is OFF until named: links-judge costs a judge
// call per unmatched link, so neither the warn default nor a global enforcement.mode turns it
// on — only enforcement.rules["links-judge"] (effectiveMode below).
const BUILT_IN_MODES = { "links-judge": "off" };

export function defaultProfilePath() {
  const explicit = process.env.I_HAVE_AUDHD_PROFILE;
  if (explicit && explicit.trim()) return explicit.trim();
  return join(homedir(), ".claude", "i-have-audhd.json");
}

// Never throws. Returns { mode, judgeCommand, rules, armOmp } with defaults applied.
// `harness` is the hook's I_HAVE_AUDHD_HARNESS; armOmp is read only when it is "omp".
export function loadEnforcement(harness, path = defaultProfilePath()) {
  const out = { mode: null, judgeCommand: null, rules: {}, armOmp: false };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out; // no profile is the normal case, not a failure
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logFault("lib/config.mjs", `enforcement: profile at ${path} does not parse (${err.message}); defaults apply`);
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logFault("lib/config.mjs", `enforcement: profile at ${path} is not a JSON object; defaults apply`);
    return out;
  }

  const e = parsed.enforcement;
  if (!e || typeof e !== "object" || Array.isArray(e)) return out; // absent = defaults, normal

  if (e.mode !== undefined) {
    if (typeof e.mode === "string" && MODES.has(e.mode)) out.mode = e.mode;
    else logFault("lib/config.mjs", `enforcement: mode ${JSON.stringify(e.mode)} is not block|warn|off; ignored`);
  }
  if (e.judgeCommand !== undefined && e.judgeCommand !== null) {
    if (typeof e.judgeCommand === "string" && e.judgeCommand.trim()) out.judgeCommand = e.judgeCommand;
    else logFault("lib/config.mjs", `enforcement: judgeCommand ${JSON.stringify(e.judgeCommand)} is not a command string; judge rules inactive`);
  }
  if (e.rules !== undefined && e.rules !== null) {
    if (typeof e.rules === "object" && !Array.isArray(e.rules)) {
      for (const [rule, mode] of Object.entries(e.rules)) {
        if (typeof mode === "string" && MODES.has(mode)) out.rules[rule] = mode;
        else logFault("lib/config.mjs", `enforcement: rules["${rule}"] ${JSON.stringify(mode)} is not block|warn|off; ignored`);
      }
    } else {
      logFault("lib/config.mjs", "enforcement: rules is not an object; ignored");
    }
  }
  if (harness === "omp" && e.armOmp !== undefined) {
    if (typeof e.armOmp === "boolean") out.armOmp = e.armOmp;
    else logFault("lib/config.mjs", `enforcement: armOmp ${JSON.stringify(e.armOmp)} is not a boolean; treated as false`);
  }
  return out;
}

// `config.disabledRules` (a Set of rule ids from the profile's `inject.rules`, attached by the
// Stop hook) turns every check bound to a switched-off rule off by default; an explicit
// enforcement.rules[check] still wins, and nothing else does — not even enforcement.mode.
// A rule whose built-in mode is "off" stays off under a global mode too: it is opt-in by name.
export function effectiveMode(config, rule) {
  if (config.rules[rule]) return config.rules[rule];
  if (config.disabledRules?.has(ruleOf(rule))) return "off";
  if (BUILT_IN_MODES[rule] === "off") return "off";
  if (config.mode) return config.mode;
  return BUILT_IN_MODES[rule] ?? "warn"; // the measured default; block arms by explicit config
}

// Precedence tier 5 (header). True when every block-mode finding of this stop must be
// emitted as warn instead. False whenever the harness tag is not exactly "omp", so a hook
// run by Claude Code is never affected.
export function harnessCapsBlocks(config, harness, stopHookActive) {
  if (harness !== "omp") return false;
  if (config.armOmp !== true) return true; // (a) OMP unarmed
  return stopHookActive === true; // (b) armed, but this stop revises this plugin's own block
}

// ─── profile switches: `inject`, `handedCommand`, `linkTheReference` ──────────
//
//   inject: "full" | "rules" | "none", default "full". What the plugin runs, independent of
//   enforcement modes:
//     full   the session-start injection AND the Stop checks (the behavior before 1.6.0)
//     rules  the session-start injection only; the Stop hook checks nothing
//     none   no session-start injection; the Stop checks still run (a checks-only plugin)
//   The kill-switch file still wins over all three: with it present the Stop hook checks
//   nothing whatever `inject` says. It never touched the injection and still does not.
//
//   inject may instead be an object, { "mode": <one of the three>, "rules": { <rule id>:
//   true|false } }; the string form is the object with that mode and every rule on, and a
//   missing mode is "full". A rule set to false is left out of the session-start injection
//   (its core block and its line in the rule list, lib/rules.mjs compileCore), and every Stop
//   check bound to it defaults to off (effectiveMode above). Rule ids are lib/rules.mjs RULES.
//   Any invalid shape anywhere in `inject` — an unknown mode, an unknown key or rule id, a
//   non-boolean switch — is one errors.log line naming every problem, and the whole field
//   reads as its default: "full", every rule on.
//
//   handedCommand.allow: glob patterns (`*` any run of characters, `?` one, everything else
//   literal) for handed-over command lines the handed-command check accepts on top of its
//   built-in `zsh /abs/path/file.sh` shape. A pattern matches the whole line.
//
//   handedCommand.scriptRoots: the directories a handed script may live under, absolute or
//   `~/` paths, default ["~/agent-scratch"]. A script under none of them, or inside any git
//   checkout, is a finding.
//
//   linkTheReference.kinds: { <kind>: true|false } for the link-the-reference check's four
//   kinds (checks/link-the-reference.mjs KINDS); a kind left out keeps its shipped default
//   (DEFAULT_KINDS). An invalid shape is one errors.log line and every kind's default.
//
// Whole-file faults (unreadable is normal; unparseable or not an object) are NOT logged here:
// each hook already reports them through its own profile reader, and one fault is one line.
// A field of the wrong shape is logged here and reads as its default.

const INJECT_VALUES = new Set(["full", "rules", "none"]);

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// { mode, disabled: Set } from a profile's `inject`, or { problems } when its shape is invalid.
function parseInject(value) {
  if (typeof value === "string") {
    return INJECT_VALUES.has(value) ? { mode: value, disabled: new Set() } : { problems: [`${JSON.stringify(value)} is not full|rules|none`] };
  }
  if (!isPlainObject(value)) return { problems: [`${JSON.stringify(value)} is neither full|rules|none nor an object`] };
  const problems = [];
  const disabled = new Set();
  for (const key of Object.keys(value)) {
    if (key !== "mode" && key !== "rules") problems.push(`unknown key "${key}"`);
  }
  const mode = value.mode === undefined ? "full" : value.mode;
  if (typeof mode !== "string" || !INJECT_VALUES.has(mode)) problems.push(`mode ${JSON.stringify(value.mode)} is not full|rules|none`);
  if (value.rules !== undefined) {
    if (!isPlainObject(value.rules)) problems.push("rules is not an object");
    else {
      for (const [id, on] of Object.entries(value.rules)) {
        if (!RULE_IDS.includes(id)) problems.push(`rules["${id}"] is not a rule id (${RULE_IDS.join(", ")})`);
        else if (typeof on !== "boolean") problems.push(`rules["${id}"] ${JSON.stringify(on)} is not true|false`);
        else if (!on) disabled.add(id);
      }
    }
  }
  return problems.length ? { problems } : { mode, disabled };
}

// Never throws. Returns { inject, disabledRules, handedCommandAllow, handedCommandScriptRoots,
// linkKinds }. `inject` is the mode string; `disabledRules` the Set of rule ids switched off.
export function loadSwitches(path = defaultProfilePath()) {
  const out = {
    inject: "full",
    disabledRules: new Set(),
    handedCommandAllow: [],
    handedCommandScriptRoots: [...DEFAULT_SCRIPT_ROOTS],
    linkKinds: { ...LINK_DEFAULT_KINDS },
  };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;

  if (parsed.inject !== undefined) {
    const r = parseInject(parsed.inject);
    if (r.problems) logFault("lib/config.mjs", `inject: ${r.problems.join("; ")}; full with every rule on applies`);
    else {
      out.inject = r.mode;
      out.disabledRules = r.disabled;
    }
  }
  const ltr = parsed.linkTheReference;
  if (ltr !== undefined && ltr !== null) {
    const kinds = isPlainObject(ltr) ? ltr.kinds : undefined;
    const valid =
      isPlainObject(ltr) &&
      Object.keys(ltr).every((k) => k === "kinds") &&
      (kinds === undefined ||
        (isPlainObject(kinds) && Object.entries(kinds).every(([k, v]) => LINK_KINDS.includes(k) && typeof v === "boolean")));
    if (valid) Object.assign(out.linkKinds, kinds ?? {});
    else {
      logFault(
        "lib/config.mjs",
        `linkTheReference is not {"kinds": {<${LINK_KINDS.join("|")}>: true|false}}; the default kinds apply`,
      );
    }
  }
  const hc = parsed.handedCommand;
  if (hc !== undefined && hc !== null) {
    const allow = hc && typeof hc === "object" && !Array.isArray(hc) ? hc.allow : undefined;
    if (Array.isArray(allow) && allow.every((p) => typeof p === "string" && p.trim())) {
      out.handedCommandAllow = allow.map((p) => p.trim());
    } else if (allow !== undefined || typeof hc !== "object" || Array.isArray(hc)) {
      logFault("lib/config.mjs", "handedCommand.allow is not an array of non-empty strings; ignored");
    }
    const roots = hc && typeof hc === "object" && !Array.isArray(hc) ? hc.scriptRoots : undefined;
    if (roots !== undefined) {
      if (Array.isArray(roots) && roots.length && roots.every((p) => typeof p === "string" && /^(?:\/|~\/|~$)/.test(p.trim()))) {
        out.handedCommandScriptRoots = roots.map((p) => p.trim());
      } else {
        logFault(
          "lib/config.mjs",
          `handedCommand.scriptRoots is not a non-empty array of absolute or ~/ paths; ${DEFAULT_SCRIPT_ROOTS.join(", ")} applies`,
        );
      }
    }
  }
  return out;
}
