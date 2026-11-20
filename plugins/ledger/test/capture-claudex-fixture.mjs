#!/usr/bin/env node
// capture-claudex-fixture.mjs — a one-off, run by hand, never by `node --test` (it exits at once
// when NODE_TEST_CONTEXT is set). For each variant it builds the deterministic repository in
// claudex-repo.mjs, runs the real claudex-loop runner's snapshot() on its uncommitted change
// through python3, and saves the result as test/fixtures/claudex/snapshot.<variant>.json. The
// tests rebuild the same repository, commit the change, and check that ledger's snapshot of HEAD
// equals the one the real runner wrote.
//
//   node test/capture-claudex-fixture.mjs <path to claudex-loop's scripts/runner.py>

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildRepo } from "./claudex-repo.mjs";

if (process.env.NODE_TEST_CONTEXT) process.exit(0);

const runner = process.argv[2];
if (!runner) {
  console.error("usage: node test/capture-claudex-fixture.mjs <runner.py>");
  process.exit(2);
}
// Resolve the real interpreter with the caller's environment: a version-manager shim (asdf, pyenv)
// needs the real HOME, and the repository below runs with an empty one.
const probe = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
if (probe.status !== 0) throw new Error(`python3 not runnable: ${probe.stderr || probe.error}`);
const python = probe.stdout.trim();
const out = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "claudex");
mkdirSync(out, { recursive: true });
// Both snapshots are captured before either fixture is replaced, so a failure leaves them untouched.
const captured = [];
for (const variant of ["staged", "untracked"]) {
  const root = mkdtempSync(join(tmpdir(), "claudex-fixture-"));
  try {
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(home);
    mkdirSync(repo);
    const env = { PATH: process.env.PATH, HOME: home, LANG: "C" };
    const base = buildRepo(repo, env, variant);
    const py = [
      "import json, sys",
      "from pathlib import Path",
      "sys.path.insert(0, str(Path(sys.argv[1]).parent))",
      "import runner",
      "print(json.dumps(runner.snapshot(Path(sys.argv[2]), sys.argv[3]), indent=2))",
    ].join("\n");
    const r = spawnSync(python, ["-I", "-c", py, runner, repo, base], { encoding: "utf8", env: { ...env, GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.status !== 0) throw new Error(`snapshot failed (${r.status}): ${r.stderr || r.error}`);
    captured.push({ variant, base, json: r.stdout });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
for (const { variant, base, json } of captured) {
  writeFileSync(join(out, `snapshot.${variant}.json`), json);
  console.log(`saved snapshot.${variant}.json (base ${base.slice(0, 8)})`);
}
