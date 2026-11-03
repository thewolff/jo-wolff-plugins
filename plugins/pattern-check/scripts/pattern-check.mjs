#!/usr/bin/env node
// pattern-check.mjs — the command an agent runs around the check.
//
//   pattern-check open "<what you are about to build>"   start the receipt: records the brief
//   pattern-check record [< table.md] [--row "a | b | c | d"]... [--no-new-pieces "<reason>"]
//                                                        write the receipt (repo copy + state copy)
//   pattern-check status                                 the session key, files counted, receipt path
//
// Options on every subcommand:
//   --session <key>   the session to act on. Otherwise PATTERN_CHECK_SESSION, otherwise the key
//                     the PreToolUse hook last recorded for this repository, otherwise a per-cwd key.
//   --cwd <dir>       act as if run from <dir> (default: the process's working directory).
//
// WHY THE SESSION KEY IS A PROBLEM HERE. Hooks get session_id; the Bash tool that runs this
// script does not. The PreToolUse hook writes the key it saw into the state directory on every
// call (state.mjs, `current/`), and it fires on the Bash call that runs this script, so the
// pointer is fresh. The hooks' deny and refusal texts include `--session <key>` anyway, so the
// command they name is exact even when two sessions share one repository.
//
// WHERE THE RECEIPT GOES. <repo root>/<receiptDir>/<key>.md (receiptDir defaults to
// .pattern-check) and a copy in the state directory. The repo copy is untracked; this script
// says so and suggests .git/info/exclude, and never edits .gitignore.
//
// Exit codes: 0 done; 1 the input was not a valid receipt (nothing written); 2 usage.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordCommand, resolveContext } from "./lib/context.mjs";
import { parseTable, render } from "./lib/receipt.mjs";
import { isSafeKey, readCurrent, readSession, writeAtomic, writeSession } from "./lib/state.mjs";

export const USAGE = `usage:
  pattern-check open "<what you are about to build>"
  pattern-check record [< table.md] [--row "new piece | existing pattern (file:line) | reuse|replace|new | reason"]... [--no-new-pieces "<reason>"]
  pattern-check status
options: --session <key>   --cwd <dir>`;

