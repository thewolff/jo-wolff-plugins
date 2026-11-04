// matchers.mjs — which Bash commands the PreToolUse hook denies once the threshold is reached,
// and which file paths a shell command obviously writes.
//
// THE HONEST GAP. A shell can write a file in more ways than any list catches: `python -c`,
// `perl -pi`, `cp`, `mv`, `install`, `dd`, a script that writes from inside, a redirect inside
// `$(…)` or `eval`. This module catches the obvious forms (`>` and `>>` redirects, `sed -i`,
// `tee`) and the two commands that turn writes into a record (`git commit`, `gh pr create`).
// Everything else goes through. The commit and PR denials are the backstop: however the files
// were written, committing them or opening the PR is caught.
//
// THE WRITE FORMS ARE READ OFF A SHELL LEXER, NOT A REGEX. A `>` counts as a redirect only when
// it is a shell operator: not inside single or double quotes, not inside `${…}`, `$(…)`,
// `$((…))` or backticks, not inside a heredoc body, not inside `[[ … ]]` or `(( … ))`, and not
// part of `>=`, `=>`, `->` or `<>`. A redirect whose target holds an expansion (`> "$OUT"`) is
// recognised as a redirect but yields no path, because the path is not known before the shell
// runs. 0.2.0 used a regex here and counted `>=2.2.3,` from a heredoc body and
// `${n:-ABSENT}"` from a quoted `->` as files in the repository (see matchers.test.mjs).
//
// `git commit` and `gh pr create` stay regular expressions over the whole command string, so a
// commit inside `sh -c '…'` is caught. A command boundary is the start of the string, `;`, `&`,
// `|`, a newline, a quote, a backtick or `(`, followed by optional whitespace; a word may also be
// preceded by plain whitespace (`sudo git commit`). `git log --grep commit` does not match.
// `echo 'git commit'` does; a false deny costs one rephrase, a missed `sh -c` costs the backstop.

import { homedir } from "node:os";

const BOUNDARY = String.raw`(?:^|[;&|\n'"\x60(]\s*|\s)`;
const GIT_COMMIT = new RegExp(`${BOUNDARY}git\\s+(?:-C\\s+\\S+\\s+|-c\\s+\\S+\\s+|--git-dir=\\S+\\s+|--work-tree=\\S+\\s+)*commit(?![\\w-])`);
const GH_PR_CREATE = new RegExp(`${BOUNDARY}gh\\s+pr\\s+create(?![\\w-])`);

