import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { REAL_ABSENT, REAL_PIN } from "../../test-fixtures/real-commands.mjs";
import { hasUnreadableWriteTarget, lex, matchDeny, writeTargets } from "./matchers.mjs";

const name = (cmd, extra) => matchDeny(cmd, extra)?.name ?? null;

test("regression: the two real commands 0.2.0 miscounted yield no bogus write target", () => {
  assert.deepEqual(writeTargets(REAL_ABSENT), []);
  assert.equal(name(REAL_ABSENT), null);
  // The pin command does write one file, outside the repository; nothing from the heredoc body.
  assert.deepEqual(writeTargets(REAL_PIN), ["/Users/jowolff/agent-scratch/shipyard/dataviz-data-cleaning-options-20261103.md"]);
  assert.equal(name(REAL_PIN), "redirect");
});

test("a > is a redirect only as a shell operator: quotes, ${…}, $(…), backticks, heredoc bodies, >=, =>, ->, <> are not", () => {
  for (const cmd of [
    'echo "$p -> ${n:-ABSENT}"',
    "echo 'a > b'",
    'echo "a > b"',
    "echo ${x:->fallback}",
    "x=$(cat > made.txt)",
    "echo `cat > made.txt`",
    "echo $((3 > 2))",
    "pip install pandas>=2.2.3",
    "pip install 'pandas >=2.2.3,<3'",
    "echo a->b",
    "echo x=>y",
    "cat <> rw.txt",
    "cat <<'EOF'\nrequires pandas >=2.2.3,<3.0.0 and a -> b > c\nEOF",
    "cat <<-EOF\n\tx > y\n\tEOF",
    "[[ a > b ]] && echo ok",
    "(( a > b ))",
    "cat <<< 'x > y'",
    "diff <(sort a) >(tee b)",
    "# echo x > commented.txt",
  ]) {
    assert.deepEqual(writeTargets(cmd), [], cmd);
  }
});

test("redirects: > >> >| &> 2> and glued forms yield their targets; 2>&1, >&2 and /dev/null do not", () => {
  assert.deepEqual(writeTargets("echo x > out.txt"), ["out.txt"]);
  assert.deepEqual(writeTargets("echo x >> 'a b.txt'"), ["a b.txt"]);
  assert.deepEqual(writeTargets('echo x > "q.txt"'), ["q.txt"]);
  assert.deepEqual(writeTargets("echo x>glued.txt"), ["glued.txt"]);
  assert.deepEqual(writeTargets("echo hi >| clob.txt"), ["clob.txt"]);
  assert.deepEqual(writeTargets("cmd &> all.log"), ["all.log"]);
  assert.deepEqual(writeTargets("cmd 2>err.log"), ["err.log"]);
  assert.deepEqual(writeTargets("cmd >&2; cmd 2>&1; cmd >&-"), []);
  assert.deepEqual(writeTargets("npm test > /dev/null 2>&1"), []);
  assert.deepEqual(writeTargets("cat <<'EOF' > src/new.ts\nx > y\nEOF"), ["src/new.ts"]);
  assert.deepEqual(writeTargets("cat <<-EOF\n\tx > y\n\tEOF\necho z > after.txt"), ["after.txt"]);
  assert.deepEqual(writeTargets("echo a \\\n > continued.txt"), ["continued.txt"]);
  assert.deepEqual(writeTargets("echo x > ~/home.txt"), [`${homedir()}/home.txt`]);
});

test("regression (codex review B2): a write target holding an expansion is flagged unreadable; static, /dev/null and fd targets are not", () => {
  for (const cmd of ['printf x > "$OUT"', "echo x > $(mktemp)", 'echo x | tee "$f"', 'sed -i "s/a/b/" "$F"', 'echo x >> "$HOME/n.md"']) {
    assert.equal(hasUnreadableWriteTarget(cmd), true, cmd);
  }
  for (const cmd of ["printf x > a.ts", "echo '$OUT' > a.ts", "npm test > /dev/null 2>&1", "cmd >&2", 'echo "$x"', "ls", 42]) {
    assert.equal(hasUnreadableWriteTarget(cmd), false, String(cmd));
  }
});

test("regression (codex review S1): BSD sed -i '' takes the empty word as the backup suffix, not the script", () => {
  assert.deepEqual(writeTargets("sed -i '' 's/a/b/' a.ts"), ["a.ts"]);
  assert.deepEqual(writeTargets("sed -i \"\" -e 's/a/b/' a.ts b.ts"), ["a.ts", "b.ts"]);
  assert.deepEqual(writeTargets("sed -i 's/a/b/' a.ts"), ["a.ts"]);
  assert.deepEqual(writeTargets("sed -i.bak 's/a/b/' a.ts"), ["a.ts"]);
});

test("regression (codex review S2): wrapper options and shell control words do not hide a write", () => {
  assert.deepEqual(writeTargets("sudo -u root tee a.ts"), ["a.ts"]);
  assert.deepEqual(writeTargets("sudo -E tee a.ts"), ["a.ts"]);
  assert.deepEqual(writeTargets("env -i tee a.ts"), ["a.ts"]);
  assert.deepEqual(writeTargets("env -u HOME FOO=1 tee a.ts"), ["a.ts"]);
  assert.deepEqual(writeTargets("nice -n 5 sed -i 's/a/b/' a.ts"), ["a.ts"]);
  assert.deepEqual(writeTargets("if true; then tee a.ts; fi"), ["a.ts"]);
  assert.deepEqual(writeTargets("for f in x; do sed -i 's/a/b/' b.ts; done"), ["b.ts"]);
  assert.deepEqual(writeTargets("! tee c.ts"), ["c.ts"]);
  assert.equal(name("sudo -u root tee a.ts"), "tee");
  // the option's value is not mistaken for the command, nor for a target
  assert.deepEqual(writeTargets("sudo -u tee ls"), []);
});

