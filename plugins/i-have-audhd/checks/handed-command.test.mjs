// handed-command.test.mjs — node --test
//
// Same proportion as the other check suites: the false-positive cases are the point. Code
// quoted as evidence — a receipt under a label, a `command → result` line, quoted output — must
// never read as a command handed to the reader.
//
// Run: node --test 'plugins/i-have-audhd/checks/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHandedCommand } from "./handed-command.mjs";

const filler = (n) => "This sentence is ordinary body prose that carries findings. ".repeat(n);

// ─── must not flag ───────────────────────────────────────────────────────────

test("a message with no command at all is not applicable", () => {
  const r = checkHandedCommand(filler(6));
  assert.equal(r.applicable, false);
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "no-handed-command");
});

test("an inline zsh script line under 'run' passes", () => {
  const r = checkHandedCommand(`${filler(4)}\n\nRun \`zsh /Users/example/agent-scratch/x.sh\` when you are back.`);
  assert.equal(r.applicable, true);
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "script-line-only");
});

test("a bash fence holding one script line passes, prompt and comment ignored", () => {
  const msg = `${filler(4)}\n\nPaste this:\n\n\`\`\`bash\n# the whole cleanup, logged beside the script\n$ zsh /Users/example/agent-scratch/repo/cleanup.sh\n\`\`\``;
  const r = checkHandedCommand(msg);
  assert.equal(r.applicable, true);
  assert.equal(r.flagged, false);
});

test("bash, sh, a ~/ path and a quoted path are the same passing shape", () => {
  for (const line of [
    "bash /Users/example/agent-scratch/x.sh",
    "sh ~/agent-scratch/x.sh",
    'zsh "/Users/example/agent scratch/x.sh"',
  ]) {
    const r = checkHandedCommand(`${filler(4)}\n\nRun \`${line}\`.`);
    assert.equal(r.flagged, false, line);
    assert.equal(r.applicable, true, line);
  }
});

test("a receipt under **CLAIM** is evidence, inline or fenced", () => {
  const inline = `${filler(4)}\n\n**CLAIM**\nRun \`gh pr list --state open\` and it lists three PRs.`;
  assert.equal(checkHandedCommand(inline).flagged, false);
  const fenced = `${filler(4)}\n\n**CLAIM**\nThe command and its output:\n\n\`\`\`bash\ngh pr list --state open\n\`\`\`\n\nMore prose after.`;
  const r = checkHandedCommand(fenced);
  assert.equal(r.flagged, false);
  assert.equal(r.applicable, false);
});

test("a **CITE** label covers its receipt the same way", () => {
  const msg = `${filler(4)}\n\n**CITE**\n\`\`\`sh\ncurl -s https://example.com/status\n\`\`\``;
  assert.equal(checkHandedCommand(msg).flagged, false);
});

test("a `command → result` line is a receipt, not a hand-over", () => {
  const msg = `${filler(4)}\n\nRan the suite: run \`npm test\` → exit 0, 231 pass.`;
  assert.equal(checkHandedCommand(msg).flagged, false);
  const fenced = `${filler(4)}\n\n\`\`\`bash\nnpm run lint → exit 0\n\`\`\``;
  assert.equal(checkHandedCommand(fenced).flagged, false);
});

test("the agent's own past or future runs are not handed: 'I ran', 'I'll run'", () => {
  for (const s of ["I ran `gh pr list` and saw three PRs.", "I'll run `npm test` next.", "We run `git fetch` hourly."]) {
    assert.equal(checkHandedCommand(`${filler(4)}\n\n${s}`).flagged, false, s);
  }
});

test("a code span that is not a command does not trigger", () => {
  const r = checkHandedCommand(`${filler(4)}\n\nRun the \`handed-command\` check against \`checks/lines.mjs\`.`);
  assert.equal(r.flagged, false);
});

test("quoted output, console fences and other languages are not handed", () => {
  const quoted = `${filler(4)}\n\n> Run \`gh pr list\` to see them.\n\nThat was the old advice.`;
  assert.equal(checkHandedCommand(quoted).flagged, false);
  const consoleFence = `${filler(4)}\n\n\`\`\`console\n$ gh pr list\n#12 fix the cache\n\`\`\``;
  assert.equal(checkHandedCommand(consoleFence).flagged, false);
  const js = `${filler(4)}\n\n\`\`\`js\nnode.run();\n\`\`\``;
  assert.equal(checkHandedCommand(js).flagged, false);
});

