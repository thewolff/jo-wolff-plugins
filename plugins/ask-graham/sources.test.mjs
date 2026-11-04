// The sources file is enforced, not remembered: the parser, the nudge lines, and the Stop check's
// sources proof on both transcript shapes. Every source here is invented; the plugin names none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSources, readSources, sourcesPath, withSources } from "./skills/ask-graham/scripts/sources.mjs";
import { NUDGE } from "./skills/ask-graham/scripts/intensity.mjs";
import { BLOCK_REASON, checkStop, localSearchBlock, sourcesBlockReason, sourcesMissing } from "./skills/ask-graham/scripts/verdict.mjs";
import { claudeCode, omp } from "./fixtures/transcripts.mjs";

const HOME = "/home/fixture";
const FILE = "/home/fixture/.config/ask-graham/sources.md";

const SOURCES_MD = [
  "# Where my open work lives",
  "",
  '- **Old tickets:** `todo-cli list -- "<the ask>"`',
  "- **Held decisions:** /tmp/fixture/HELD.md",
  "- **Planning notes:** `~/fixture-notes/*/PLAN.md`",
  "- **Team wiki:** ask in the team channel",
  "- no label on this one",
].join("\n");

const sources = (text = SOURCES_MD) => ({ path: FILE, ...parseSources(text) });

// --- parseSources ------------------------------------------------------------------------------

test("parseSources: command, bare path, backticked glob path, neither; an unlabelled item is skipped", () => {
  const { bullets, skipped } = parseSources(SOURCES_MD);
  assert.deepEqual(bullets.map((b) => [b.label, b.kind, b.value, b.prefix]), [
    ["Old tickets", "command", 'todo-cli list -- "<the ask>"', "todo-cli list"],
    ["Held decisions", "path", "/tmp/fixture/HELD.md", undefined],
    ["Planning notes", "path", "~/fixture-notes/*/PLAN.md", undefined],
    ["Team wiki", "none", null, undefined],
  ]);
  assert.equal(skipped, 1);
});

test("parseSources: a command beside a path wins; a runner second token takes three; a placeholder cuts the prefix", () => {
  const { bullets } = parseSources([
    "- **Both:** `fixture-db query` against `~/fixture/work.db`",
    "- **Wrapped:** `env node lookup.mjs --open`",
    "- **Plain node:** `node ~/fixture-bin/finder.mjs search \"<noun>\"`",
    "- **Short:** `fixture-find \"<noun>\" --all`",
    "- __Underscored__: `grep -ri fixture ~/fixture/notes`",
  ].join("\n"));
  assert.deepEqual(bullets.map((b) => [b.label, b.kind, b.prefix]), [
    ["Both", "command", "fixture-db query"],
    ["Wrapped", "command", "env node lookup.mjs"],
    ["Plain node", "command", "node ~/fixture-bin/finder.mjs"],
    ["Short", "command", "fixture-find"],
    ["Underscored", "command", "grep -ri"],
  ]);
});

test("parseSources: an indented line continues its item; items in a code fence do not count", () => {
  const { bullets } = parseSources([
    "- **Tracker:** the open items,",
    "  read with `fixture-tracker open --json`",
    "```markdown",
    "- **Example only:** `never-run this`",
    "```",
  ].join("\n"));
  assert.deepEqual(bullets.map((b) => [b.label, b.prefix]), [["Tracker", "fixture-tracker open"]]);
});

test("readSources: missing, unreadable or unlabelled file is null; a parseable one sits beside the user config", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ask-graham-sources-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: join(base, "config") };
  assert.equal(sourcesPath(env, base), join(base, "config", "ask-graham", "sources.md"));
  assert.equal(sourcesPath({ XDG_CONFIG_HOME: "relative" }, base), join(base, ".config", "ask-graham", "sources.md"));
  assert.equal(readSources({ env, home: base }), null);
  mkdirSync(join(base, "config", "ask-graham"), { recursive: true });
  mkdirSync(sourcesPath(env, base)); // a directory where the file should be: unreadable
  assert.equal(readSources({ env, home: base }), null);
  rmSync(sourcesPath(env, base), { recursive: true });
  writeFileSync(sourcesPath(env, base), "just prose, no list\n- an item with no label\n");
  assert.equal(readSources({ env, home: base }), null);
  writeFileSync(sourcesPath(env, base), SOURCES_MD);
  const s = readSources({ env, home: base });
  assert.equal(s.path, sourcesPath(env, base));
  assert.equal(s.bullets.length, 4);
});