/** Splits argv into { command, positional, flags }. Flags with values: --session, --cwd, --row (repeatable), --no-new-pieces. */
export function parseArgs(argv) {
  const out = { command: null, positional: [], session: null, cwd: null, rows: [], noNewPieces: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session" || a === "--cwd" || a === "--row" || a === "--no-new-pieces") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i++;
      if (a === "--session") out.session = v;
      else if (a === "--cwd") out.cwd = v;
      else if (a === "--row") out.rows.push(v);
      else out.noNewPieces = v;
    } else if (a.startsWith("--")) {
      throw new Error(`unknown option ${a}`);
    } else if (out.command === null) {
      out.command = a;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

/** The session key for a CLI run: --session, then PATTERN_CHECK_SESSION, then the hook's pointer, then per-cwd. */
export function resolveSession({ session, cwd, env, home }) {
  if (session) {
    if (!isSafeKey(session)) throw new Error(`--session must be letters, digits, dots, dashes or underscores: ${session}`);
    return { ctx: resolveContext({ cwd }, { env, home, session }), source: "--session" };
  }
  const fromEnv = env.PATTERN_CHECK_SESSION;
  if (typeof fromEnv === "string" && fromEnv !== "") {
    if (!isSafeKey(fromEnv)) throw new Error(`PATTERN_CHECK_SESSION must be letters, digits, dots, dashes or underscores: ${fromEnv}`);
    return { ctx: resolveContext({ cwd }, { env, home, session: fromEnv }), source: "PATTERN_CHECK_SESSION" };
  }
  const probe = resolveContext({ cwd }, { env, home });
  const current = readCurrent(probe.base, probe.root);
  if (current) return { ctx: resolveContext({ cwd }, { env, home, session: current }), source: "the session the hook last saw in this repository" };
  return { ctx: probe, source: "this working directory (no hook has run here yet)" };
}

/**
 * Runs one CLI invocation. Returns { code, stdout, stderr }; never throws for user errors.
 * @param {string[]} argv
 * @param {{ env?: object, home?: string, cwd?: string, stdin?: string|null }} opts `stdin` is the piped text, or null when stdin is a TTY/empty
 */
export function run(argv, opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home;
  let args;
  try { args = parseArgs(argv); } catch (e) { return { code: 2, stdout: "", stderr: `${e.message}\n${USAGE}\n` }; }
  if (!args.command || !["open", "record", "status"].includes(args.command)) return { code: 2, stdout: "", stderr: `${USAGE}\n` };
  const cwd = args.cwd ?? opts.cwd ?? process.cwd();
  let resolved;
  try { resolved = resolveSession({ session: args.session, cwd, env, home }); } catch (e) { return { code: 2, stdout: "", stderr: `${e.message}\n` }; }
  const { ctx, source } = resolved;
  const { base, key, root, receiptPath, receiptCopy } = ctx;
  const notes = ctx.warnings.map((w) => `note: ${w}`);

  if (args.command === "open") {
    const what = args.positional.join(" ").trim();
    if (what === "") return { code: 2, stdout: "", stderr: `open needs the thing you are about to build, in quotes\n${USAGE}\n` };
    const { session } = readSession(base, key, root);
    session.what = what;
    session.opened = new Date().toISOString();
    session.repo = root;
    writeSession(base, session);
    const lines = [
      `pattern-check: opened for session ${key} (${source}).`,
      `what: ${what}`,
      `Now, for each new piece this adds, find the existing pattern in ${root} that does its job (the pattern-check skill has the method), then run:`,
      `  ${recordCommand(key, env)} < table.md`,
      ...notes,
    ];
    return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  }

  if (args.command === "status") {
    const { session, fault } = readSession(base, key, root);
    const lines = [
      `session: ${key} (${source})`,
      `repository: ${root}`,
      `what: ${session.what ?? "(not opened)"}`,
      `files touched: ${session.files.length} (threshold ${ctx.config.threshold})`,
      ...session.files.map((f) => `  ${f}`),
      `receipt: ${ctx.receiptExists ? (existsSync(receiptPath) ? receiptPath : receiptCopy) : "none"}`,
      `config: user ${ctx.config.sources.user ?? "(none)"}; repo ${ctx.config.sources.repo ?? "(none)"}`,
      ...(fault ? [`note: ${fault}`] : []),
      ...notes,
    ];
    return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  }

  // record
  let text = "";
  if (args.noNewPieces !== null) {
    if (args.noNewPieces.trim() === "") return { code: 1, stdout: "", stderr: "--no-new-pieces needs a reason\n" };
    text = `No new pieces: ${args.noNewPieces.trim()}\n`;
  }
  if (args.rows.length) text += `${args.rows.map((r) => (r.trim().startsWith("|") ? r : `| ${r} |`)).join("\n")}\n`;
  if (typeof opts.stdin === "string" && opts.stdin.trim() !== "") text += opts.stdin;
  const parsed = parseTable(text);
  if (!parsed.ok) return { code: 1, stdout: "", stderr: `pattern-check: receipt not written: ${parsed.error}\n` };
  const { session } = readSession(base, key, root);
  const body = render({ key, what: session.what, opened: session.opened, recorded: new Date().toISOString(), rows: parsed.rows, noNewPieces: parsed.noNewPieces });
  writeAtomic(receiptPath, body);
  writeAtomic(receiptCopy, body);
  session.receipt = receiptPath;
  session.repo = root;
  writeSession(base, session);
  const excluded = gitExcludes(root, ctx.config.receiptDir);
  const lines = [
    `pattern-check: receipt recorded for session ${key} (${source}).`,
    `  ${receiptPath}`,
    `  copy: ${receiptCopy}`,
    parsed.noNewPieces !== null ? `No new pieces: ${parsed.noNewPieces}` : `${parsed.rows.length} row${parsed.rows.length === 1 ? "" : "s"}: ${summarize(parsed.rows)}`,
    "Writes, commits and PRs in this session are no longer held.",
    ...(excluded ? [] : [`The receipt directory ${ctx.config.receiptDir}/ is untracked; add "${ctx.config.receiptDir}/" to .gitignore or .git/info/exclude if it should stay out of commits.`]),
    ...notes,
  ];
  return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

function summarize(rows) {
  const counts = { reuse: 0, replace: 0, new: 0 };
  for (const r of rows) counts[r.decision]++;
  return `${counts.reuse} reuse, ${counts.replace} replace, ${counts.new} new`;
}

// Is receiptDir already listed in .gitignore or .git/info/exclude? Read-only; a miss means "say so".
function gitExcludes(root, receiptDir) {
  const needle = receiptDir.replace(/\/+$/, "");
  for (const f of [join(root, ".gitignore"), join(root, ".git", "info", "exclude")]) {
    try {
      const lines = readFileSync(f, "utf8").split(/\r?\n/).map((l) => l.trim().replace(/\/+$/, ""));
      if (lines.includes(needle) || lines.includes(`/${needle}`)) return true;
    } catch { /* absent file: not excluded there */ }
  }
  return false;
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return null;
    return readFileSync(0, "utf8");
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  // stdin is read only for `record` with no --row and no --no-new-pieces, so a call that
  // supplies its rows on the command line never waits on a pipe nobody will close.
  const wantsStdin = args[0] === "record" && !args.includes("--row") && !args.includes("--no-new-pieces");
  const r = run(args, { stdin: wantsStdin ? readStdin() : null });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code);
}

const invoked = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) main();
