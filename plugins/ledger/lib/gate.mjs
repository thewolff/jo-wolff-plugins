// gate.mjs — the PreToolUse rules, pure given a db:
//
//   denyAskWithoutRow  AskUserQuestion is denied while no ledger question is open for the
//                      folder, so every question the human is asked has a q- row they can
//                      answer by typing. "In scope" means a question whose cwd equals the
//                      hook's cwd or is an ancestor of it.
//   pushNeedsNote      a Bash command that runs `git push` or `gh pr create` is denied while
//                      the session has no `note` or `outcome` row: what is being pushed, and
//                      why, is on the record before it leaves the machine. One in the session
//                      lifts it.
//
// Nothing else is gated: what a project allows a tool to do otherwise is the project's own
// business, not the ledger's.

import { openQuestions, sessionNotes } from "./commands.mjs";

/**
 * The switched-on rule this input is subject to, whether or not it passes: `denyAskWithoutRow`,
 * `pushNeedsNote`, or null. The hook uses it to mark earlier bounces of that rule satisfied.
 */
export function gatedRule(input, config) {
  const forcing = config.forcing ?? {};
  if (input.tool_name === "AskUserQuestion") return forcing.denyAskWithoutRow === false ? null : "denyAskWithoutRow";
  if (input.tool_name === "Bash" && forcing.pushNeedsNote !== false && isPushCommand(input.tool_input?.command)) return "pushNeedsNote";
  return null;
}

/**
 * The PreToolUse decision for one hook input: `{ rule, reason }` to deny, null to pass.
 * `cli` is the exact invocation the reason tells the agent to run; `sessionId` the hook's.
 */
export function evaluate(input, { db, config, cwd, cli = "ledger", sessionId = null }) {
  const forcing = config.forcing ?? {};
  if (input.tool_name === "AskUserQuestion") {
    if (forcing.denyAskWithoutRow === false) return null;
    if (openQuestions(db, cwd, { below: false }).length) return null;
    return {
      rule: "denyAskWithoutRow",
      reason: `ledger: ask the question through the ledger first: \`${cli} ask "<body>" --name <short> --options a,b --default a\`, then ask it; keep the q- id to yourself and record the reply with \`${cli} answer <q-id> <option>\`.`,
    };
  }
  if (input.tool_name === "Bash") {
    if (forcing.pushNeedsNote === false) return null;
    if (!isPushCommand(input.tool_input?.command)) return null;
    if (sessionNotes(db, { sessionId, cwd, kinds: ["note", "outcome"] }).length) return null;
    return {
      rule: "pushNeedsNote",
      reason: `ledger: record what this push is before pushing: \`${cli} note "<what and why>"\` or \`${cli} outcome <ref> "<what and why>"\` (one in this session lifts the gate).`,
    };
  }
  return null;
}

// Global git options that take a separate argument, so `git -C dir push` is still a push.
const GIT_OPT_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);
// Words that run the rest of the command line as the command.
const PREFIX_WORDS = new Set(["command", "env", "exec", "time", "nohup"]);
// The one-word commands simpleCommands emits around a subshell or command substitution: what
// runs between them cannot change the directory or environment of what follows.
export const SCOPE_OPEN = "\0(";
export const SCOPE_CLOSE = "\0)";
// Git subcommands that can move HEAD, so a push after one on the same command line publishes a
// commit that does not exist yet when the hook runs.
const HEAD_MOVERS = new Set(["commit", "rebase", "merge", "cherry-pick", "revert", "reset", "pull", "checkout", "switch", "am", "bisect", "update-ref", "symbolic-ref"]);
// Config keys that change which refs a push publishes or where it goes.
const PUSH_CONFIG = /^(push\.|remote\.pushdefault$|remote\..+\.(push|pushurl|url|mirror)$|branch\..+\.(remote|pushremote|merge)$|url\.)/i;
// Environment variables that change git's config or repository.
const GIT_ENV = /^(GIT_CONFIG[A-Z0-9_]*|GIT_DIR|GIT_WORK_TREE|GIT_NAMESPACE)=/;

/** The index of the `)` closing a `$(` whose body starts at `i`; quotes and nesting honoured. */
function closeParen(s, i) {
  let depth = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") i += 2;
    else if (c === "'") i = (s.indexOf("'", i + 1) + 1 || s.length + 1);
    else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
      i++;
    } else {
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return i;
      i++;
    }
  }
  return s.length;
}

/**
 * The command substitutions in `s` starting at `i` (`$(…)` or a backtick): { body, end } with
 * `end` the index after it, or null when `s[i]` starts none. `$((…))` is arithmetic, not a command.
 */