test("withSources: one line per source with its label and its command or path verbatim; none adds nothing", () => {
  assert.equal(withSources(NUDGE, null), NUDGE);
  assert.equal(withSources(NUDGE, { bullets: [] }), NUDGE);
  assert.equal(withSources(NUDGE, sources()), [
    NUDGE,
    'ask-graham source: **Old tickets:** `todo-cli list -- "<the ask>"`',
    "ask-graham source: **Held decisions:** /tmp/fixture/HELD.md",
    "ask-graham source: **Planning notes:** `~/fixture-notes/*/PLAN.md`",
    "ask-graham source: **Team wiki:**",
  ].join("\n"));
});

// --- The reply's Local search block ------------------------------------------------------------

const LOCAL = [
  "**Local search:**",
  "- Old tickets: nothing found",
  "- **Held decisions:** found: HELD.md line 4 parks this",
  "- planning notes: unreachable (no such folder)",
  "- Team Wiki: nothing found",
].join("\n");

test("localSearchBlock: heading in any case, bold optional; fenced or quoted blocks do not count", () => {
  assert.equal(localSearchBlock("no block here"), null);
  assert.equal(localSearchBlock(LOCAL).length, 5);
  assert.ok(localSearchBlock("local search: Old tickets nothing found"));
  assert.equal(localSearchBlock("```\n" + LOCAL + "\n```"), null);
  assert.equal(localSearchBlock(LOCAL.replace(/^/gm, "> ")), null);
});

// --- checkStop with a sources file: both harnesses ------------------------------------------------

const VERDICT = "**Verdict:** later. Nothing gets worse while it waits.";

const HARNESS = {
  "Claude Code": {
    make: claudeCode,
    load: (t) => t.skill("ask-graham:ask-graham", "should we build a cache"),
    readFile: (t, p) => t.read(p),
    run: (t, cmd, failed = false) => t.tool("Bash", { command: cmd }, failed ? "exit 1" : "", failed),
    named: (t, p) => t.tool("Grep", { pattern: "cache", path: p }),
  },
  OMP: {
    make: omp,
    load: (t) => t.read("skill://ask-graham"),
    readFile: (t, p) => t.read(`${p}:1-40`),
    run: (t, cmd) => t.tool("eval", { language: "js", code: `await $\`${cmd}\`` }),
    named: (t, p) => t.tool("grep", { pattern: "cache", path: p }),
  },
};

