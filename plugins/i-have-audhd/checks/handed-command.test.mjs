// handed-command.test.mjs — node --test
//
// Same proportion as the other check suites: the false-positive cases are the point. Code
// quoted as evidence — a receipt under a label, a `command → result` line, quoted output — must
// never read as a command handed to the reader.
//
// The fixtures pass `home: "/Users/example"`, so `~/agent-scratch` (the default script root)
// is `/Users/example/agent-scratch` whatever machine runs the suite. Script-location cases that
// need a real filesystem (a checkout, a worktree, a symlink) build it under a temp directory.
// Cases named after a probe reproduce the round-1 review's probe input verbatim.
//
// Run: node --test 'plugins/i-have-audhd/checks/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHandedCommand, globMatch } from "./handed-command.mjs";

const HOME = "/Users/example";
const check = (text, options = {}) => checkHandedCommand(text, { home: HOME, ...options });

const filler = (n) => "This sentence is ordinary body prose that carries findings. ".repeat(n);
const SCRIPT = "zsh /Users/example/agent-scratch/x.sh";

// ─── must not flag ───────────────────────────────────────────────────────────

test("a message with no command at all is not applicable", () => {
  const r = check(filler(6));
  assert.equal(r.applicable, false);
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "no-handed-command");
});

test("an inline zsh script line under 'run' passes", () => {
  const r = check(`${filler(4)}\n\nRun \`${SCRIPT}\` when you are back.`);
  assert.equal(r.applicable, true);
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "script-line-only");
});

test("a bash fence holding one script line passes, prompt and comment ignored", () => {
  const msg = `${filler(4)}\n\nPaste this:\n\n\`\`\`bash\n# the whole cleanup, logged beside the script\n$ zsh /Users/example/agent-scratch/repo/cleanup.sh\n\`\`\``;
  const r = check(msg);
  assert.equal(r.applicable, true);
  assert.equal(r.flagged, false);
});

test("bash, sh, a ~/ path and a quoted path are the same passing shape", () => {
  for (const line of [
    "bash /Users/example/agent-scratch/x.sh",
    "sh ~/agent-scratch/x.sh",
    'zsh "/Users/example/agent-scratch/my scripts/x.sh"',
  ]) {
    const r = check(`${filler(4)}\n\nRun \`${line}\`.`);
    assert.equal(r.flagged, false, line);
    assert.equal(r.applicable, true, line);
  }
});

test("a receipt under **CLAIM** is evidence, inline or fenced", () => {
  const inline = `${filler(4)}\n\n**CLAIM**\nRun \`gh pr list --state open\` and it lists three PRs.`;
  assert.equal(check(inline).flagged, false);
  const fenced = `${filler(4)}\n\n**CLAIM**\nThe command and its output:\n\n\`\`\`bash\ngh pr list --state open\n\`\`\`\n\nMore prose after.`;
  const r = check(fenced);
  assert.equal(r.flagged, false);
  assert.equal(r.applicable, false);
});

test("a **CITE** label covers its receipt the same way", () => {
  const msg = `${filler(4)}\n\n**CITE**\n\`\`\`sh\ncurl -s https://example.com/status\n\`\`\``;
  assert.equal(check(msg).flagged, false);
});

test("a `command → result` line is a receipt, not a hand-over", () => {
  const msg = `${filler(4)}\n\nRan the suite: run \`npm test\` → exit 0, 231 pass.`;
  assert.equal(check(msg).flagged, false);
  const fenced = `${filler(4)}\n\n\`\`\`bash\nnpm run lint → exit 0\n\`\`\``;
  assert.equal(check(fenced).flagged, false);
});

test("the agent's own past or future runs are not handed: 'I ran', 'I'll run'", () => {
  for (const s of ["I ran `gh pr list` and saw three PRs.", "I'll run `npm test` next.", "We run `git fetch` hourly."]) {
    assert.equal(check(`${filler(4)}\n\n${s}`).flagged, false, s);
  }
});

test("a code span that is not a command does not trigger", () => {
  const r = check(`${filler(4)}\n\nRun the \`handed-command\` check against \`checks/lines.mjs\`.`);
  assert.equal(r.flagged, false);
});

