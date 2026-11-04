#!/usr/bin/env node
// capture-real-judge.mjs — one-off capture of a REAL judge's output, for judge/ask.test.mjs.
//
// NOT A TEST. node --test never runs this file (its name matches no test pattern). Run it by hand
// when the fixtures need refreshing:
//
//   node plugins/i-have-audhd/judge/fixtures/capture-real-judge.mjs [profile.json]
//
// It reads enforcement.judgeCommand from the operator profile (default ~/.claude/i-have-audhd.json),
// then runs the REAL Stop hook, as a process, in a temp HOME on a message that trips the
// conclusion-first and bad-news-first triggers. The temp profile's judgeCommand is a wrapper that
// records the exact prompt the hook sent, then runs the operator's command with the real HOME
// (the judge's credentials live there) and records its stdout, stderr and exit code. Each judge
// job lands as fixtures/<rule>.{prompt,stdout,stderr}.txt plus <rule>.exit.txt. The parser tests
// read those files verbatim; nothing in them is hand-written.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const HOOK = fileURLToPath(new URL("../../hooks/i-have-audhd-stop.mjs", import.meta.url));
const realHome = homedir();
const profilePath = process.argv[2] || join(realHome, ".claude", "i-have-audhd.json");
const judgeCommand = JSON.parse(readFileSync(profilePath, "utf8"))?.enforcement?.judgeCommand;
if (typeof judgeCommand !== "string" || !judgeCommand.trim()) {
  writeFileSync(join(HERE, "judge.unavailable.txt"), `no enforcement.judgeCommand in ${profilePath}\n`);
  console.error(`no judgeCommand in ${profilePath}; wrote judge.unavailable.txt`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "audhd-capture-"));
const raw = join(work, "raw");
mkdirSync(raw);
const home = join(work, "home");
mkdirSync(join(home, ".claude"), { recursive: true });

const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const wrapper = join(work, "judge-wrapper.sh");
writeFileSync(
  wrapper,
  [
    "#!/bin/sh",
    `d=${q(raw)}; n=$$`,
    'cat > "$d/$n.prompt.txt"',
    `HOME=${q(realHome)} /bin/sh -c ${q(judgeCommand)} < "$d/$n.prompt.txt" > "$d/$n.stdout.txt" 2> "$d/$n.stderr.txt"`,
    'c=$?; echo "$c" > "$d/$n.exit.txt"; cat "$d/$n.stdout.txt"; exit "$c"',
    "",
  ].join("\n"),
);
chmodSync(wrapper, 0o755);
writeFileSync(
  join(home, ".claude", "i-have-audhd.json"),
  JSON.stringify({ enforcement: { judgeCommand: wrapper, mode: "warn" } }),
);

// Setup first, point last (conclusion-first), and a failure stated below the fold (bad-news-first).
const message = [
  "I started by reading the deploy workflow end to end, then compared the staging and production " +
    "configuration files line by line, then walked through the last three release tags to see how " +
    "the cache keys were derived in each of them, and then read the runbook section on rollbacks.",
  "",
  "After all of that, the conclusion is that the production deploy failed last night and the " +
    "rollback did not run, so the site is still serving the broken build. The fix is to rerun the " +
    "rollback job by hand from the actions page.",
].join("\n");

const r = spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ session_id: "capture", cwd: work, stop_hook_active: false, last_assistant_message: message }),
  encoding: "utf8",
  env: { ...process.env, HOME: home, I_HAVE_AUDHD_PROFILE: "", I_HAVE_AUDHD_ENFORCE: "", I_HAVE_AUDHD_HARNESS: "" },
  timeout: 90_000,
});
console.log(`stop hook exit=${r.status} stdout=${r.stdout}`);

for (const name of readdirSync(raw).filter((f) => f.endsWith(".prompt.txt"))) {
  const n = name.slice(0, -".prompt.txt".length);
  const rule = /^Rule: (.+)$/m.exec(readFileSync(join(raw, name), "utf8"))?.[1] ?? `job-${n}`;
  for (const part of ["prompt", "stdout", "stderr", "exit"]) {
    renameSync(join(raw, `${n}.${part}.txt`), join(HERE, `${rule}.${part}.txt`));
  }
  console.log(`captured ${rule}`);
}
// The operator's home directory is written as <home>: the fixture is committed, the path is theirs.
writeFileSync(
  join(HERE, "CAPTURED.txt"),
  `captured ${new Date().toISOString()} by capture-real-judge.mjs\n` +
    `judgeCommand: ${judgeCommand.split(realHome).join("<home>")}\n`,
);
