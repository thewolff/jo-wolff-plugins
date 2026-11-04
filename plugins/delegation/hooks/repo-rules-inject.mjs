#!/usr/bin/env node
// hooks/repo-rules-inject.mjs — PreToolUse on `Read|Edit|Write|MultiEdit|NotebookEdit`: when
// a tool touches a file whose rules chain (CLAUDE.md / AGENTS.md on the walk up from it) the
// host did not load at launch, inject that chain as additionalContext, once per session per
// file. Ported from newdle's hooks/repo-rules-inject.mjs (0.2.175). Runs under
// lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line and a systemMessage.
//
// WHY: Claude Code loads the rules files on the walk up from the LAUNCH directory. A session
// launched at a workspace root that then edits `repos/<name>/src/x.ts` never saw
// `repos/<name>/CLAUDE.md`. This hook is the missing load. Never a decision: it only adds
// context, so it can never block a call.
//
// WHAT IT INJECTS: every level of the target file's chain that is NOT an ancestor of the
// launch directory (`CLAUDE_PROJECT_DIR`, else the payload cwd: those the host already
// loaded), minus every file injected earlier this session, imports resolved. When a level is
// re-entered after working elsewhere, a one-line "now editing <repo>" reminder instead of
// the text. Output is fit to `rulesBudget` (default 9000; the host caps hook output at
// 10 000 characters): oversized sections become a path plus heading outline.
//
// STATE: `${XDG_STATE_HOME:-~/.local/state}/delegation/rules/<session key>.json`, written
// atomically (tmp + rename): `{ injected: [canonical paths], last: <dir> }`.
//
// Config: `checks["repo-rules-inject"]`: "off" turns it off; any other value is on.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows. An unreadable rules file contributes nothing.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { loadConfig, stateDir, withFault } from "../lib/config.mjs";
import { canonical, collectChain, fitToBudget, includeFile, isAncestorOf, outlineOf } from "../lib/repo-rules.mjs";

const HOOK = "repo-rules-inject";
const TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

const emit = (context) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context } });

const rulesDir = (env) => join(stateDir(env), "rules");
const statePath = (env, sessionId) => join(rulesDir(env), `${String(sessionId || "nosess").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128)}.json`);

function loadState(env, sessionId) {
  try {
    const s = JSON.parse(readFileSync(statePath(env, sessionId), "utf8"));
    return { injected: new Set(Array.isArray(s.injected) ? s.injected : []), last: typeof s.last === "string" ? s.last : "" };
  } catch {
    return { injected: new Set(), last: "" };
  }
}

function saveState(env, sessionId, state) {
  const target = statePath(env, sessionId);
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    mkdirSync(rulesDir(env), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ injected: [...state.injected], last: state.last }));
    renameSync(tmp, target);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean
    }
  }
}

const PRECEDENCE =
  "Precedence: for any edit, the rules of the repository the file lives in win over every other repository's rules and over generic workspace guidance. Rules for other repositories you touched this session still apply to their files.";

function renderSection(budget) {
  return (sec, asPointer) => {
    const head = `## Rules from \`${sec.file}\`\n\n`;
    if (!asPointer) return `${head}${sec.content.trim()}\n`;
    const toRead = (sec.sources.length ? sec.sources : [sec.file]).map((f) => `\`${f}\``).join(", ");
    return `${head}**${sec.content.length} characters (imports resolved), past this hook's ${budget}-character budget, so the text is NOT inlined.** Read ${toRead} in full before you write, review, or brief anyone on work under \`${sec.dir}\`. Its sections:\n\n${outlineOf(sec.content)}\n`;
  };
}

/**
 * @param {object} input  the host's JSON for this event
 * @returns {object|null}  an additionalContext, a systemMessage, or null
 */
export function handle(input, { env = process.env, home } = {}) {
  const { config, fault } = loadConfig(env);
  if (config.off || config.checks[HOOK] === "off") return null;
  const done = (out) => withFault(out, fault, HOOK);

  if (!TOOLS.has(String(input?.tool_name ?? ""))) return done(null);
  const ti = input?.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const rawPath = ti.file_path || ti.notebook_path || ti.path || "";
  if (typeof rawPath !== "string" || !rawPath) return done(null);

  const invocationCwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const fileDir = dirname(resolve(invocationCwd, rawPath));
  const chain = collectChain(fileDir);
  if (!chain.length) return done(null);

  const launchDir = env.CLAUDE_PROJECT_DIR || invocationCwd;
  const state = loadState(env, input?.session_id);
  const nearest = chain[0];
  const repoName = nearest.dir.split("/").filter(Boolean).pop() || nearest.dir;

  const visited = new Set(state.injected);
  const sections = [];
  for (const level of [...chain].reverse()) {
    if (isAncestorOf(level.dir, launchDir)) {
      for (const f of level.files) visited.add(canonical(f));
      continue;
    }
    for (const f of level.files) {
      const sources = [];
      const content = includeFile(f, visited, 0, sources, home);
      if (content === null || !content.trim()) continue;
      sections.push({ file: f, dir: level.dir, content, sources });
    }
  }

  if (!sections.length) {
    if (state.last === nearest.dir) return done(null);
    state.last = nearest.dir;
    saveState(env, input?.session_id, state);
    if (!chain.some((l) => l.files.some((f) => state.injected.has(canonical(f))))) return done(null);
    return done(emit(`# Now editing \`${repoName}\` (delegation repo-rules-inject)\n\nYou are back to files in the **${repoName}** repository (\`${nearest.dir}\`); its rules, injected earlier this session, govern here. ${PRECEDENCE}`));
  }

  state.injected = visited;
  state.last = nearest.dir;
  saveState(env, input?.session_id, state);
  const header = `# Rules chain for \`${repoName}\` (auto-loaded by delegation repo-rules-inject)\n\nYou are now touching files in \`${nearest.dir}\`. Below is the rules chain the host would have loaded had this session been launched there: every rules file on the walk up from the file you touched, imports resolved, minus anything already in your context. Follow these for all work in this tree. They are additive. ${PRECEDENCE}\n\n`;
  return done(emit(fitToBudget(header, sections, renderSection(config.rulesBudget), config.rulesBudget)));
}

if (invokedDirectly(import.meta.url)) runHook(HOOK, import.meta.url, { plugin: "delegation" });