test("quoted output, console fences and other languages are not handed", () => {
  const quoted = `${filler(4)}\n\n> Run \`gh pr list\` to see them.\n\nThat was the old advice.`;
  assert.equal(check(quoted).flagged, false);
  const consoleFence = `${filler(4)}\n\n\`\`\`console\n$ gh pr list\n#12 fix the cache\n\`\`\``;
  assert.equal(check(consoleFence).flagged, false);
  const js = `${filler(4)}\n\n\`\`\`js\nnode.run();\n\`\`\``;
  assert.equal(check(js).flagged, false);
});

test("an untagged fence with no imperative above it is code, not a hand-over", () => {
  const msg = `${filler(4)}\n\nThe hook spawns this:\n\n\`\`\`\nnode hooks/i-have-audhd-stop.mjs\n\`\`\``;
  assert.equal(check(msg).flagged, false);
});

test("allow globs accept the operator's own line shape", () => {
  const msg = `${filler(4)}\n\nRun \`just deploy-preview\`.`;
  assert.equal(check(msg).flagged, true);
  const r = check(msg, { allow: ["just deploy-*"] });
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "script-line-only");
});

// ─── must flag ───────────────────────────────────────────────────────────────

test("a bare inline command under 'run' is the finding, naming the line", () => {
  const r = check(`${filler(4)}\n\nRun \`gh pr list\` to see what is open.`);
  assert.equal(r.flagged, true);
  assert.equal(r.reason, "bare-command");
  assert.deepEqual(r.findings, [{ line: 3, command: "gh pr list", where: "inline", problem: "bare-command" }]);
});

test("imperatives after a clause break, 'please', or 'you can' all count", () => {
  for (const s of [
    "Once it merges, run `git pull --rebase`.",
    "Next step: paste `npm install` in the repo.",
    "- please type `sudo launchctl kickstart system/x`",
    "You can run `brew upgrade` when convenient.",
    "You'll need to run `gh auth login` first.",
  ]) {
    const r = check(`${filler(4)}\n\n${s}`);
    assert.equal(r.flagged, true, s);
  }
});

test("a bash fence with a bare command is the finding", () => {
  const msg = `${filler(4)}\n\n\`\`\`bash\ngh pr list\n\`\`\``;
  const r = check(msg);
  assert.equal(r.flagged, true);
  assert.deepEqual(r.findings, [{ line: 4, command: "gh pr list", where: "fence", problem: "bare-command" }]);
});

test("a multi-command paste is a finding even when one line is a script", () => {
  const msg = `${filler(4)}\n\n\`\`\`zsh\n${SCRIPT}\ngit push\n\`\`\``;
  const r = check(msg);
  assert.equal(r.flagged, true);
  assert.equal(r.findings[0].command, "git push");
  const twoScripts = `${filler(4)}\n\n\`\`\`zsh\nzsh ~/agent-scratch/one.sh\nzsh ~/agent-scratch/two.sh\n\`\`\``;
  assert.equal(check(twoScripts).flagged, true);
});

test("an untagged fence under 'Paste this' is handed", () => {
  const msg = `${filler(4)}\n\nPaste this into your terminal:\n\n\`\`\`\ncd ~/code/app\nnpm ci\n\`\`\``;
  const r = check(msg);
  assert.equal(r.flagged, true);
  assert.equal(r.findings[0].command, "cd ~/code/app");
});

test("a script line with arguments or a chained command is not the passing shape", () => {
  for (const line of [`${SCRIPT} --force`, `${SCRIPT} && git push`, "zsh ./x.sh"]) {
    assert.equal(check(`${filler(4)}\n\nRun \`${line}\`.`).flagged, true, line);
  }
});

test("a receipt covers only its own paragraph: a later hand-over still flags", () => {
  const msg = `${filler(4)}\n\n**CLAIM**\n\`gh pr list\` printed three rows.\n\nNow run \`gh pr merge 12\` to land it.`;
  const r = check(msg);
  assert.equal(r.flagged, true);
  assert.equal(r.findings[0].command, "gh pr merge 12");
});

test("every bare hand-over in a message is listed", () => {
  const msg = `${filler(4)}\n\nRun \`git fetch\`.\n\n\`\`\`sh\nnpm ci\n\`\`\``;
  assert.equal(check(msg).findings.length, 2);
});