test("a redirect whose target holds an expansion is a redirect with no known path", () => {
  assert.deepEqual(writeTargets('echo x > "$OUT"'), []);
  assert.deepEqual(writeTargets("echo x > $(mktemp)"), []);
  assert.equal(name('echo x > "$OUT"'), "redirect");
});

test("lex: commands split on ; && || | & newline and parens; quotes removed", () => {
  const { commands } = lex("a 'b c' && d \"e\"|f; (g)\nh &");
  assert.deepEqual(commands.map((c) => c.map((w) => w.text)), [["a", "b c"], ["d", "e"], ["f"], ["g"], ["h"]]);
  assert.equal(lex('echo "$x"').commands[0][1].dynamic, true);
  assert.equal(lex("echo '$x'").commands[0][1].dynamic, false);
});

test("git commit: matched at the start, after && and ;, with -C, under sudo; not as a word elsewhere", () => {
  assert.equal(name("git commit -m x"), "git commit");
  assert.equal(name("cd a && git commit -am x"), "git commit");
  assert.equal(name("git add .; git commit"), "git commit");
  assert.equal(name("git -C sub commit -m x"), "git commit");
  assert.equal(name("git log --grep commit"), null);
  assert.equal(name("git commit-tree HEAD^{tree}"), null);
  assert.equal(name("echo 'git commit'"), "git commit"); // a quoted mention still matches: the gap is stated in the README
  assert.equal(name("git status"), null);
});

test("gh pr create: matched; gh pr list and gh pr view are not", () => {
  assert.equal(name("gh pr create --fill"), "gh pr create");
  assert.equal(name("git push && gh pr create -t x"), "gh pr create");
  assert.equal(name("gh pr list"), null);
  assert.equal(name("gh pr view 12"), null);
});

test("redirect matcher: > and >> to a path match; 2>&1, >/dev/null, <> and heredocs do not", () => {
  assert.equal(name("echo x > out.txt"), "redirect");
  assert.equal(name("echo x >> out.txt"), "redirect");
  assert.equal(name("cat <<'EOF' > file\nx\nEOF"), "redirect");
  assert.equal(name("npm test 2>&1"), null);
  assert.equal(name("npm test > /dev/null"), null);
  assert.equal(name("npm test >/dev/null 2>&1"), null);
  assert.equal(name("npm test &> /dev/null"), null);
  assert.equal(name("cat <<EOF\nx\nEOF"), null);
  assert.equal(name("ls -la"), null);
});

test("sed -i: matched with -i, -i.bak, -ni, --in-place, under sudo or env; sed without -i is not", () => {
  assert.equal(name("sed -i 's/a/b/' f.txt"), "sed -i");
  assert.equal(name("sed -i.bak 's/a/b/' f.txt"), "sed -i");
  assert.equal(name("sed -ni 's/a/b/p' f.txt"), "sed -i");
  assert.equal(name("sed --in-place 's/a/b/' f.txt"), "sed -i");
  assert.equal(name("sed -E -i 's/a/b/' f.txt"), "sed -i");
  assert.equal(name("sudo LC_ALL=C sed -i 's/a/b/' f.txt"), "sed -i");
  assert.equal(name("sed -n '1,5p' f.txt"), null);
  assert.equal(name("grep x | sed 's/a/b/'"), null);
  assert.equal(name("echo 'sed -i x f'"), null);
});

test("tee: matched unless the only target is /dev/null", () => {
  assert.equal(name("make 2>&1 | tee build.log"), "tee");
  assert.equal(name("echo x | tee -a notes.md"), "tee");
  assert.equal(name("make | tee /dev/null"), null);
  assert.equal(name("echo steer"), null);
  assert.equal(name("echo tee x"), null);
});

test("configured matchers: tested after the built-ins; an uncompilable entry is skipped", () => {
  assert.equal(name("terraform apply", ["^terraform apply"]), "configured: ^terraform apply");
  assert.equal(name("terraform plan", ["^terraform apply"]), null);
  assert.equal(name("terraform apply", ["(unclosed", "^terraform apply"]), "configured: ^terraform apply");
  assert.equal(name("", ["."]), null);
  assert.equal(name(undefined), null);
});

test("writeTargets: tee and sed -i files, quoted paths; /dev/null excluded; non-strings give nothing", () => {
  assert.deepEqual(writeTargets("make 2>&1 | tee build.log"), ["build.log"]);
  assert.deepEqual(writeTargets("echo x | tee -a one.md two.md"), ["one.md", "two.md"]);
  assert.deepEqual(writeTargets("sed -i 's/a/b/' f.txt g.txt"), ["f.txt", "g.txt"]);
  assert.deepEqual(writeTargets("sed -i.bak -e 's/a/b/' f.txt"), ["f.txt"]);
  assert.deepEqual(writeTargets("sed -n '1,5p' f.txt"), []);
  assert.deepEqual(writeTargets("ls"), []);
  assert.deepEqual(writeTargets(42), []);
});

test("the lexer always terminates: unterminated quotes, lone operators, stray characters", () => {
  for (const cmd of ["echo 'open", 'echo "open', "echo $(", "echo ${", "echo `x", ">", ">>", "<<", "&", "|", "a\\", "<<EOF\nno end"]) {
    assert.doesNotThrow(() => writeTargets(cmd), cmd);
  }
});