test("an untagged fence with no imperative above it is code, not a hand-over", () => {
  const msg = `${filler(4)}\n\nThe hook spawns this:\n\n\`\`\`\nnode hooks/i-have-audhd-stop.mjs\n\`\`\``;
  assert.equal(checkHandedCommand(msg).flagged, false);
});

test("allow globs accept the operator's own line shape", () => {
  const msg = `${filler(4)}\n\nRun \`just deploy-preview\`.`;
  assert.equal(checkHandedCommand(msg).flagged, true);
  const r = checkHandedCommand(msg, { allow: ["just deploy-*"] });
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "script-line-only");
});

// ─── must flag ───────────────────────────────────────────────────────────────

test("a bare inline command under 'run' is the finding, naming the line", () => {
  const r = checkHandedCommand(`${filler(4)}\n\nRun \`gh pr list\` to see what is open.`);
  assert.equal(r.flagged, true);
  assert.equal(r.reason, "bare-command");
  assert.deepEqual(r.findings, [{ line: 3, command: "gh pr list", where: "inline" }]);
});

test("imperatives after a clause break, 'please', or 'you can' all count", () => {
  for (const s of [
    "Once it merges, run `git pull --rebase`.",
    "Next step: paste `npm install` in the repo.",
    "- please type `sudo launchctl kickstart system/x`",
    "You can run `brew upgrade` when convenient.",
    "You'll need to run `gh auth login` first.",
  ]) {
    const r = checkHandedCommand(`${filler(4)}\n\n${s}`);
    assert.equal(r.flagged, true, s);
  }
});

test("a bash fence with a bare command is the finding", () => {
  const msg = `${filler(4)}\n\n\`\`\`bash\ngh pr list\n\`\`\``;
  const r = checkHandedCommand(msg);
  assert.equal(r.flagged, true);
  assert.deepEqual(r.findings, [{ line: 4, command: "gh pr list", where: "fence" }]);
});

test("a multi-command paste is a finding even when one line is a script", () => {
  const msg = `${filler(4)}\n\n\`\`\`zsh\nzsh /Users/example/agent-scratch/x.sh\ngit push\n\`\`\``;
  const r = checkHandedCommand(msg);
  assert.equal(r.flagged, true);
  assert.equal(r.findings[0].command, "git push");
  const twoScripts = `${filler(4)}\n\n\`\`\`zsh\nzsh /a/one.sh\nzsh /a/two.sh\n\`\`\``;
  assert.equal(checkHandedCommand(twoScripts).flagged, true);
});

test("an untagged fence under 'Paste this' is handed", () => {
  const msg = `${filler(4)}\n\nPaste this into your terminal:\n\n\`\`\`\ncd ~/code/app\nnpm ci\n\`\`\``;
  const r = checkHandedCommand(msg);
  assert.equal(r.flagged, true);
  assert.equal(r.findings[0].command, "cd ~/code/app");
});

test("a script line with arguments or a chained command is not the passing shape", () => {
  for (const line of ["zsh /a/x.sh --force", "zsh /a/x.sh && git push", "zsh ./x.sh"]) {
    assert.equal(checkHandedCommand(`${filler(4)}\n\nRun \`${line}\`.`).flagged, true, line);
  }
});

test("a receipt covers only its own paragraph: a later hand-over still flags", () => {
  const msg = `${filler(4)}\n\n**CLAIM**\n\`gh pr list\` printed three rows.\n\nNow run \`gh pr merge 12\` to land it.`;
  const r = checkHandedCommand(msg);
  assert.equal(r.flagged, true);
  assert.equal(r.findings[0].command, "gh pr merge 12");
});

test("every bare hand-over in a message is listed", () => {
  const msg = `${filler(4)}\n\nRun \`git fetch\`.\n\n\`\`\`sh\nnpm ci\n\`\`\``;
  assert.equal(checkHandedCommand(msg).findings.length, 2);
});
