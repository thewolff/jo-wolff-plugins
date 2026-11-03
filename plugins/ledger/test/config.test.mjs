import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, loadConfig, leafKeys, describeConfig } from "../lib/config.mjs";
import { sandbox, cli, PLUGIN_ROOT } from "./helpers.mjs";

const box = sandbox();

test("step 2 (e): clean env + HOME in a temp dir → db under <HOME>/.local/share/ledger, every key source default", () => {
  const env = { HOME: box.home };
  const r = loadConfig({ env, home: box.home });
  assert.equal(r.config.db, join(box.home, ".local", "share", "ledger", "ledger.db"));
  for (const k of leafKeys()) assert.equal(r.sources[k], "default", k);
  assert.deepEqual(r.notices, []);
});

test("step 2 (d): LEDGER_DB wins over the config file's db", () => {
  box.writeConfig({ db: "/from/file.db" });
  const r = loadConfig({ env: { ...box.env, LEDGER_DB: "/from/env.db" }, home: box.home });
  assert.equal(r.config.db, "/from/env.db");
  assert.equal(r.sources.db, "env");
  const r2 = loadConfig({ env: { ...box.env, LEDGER_DB: "" }, home: box.home });
  assert.equal(r2.config.db, "/from/file.db");
  assert.equal(r2.sources.db, "file");
});

test("step 2 (c): a config file containing `{` → defaults plus one notice naming the path", () => {
  box.writeConfig("{");
  const r = loadConfig({ env: { ...box.env, LEDGER_DB: "" }, home: box.home });
  assert.equal(r.config.stale.days, DEFAULTS.stale.days);
  assert.equal(r.notices.length, 1);
  assert.match(r.notices[0], /^ledger: config .*config\.json ignored: /);
  assert.ok(r.notices[0].includes(box.configPath));
});

test("fail-open table: wrong-type value → default for that key, one notice; other keys from the file still apply", () => {
  box.writeConfig({ stale: { days: "seven" }, inject: { decisions: 2 }, forcing: { denyPush: "no" } });
  const r = loadConfig({ env: { ...box.env, LEDGER_DB: "" }, home: box.home });
  assert.equal(r.config.stale.days, 7);
  assert.equal(r.config.inject.decisions, 2);
  assert.equal(r.config.forcing.denyPush, true);
  assert.equal(r.sources["inject.decisions"], "file");
  assert.equal(r.notices.length, 2);
  assert.match(r.notices[0], /forcing\.denyPush must be boolean/);
  assert.match(r.notices[1], /stale\.days must be integer/);
});

test("fail-open table: unknown config key is ignored silently", () => {
  box.writeConfig({ somethingNew: 1, hooks: { futureHook: true, stop: false } });
  const r = loadConfig({ env: { ...box.env, LEDGER_DB: "" }, home: box.home });
  assert.deepEqual(r.notices, []);
  assert.equal(r.config.hooks.stop, false);
});

test("XDG_CONFIG_HOME counts only when absolute", () => {
  box.writeConfig({ stale: { days: 3 } });
  const rel = loadConfig({ env: { XDG_CONFIG_HOME: "relative/dir", HOME: box.home }, home: box.home });
  assert.equal(rel.path, join(box.home, ".config", "ledger", "config.json"));
  const abs = loadConfig({ env: { XDG_CONFIG_HOME: join(box.root, "config"), HOME: box.home }, home: box.home });
  assert.equal(abs.config.stale.days, 3);
});

test("~ in a configured db path expands against HOME", () => {
  box.writeConfig({ db: "~/elsewhere/l.db" });
  const r = loadConfig({ env: { ...box.env, LEDGER_DB: "" }, home: box.home });
  assert.equal(r.config.db, join(box.home, "elsewhere", "l.db"));
});

test("example.config.json is the DEFAULTS object verbatim", () => {
  const shipped = JSON.parse(readFileSync(join(PLUGIN_ROOT, "example.config.json"), "utf8"));
  assert.deepEqual(shipped, structuredClone(DEFAULTS));
});

test("ledger config prints every leaf key with its source; zero-config proof via the CLI", () => {
  const r = cli(box, ["config"], { env: { XDG_CONFIG_HOME: join(box.root, "nowhere"), LEDGER_DB: "" } });
  assert.equal(r.code, 0, r.err);
  for (const k of leafKeys()) assert.ok(r.out.includes(`${k} = `), k);
  assert.ok(r.out.includes(`db = ${JSON.stringify(join(box.home, ".local", "share", "ledger", "ledger.db"))}  (source: default)`), r.out);
  assert.equal((r.out.match(/\(source: default\)/g) ?? []).length, leafKeys().length);
  assert.equal(describeConfig(loadConfig({ env: { HOME: box.home }, home: box.home })).split("\n").length, leafKeys().length + 1);
});
