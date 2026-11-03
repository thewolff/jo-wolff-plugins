import { test } from "node:test";
import assert from "node:assert/strict";
import { matchDeny, writeTargets } from "./matchers.mjs";

const name = (cmd, extra) => matchDeny(cmd, extra)?.name ?? null;

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

test("redirects: > and >> to a path match; 2>&1, >/dev/null, <> and heredocs do not", () => {
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

test("sed -i: matched with -i, -i.bak, -ni, --in-place; sed without -i is not", () => {
  assert.equal(name("sed -i 's/a/b/' f.txt"), "sed -i");
  assert.equal(name("sed -i.bak 's/a/b/' f.txt"), "sed -i");
  assert.equal(name("sed -ni 's/a/b/p' f.txt"), "sed -i");
  assert.equal(name("sed --in-place 's/a/b/' f.txt"), "sed -i");
  assert.equal(name("sed -E -i 's/a/b/' f.txt"), "sed -i");
  assert.equal(name("sed -n '1,5p' f.txt"), null);
  assert.equal(name("grep x | sed 's/a/b/'"), null);
});

test("tee: matched unless the only target is /dev/null", () => {
  assert.equal(name("make 2>&1 | tee build.log"), "tee");
  assert.equal(name("echo x | tee -a notes.md"), "tee");
  assert.equal(name("make | tee /dev/null"), null);
  assert.equal(name("echo steer"), null);
});

test("configured matchers: tested after the built-ins; an uncompilable entry is skipped", () => {
  assert.equal(name("terraform apply", ["^terraform apply"]), "configured: ^terraform apply");
  assert.equal(name("terraform plan", ["^terraform apply"]), null);
  assert.equal(name("terraform apply", ["(unclosed", "^terraform apply"]), "configured: ^terraform apply");
  assert.equal(name("", ["."]), null);
  assert.equal(name(undefined), null);
});

test("writeTargets: redirect targets, tee and sed -i files, quoted paths; /dev/null and &N excluded", () => {
  assert.deepEqual(writeTargets("echo x > out.txt"), ["out.txt"]);
  assert.deepEqual(writeTargets("echo x >> 'a b.txt'"), ["a b.txt"]);
  assert.deepEqual(writeTargets("npm test > /dev/null 2>&1"), []);
  assert.deepEqual(writeTargets("make 2>&1 | tee build.log"), ["build.log"]);
  assert.deepEqual(writeTargets("echo x | tee -a one.md two.md"), ["one.md", "two.md"]);
  assert.deepEqual(writeTargets("sed -i 's/a/b/' f.txt g.txt"), ["f.txt", "g.txt"]);
  assert.deepEqual(writeTargets("sed -i.bak -e 's/a/b/' f.txt"), ["f.txt"]);
  assert.deepEqual(writeTargets("sed -n '1,5p' f.txt"), []);
  assert.deepEqual(writeTargets("cat <<'EOF' > src/new.ts\nx\nEOF"), ["src/new.ts"]);
  assert.deepEqual(writeTargets("ls"), []);
  assert.deepEqual(writeTargets(42), []);
});
