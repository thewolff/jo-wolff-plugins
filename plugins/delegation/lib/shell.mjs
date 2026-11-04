// shell.mjs — a Bash command string as the shell's parser would see it. Pure string work;
// ported from newdle's hooks/lib/git-cmd.mjs (segments, shellSurface) with one fix: quotes are
// masked BEFORE the split on `; | &`, so `rg "foo|bar" src/` is one simple command, not two.

/**
 * One line's command surface: quoted spans masked to underscores of the same length, an
 * unquoted `#` comment and everything after it dropped. Null when the line ends inside an
 * unterminated quote.
 */
export function shellSurface(line) {
  let out = "";
  let mode = null; // null (bare) | "'" | '"'
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (mode === "'") {
      if (ch === "'") mode = null;
      out += "_";
    } else if (mode === '"') {
      if (ch === "\\" && i + 1 < line.length) {
        out += "__";
        i++;
      } else {
        if (ch === '"') mode = null;
        out += "_";
      }
    } else if (ch === "\\" && i + 1 < line.length) {
      out += "__";
      i++;
    } else if (ch === "'" || ch === '"') {
      mode = ch;
      out += "_";
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      break; // unquoted comment: nothing after it executes
    } else {
      out += ch;
    }
  }
  return mode === null ? out : null;
}

/**
 * The simple commands of `str` as surfaces (quotes masked, comments dropped), split on
 * newlines and on unquoted `; | &`. A line with an unterminated quote is split raw.
 */
export function commandSurfaces(str) {
  const out = [];
  for (const line of String(str).split("\n")) {
    const surface = shellSurface(line) ?? line;
    for (const seg of surface.split(/[;&|]+/)) {
      const s = seg.trim();
      if (s) out.push(s);
    }
  }
  return out;
}