for (const [name, h] of Object.entries(HARNESS)) {
  // A turn: prompt, skill load, then `work`, then the reply.
  const turn = (work, reply = `${LOCAL}\n\n${VERDICT}`) => {
    const t = h.make();
    const opener = t.prompt("should we build a cache?");
    h.load(t);
    work(t);
    t.say(reply);
    return { t, opener, check: (extra = {}) => checkStop({ entries: t.entries, sources: sources(), home: HOME, ...extra }) };
  };
  const allWork = (t) => {
    h.readFile(t, FILE);
    h.run(t, 'todo-cli   list -- "cache"');
    h.named(t, "/tmp/fixture/HELD.md");
    h.named(t, `${HOME}/fixture-notes/q3/PLAN.md`);
  };

  test(`${name}: a verdict reply with a sources file and no tool calls is blocked, naming the first missing source`, () => {
    const { t, opener, check } = turn(() => {}, VERDICT);
    const r = check();
    assert.equal(r.opener, opener);
    assert.match(r.block, /First missing: sources file: a Read of \/home\/fixture\/\.config\/ask-graham\/sources\.md \(\+4 more\)\./);
    assert.ok(r.block.length <= 300, r.block);
    // once per turn
    assert.deepEqual(check({ blockedOpener: opener }), { pass: "already-blocked", opener });
    // the same turn without a sources file is ff7aace's: the verdict passes
    assert.deepEqual(checkStop({ entries: t.entries }), { pass: "verdict", opener });
  });

  test(`${name}: every source run or read and the Local search block passes`, () => {
    const { opener, check } = turn(allWork);
    assert.deepEqual(check(), { pass: "verdict", opener });
  });

  test(`${name}: a waiting reply needs the same proof`, () => {
    const waiting = "**Ask:** a cache for the feeds API.\n\n**Gate questions** (Graham #1)\n- Why: speed.\n- How long lived: permanent.\n" +
      "- Already exists: local search pending.\n- In scope: yes.\n- Owner / maintenance: the asker.\n\n" +
      `${LOCAL}\n\nDo you want me to research and see if something comparable exists?`;
    assert.deepEqual(turn(allWork, waiting).check().pass, "comparables-question");
    assert.match(turn(() => {}, waiting).check().block, /First missing: sources file/);
  });

  test(`${name}: each missing piece is named in order`, () => {
    const cases = [
      [(t) => { allWork(t); }, VERDICT, /First missing: \*\*Local search:\*\*: a block in the reply\./],
      [(t) => { h.readFile(t, FILE); h.named(t, "/tmp/fixture/HELD.md"); h.named(t, `${HOME}/fixture-notes/a/PLAN.md`); }, undefined,
        /First missing: Old tickets: a Bash or eval call running `todo-cli list`\./],
      [(t) => { h.readFile(t, FILE); h.run(t, "todo-cli list"); h.named(t, `${HOME}/fixture-notes/a/PLAN.md`); }, undefined,
        /First missing: Held decisions: a tool call naming \/tmp\/fixture\/HELD\.md\./],
      [(t) => { h.readFile(t, FILE); h.run(t, "todo-cli list"); h.named(t, "/tmp/fixture/HELD.md"); }, undefined,
        /First missing: Planning notes: a tool call naming ~\/fixture-notes\/\*\/PLAN\.md\./],
      [allWork, `${LOCAL.replace(/^- Team Wiki.*$/m, "")}\n\n${VERDICT}`, /First missing: Team wiki: a \*\*Local search:\*\* line marking it\./],
    ];
    for (const [work, reply, reason] of cases) assert.match(turn(work, reply).check().block, reason);
  });

  test(`${name}: tool calls before the skill load do not count`, () => {
    const t = h.make();
    t.prompt("should we build a cache?");
    allWork(t);
    h.load(t);
    t.say(`${LOCAL}\n\n${VERDICT}`);
    assert.match(checkStop({ entries: t.entries, sources: sources(), home: HOME }).block, /First missing: sources file/);
  });

  test(`${name}: a Local search block inside a fence or a quote never counts`, () => {
    for (const block of ["```\n" + LOCAL + "\n```", LOCAL.replace(/^/gm, "> ")]) {
      assert.match(turn(allWork, `${block}\n\n${VERDICT}`).check().block, /First missing: \*\*Local search:\*\*/);
    }
  });

  test(`${name}: a structure check needs no sources proof`, () => {
    const t = h.make();
    const opener = t.prompt("add a chart table");
    if (name === "OMP") t.read("skill://ask-graham/structure-check.md");
    else t.skill("ask-graham:ask-graham", "structure-check a new chart table");
    t.say("**Structure check:** a new chart table\n**No similar:** searched migrations/.");
    assert.deepEqual(checkStop({ entries: t.entries, sources: sources(), home: HOME }), { pass: "structure-check", opener });
  });

  test(`${name}: a reply without a verdict still gets the verdict reason first`, () => {
    const { opener, check } = turn(() => {}, "Searched; nothing found.");
    assert.deepEqual(check(), { block: BLOCK_REASON, opener });
  });

  // Without a run of `todo-cli list`: every other source run or read.
  const allButTickets = (t) => {
    h.readFile(t, FILE);
    h.named(t, "/tmp/fixture/HELD.md");
    h.named(t, `${HOME}/fixture-notes/q3/PLAN.md`);
  };
  const ticketsLine = (result) => `${LOCAL.replace(/^- Old tickets:.*$/m, `- Old tickets: ${result}`)}\n\n${VERDICT}`;

  test(`${name}: a source skipped because its command writes, or because research was declined, passes unrun`, () => {
    for (const result of [
      "unreachable (listed command writes a file; skipped as required)",
      "**unreachable**: remote-only, research declined (user said no)",
    ]) {
      const { opener, check } = turn(allButTickets, ticketsLine(result));
      assert.deepEqual(check(), { pass: "verdict", opener }, result);
    }
  });

  test(`${name}: unreachable with no policy reason on a runnable source still needs the run`, () => {
    for (const result of ["unreachable", "unreachable (cannot write lockfile)", "nothing found; the command writes nothing"]) {
      assert.match(turn(allButTickets, ticketsLine(result)).check().block,
        /First missing: Old tickets: a Bash or eval call running `todo-cli list`\./, result);
    }
  });
}

