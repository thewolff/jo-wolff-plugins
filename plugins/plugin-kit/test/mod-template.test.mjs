// mod-template.test.mjs — templates/mod/register.mjs (README "Writing a mod") driven with a fake
// `on` and `$`: the lifecycle the engine runs (session.start, ui.render, session.end and the
// classic.SessionStart that follows /clear, /resume and /branch), and clip() at narrow widths.
// The engine itself is not here; `claude plugin test` needs a mod to load, and the kit has none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { KIT_ROOT } from "../scripts/new-plugin.mjs";

const TEMPLATE = join(KIT_ROOT, "templates", "mod", "register.mjs");
const PAYLOADS = {
  terminal: { surface: "terminal", isInteractive: true, cwd: "/work" },
  desktop: { surface: null, isInteractive: false, cwd: "/work" },
};

let loads = 0;
/** A fresh copy of the template (module state is per file), `{{name}}` filled with `demo`. */
async function load() {
  const dir = mkdtempSync(join(tmpdir(), "mod-template-"));
  const file = join(dir, `register-${loads++}.mjs`);
  writeFileSync(file, readFileSync(TEMPLATE, "utf8").replaceAll("{{name}}", "demo"));
  return import(pathToFileURL(file).href);
}

/** Registers the module against a fake engine; returns the engine and the fake `$`. */
async function engine(fileState) {
  const mod = await load();
  const hooks = [];
  const on = (event, filterOrFn, maybeFn) =>
    hooks.push(typeof filterOrFn === "function" ? { event, filter: {}, fn: filterOrFn } : { event, filter: filterOrFn, fn: maybeFn });
  const timers = [];
  const calls = { status: [], log: [] };
  const el = (type) => (props) => ({ type, props });
  const $ = {
    clock: { every: (ms, fn) => { const t = { ms, fn, active: true, cancel() { t.active = false; } }; timers.push(t); return t; } },
    env: { get: async (k) => (k === "HOME" ? "/home/demo" : undefined) },
    fs: { exists: async () => fileState.value !== null, read: async () => JSON.stringify(fileState.value) },
    ui: {
      status: (text) => calls.status.push(text),
      log: (text) => calls.log.push(text),
      invalidate: () => {},
      resolve: () => ({ Box: el("Box"), Text: el("Text"), Button: el("Button") }),
    },
  };
  mod.register(on, {});
  const matches = (filter, e) => Object.entries(filter).every(([k, v]) => (Array.isArray(v) ? v.includes(e[k]) : v === e[k]));
  const fire = async (event, e) => {
    const chain = hooks.filter((h) => h.event === event && matches(h.filter, e));
    const run = (i, ev) => (i < chain.length ? chain[i].fn($, ev, (next) => run(i + 1, next)) : Promise.resolve(ev.component ? null : ev));
    return run(0, e);
  };
  const render = (bodyColumns = 80) => fire("ui.render", { component: "AbovePrompt", surface: "terminal", props: { bodyColumns } });
  const active = () => timers.filter((t) => t.active);
  return { fire, render, active, calls, mod };
}

const texts = (node) => (node == null ? [] : typeof node === "string" ? [node] : Array.isArray(node) ? node.flatMap(texts) : texts(node.props?.children));

for (const [host, payload] of Object.entries(PAYLOADS)) {
  for (const source of ["clear", "resume", "fork"]) {
    test(`mod template re-initialises after ${source} (${host} payload): poll running, status and band fresh`, async () => {
      const fileState = { value: { headline: "Away", count: 3 } };
      const { fire, render, active, calls } = await engine(fileState);
      await fire("session.start", payload);
      assert.equal(active().length, 1, "one poll after session.start");
      assert.deepEqual(calls.status, ["Away · 3 held"], "the fallback line is pinned before any band");
      await render();
      assert.equal(calls.status.at(-1), undefined, "the first band clears the fallback line");

      await fire("session.end", { reason: source === "fork" ? "resume" : source });
      assert.equal(active().length, 0, "session.end cancels the poll");
      fileState.value = null; // the new conversation has nothing to say
      calls.status.length = 0;
      await fire("classic.SessionStart", { source });
      assert.equal(active().length, 1, `the poll runs again after ${source}`);
      assert.equal(await render(), null, "no stale band: the new conversation's state is empty");

      fileState.value = { headline: "Back", count: 1 };
      await fire("session.end", { reason: "clear" });
      await fire("classic.SessionStart", { source });
      assert.equal(calls.status.at(-1), "Back · 1 held", "bandDrawn reset: the fallback line is pinned again until the band is asked for");
      assert.equal(active().length, 1, "still exactly one poll");
      const band = await render();
      assert.ok(texts(band).some((t) => t.startsWith("Back")), "the band shows the new state");
      assert.equal(calls.status.at(-1), undefined, "and clears the fallback line again");
    });
  }
}

test("mod template ignores classic.SessionStart at startup and compact (state survives those)", async () => {
  const { fire, active } = await engine({ value: { headline: "Away", count: 3 } });
  await fire("session.start", PAYLOADS.desktop);
  await fire("classic.SessionStart", { source: "startup" });
  await fire("classic.SessionStart", { source: "compact" });
  assert.equal(active().length, 1, "no second poll");
});

test("mod template band never gets a negative width, cuts at a word, and keeps its hotkey visible", async () => {
  const full = "Away from keyboard since lunch · 12 held";
  const { fire, render } = await engine({ value: { headline: "Away from keyboard since lunch", count: 12 } });
  await fire("session.start", PAYLOADS.terminal);
  for (const cols of [0, 1, 5, 10, 16, 17, 20, 30, 80]) {
    const head = texts(await render(cols))[0] ?? "";
    assert.ok(head.length <= cols, `${cols} columns: headline ${JSON.stringify(head)} is ${head.length} long`);
    if (head.endsWith("…")) {
      const base = head.slice(0, -1);
      assert.ok(full.startsWith(base), `${cols}: ${JSON.stringify(head)} is not a prefix`);
      assert.ok(!base.includes(" ") || full[base.length] === " ", `${cols}: cut mid-word: ${JSON.stringify(head)}`);
    } else assert.ok(head === "" || head === full, `${cols}: ${JSON.stringify(head)}`);
  }
  const button = JSON.stringify(await render(80));
  assert.match(button, /"plain":true|"label":"[^"]*\bd\b/, "the dismiss button shows its hotkey in the terminal");
});
