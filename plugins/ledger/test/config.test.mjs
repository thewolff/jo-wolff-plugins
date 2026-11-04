import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, loadConfig, leafKeys, describeConfig, PROJECT_FILE } from "../lib/config.mjs";
import { sandbox, cli, PLUGIN_ROOT } from "./helpers.mjs";

const box = sandbox();

test("clean env + HOME in a temp dir → db under <HOME>/.local/share/ledger, every key source default, hooks off", () => {
  const env = { HOME: box.home };
  const r = loadConfig({ env, home: box.home, cwd: box.work });
  assert.equal(r.config.db, join(box.home, ".local", "share", "ledger", "ledger.db"));
  assert.equal(r.config.enabled, false);
  for (const k of leafKeys()) assert.equal(r.sources[k], "default", k);
  assert.deepEqual(r.notices, []);
  assert.equal(r.projectPath, null);
});

test("LEDGER_DB wins over the user file's db", () => {
  box.writeConfig({ db: "/from/file.db" });
  const r = loadConfig({ env: { ...box.env, LEDGER_DB: "/from/env.db" }, home: box.home });
  assert.equal(r.config.db, "/from/env.db");
  assert.equal(r.sources.db, "env");
  const r2 = loadConfig({ env: { ...box.env, LEDGER_DB: "" }, home: box.home });
  assert.equal(r2.config.db, "/from/file.db");
  assert.equal(r2.sources.db, "user file");
});

test("resolution order: env > project file > user file > default, per key", () => {
  const b = sandbox();
  b.writeConfig({ inject: { notes: 2 }, hooks: { stop: false }, timezone: "Europe/Berlin" });
  writeFileSync(join(b.work, PROJECT_FILE), JSON.stringify({ enabled: true, inject: { notes: 9 } }));
  const r = loadConfig({ env: { HOME: b.home, XDG_CONFIG_HOME: join(b.root, "config"), LEDGER_ENABLED: "false" }, home: b.home, cwd: b.work });
  assert.equal(r.config.enabled, false);
  assert.equal(r.sources.enabled, "env");
  assert.equal(r.config.inject.notes, 9);
  assert.equal(r.sources["inject.notes"], "project file");
  assert.equal(r.config.hooks.stop, false);
  assert.equal(r.sources["hooks.stop"], "user file");
  assert.equal(r.config.timezone, "Europe/Berlin");
  assert.equal(r.sources["hooks.preToolUse"], "default");
  assert.equal(r.projectPath, join(b.work, PROJECT_FILE));
});

test("a user config file containing `{` → defaults plus one notice naming the path", () => {
  box.writeConfig("{");
  const r = loadConfig({ env: { ...box.env, LEDGER_DB: "" }, home: box.home });
  assert.equal(r.config.inject.notes, DEFAULTS.inject.notes);
  assert.equal(r.notices.length, 1);
  assert.match(r.notices[0], /^ledger: config .*config\.json ignored: /);
  assert.ok(r.notices[0].includes(box.configPath));
});

test("fail-open table: wrong-type value → default for that key, one notice; other keys from the file still apply", () => {
  box.writeConfig({ inject: { notes: "five" }, hooks: { stop: false }, forcing: { stopAskRule: "no" } });
  const r = loadConfig({ env: { ...box.env, LEDGER_DB: "" }, home: box.home });
  assert.equal(r.config.inject.notes, DEFAULTS.inject.notes);
  assert.equal(r.config.hooks.stop, false);
  assert.equal(r.config.forcing.stopAskRule, true);
  assert.equal(r.sources["hooks.stop"], "user file");
  assert.equal(r.notices.length, 2);
  assert.match(r.notices[0], /forcing\.stopAskRule must be boolean/);
  assert.match(r.notices[1], /inject\.notes must be integer/);
});

test("fail-open table: unknown config key is ignored silently", () => {
  box.writeConfig({ somethingNew: 1, hooks: { futureHook: true, stop: false } });
  const r = loadConfig({ env: { ...box.env, LEDGER_DB: "" }, home: box.home });
  assert.deepEqual(r.notices, []);
  assert.equal(r.config.hooks.stop, false);
});

test("XDG_CONFIG_HOME counts only when absolute", () => {
  box.writeConfig({ inject: { notes: 3 } });
  const rel = loadConfig({ env: { XDG_CONFIG_HOME: "relative/dir", HOME: box.home }, home: box.home });
  assert.equal(rel.path, join(box.home, ".config", "ledger", "config.json"));
  const abs = loadConfig({ env: { XDG_CONFIG_HOME: join(box.root, "config"), HOME: box.home }, home: box.home });
  assert.equal(abs.config.inject.notes, 3);
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

test("ledger config prints every leaf key with its source, the two file paths and shared/own; zero-config proof via the CLI", () => {
  const r = cli(box, ["config"], { env: { XDG_CONFIG_HOME: join(box.root, "nowhere"), LEDGER_DB: "", LEDGER_ENABLED: "" } });
  assert.equal(r.code, 0, r.err);
  for (const k of leafKeys()) assert.ok(r.out.includes(`${k} = `), k);
  assert.ok(r.out.includes(`db = ${JSON.stringify(join(box.home, ".local", "share", "ledger", "ledger.db"))}  (source: default)`), r.out);
  assert.equal((r.out.match(/\(source: default\)/g) ?? []).length, leafKeys().length);
  assert.match(r.out, /^user config file: .*nowhere\/ledger\/config\.json$/m);
  assert.match(r.out, new RegExp(`^project config file: none \\(no ${PROJECT_FILE} here or above\\)$`, "m"));
  assert.match(r.out, /^database: .*ledger\.db \(own file: only the plugin's cc_ tables\)$/m);
  assert.equal(describeConfig(loadConfig({ env: { HOME: box.home }, home: box.home })).split("\n").length, leafKeys().length + 2);
});
