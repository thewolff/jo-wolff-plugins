// sibling-state.test.mjs — node --test, run from plugins/paired-coding/.
//
// The one list of sibling-plugin state every sandbox lets pair_run write, over a fake home,
// environment and config files, so these run anywhere and touch no real config.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PATTERN_CHECK_DIR, siblingState } from "./sibling-state.mjs";

const HOME = "/Users/example";
const ROOT = "/Users/example/code/repo";

/** A fake filesystem of config files: path -> text (a non-string is a read error). */
function files(map = {}) {
  return {
    readFile: (p) => {
      if (!(p in map) || typeof map[p] !== "string") throw new Error("ENOENT");
      return map[p];
    },
    exists: (p) => p in map,
  };
}

const sidecars = (db) => [db, `${db}-wal`, `${db}-shm`];

describe("siblingState", () => {
  test("a fresh machine: the measured ledger layout, the ledger's default, the receipt directory and the two state directories", () => {
    const s = siblingState({ root: ROOT, env: {}, home: HOME, ...files() });
    assert.deepEqual(s, {
      files: [...sidecars(`${HOME}/.agent-system-2/ledger.db`), ...sidecars(`${HOME}/.local/share/ledger/ledger.db`)],
      dirs: [`${ROOT}/${PATTERN_CHECK_DIR}`, `${HOME}/.local/state/ledger`, `${HOME}/.local/state/pattern-check`],
    });
  });

  test("the XDG variables move the default database and the state directories when absolute, and not otherwise", () => {
    const env = { XDG_DATA_HOME: "/data", XDG_STATE_HOME: "/st", XDG_CONFIG_HOME: "/cfg" };
    const s = siblingState({ root: ROOT, env, home: HOME, ...files() });
    assert.ok(s.files.includes("/data/ledger/ledger.db"));
    assert.deepEqual(s.dirs, [`${ROOT}/.pattern-check`, "/st/ledger", "/st/pattern-check"]);
    const rel = siblingState({ root: ROOT, env: { XDG_DATA_HOME: "data", XDG_STATE_HOME: "st" }, home: HOME, ...files() });
    assert.ok(rel.files.includes(`${HOME}/.local/share/ledger/ledger.db`));
    assert.deepEqual(rel.dirs, [`${ROOT}/.pattern-check`, `${HOME}/.local/state/ledger`, `${HOME}/.local/state/pattern-check`]);
  });

  test("LEDGER_DB adds its database with sidecars; a relative one is ignored; ~ is expanded", () => {
    assert.ok(siblingState({ root: ROOT, env: { LEDGER_DB: "/srv/l.db" }, home: HOME, ...files() }).files.includes("/srv/l.db-shm"));
    assert.equal(siblingState({ root: ROOT, env: { LEDGER_DB: "rel/l.db" }, home: HOME, ...files() }).files.some((f) => f.includes("rel")), false);
    assert.ok(siblingState({ root: ROOT, env: { LEDGER_DB: "~/l.db" }, home: HOME, ...files() }).files.includes(`${HOME}/l.db`));
  });

  test("the user config file's db is read from LEDGER_CONFIG or the XDG config path; anything unreadable, not JSON or without a string db adds nothing", () => {
    const at = `${HOME}/.config/ledger/config.json`;
    const good = siblingState({ root: ROOT, env: {}, home: HOME, ...files({ [at]: '{"db":"/Users/example/.agent-system-2/ledger.db","enabled":true}' }) });
    assert.equal(good.files.filter((f) => f === `${HOME}/.agent-system-2/ledger.db`).length, 1, "no duplicate");
    const other = siblingState({ root: ROOT, env: {}, home: HOME, ...files({ [at]: '{"db":"~/elsewhere/l.db"}' }) });
    assert.ok(other.files.includes(`${HOME}/elsewhere/l.db-wal`));
    const named = siblingState({ root: ROOT, env: { LEDGER_CONFIG: "/etc/ledger.json" }, home: HOME, ...files({ "/etc/ledger.json": '{"db":"/var/l.db"}', [at]: '{"db":"/ignored.db"}' }) });
    assert.ok(named.files.includes("/var/l.db"));
    assert.equal(named.files.includes("/ignored.db"), false);
    for (const text of ["{not json", '{"db":5}', '{"db":""}', "[]", "null", 42]) {
      const s = siblingState({ root: ROOT, env: {}, home: HOME, ...files({ [at]: text }) });
      assert.equal(s.files.length, 6, String(text));
    }
  });

  test("the nearest .ledger.json at or above the worktree contributes its db", () => {
    const s = siblingState({ root: ROOT, env: {}, home: HOME, ...files({ "/Users/example/code/.ledger.json": '{"db":"/Users/example/code/shared.db"}' }) });
    assert.ok(s.files.includes("/Users/example/code/shared.db"));
    const nearer = siblingState({ root: ROOT, env: {}, home: HOME, ...files({ "/Users/example/code/.ledger.json": '{"db":"/far.db"}', [`${ROOT}/.ledger.json`]: '{"db":"/near.db"}' }) });
    assert.ok(nearer.files.includes("/near.db"));
    assert.equal(nearer.files.includes("/far.db"), false);
  });

  test("every path is absolute, and the list has no duplicates", () => {
    const s = siblingState({ root: ROOT, env: { LEDGER_DB: `${HOME}/.agent-system-2/ledger.db` }, home: HOME, ...files() });
    for (const p of [...s.files, ...s.dirs]) assert.ok(p.startsWith("/"), p);
    assert.equal(new Set(s.files).size, s.files.length);
    assert.equal(new Set(s.dirs).size, s.dirs.length);
  });
});