const OPERATOR_CHARS = new Set([";", "&", "|", "(", ")", "<", ">", "\n"]);
const BLANK = new Set([" ", "\t"]);
const WRAPPERS = new Set(["sudo", "env", "command", "nohup", "time", "exec", "builtin"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Index just past the `)` closing the `(` at `i`, honouring nested parens and quotes.
function skipParens(s, i) {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "'") { const e = s.indexOf("'", i + 1); i = e < 0 ? s.length : e + 1; continue; }
    if (c === '"') { i = skipDouble(s, i).end; continue; }
    if (c === "`") { i = skipBacktick(s, i); continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return s.length;
}

// Index just past the `}` closing the `${` at `i`.
function skipBrace(s, i) {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "'") { const e = s.indexOf("'", i + 1); i = e < 0 ? s.length : e + 1; continue; }
    if (c === '"') { i = skipDouble(s, i).end; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return s.length;
}

function skipBacktick(s, i) {
  i++;
  while (i < s.length && s[i] !== "`") i += s[i] === "\\" ? 2 : 1;
  return Math.min(i + 1, s.length);
}

// A `$…` expansion at `i`: returns its end. `$name`, `$1`, `$?`, `${…}`, `$(…)`, `$((…))`.
function skipDollar(s, i) {
  const n = s[i + 1];
  if (n === "(") return skipParens(s, i + 1);
  if (n === "{") return skipBrace(s, i + 1);
  if (n === "'") { const e = s.indexOf("'", i + 2); return e < 0 ? s.length : e + 1; } // $'…' ANSI-C quoting
  let j = i + 1;
  if (j < s.length && /[A-Za-z_]/.test(s[j])) { while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++; return j; }
  if (j < s.length && /[0-9?#@*$!-]/.test(s[j])) return j + 1;
  return j; // a lone `$`
}

// A double-quoted string at `i`: its literal text (expansions kept raw) and whether it expands.
function skipDouble(s, i) {
  let j = i + 1;
  let text = "";
  let dynamic = false;
  while (j < s.length && s[j] !== '"') {
    const c = s[j];
    if (c === "\\" && j + 1 < s.length) { text += /["\\$`]/.test(s[j + 1]) ? s[j + 1] : `\\${s[j + 1]}`; j += 2; continue; }
    if (c === "$" && j + 1 < s.length && s[j + 1] !== '"') { const e = skipDollar(s, j); if (e > j + 1) dynamic = true; text += s.slice(j, e); j = e; continue; }
    if (c === "`") { const e = skipBacktick(s, j); dynamic = true; text += s.slice(j, e); j = e; continue; }
    text += c;
    j++;
  }
  return { text, dynamic, end: Math.min(j + 1, s.length) };
}

/**
 * Reads one shell word at `i`: quotes removed, expansions kept raw and flagged `dynamic`. Stops
 * at a blank or an unquoted operator character. A `>` preceded by `=` or `-`, or followed by
 * `=`, is part of the word (`a->b`, `x=>y`, `pandas>=2.2.3`), as the brief for 0.3.0 asks.
 */
function readWord(s, i) {
  let text = "";
  let dynamic = false;
  const start = i;
  while (i < s.length) {
    const c = s[i];
    if (BLANK.has(c)) break;
    if (c === ">" && ((i > start && (s[i - 1] === "=" || s[i - 1] === "-")) || s[i + 1] === "=")) { text += c; i++; continue; }
    if (OPERATOR_CHARS.has(c)) break;
    if (c === "\\") { if (s[i + 1] === "\n") { i += 2; continue; } text += s[i + 1] ?? ""; i += 2; continue; }
    if (c === "'") { const e = s.indexOf("'", i + 1); const end = e < 0 ? s.length : e; text += s.slice(i + 1, end); i = end + 1; continue; }
    if (c === '"') { const d = skipDouble(s, i); text += d.text; dynamic ||= d.dynamic; i = d.end; continue; }
    if (c === "$") { const e = skipDollar(s, i); if (e > i + 1) dynamic = true; text += s.slice(i, e); i = e; continue; }
    if (c === "`") { const e = skipBacktick(s, i); dynamic = true; text += s.slice(i, e); i = e; continue; }
    text += c;
    i++;
  }
  return { text, dynamic, end: i };
}

function skipBlanks(s, i) {
  while (i < s.length && BLANK.has(s[i])) i++;
  return i;
}

// Skips the bodies of the heredocs opened on the line that just ended; `i` is the start of the next line.
function skipHeredocBodies(s, i, pending) {
  while (pending.length) {
    const { delim, strip } = pending.shift();
    for (;;) {
      if (i >= s.length) return s.length;
      const nl = s.indexOf("\n", i);
      const end = nl < 0 ? s.length : nl;
      const line = s.slice(i, end);
      i = nl < 0 ? s.length : nl + 1;
      if ((strip ? line.replace(/^\t+/, "") : line) === delim) break;
    }
  }
  return i;
}

/**
 * A small POSIX-shell lexer, enough to find the write forms: the simple commands (each a list of
 * words) and the output redirects with their targets. Not a shell: it does not expand, alias or
 * execute, and it does not descend into `$(…)`, backticks, `eval` or `sh -c` strings.
 * @param {string} s
 * @returns {{ commands: Array<Array<{ text: string, dynamic: boolean }>>, redirects: Array<{ op: string, target: { text: string, dynamic: boolean }|null }> }}
 */
export function lex(s) {
  const commands = [[]];
  const redirects = [];
  const heredocs = [];
  let inTest = false; // inside [[ … ]]: `<` and `>` compare strings there
  const cmd = () => commands[commands.length - 1];
  const endCommand = () => { if (cmd().length) commands.push([]); };
  const readTarget = (j) => {
    j = skipBlanks(s, j);
    if (j >= s.length || OPERATOR_CHARS.has(s[j])) return { target: null, end: j };
    const w = readWord(s, j);
    return { target: { text: w.text, dynamic: w.dynamic }, end: w.end };
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (BLANK.has(c)) { i++; continue; }
    if (c === "\n") { i = skipHeredocBodies(s, i + 1, heredocs); endCommand(); continue; }
    if (c === "#") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "\\" && s[i + 1] === "\n") { i += 2; continue; }
    if (c === "(" && s[i + 1] === "(") { i = skipParens(s, i); continue; } // (( arithmetic ))
    if (c === ";" || c === "(" || c === ")") { i++; endCommand(); continue; }
    if (c === "|") { i += s[i + 1] === "|" || s[i + 1] === "&" ? 2 : 1; endCommand(); continue; }
    if (c === "&") {
      if (s[i + 1] === ">") {
        const op = s[i + 2] === ">" ? "&>>" : "&>";
        const r = readTarget(i + op.length);
        redirects.push({ op, target: r.target });
        i = r.end;
        continue;
      }
      i += s[i + 1] === "&" ? 2 : 1;
      endCommand();
      continue;
    }
    if (c === "<" || (c === ">" && s[i + 1] !== "=")) {
      if (inTest) { cmd().push({ text: c, dynamic: false }); i++; continue; }
      if (c === "<") {
        if (s[i + 1] === "<" && s[i + 2] === "<") { i = readTarget(i + 3).end; continue; } // here-string: data
        if (s[i + 1] === "<") {
          let j = i + 2;
          const strip = s[j] === "-";
          if (strip) j++;
          const r = readTarget(j);
          if (r.target) heredocs.push({ delim: r.target.text, strip });
          i = r.end;
          continue;
        }
        if (s[i + 1] === "(") { i = skipParens(s, i + 1); continue; } // <(…) process substitution
        if (s[i + 1] === "&") { i = readTarget(i + 2).end; continue; }
        // `<file` reads; `<>file` opens read-write but is not counted (the 0.3.0 brief).
        i = readTarget(i + (s[i + 1] === ">" ? 2 : 1)).end;
        continue;
      }
      if (s[i + 1] === "(") { i = skipParens(s, i + 1); continue; } // >(…) process substitution
      let op = ">";
      if (s[i + 1] === ">") op = ">>";
      else if (s[i + 1] === "|") op = ">|";
      else if (s[i + 1] === "&") op = ">&";
      const r = readTarget(i + op.length);
      i = r.end;
      // `>&2`, `>&-`: duplicate a descriptor, no file.
      if (op === ">&" && r.target && /^(?:\d+|-)$/.test(r.target.text)) continue;
      redirects.push({ op: op === ">&" ? "&>" : op, target: r.target });
      continue;
    }
    const w = readWord(s, i);
    if (w.end === i) { i++; continue; } // never stall on a character no branch above consumed
    i = w.end;
    // `2>`, `1>>`: a digit-only word glued to a redirect is its descriptor, not an argument.
    if (/^\d+$/.test(w.text) && (s[i] === ">" || s[i] === "<")) continue;
    if (w.text === "[[" && !w.dynamic) inTest = true;
    else if (w.text === "]]" && inTest) inTest = false;
    cmd().push({ text: w.text, dynamic: w.dynamic });
  }
  return { commands: commands.filter((c) => c.length), redirects };
}

// Options of the wrappers that take a separate value (`sudo -u root`, `env -u NAME`, `nice -n 5`,
// `exec -a name`). Other dash words after a wrapper are flags without a value.
const WRAPPER_VALUE_OPTIONS = Object.freeze({
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group", "--host", "--prompt", "--chdir"]),
  env: new Set(["-u", "-C", "--unset", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  exec: new Set(["-a"]),
});
// Shell reserved words that can stand where a command name stands (`then tee x`, `! sed -i ...`).
const CONTROL = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "time"]);

// The words of a simple command from its command name on: assignments, control words, wrappers
// and the wrappers' options skipped.
function commandWords(words) {
  let k = 0;
  while (k < words.length) {
    const w = words[k].text;
    if (ASSIGNMENT.test(w) || CONTROL.has(w)) { k++; continue; }
    if (WRAPPERS.has(w) || w === "nice") {
      const valued = WRAPPER_VALUE_OPTIONS[w] ?? new Set();
      k++;
      while (k < words.length && words[k].text.startsWith("-")) {
        const o = words[k].text;
        k += o === "--" ? 1 : valued.has(o) ? 2 : 1;
        if (o === "--") break;
      }
      continue;
    }
    break;
  }
  return words.slice(k);
}

const isNull = (t) => t === "/dev/null";
const expandTilde = (t) => (t === "~" ? homedir() : t.startsWith("~/") ? `${homedir()}${t.slice(1)}` : t);

// The file arguments of a `sed -i` command (words after `sed`), or null when it is not in-place.
function sedInPlaceFiles(rest) {
  const texts = rest.map((w) => w.text);
  const inPlace = texts.some((w) => /^-[A-Za-z]*i/.test(w) || w === "--in-place" || w.startsWith("--in-place="));
  if (!inPlace) return null;
  // Skip flags and their values (-e expr, -f file, --expression=...). Remaining non-flag words:
  // the first is the script (unless -e/-f given), the rest are files.
  const files = [];
  let hasScriptFlag = false;
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k].text;
    // BSD `sed -i '' ...`: the empty word after a bare -i is the backup suffix, not the script.
    if (/^-[A-Za-z]*i$/.test(w) && rest[k + 1]?.text === "" && !rest[k + 1].dynamic) { k++; continue; }
    if (w === "-e" || w === "-f" || w === "--expression" || w === "--file") { hasScriptFlag = true; k++; continue; }
    if (/^-[A-Za-z]*[ef]/.test(w) && !/^-[A-Za-z]*i/.test(w)) { hasScriptFlag = true; continue; }
    if (w.startsWith("--expression=") || w.startsWith("--file=")) { hasScriptFlag = true; continue; }
    if (w.startsWith("-")) continue;
    files.push(rest[k]);
  }
  if (!hasScriptFlag) files.shift();
  return files;
}

/** The write forms a command uses, their static targets, and how many targets hold an expansion. */
function writeForms(command) {
  const { commands, redirects } = lex(command);
  const forms = { redirect: [], tee: [], sed: [] };
  let unknown = 0;
  let redirect = false;
  for (const r of redirects) {
    if (!r.target || isNull(r.target.text)) continue;
    redirect = true;
    if (r.target.dynamic) unknown++;
    else if (r.target.text !== "") forms.redirect.push(r.target.text);
  }
  let tee = false;
  let sed = false;
  for (const words of commands) {
    const [name, ...rest] = commandWords(words);
    if (!name || name.dynamic) continue;
    if (name.text === "tee") {
      const args = rest.filter((w) => !w.text.startsWith("-") && !isNull(w.text));
      if (args.length) tee = true;
      for (const w of args) if (w.dynamic) unknown++; else forms.tee.push(w.text);
    } else if (name.text === "sed") {
      const files = sedInPlaceFiles(rest);
      if (files) { sed = true; for (const w of files) if (w.dynamic) unknown++; else forms.sed.push(w.text); }
    }
  }
  return { ...forms, unknown, has: { redirect, tee, sed } };
}

export const BUILT_IN = Object.freeze([
  { name: "git commit", test: (c) => GIT_COMMIT.test(c) },
  { name: "gh pr create", test: (c) => GH_PR_CREATE.test(c) },
  { name: "redirect", test: (c) => writeForms(c).has.redirect },
  { name: "sed -i", test: (c) => writeForms(c).has.sed },
  { name: "tee", test: (c) => writeForms(c).has.tee },
]);

/**
 * The first built-in or configured matcher the command trips, or null.
 * @param {string} command
 * @param {string[]} extra regular expression sources from config (already validated to compile)
 * @returns {{ name: string }|null}
 */
export function matchDeny(command, extra = []) {
  if (typeof command !== "string" || command === "") return null;
  for (const m of BUILT_IN) if (m.test(command)) return { name: m.name };
  for (const src of extra) {
    let re;
    try { re = new RegExp(src); } catch { continue; }
    if (re.test(command)) return { name: `configured: ${src}` };
  }
  return null;
}

/**
 * The file paths a command obviously writes: redirect targets, `tee` arguments, `sed -i` file
 * arguments. Paths are returned as written, `~` expanded (the caller normalizes against cwd and
 * keeps only paths inside the repository). /dev/null, descriptor duplications and targets holding
 * an expansion are never returned.
 * @param {string} command
 * @returns {string[]}
 */
export function writeTargets(command) {
  if (typeof command !== "string") return [];
  const f = writeForms(command);
  return [...new Set([...f.redirect, ...f.tee, ...f.sed].map(expandTilde))];
}

/**
 * Whether a command writes to a target that holds an expansion (`> "$OUT"`, `tee "$f"`), whose
 * path cannot be known before the shell runs. The PreToolUse hook denies such a write while the
 * session is held, since it may land in the repository.
 * @param {string} command
 * @returns {boolean}
 */
export function hasUnreadableWriteTarget(command) {
  return typeof command === "string" && writeForms(command).unknown > 0;
}