// ─── HC-01: where the script lives ───────────────────────────────────────────

// A temp tree: <tmp>/home/agent-scratch, a checkout <tmp>/repo (.git dir), a worktree
// <tmp>/wt (.git file), and scratch symlinks into both.
function tree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "handed-command-")));
  const home = join(root, "home");
  const scratch = join(home, "agent-scratch");
  mkdirSync(scratch, { recursive: true });
  mkdirSync(join(root, "repo", ".git"), { recursive: true });
  mkdirSync(join(root, "repo", "scripts"), { recursive: true });
  writeFileSync(join(root, "repo", "scripts", "check.sh"), "echo hi\n");
  mkdirSync(join(root, "wt", "scripts"), { recursive: true });
  writeFileSync(join(root, "wt", ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
  writeFileSync(join(scratch, "ok.sh"), "echo hi\n");
  symlinkSync(join(root, "repo", "scripts", "check.sh"), join(scratch, "linked.sh"));
  symlinkSync(join(root, "repo"), join(scratch, "repo-link"));
  return { root, home, scratch };
}

test("HC-01 script_inside_checkout: a script inside a git checkout is a finding naming the checkout", () => {
  const t = tree();
  const r = checkHandedCommand(`Run \`zsh ${t.root}/repo/scripts/check.sh\`.`, { home: t.home });
  assert.equal(r.flagged, true);
  assert.equal(r.reason, "script-location");
  assert.deepEqual(r.findings[0], {
    line: 1,
    command: `zsh ${t.root}/repo/scripts/check.sh`,
    where: "inline",
    problem: "in-checkout",
    checkout: join(t.root, "repo"),
  });
});

test("HC-01: a worktree (.git file) counts, and a not-yet-written script inside it too", () => {
  const t = tree();
  const r = checkHandedCommand(`Run \`zsh ${t.root}/wt/scripts/later.sh\`.`, { home: t.home });
  assert.equal(r.findings[0].problem, "in-checkout");
  assert.equal(r.findings[0].checkout, join(t.root, "wt"));
});

test("HC-01: symlinks resolve: a scratch path linking into a checkout is inside it", () => {
  const t = tree();
  for (const p of ["~/agent-scratch/linked.sh", "~/agent-scratch/repo-link/scripts/new.sh"]) {
    const r = checkHandedCommand(`Run \`zsh ${p}\`.`, { home: t.home });
    assert.equal(r.findings[0]?.problem, "in-checkout", p);
  }
  // A checkout listed as a root is still a checkout.
  const r = checkHandedCommand(`Run \`zsh ${t.root}/repo/scripts/check.sh\`.`, { home: t.home, scriptRoots: [`${t.root}/repo`] });
  assert.equal(r.findings[0].problem, "in-checkout");
});

test("HC-01: a script under the scratch root and no checkout passes, by real path or ~/ path", () => {
  const t = tree();
  for (const p of [`${t.scratch}/ok.sh`, "~/agent-scratch/ok.sh", "~/agent-scratch/sub/not-yet.sh"]) {
    const r = checkHandedCommand(`Run \`zsh ${p}\`.`, { home: t.home });
    assert.equal(r.flagged, false, p);
    assert.equal(r.reason, "script-line-only", p);
  }
});

test("HC-01 script_outside_scratch: a script outside every root warns, naming the roots", () => {
  const r = check("Run `zsh /path/script.sh`.");
  assert.equal(r.flagged, true);
  assert.equal(r.reason, "script-location");
  assert.deepEqual(r.findings[0], {
    line: 1,
    command: "zsh /path/script.sh",
    where: "inline",
    problem: "outside-script-roots",
    roots: ["~/agent-scratch"],
  });
});

test("HC-01: scriptRoots replaces the default root", () => {
  const msg = "Run `zsh /Users/example/tmp/x.sh`.";
  assert.equal(check(msg).flagged, true);
  assert.equal(check(msg, { scriptRoots: ["/Users/example/tmp"] }).flagged, false);
  const r = check(`Run \`${SCRIPT}\`.`, { scriptRoots: ["/Users/example/tmp"] });
  assert.deepEqual(r.findings[0].roots, ["/Users/example/tmp"]);
});

// Round 2: `..` after a symlink is applied to the link's target, as the kernel does, not
// collapsed against the link's own spelling.
test("HC-01-R2: symlink then `..` into a .git-dir checkout is in the checkout, ~/ and absolute", () => {
  const t = tree();
  writeFileSync(join(t.root, "repo", "danger.sh"), "echo nope\n");
  symlinkSync(join(t.root, "repo", "scripts"), join(t.scratch, "jump"));
  for (const p of ["~/agent-scratch/jump/../danger.sh", `${t.scratch}/jump/../danger.sh`, "~/agent-scratch/jump/../later.sh"]) {
    const r = checkHandedCommand(`Run \`zsh ${p}\`.`, { home: t.home });
    assert.equal(r.reason, "script-location", p);
    assert.equal(r.findings[0]?.problem, "in-checkout", p);
    assert.equal(r.findings[0]?.checkout, join(t.root, "repo"), p);
  }
});

test("HC-01-R2: symlink then `..` into a .git-file worktree is in the worktree", () => {
  const t = tree();
  writeFileSync(join(t.root, "wt", "danger.sh"), "echo nope\n");
  symlinkSync(join(t.root, "wt", "scripts"), join(t.scratch, "wt-jump"));
  const r = checkHandedCommand("Run `zsh ~/agent-scratch/wt-jump/../danger.sh`.", { home: t.home });
  assert.equal(r.reason, "script-location");
  assert.equal(r.findings[0].problem, "in-checkout");
  assert.equal(r.findings[0].checkout, join(t.root, "wt"));
});

test("HC-01-R2: a symlink loop is flagged unresolvable, in under 50 ms", () => {
  const t = tree();
  symlinkSync(join(t.scratch, "loop.sh"), join(t.scratch, "loop.sh"));
  symlinkSync(join(t.scratch, "loopdir"), join(t.scratch, "loopdir"));
  for (const p of ["~/agent-scratch/loop.sh", "~/agent-scratch/loopdir/x.sh"]) {
    const t0 = performance.now();
    const r = checkHandedCommand(`Run \`zsh ${p}\`.`, { home: t.home });
    const ms = performance.now() - t0;
    assert.equal(r.reason, "script-location", p);
    assert.deepEqual(r.findings[0], { line: 1, command: `zsh ${p}`, where: "inline", problem: "unresolvable-path", error: "ELOOP" });
    assert.ok(ms < 50, `${p} took ${ms.toFixed(1)} ms`);
  }
});

// ─── HC-02: every span, adjacent spans assembled ─────────────────────────────

test("HC-02 split_inline_spans: adjacent spans are one command", () => {
  const r = check("Run `zsh /Users/example/agent-scratch/x.sh` `--flag`.");
  assert.equal(r.flagged, true);
  assert.equal(r.findings[0].command, "zsh /Users/example/agent-scratch/x.sh --flag");
});

test("HC-02 split_inline_binary: `gh` `pr list` is `gh pr list`", () => {
  const r = check("Run `gh` `pr list`.");
  assert.deepEqual(r.findings, [{ line: 1, command: "gh pr list", where: "inline", problem: "bare-command" }]);
});

test("HC-02 safe_then_unsafe_inline: a later imperative's command is checked too", () => {
  const r = check(`Run \`${SCRIPT}\`, then run \`gh pr list\`.`);
  assert.equal(r.flagged, true);
  assert.deepEqual(r.findings.map((f) => f.command), ["gh pr list"]);
});

test("HC-02: a valid script line followed by another bare command span on the same line warns", () => {
  const r = check(`Run \`${SCRIPT}\`; \`git push\` after it.`);
  assert.deepEqual(r.findings.map((f) => f.command), ["git push"]);
});

test("HC-02 script_split_across_lines: a span group continues onto the next line", () => {
  const r = check(`Run \`${SCRIPT}\`\n\`--flag\`.`);
  assert.equal(r.flagged, true);
  assert.equal(r.findings[0].command, `${SCRIPT} --flag`);
  assert.equal(r.findings[0].line, 1);
});

test("HC-02-R2: a three-line span continuation is one command", () => {
  const r = check("Run `zsh`\n`~/agent-scratch/a.sh`\n`--force`.");
  assert.equal(r.reason, "bare-command");
  assert.deepEqual(r.findings, [{ line: 1, command: "zsh ~/agent-scratch/a.sh --force", where: "inline", problem: "bare-command" }]);
});

test("HC-02-R2: a four-line continuation, with a shell operator, is one command", () => {
  const r = check("Run `zsh`\n`~/agent-scratch/a.sh`\n`&&`\n`git push`");
  assert.deepEqual(r.findings.map((f) => f.command), ["zsh ~/agent-scratch/a.sh && git push"]);
});

test("HC-02-R2: prose ends the continuation; a span after it is not part of the command", () => {
  // The script line passes on its own; `--force` sits after prose on the third line.
  const r = check("Run `zsh`\n`~/agent-scratch/a.sh`\nand later `--force`.");
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "script-line-only");
  // Prose after a span on the second line stops it too.
  const r2 = check("Run `zsh`\n`~/agent-scratch/a.sh` in a terminal\n`--force`.");
  assert.equal(r2.reason, "script-line-only");
});

