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

/**
 * The simple commands in shell text, each as its list of words after quote removal. A lexer, not
 * a shell: single and double quotes, backslash escapes and line continuations are honoured;
 * `;` `&` `|` `(` `)` and newlines end a command; `# …` comments, redirections with their
 * target, and here-document bodies (`<<WORD`, `<<-WORD`, quoted or not) are dropped. Command
 * substitutions are not expanded: their text stays inside the word it appears in.
 * @returns {string[][]}
 */
export function simpleCommands(text) {
  const s = String(text ?? "");
  const n = s.length;
  const cmds = [];
  const heredocs = [];
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
  const endCmd = () => {
    endWord();
    if (words.length) cmds.push(words);
    words = [];
  };
  while (i < n) {
    const c = s[i];
    if (c === "\n") {
      endCmd();
      i++;
      while (heredocs.length) {
        const { delim, strip } = heredocs.shift();
        while (i < n) {
          let j = s.indexOf("\n", i);
          if (j < 0) j = n;
          const line = strip ? s.slice(i, j).replace(/^\t+/, "") : s.slice(i, j);
          i = j + 1;
          if (line === delim) break;
        }
      }
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
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
        if (s[i] === "\\" && i + 1 < n && '"\\$`\n'.includes(s[i + 1])) {
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
      while (i < n && !/[\s;&|<>()]/.test(s[i])) {
        if (s[i] === "'" || s[i] === '"') {
          const j = s.indexOf(s[i], i + 1);
          const end = j < 0 ? n : j;
          delim += s.slice(i + 1, end);
          i = end + 1;
        } else if (s[i] === "\\") {
          delim += s[i + 1] ?? "";
          i += 2;
        } else delim += s[i++];
      }
      if (delim) heredocs.push({ delim, strip });
    } else if (c === "<" || c === ">") {
      if (word !== null && /^\d+$/.test(word)) word = null; // the fd number of `2>…`
      endWord();
      i++;
      while (s[i] === ">" || s[i] === "<" || s[i] === "&" || s[i] === "|") i++;
      dropNext = true;
    } else if (";&|()".includes(c)) {
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
 * The publishing operations in `command`: one per simple command that is `git push …` or
 * `gh pr <sub> …` for a `sub` in `ghPr` (default `create`). Leading `VAR=value` words and
 * `command`/`env`/`exec`/`time`/`nohup` are skipped, a path on the binary is tolerated, and git's
 * global options are read:
 *   { tool: "git", dirs: [-C dirs in order], unsupported: "--git-dir"|"--work-tree"|null, args }
 *   { tool: "gh", sub, args }
 * `args` are the words after `push` / after `pr <sub>`.
 */
export function pushOperations(command, ghPr = ["create"]) {
  const ops = [];
  for (const words of simpleCommands(command)) {
    const tokens = [...words];
    while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || PREFIX_WORDS.has(tokens[0]))) tokens.shift();
    if (!tokens.length) continue;
    const bin = tokens[0].split("/").pop();
    if (bin === "gh") {
      if (tokens[1] === "pr" && ghPr.includes(tokens[2])) ops.push({ tool: "gh", sub: tokens[2], args: tokens.slice(3) });
      continue;
    }
    if (bin !== "git") continue;
    const dirs = [];
    let unsupported = null;
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      const t = tokens[i];
      if (t === "-C") dirs.push(tokens[i + 1] ?? "");
      if (t === "--git-dir" || t.startsWith("--git-dir=")) unsupported = "--git-dir";
      if (t === "--work-tree" || t.startsWith("--work-tree=")) unsupported = "--work-tree";
      i += GIT_OPT_WITH_ARG.has(t) ? 2 : 1;
    }
    if (tokens[i] === "push") ops.push({ tool: "git", dirs, unsupported, args: tokens.slice(i + 1) });
  }
  return ops;
}

/** True when `command` runs `git push` or `gh pr <sub>` for a `sub` in `ghPr` (see pushOperations). */
export function isPushCommand(command, ghPr = ["create"]) {
  if (typeof command !== "string" || !command.trim()) return false;
  return pushOperations(command, ghPr).length > 0;
}
