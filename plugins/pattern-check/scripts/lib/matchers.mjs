// matchers.mjs — which Bash commands the PreToolUse hook denies once the threshold is reached,
// and which file paths a shell command obviously writes.
//
// THE HONEST GAP. A shell can write a file in more ways than any list catches: `python -c`,
// `perl -pi`, `cp`, `mv`, `install`, `dd`, a heredoc into `cat` with a redirect the parser
// misreads, a script that writes from inside. This list catches the obvious forms (`>` and `>>`
// redirects, `sed -i`, `tee`) and the two commands that turn writes into a record (`git commit`,
// `gh pr create`). Everything else goes through. The commit and PR denials are the backstop:
// however the files were written, committing them or opening the PR is caught.
//
// Each built-in matcher is a JavaScript regular expression tested against the whole command
// string. A command boundary is the start of the string, `;`, `&`, `|`, a newline, a quote, a
// backtick or `(`, followed by optional whitespace; a word may also be preceded by plain
// whitespace (`sudo git commit`, `cd x && git commit`, `sh -c 'git commit'`). `git log --grep
// commit` does not match: `commit` is not the git subcommand there. `echo 'git commit'` does
// match; a false deny costs one rephrase, a missed `sh -c` costs the backstop.

const BOUNDARY = String.raw`(?:^|[;&|\n'"\x60(]\s*|\s)`;

export const BUILT_IN = Object.freeze([
  { name: "git commit", pattern: new RegExp(`${BOUNDARY}git\\s+(?:-C\\s+\\S+\\s+|-c\\s+\\S+\\s+|--git-dir=\\S+\\s+|--work-tree=\\S+\\s+)*commit(?![\\w-])`) },
  { name: "gh pr create", pattern: new RegExp(`${BOUNDARY}gh\\s+pr\\s+create(?![\\w-])`) },
  // A `>` or `>>` that is not `<>`, `>&`, `2>&1`, `&>` to /dev/null, or a comparison inside
  // `[[ ]]`/`(( ))` (those are rare in agent commands; the gap is documented).
  { name: "redirect", pattern: /(?:^|[^<>&\d])>{1,2}\s*(?!&\d|\/dev\/null\b|&\s*$)[^\s&|;>]/ },
  { name: "sed -i", pattern: new RegExp(`${BOUNDARY}sed\\s+(?:-[A-Za-z]*\\s+|--[a-z-]+(?:=\\S+)?\\s+)*(?:-[A-Za-z]*i|--in-place)\\b`) },
  { name: "tee", pattern: new RegExp(`${BOUNDARY}tee\\b(?!\\s+(?:-a\\s+)?/dev/null\\s*$)`) },
]);

/**
 * The first built-in or configured matcher the command trips, or null.
 * @param {string} command
 * @param {string[]} extra regular expression sources from config (already validated to compile)
 * @returns {{ name: string }|null}
 */
export function matchDeny(command, extra = []) {
  if (typeof command !== "string" || command === "") return null;
  for (const m of BUILT_IN) if (m.pattern.test(command)) return { name: m.name };
  for (const src of extra) {
    let re;
    try { re = new RegExp(src); } catch { continue; }
    if (re.test(command)) return { name: `configured: ${src}` };
  }
  return null;
}

// Strips one layer of shell quoting from a token. Enough for `> "a b.txt"` and `> 'x'`.
function unquote(tok) {
  const t = tok.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/**
 * The file paths a command obviously writes: redirect targets, `tee` arguments, `sed -i` file
 * arguments. Best effort; a path that cannot be read off the command is simply not returned.
 * Paths are returned as written (the caller normalizes against cwd). /dev/null and `&N` are
 * never returned.
 * @param {string} command
 * @returns {string[]}
 */
export function writeTargets(command) {
  if (typeof command !== "string") return [];
  const out = new Set();
  // Redirects: `> path`, `>> path`, `&> path`, `2> path`, with optional quotes.
  const redirect = /(?:^|[^<>])(?:&|\d)?>{1,2}\s*("[^"]*"|'[^']*'|[^\s&|;<>]+)/g;
  for (const m of command.matchAll(redirect)) {
    const target = unquote(m[1]);
    if (target === "" || target === "/dev/null" || target.startsWith("&")) continue;
    out.add(target);
  }
  // Segments split on command boundaries, for tee and sed -i.
  const segments = command.split(/[;&|\n]+/);
  for (const seg of segments) {
    const words = seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    const teeAt = words.findIndex((w) => w === "tee");
    if (teeAt >= 0) {
      for (const w of words.slice(teeAt + 1)) {
        if (w.startsWith("-")) continue;
        const t = unquote(w);
        if (t !== "/dev/null") out.add(t);
      }
    }
    const sedAt = words.findIndex((w) => w === "sed");
    if (sedAt >= 0) {
      const rest = words.slice(sedAt + 1);
      const inPlace = rest.some((w) => /^-[A-Za-z]*i/.test(w) || w === "--in-place" || w.startsWith("--in-place="));
      if (inPlace) {
        // Skip flags and their values (-e expr, -f file, --expression=...). Remaining non-flag
        // words: the first is the script (unless -e/-f given), the rest are files.
        const files = [];
        let hasScriptFlag = false;
        for (let i = 0; i < rest.length; i++) {
          const w = rest[i];
          if (w === "-e" || w === "-f" || w === "--expression" || w === "--file") { hasScriptFlag = true; i++; continue; }
          if (/^-[A-Za-z]*[ef]/.test(w) && !/^-[A-Za-z]*i/.test(w)) { hasScriptFlag = true; continue; }
          if (w.startsWith("--expression=") || w.startsWith("--file=")) { hasScriptFlag = true; continue; }
          if (w.startsWith("-")) continue;
          files.push(unquote(w));
        }
        if (!hasScriptFlag) files.shift();
        for (const f of files) out.add(f);
      }
    }
  }
  return [...out];
}