// ─── HC-04: the glob matcher is bounded ──────────────────────────────────────

test("HC-04 glob_budget: 24 × `*a` against a near miss finishes in under 50 ms", () => {
  const pattern = `just ${"*a".repeat(24)}z`;
  const line = `just ${"a".repeat(70)}!`;
  const t0 = performance.now();
  const r = check(`Run \`${line}\`.`, { allow: [pattern] });
  const ms = performance.now() - t0;
  assert.equal(r.flagged, true);
  assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
});

test("HC-04: the matcher keeps the documented grammar: `*`, `?`, everything else literal, whole line", () => {
  assert.equal(globMatch("just deploy-*", "just deploy-preview"), true);
  assert.equal(globMatch("just deploy-*", "just deploy-preview && rm -rf ~"), true); // `*` is any run
  assert.equal(globMatch("just deploy", "just deploy && rm -rf ~"), false);
  assert.equal(globMatch("gh pr view ?", "gh pr view 7"), true);
  assert.equal(globMatch("gh pr view ?", "gh pr view 12"), false);
  assert.equal(globMatch("just deploy.[x](a)+{b}^$|\\end", "just deploy.[x](a)+{b}^$|\\end"), true);
  assert.equal(globMatch("just deploy.sh", "just deployXsh"), false);
  assert.equal(globMatch("just deploy[x]", "just deployx"), false);
  assert.equal(globMatch("*", ""), true);
  assert.equal(globMatch("a*b*c", "aXbYc"), true);
  assert.equal(globMatch("a*b*c", "aXbYcd"), false);
});