function substitution(s, i) {
  if (s[i] === "$" && s[i + 1] === "(" && s[i + 2] !== "(") {
    const close = closeParen(s, i + 2);
    return { body: s.slice(i + 2, close), end: close + 1 };
  }
  if (s[i] === "`") {
    let j = i + 1;
    while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
    return { body: s.slice(i + 1, j).replace(/\\`/g, "`"), end: j + 1 };
  }
  return null;
}

/** The command substitutions in an unquoted here-document body (they run; the rest is text). */
function bodySubstitutions(text) {
  const out = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    const sub = substitution(text, i);
    if (sub) {
      out.push(sub.body);
      i = sub.end;
    } else i++;
  }
  return out;
}

/**
 * The simple commands in shell text, each as its list of words after quote removal, in the order
 * they run. A lexer, not a shell: single and double quotes, backslash escapes and line
 * continuations are honoured; `;` `&` `|` `(` `)` and newlines end a command; `# …` comments
 * and redirections with their target are dropped. Command substitutions (`$(…)` and backticks,
 * unquoted, inside double quotes, or in an unquoted here-document body) are scanned as commands
 * of their own, listed before the command they appear in; their text also stays in its word.
 * Here-document bodies are otherwise text. A subshell `( … )` and each command substitution are
 * bracketed by the one-word commands [SCOPE_OPEN] and [SCOPE_CLOSE].
 * @returns {string[][]}
 */
export function simpleCommands(text) {
  const s = String(text ?? "");
  const n = s.length;
  const cmds = [];
  const heredocs = [];
  let nested = [];
  let words = [];
  let word = null;
  let dropNext = false;
  let i = 0;
  const endWord = () => {
    if (word === null) return;
    if (dropNext) dropNext = false;
    else words.push(word);
    word = null;
  };
  const scoped = (body) => [[SCOPE_OPEN], ...simpleCommands(body), [SCOPE_CLOSE]];
  const endCmd = () => {
    endWord();
    for (const body of nested) cmds.push(...scoped(body));
    nested = [];
    if (words.length) cmds.push(words);
    words = [];
  };
  while (i < n) {
    const c = s[i];
    if (c === "\n") {
      endCmd();
      i++;
      while (heredocs.length) {
        const { delim, strip, quoted } = heredocs.shift();
        const lines = [];
        while (i < n) {
          let j = s.indexOf("\n", i);
          if (j < 0) j = n;
          const line = strip ? s.slice(i, j).replace(/^\t+/, "") : s.slice(i, j);
          i = j + 1;
          if (line === delim) break;
          lines.push(line);
        }
        if (!quoted) for (const body of bodySubstitutions(lines.join("\n"))) cmds.push(...scoped(body));
      }
      continue;
    }
    const sub = substitution(s, i);
    if (sub) {
      nested.push(sub.body);
      word = (word ?? "") + s.slice(i, sub.end);
      i = sub.end;
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
    } else if (c === "#" && word === null) {
      while (i < n && s[i] !== "\n") i++;
    } else if (c === "\\") {
      if (s[i + 1] !== "\n") word = (word ?? "") + (s[i + 1] ?? "");
      i += 2;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      word = (word ?? "") + s.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let q = "";
      i++;
      while (i < n && s[i] !== '"') {
        const inner = substitution(s, i);
        if (inner) {
          nested.push(inner.body);
          q += s.slice(i, inner.end);
          i = inner.end;
        } else if (s[i] === "\\" && i + 1 < n && '"\\$`\n'.includes(s[i + 1])) {
          if (s[i + 1] !== "\n") q += s[i + 1];
          i += 2;
        } else q += s[i++];
      }
      i++;
      word = (word ?? "") + q;
    } else if (c === "<" && s[i + 1] === "<" && s[i + 2] !== "<") {
      endWord();
      i += 2;
      const strip = s[i] === "-";
      if (strip) i++;
      while (s[i] === " " || s[i] === "\t") i++;
      let delim = "";
      let quoted = false;
      while (i < n && !/[\s;&|<>()]/.test(s[i])) {
        if (s[i] === "'" || s[i] === '"') {
          quoted = true;
          const j = s.indexOf(s[i], i + 1);
          const end = j < 0 ? n : j;
          delim += s.slice(i + 1, end);
          i = end + 1;
        } else if (s[i] === "\\") {
          quoted = true;
          delim += s[i + 1] ?? "";
          i += 2;
        } else delim += s[i++];
      }
      if (delim) heredocs.push({ delim, strip, quoted });
    } else if (c === "<" || c === ">") {
      if (word !== null && /^\d+$/.test(word)) word = null; // the fd number of `2>…`
      endWord();
      i++;
      while (s[i] === ">" || s[i] === "<" || s[i] === "&" || s[i] === "|") i++;
      dropNext = true;
    } else if (c === "(" || c === ")") {
      endCmd();
      cmds.push([c === "(" ? SCOPE_OPEN : SCOPE_CLOSE]);
      i++;
    } else if (";&|".includes(c)) {
      endCmd();
      i++;
    } else {
      word = (word ?? "") + c;
      i++;
    }
  }
  endCmd();
  return cmds;
}

/**
 * A directory word the gate cannot resolve statically: an expansion (`$`, a backtick), `~`, a
 * glob, or the bare word `-` (`cd -`). A hyphen inside a literal path is an ordinary character.
 */
const dynamicDir = (d) => !d || d === "-" || /[$`~*?]/.test(d);

/**
 * The publishing operations in `command`: one per simple command that is `git push …` or
 * `gh pr <sub> …` for a `sub` in `ghPr` (default `create`). Leading `VAR=value` words and
 * `command`/`env`/`exec`/`time`/`nohup` are skipped, a path on the binary is tolerated, and git's
 * global options are read. Every operation carries the `cd` directories run before it in its own
 * shell scope (`cds`, in order; a `cd` inside a subshell or command substitution does not reach
 * past it), so a relative `-C` resolves where git would run:
 *   { tool: "git", cds, dirs: [-C dirs in order], unsupported: <why>|null, after: <cmd>|null, args }
 *   { tool: "gh", cds, unsupported: <why>|null, after: <cmd>|null, sub, args }
 * `unsupported` names what the gate cannot follow: `--git-dir`, `--work-tree`, a `cd` or `-C`
 * whose directory is an expansion, `~` or `-`, a `-c`/`--config-env` that sets push, remote or
 * branch config, a `GIT_CONFIG*`/`GIT_DIR`/`GIT_WORK_TREE` assignment or export. `after` names the
 * first command earlier on the command line that can move HEAD (`git commit`, `git rebase`, …
 * HEAD_MOVERS, or `gh pr checkout`), in any shell scope: the hook sees HEAD as it is before any of
 * the line runs. `args` are the words after `push` / `pr <sub>`.
 */
export function pushOperations(command, ghPr = ["create"]) {
  const ops = [];
  let scope = { cds: [], unknown: null };
  let moved = null;
  const outer = [];
  for (const words of simpleCommands(command)) {
    if (words.length === 1 && words[0] === SCOPE_OPEN) {
      outer.push(scope);
      scope = { cds: [...scope.cds], unknown: scope.unknown };
      continue;
    }
    if (words.length === 1 && words[0] === SCOPE_CLOSE) {
      if (outer.length) scope = outer.pop();
      continue;
    }
    const tokens = [...words];
    let envUnknown = null;
    while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || PREFIX_WORDS.has(tokens[0]))) {
      if (GIT_ENV.test(tokens[0])) envUnknown = tokens[0].split("=")[0];
      tokens.shift();
    }
    if (!tokens.length) {
      if (envUnknown) scope.unknown = envUnknown;
      continue;
    }
    if (tokens[0] === "export") {
      const set = tokens.slice(1).find((t) => GIT_ENV.test(t));
      if (set) scope.unknown = `export ${set.split("=")[0]}`;
      continue;
    }
    if (tokens[0] === "cd" || tokens[0] === "pushd") {
      const dir = tokens.slice(1).find((t) => !t.startsWith("-") || t === "-");
      if (dynamicDir(dir)) scope.unknown = `${tokens[0]} ${dir ?? "(home)"}`;
      else scope.cds.push(dir);
      continue;
    }
    const bin = tokens[0].split("/").pop();
    if (bin === "gh") {
      if (tokens[1] === "pr" && ghPr.includes(tokens[2])) ops.push({ tool: "gh", cds: [...scope.cds], unsupported: envUnknown ?? scope.unknown, after: moved, sub: tokens[2], args: tokens.slice(3) });
      if (tokens[1] === "pr" && tokens[2] === "checkout") moved ??= "gh pr checkout";
      continue;
    }
    if (bin !== "git") continue;
    const dirs = [];
    let unsupported = envUnknown ?? scope.unknown;
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      const t = tokens[i];
      if (t === "-C") {
        const d = tokens[i + 1] ?? "";
        if (dynamicDir(d)) unsupported = `-C ${d}`;
        dirs.push(d);
      }
      if (t === "--git-dir" || t.startsWith("--git-dir=")) unsupported = "--git-dir";
      if (t === "--work-tree" || t.startsWith("--work-tree=")) unsupported = "--work-tree";
      const setting = t === "-c" || t === "--config-env" ? tokens[i + 1] ?? "" : t.startsWith("--config-env=") ? t.slice("--config-env=".length) : null;
      if (setting !== null && PUSH_CONFIG.test(setting.split("=")[0])) unsupported = `${t.split("=")[0]} ${setting.split("=")[0]}`;
      i += GIT_OPT_WITH_ARG.has(t) ? 2 : 1;
    }
    if (tokens[i] === "push") ops.push({ tool: "git", cds: [...scope.cds], dirs, unsupported, after: moved, args: tokens.slice(i + 1) });
    else if (HEAD_MOVERS.has(tokens[i])) moved ??= `git ${tokens[i]}`;
  }
  return ops;
}

/** True when `command` runs `git push` or `gh pr <sub>` for a `sub` in `ghPr` (see pushOperations). */
export function isPushCommand(command, ghPr = ["create"]) {
  if (typeof command !== "string" || !command.trim()) return false;
  return pushOperations(command, ghPr).length > 0;
}
