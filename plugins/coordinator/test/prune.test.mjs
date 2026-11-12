import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/prune.mjs", import.meta.url));

function run(state) {
  return spawnSync(process.execPath, [SCRIPT, "--days", "30"], { env: { PATH: process.env.PATH, HOME: state.home, XDG_STATE_HOME: state.xdg }, encoding: "utf8" });
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "coordinator-prune-"));
  const xdg = join(root, "state");
  mkdirSync(join(xdg, "coordinator"), { recursive: true });
  return { root, xdg, home: join(root, "home"), dir: join(xdg, "coordinator") };
}

test("an unreadable state directory is named on stderr with its error, and the exit stays 0", () => {
  const s = sandbox();
  writeFileSync(join(s.dir, "a.log"), "x");
  chmodSync(s.dir, 0o000);
  try {
    const r = run(s);
    assert.equal(r.status, 0);
    assert.ok(r.stderr.includes(`prune: could not read ${s.dir}: `), r.stderr);
    assert.match(r.stderr, /EACCES/);
  } finally {
    chmodSync(s.dir, 0o755);
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("an unreadable subdirectory is named on stderr and the rest is still pruned", () => {
  const s = sandbox();
  const sub = join(s.dir, "sub");
  mkdirSync(sub);
  chmodSync(sub, 0o000);
  try {
    const r = run(s);
    assert.equal(r.status, 0);
    assert.ok(r.stderr.includes(`prune: could not read ${sub}: `), r.stderr);
    assert.match(r.stdout, /^pruned: 0 file\(s\)/m);
  } finally {
    chmodSync(sub, 0o755);
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a missing state directory is silent", () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-prune-"));
  try {
    const r = run({ home: join(root, "home"), xdg: join(root, "none") });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^pruned: 0 file\(s\), 0 bytes freed; kept 0$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
