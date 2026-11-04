#!/usr/bin/env node
// setup.mjs — this plugin's own judge choice for the Stop hook: the override in the profile.
// Run it in a terminal: `node <plugin dir>/tools/setup.mjs`. It works the same for Claude Code
// and OMP installs, because both read one profile (lib/config.mjs, defaultProfilePath).
//
// Since 1.7.0 the judge command is resolved in plugin-kit's shared order (judge/ask.mjs,
// resolveJudge): the profile's enforcement.judgeCommand first, else the shared judge file
// ${XDG_CONFIG_HOME:-~/.config}/judge/config.json that every judging plugin reads. The shared
// file is written by `node <plugin dir>/lib/judge.mjs setup` (the vendored kit CLI; not forked
// here). This tool writes the OVERRIDE only, for a judge that is this plugin's alone; it shows
// the shared file and what resolves right now, so the two never surprise each other.
//
// What it does, in order, announcing each step:
//   1. Checks that `node` is on PATH: the hooks are run as `node <hook>.mjs` by both hosts, and
//      prints the profile, the shared file, and the judge that resolves today with its source.
//   2. Lists the judge choices — Claude Code CLI, Codex CLI, OMP, a custom command, or none —
//      marking which CLIs it found on PATH, and requires an explicit pick. "none" is a real
//      choice: it writes judgeCommand: null, no override, which stops the session-start notice
//      (lib/judge-setup.mjs, THE STATES); the shared file applies when it names a command, and
//      otherwise the five judge checks stay off.
//   3. For any judge, makes one cheap test call through the hook's own dispatch (askJudge in
//      judge/ask.mjs), with a throwaway state dir so the test leaves no cache entry or log
//      line in the real one. A judge that fails, or that is slower than OMP's 20s judge budget,
//      is reported in plain words; a failed judge is written only if the operator says so.
//   4. Prints the profile path and the full JSON it will write, and writes only after a yes.
//      Every other field in the profile is kept as it was.
// Safe to re-run: it shows the current choice first, and writing the same choice again is a
// no-op.
//
// Flags, for scripted installs and tests: --judge claude|codex|omp|custom|none,
// --command <cmd> (with custom), --model <name> (with omp), --yes (write without asking; a
// failed test call still refuses). Exit 0 written or already set; 1 refused or failed; 2 usage.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { askJudge, judgeSources, resolveJudge } from "../judge/ask.mjs";
import { defaultProfilePath } from "../lib/config.mjs";
import { readSharedConfig } from "../lib/judge.mjs";
import { JUDGE_RULES, TOTAL_CHECKS, SHARED_SETUP_COMMAND } from "../lib/judge-setup.mjs";

// The judge's own session must not run this plugin's hooks on the judge's reply. Both Claude
// Code and OMP pass the environment to the hooks they spawn, and these two switches turn the
// injection and the Stop hook off for that one child. askJudge sets them on every judge it runs
// as well (so a command from the shared file is covered); the prefix keeps a command written
// here self-describing when run by hand.
const QUIET = "I_HAVE_AUDHD_ENFORCE=off I_HAVE_AUDHD_INJECT=off";
const OMP_BUDGET_MS = 20_000; // judge/ask.mjs, THE TIMEOUT: the judge's budget under OMP
const TEST_TIMEOUT_MS = 60_000;

export const CHOICES = [
  {
    id: "claude",
    label: "Claude Code CLI, Haiku model",
    bin: "claude",
    command: () => `${QUIET} claude -p --output-format json --model haiku`,
  },
  {
    id: "codex",
    label: "Codex CLI, its default model",
    bin: "codex",
    command: () => "codex exec --skip-git-repo-check -",
  },
  {
    id: "omp",
    label: "OMP, a model you name (default haiku)",
    bin: "omp",
    command: (model) =>
      `${QUIET} omp -p --no-session --no-tools --no-extensions --no-skills --no-rules --no-lsp --no-title --model ${model || "haiku"}`,
  },
  { id: "custom", label: "A command you type", bin: null, command: (c) => c },
  { id: "none", label: `None of its own: the shared judge file applies when it names a command; otherwise ${JUDGE_RULES.length} of ${TOTAL_CHECKS} checks stay off`, bin: null, command: () => null },
];

const USAGE =
  "usage: node setup.mjs [--judge claude|codex|omp|custom|none] [--command <cmd>] [--model <name>] [--yes]\n" +
  "  no flags  interactive: pick a judge, test it, preview, confirm\n";

function parseArgs(argv) {
  const out = { judge: null, command: null, model: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") out.yes = true;
    else if (a === "--judge" || a === "--command" || a === "--model") {
      const v = argv[++i];
      if (v === undefined) return null;
      out[a.slice(2)] = v;
    } else return null;
  }
  if (out.judge && !CHOICES.some((c) => c.id === out.judge)) return null;
  if (out.judge === "custom" && out.command !== null && !out.command.trim()) return null;
  return out;
}

