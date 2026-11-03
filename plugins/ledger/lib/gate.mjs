// gate.mjs — the PreToolUse rules: what is denied while no workload is open for the folder.
//
// "Gate open" means an `open` workload whose cwd equals the hook's cwd or is an ancestor of it.
// When the gate is open every rule passes. When the governing workload is `halted`, the reason
// says so and names the `open wl-…` that lifts it.
//
// The Bash rules run on PARSED SUBCOMMANDS, not the raw text: the command is split on `&&`,
// `||`, `;`, `|`, `&` and newlines outside quotes, bodies of `$( … )` and backticks are added as
// subcommands of their own, and leading `VAR=value` assignments are stripped. So `echo "git push"`
// is not a push and `npm test && git push` is.
//
// The write rule compares realpaths: the nearest existing ancestor of the target path (a file
// that does not exist yet has none of its own) against the realpath of the hook cwd. Paths under
// the OS temp directory, `/tmp`, and the session's scratchpad directory are exempt.

import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gateState, isWithin } from "./commands.mjs";

export const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const PUSH_RE = /^git(\s+-C\s+\S+)?(\s+-\S+)*\s+push\b/;
const PR_CREATE_RE = /^gh\s+pr\s+create\b/;

/** Split a shell command into the simple commands it would run, as far as a scanner can tell. */
export function subcommands(command) {
  const out = [];
  const walk = (text) => {
    let cur = "";
    let quote = null;
    let i = 0;
    const flush = () => {
      const t = cur.trim();
      if (t) out.push(t);
      cur = "";
    };
    while (i < text.length) {
      const c = text[i];
      const next = text[i + 1];
      if (quote) {
        cur += c;
        if (c === "\\" && quote === '"' && i + 1 < text.length) {
          cur += next;
          i += 2;
          continue;
        }
        if (c === quote) quote = null;
        i++;
        continue;
      }
      if (c === "\\" && i + 1 < text.length) {
        cur += c + next;
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        cur += c;
        i++;
        continue;
      }
      if (c === "$" && next === "(") {
        // Capture the balanced body, walk it as its own command, keep a placeholder here.
        let depth = 1;
        let j = i + 2;
        while (j < text.length && depth > 0) {
          if (text[j] === "(") depth++;
          else if (text[j] === ")") depth--;
          if (depth > 0) j++;
        }
        walk(text.slice(i + 2, j));
        cur += "$(…)";
        i = j + 1;
        continue;
      }
      if (c === "`") {
        const j = text.indexOf("`", i + 1);
        const end = j === -1 ? text.length : j;
        walk(text.slice(i + 1, end));
        cur += "`…`";
        i = end + 1;
        continue;
      }
      if (c === "\n" || c === ";" || c === "|" || c === "&") {
        flush();
        while (i < text.length && /[;|&\s]/.test(text[i])) i++;
        continue;
      }
      cur += c;
      i++;
    }
    flush();
  };
  walk(String(command ?? ""));
  return out.map(stripAssignments);
}

/** Remove leading `VAR=value` words (and a leading `env`/`sudo` is left alone on purpose). */
export function stripAssignments(text) {
  return text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
}

export const isPush = (command) => subcommands(command).some((s) => PUSH_RE.test(s));
export const isPrCreate = (command) => subcommands(command).some((s) => PR_CREATE_RE.test(s));

/**
 * The real path of `p` even when it does not exist yet: the nearest existing ancestor is
 * resolved through symlinks (macOS keeps /tmp and /var under /private) and the missing tail
 * is appended unchanged.
 */
function realish(p) {
  const abs = resolve(p);
  const tail = [];
  let cur = abs;
  for (;;) {
    if (existsSync(cur)) {
      let real = cur;
      try {
        real = realpathSync(cur);
      } catch {
        /* keep cur */
      }
      return tail.length ? join(real, ...tail) : real;
    }
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(basename(cur));
    cur = parent;
  }
}

/**
 * True when a write to `filePath` lands outside `cwd` and outside the exempt scratch folders
 * (os.tmpdir(), /tmp, and the session's scratchpad directory; `tmpDirs` overrides the first two).
 * An exempt folder that contains `cwd` itself is not exempt: when the project lives under /tmp
 * (CI runners, throwaway checkouts), "anywhere in /tmp" would cover every sibling of the project.
 */
export function writeIsOutside(filePath, cwd, { scratchpadDir = null, tmpDirs = [tmpdir(), "/tmp"] } = {}) {
  if (typeof filePath !== "string" || !filePath) return false;
  const target = realish(dirname(filePath));
  const root = realish(cwd);
  if (isWithin(target, root)) return false;
  const exempt = [...tmpDirs, scratchpadDir]
    .filter(Boolean)
    .map(realish)
    .filter((e) => !isWithin(root, e));
  return !exempt.some((e) => isWithin(target, e));
}

/**
 * Decide one PreToolUse call.
 * @returns {null | { rule: string, reason: string }}
 */
export function evaluate(input, { db, config, cwd, cli = "ledger" }) {
  const forcing = config.forcing;
  const openHint = `Run \`${cli} open "<what you are doing>"\` (or \`${cli} open wl-…\` to resume a parked one), then retry.`;
  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const state = gateState(db, cwd);
  const halted = state.halted;
  const lift = halted ? `${halted.id} is halted (${halted.status_reason}); \`${cli} open ${halted.id}\` lifts it.` : openHint;

  if (toolName === "AskUserQuestion") {
    if (!forcing.denyAskWithoutRow) return null;
    if (state.open) {
      const row = db.prepare("SELECT 1 FROM questions WHERE workload_id = ? AND state = 'open' LIMIT 1").get(state.open.id);
      if (row) return null;
      return {
        rule: "denyAskWithoutRow",
        reason: `ledger: ask the question through the ledger first: \`${cli} ask "<body>" --name <short> --options a,b --default a\` (on ${state.open.id}), then put the q-id in the question text.`,
      };
    }
    return {
      rule: "denyAskWithoutRow",
      reason: `ledger: ask the question through the ledger first. No workload is open for ${cwd}: ${lift} Then \`${cli} ask "<body>" --name <short> --options a,b --default a\` and put the q-id in the question text.`,
    };
  }

  if (state.open) return null;

  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    if (forcing.denyPush && isPush(command)) {
      return { rule: "denyPush", reason: `ledger: git push denied — no open workload for ${cwd}. ${lift}` };
    }
    if (forcing.denyPrCreate && isPrCreate(command)) {
      return { rule: "denyPrCreate", reason: `ledger: gh pr create denied — no open workload for ${cwd}. ${lift}` };
    }
    return null;
  }

  if (WRITE_TOOLS.has(toolName) && forcing.denyWritesOutsideCwd) {
    const filePath = toolInput.file_path ?? toolInput.notebook_path;
    if (writeIsOutside(filePath, cwd, { scratchpadDir: input.scratchpad_dir ?? null })) {
      return {
        rule: "denyWritesOutsideCwd",
        reason: `ledger: write to ${filePath} is outside ${cwd} and no workload is open here. ${halted ? lift : `\`${cli} open "<what you are doing>"\` lifts this.`}`,
      };
    }
  }
  return null;
}