test("Claude Code: a command that exited non-zero counts as run", () => {
  const t = claudeCode();
  const opener = t.prompt("should we build a cache?");
  t.skill("ask-graham:ask-graham");
  t.read(FILE);
  t.tool("Bash", { command: "todo-cli list -- cache" }, "todo-cli: no such store", true);
  t.tool("Read", { file_path: "/tmp/fixture/HELD.md" });
  t.bash("ls ~/fixture-notes/*/PLAN.md");
  t.say(`${LOCAL}\n\n${VERDICT}`);
  assert.deepEqual(checkStop({ entries: t.entries, sources: sources(), home: HOME }), { pass: "verdict", opener });
});

test("Claude Code: the sources file read as ~ or $HOME, and a source run in a parallel call, count", () => {
  const t = claudeCode();
  const opener = t.prompt("should we build a cache?");
  t.skill("ask-graham:ask-graham");
  t.read("~/.config/ask-graham/sources.md");
  t.parallel({ name: "Bash", input: { command: "todo-cli list -- cache" } }, { name: "Bash", input: { command: "cat $HOME/fixture-notes/x/PLAN.md /tmp/fixture/HELD.md" } });
  t.say(`${LOCAL}\n\n${VERDICT}`);
  assert.deepEqual(checkStop({ entries: t.entries, sources: sources(), home: HOME }), { pass: "verdict", opener });
});

test("OMP: bash and pair_run commands count as runs", () => {
  for (const tool of ["bash", "pair_run"]) {
    const t = omp();
    const opener = t.prompt("should we build a cache?");
    t.read("skill://ask-graham");
    t.read(FILE);
    t.tool(tool, { command: "todo-cli list -- cache && cat /tmp/fixture/HELD.md ~/fixture-notes/b/PLAN.md" });
    t.say(`${LOCAL}\n\n${VERDICT}`);
    assert.deepEqual(checkStop({ entries: t.entries, sources: sources(), home: HOME }), { pass: "verdict", opener }, tool);
  }
});

test("sourcesMissing: a fenced command in the reply is not a run; an unlabelled item is never required", () => {
  const s = sources();
  const reply = "```sh\ntodo-cli list -- cache\n```\n" + LOCAL;
  assert.deepEqual(sourcesMissing({ calls: [{ name: "Read", input: { file_path: FILE } }], reply, sources: s, home: HOME }).map((m) => m.label),
    ["Old tickets", "Held decisions", "Planning notes"]);
});

test("sourcesMissing: a result line proves only the source whose whole label it carries", () => {
  const s = sources("- **Decisions:** ask the owner\n- **Held decisions:** ask the owner");
  const calls = [{ name: "Read", input: { file_path: FILE } }];
  const missing = (reply) => sourcesMissing({ calls, reply, sources: s, home: HOME }).map((m) => m.label);
  assert.deepEqual(missing("**Local search:**\n- Held decisions: nothing found"), ["Decisions"]);
  assert.deepEqual(missing("**Local search:**\n- **Decisions:** found: D-4\n- held  Decisions: nothing found"), []);
});

test("sourcesMissing: a status word inside a label is not the status", () => {
  const s = sources("- **Found items:** ask the owner\n- **Unreachable hosts:** ask ops");
  const calls = [{ name: "Read", input: { file_path: FILE } }];
  const missing = (reply) => sourcesMissing({ calls, reply, sources: s, home: HOME }).map((m) => m.label);
  assert.deepEqual(missing("**Local search:**\n- Found items: checked\n- **Unreachable hosts:** looked"), ["Found items", "Unreachable hosts"]);
  assert.deepEqual(missing("**Local search:**\n- Found items: nothing found\n- Unreachable hosts: unreachable (no VPN)"), []);
});

test("sourcesBlockReason: stays within 300 characters with a long label and command", () => {
  const long = [{ label: "L".repeat(200), expected: `a Bash or eval call running \`${"x ".repeat(200)}\`` }, { label: "b", expected: "c" }];
  const reason = sourcesBlockReason(long);
  assert.ok(reason.length <= 300, String(reason.length));
  assert.match(reason, /\(\+1 more\)\./);
});

test("SKILL.md and README state the Local search block and when it is enforced", async () => {
  const { readFileSync } = await import("node:fs");
  const skill = readFileSync(new URL("./skills/ask-graham/SKILL.md", import.meta.url), "utf8");
  assert.equal(skill.match(/^\*\*Local search:\*\*$/gm)?.length, 2, "both Output templates carry the block");
  assert.match(skill, /The Stop check enforces all of this when the file exists, on both harnesses/);
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  assert.match(readme, /The Local search block is enforced only\nwhen a sources file exists/);
});