// ─── HC-05/06/07/09: receipt context ─────────────────────────────────────────

test("HC-05 claim_two_paragraphs: a receipt fence two explanatory paragraphs below its label is evidence", () => {
  const msg =
    "**CLAIM**\nThe completed check used the following command.\n\nIts exact invocation and result follow.\n\n```bash\ngh pr list\n```\nThe command exited zero.";
  const r = check(msg);
  assert.equal(r.flagged, false);
  assert.equal(r.applicable, false);
});

test("HC-05: a later paragraph that tells the reader to run something ends the receipt", () => {
  const msg = "**CLAIM**\nThe check passed.\n\nNow run this to land it:\n\n```bash\ngh pr merge 12\n```";
  assert.deepEqual(check(msg).findings.map((f) => f.command), ["gh pr merge 12"]);
  const afterFence = "**CLAIM**\nThe command:\n\n```bash\ngh pr list\n```\n\nThat listed three.\n\n```bash\ngh pr merge 12\n```";
  assert.deepEqual(check(afterFence).findings.map((f) => f.command), ["gh pr merge 12"]);
});

test("HC-06 arrow_next_line_inline / arrow_next_line_fence: a result on the next line attaches", () => {
  assert.equal(check("Run `gh pr list`\n→ exit 0, three pull requests.").flagged, false);
  assert.equal(check("```bash\ngh pr list\n```\n→ exit 0, three pull requests.").flagged, false);
  assert.equal(check("```bash\nnpm test\n```\nExit code: 0.").flagged, false);
  assert.equal(check("Run `npm test`\nexit 0").flagged, false);
});