// Line-at-a-time answers that work the same for a terminal and a pipe. EOF answers null.
function makeAsker() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(prompt) {
      process.stdout.write(prompt);
      const { value, done } = await lines.next();
      if (done) {
        process.stdout.write("\n");
        return null;
      }
      return value.trim();
    },
    close: () => rl.close(),
  };
}

function onPath(bin) {
  return spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;
}

function nodeCheck() {
  const here = spawnSync("node", ["--version"], { encoding: "utf8" });
  return { version: here.status === 0 ? here.stdout.trim() : null };
}

// { profile, error } — never prints the file's contents on a parse failure.
function readProfile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { profile: null, error: null };
    return { profile: null, error: `could not be read (${err.code})` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { profile: null, error: "is not a JSON object" };
    return { profile: parsed, error: null };
  } catch {
    return { profile: null, error: "is not valid JSON" };
  }
}

function describe(judgeCommand) {
  if (judgeCommand === undefined) return "not chosen yet";
  if (judgeCommand === null) return "none of its own (the shared judge file applies when it names a command)";
  return JSON.stringify(judgeCommand);
}

async function testJudge(command) {
  const dir = mkdtempSync(join(tmpdir(), "i-have-audhd-setup-"));
  try {
    const started = Date.now();
    const result = await askJudge(
      "setup-test",
      "Does the message contain the word banana?",
      "The sky is blue.",
      { judgeCommand: command },
      { stateDir: dir, timeoutMs: TEST_TIMEOUT_MS },
    );
    return { ...result, ms: Date.now() - started };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FAILURE_WORDS = {
  timeout: `it printed no verdict within ${TEST_TIMEOUT_MS / 1000}s`,
  unparseable: 'it exited 0 but printed no {"violation": <boolean>, "reason": <string>} object last on stdout',
  "spawn-failed": "/bin/sh could not start it",
};
function failureText(error, detail) {
  if (FAILURE_WORDS[error]) return FAILURE_WORDS[error];
  if (error === "nonzero") {
    const status = /^exit (\S+)$/.exec(String(detail ?? ""))?.[1] ?? "unknown";
    return `it exited with status ${status} (127 usually means the command is not on PATH; otherwise check it is signed in)`;
  }
  return detail ? `${error} (${detail})` : error;
}

function writeProfile(path, profile) {
  mkdirSync(dirname(path), { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // a new profile is private to its owner
  }
  const tmp = `${path}.setup-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write(USAGE);
    return 2;
  }
  const asker = makeAsker();
  try {
    return await run(args, asker);
  } finally {
    asker.close();
  }
}

async function run(args, { ask }) {
  console.log("i-have-audhd setup: choose the judge for the Stop hook's model-graded checks.\n");

  console.log("Step 1 of 4: checking node.");
  const node = nodeCheck();
  if (!node.version) {
    console.log("  node is not on PATH. Both Claude Code and OMP run this plugin's hooks as `node <hook>.mjs`,");
    console.log("  so without it no check runs at all. Install Node.js, then run this again.");
    return 1;
  }
  console.log(`  node ${node.version} is on PATH.`);

  const path = defaultProfilePath();
  const { profile, error } = readProfile(path);
  if (error) {
    console.log(`\nThe profile at ${path} ${error}. Fix or move it, then run this again; nothing was written.`);
    return 1;
  }
  const current = profile?.enforcement && typeof profile.enforcement === "object" ? profile.enforcement.judgeCommand : undefined;
  console.log(`  Profile: ${path}${profile ? "" : " (does not exist yet)"}`);
  console.log(`  This plugin's own judge (enforcement.judgeCommand, the override): ${describe(current)}`);
  const { shared, malformed } = judgeSources();
  console.log(`  Shared judge file, read by every plugin that judges: ${shared}${malformed ? ` (malformed: ${malformed})` : ""}`);
  console.log(`  Written by \`${SHARED_SETUP_COMMAND}\`.`);
  const resolved = resolveJudge({ judgeCommand: typeof current === "string" ? current : null });
  console.log(`  Resolves now to: ${resolved ? `${JSON.stringify(resolved.command)} from ${resolved.source}` : "no judge"}`);

  console.log(`\nStep 2 of 4: choose a judge. ${JUDGE_RULES.length} of the ${TOTAL_CHECKS} checks need one:`);
  console.log(`  ${JUDGE_RULES.join(", ")}.`);
  console.log("  The judge is any command that reads a prompt on stdin (or in a {prompt} placeholder) and prints");
  console.log('  {"violation": <boolean>, "reason": "<sentence>"} on stdout. Each check makes one call per message it fires on.\n');
  CHOICES.forEach((c, i) => {
    const found = c.bin ? (onPath(c.bin) ? `  [${c.bin} found]` : `  [${c.bin} not on PATH]`) : "";
    console.log(`  ${i + 1}. ${c.label}${found}`);
  });

  let choice = args.judge ? CHOICES.find((c) => c.id === args.judge) : null;
  while (!choice) {
    const answer = await ask(`\nType 1-${CHOICES.length}: `);
    if (answer === null) {
      console.log("No choice made; nothing was written.");
      return 1;
    }
    const n = Number(answer);
    choice = Number.isInteger(n) && n >= 1 && n <= CHOICES.length ? CHOICES[n - 1] : CHOICES.find((c) => c.id === answer);
    if (!choice) console.log(`  "${answer}" is not one of the choices.`);
  }

  let detail = null;
  if (choice.id === "custom") {
    detail = args.command;
    while (!detail) {
      detail = await ask("Judge command: ");
      if (detail === null) {
        console.log("No command given; nothing was written.");
        return 1;
      }
    }
  } else if (choice.id === "omp") {
    detail = args.model;
    if (!detail && !args.judge) detail = (await ask("OMP model [haiku]: ")) || null;
  }
  const command = choice.command(detail);
  console.log(`  Chosen: ${choice.label}${command ? `\n  Command: ${command}` : ""}`);

  console.log("\nStep 3 of 4: testing the judge with one call.");
  let failed = false;
  if (command === null) {
    // The shared file alone: resolveJudge would also read the profile as the kit's legacy
    // fallback, and that is the override this choice is about to remove.
    const { path: sharedPath, config: sharedConfig, malformed: sharedMalformed } = readSharedConfig();
    const sharedCommand = !sharedMalformed && typeof sharedConfig?.command === "string" && sharedConfig.command.trim() ? sharedConfig.command : null;
    if (sharedCommand) {
      console.log(`  No judge of its own, no test. The shared judge applies: ${JSON.stringify(sharedCommand)} from ${sharedPath}.`);
    } else {
      if (sharedMalformed) console.log(`  The shared judge file is malformed (${sharedMalformed}), so it supplies no judge until it is fixed.`);
      console.log(`  No judge, no test. ${JUDGE_RULES.join(", ")} stay off; each time one would have fired,`);
      console.log(`  skipped.log gets a line. Run this again any time to add a judge, or \`${SHARED_SETUP_COMMAND}\` for one every plugin shares.`);
    }
  } else {
    const result = await testJudge(command);
    const secs = (result.ms / 1000).toFixed(1);
    if (result.error) {
      failed = true;
      console.log(`  The judge did not work: ${failureText(result.error, result.detail)}. (${secs}s)`);
    } else {
      console.log(`  The judge answered in ${secs}s: violation=${result.violation}, "${result.reason}"`);
      if (result.violation) console.log("  Warning: that answer is wrong (the test message has no banana). A weak judge makes noisy checks.");
      if (result.ms > OMP_BUDGET_MS) {
        console.log(`  Warning: OMP gives a judge ${OMP_BUDGET_MS / 1000}s, so under OMP this one will time out and its checks`);
        console.log("  will be skipped. Claude Code gives 30s. A smaller model is faster.");
      }
    }
  }

  const next = { ...(profile ?? {}) };
  const enforcement = next.enforcement && typeof next.enforcement === "object" && !Array.isArray(next.enforcement) ? next.enforcement : {};
  next.enforcement = { ...enforcement, judgeCommand: command };

  console.log("\nStep 4 of 4: write the profile.");
  if (current === command) {
    console.log(`  ${path} already has this choice; nothing to write.`);
    return failed ? 1 : 0;
  }
  console.log(`  ${path} will contain:\n`);
  console.log(JSON.stringify(next, null, 2).replace(/^/gm, "    "));
  console.log(`\n  enforcement.judgeCommand: ${describe(current)}  ->  ${describe(command)}`);

  if (failed) {
    if (args.yes) {
      console.log("\n  The test call failed, so --yes does not write it. Nothing was written.");
      return 1;
    }
    const a = await ask("\nThe test call failed. Write it anyway? Type yes to write: ");
    if (a !== "yes") {
      console.log("Nothing was written. Fix the command, or choose another judge, and run this again.");
      return 1;
    }
  } else if (!args.yes) {
    const a = await ask("\nWrite this? Type yes to write: ");
    if (a !== "yes") {
      console.log("Nothing was written.");
      return 1;
    }
  }
  writeProfile(path, next);
  console.log(`\nWrote ${path}. The next session uses it; running sessions pick it up at their next stop.`);
  return 0;
}

function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (process.argv[1] && isEntryPoint()) {
  main().then((code) => process.exit(code));
}