test("HC-06: with no result attached, instruction detection is unchanged", () => {
  assert.equal(check("Run `gh pr list`\nIt lists three pull requests.").flagged, true);
  assert.equal(check("```bash\ngh pr list\n```\nIt lists three pull requests.").flagged, true);
});

test("HC-07 numbered_what_i_ran_fence: a numbered item under 'What I ran' with its result is evidence", () => {
  const msg = "## What I ran\n1. Listed open pull requests:\n\n   ```bash\n   gh pr list\n   ```\n\n   Exit code: 0.";
  assert.equal(check(msg).flagged, false);
  const inline = "## What I ran\n1. `gh pr list` — exit 0.\n2. `npm test` — exit 0.";
  assert.equal(check(inline).flagged, false);
  for (const heading of ["**Verification**", "## Ran"]) {
    assert.equal(check(msg.replace("## What I ran", heading)).flagged, false, heading);
  }
});

test("HC-07: the same item under another heading, or without a result, is still handed", () => {
  const next = "## Next steps\n1. List open pull requests:\n\n   ```bash\n   gh pr list\n   ```\n\n   Exit code: 0.";
  assert.equal(check(next).flagged, true);
  const noResult = "## What I ran\n1. Listed open pull requests:\n\n   ```bash\n   gh pr list\n   ```";
  assert.equal(check(noResult).flagged, true);
});

test("HC-09 table cells: an instructional cell warns; a row with a result entry is evidence", () => {
  const imperative = "| Step | Command |\n| --- | --- |\n| Run `gh pr list` | Lists open pull requests |";
  assert.deepEqual(check(imperative).findings, [{ line: 3, command: "gh pr list", where: "inline", problem: "bare-command" }]);
  for (const evidence of [
    "| Check | Result |\n| --- | --- |\n| Completed: run `gh pr list` | exit 0 |", // table_colon_evidence
    "| What I ran | Result |\n| --- | --- |\n| `gh pr list` | exit 0 |", // table_evidence
    "| Check | Result |\n| --- | --- |\n| canary run `gh pr list` | exit 0 |", // table_run_noun
    "| Step | Notes |\n| --- | --- |\n| Run `gh pr list` | exit 0 |", // a result-line cell
  ]) {
    assert.equal(check(evidence).flagged, false, evidence);
  }
});

// ─── HC-08/10: terminal sessions under an instruction ────────────────────────

test("HC-08 console_instructions: a console fence under an instruction is handed", () => {
  const r = check("Run this in your terminal:\n\n```console\n$ gh pr list\n```");
  assert.deepEqual(r.findings, [{ line: 4, command: "gh pr list", where: "fence", problem: "bare-command" }]);
  const text = check("Paste this:\n\n```text\n$ npm ci\n$ npm test\n```");
  assert.equal(text.flagged, true);
  const script = check(`Run this in your terminal:\n\n\`\`\`console\n$ ${SCRIPT}\nlogged beside the script\n\`\`\``);
  assert.equal(script.flagged, false);
  assert.equal(script.reason, "script-line-only");
});

test("HC-08: console output with no instruction above stays evidence", () => {
  assert.equal(check("The run printed:\n\n```console\n$ gh pr list\n#12 fix the cache\n```").flagged, false);
});

test("HC-10 prompt_after_run: an unfenced `$ cmd` under an instruction is handed", () => {
  const r = check("Run this in your terminal:\n\n$ gh pr list");
  assert.deepEqual(r.findings, [{ line: 3, command: "gh pr list", where: "prompt", problem: "bare-command" }]);
  assert.equal(check("Run this:\n$ npm ci\n$ npm test").findings[0].command, "npm ci");
});

test("HC-10 dollar_prompt_bare: a lone `$ cmd` with no instruction is not handed", () => {
  assert.equal(check("$ gh pr list").flagged, false);
  assert.equal(check("$ gh pr list").applicable, false);
});

test("dollar_prompt_inline: a prompt inside the span is stripped", () => {
  assert.equal(check("Run `$ gh pr list`.").findings[0].command, "gh pr list");
});

test("noun uses of 'run' stay silent: noun_canary_run, noun_canary_run_x", () => {
  assert.equal(check("The canary run `gh pr list` completed successfully.").flagged, false);
  assert.equal(check("The canary run `x` completed successfully.").flagged, false);
});
