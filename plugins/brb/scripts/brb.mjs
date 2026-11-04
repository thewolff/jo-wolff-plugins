#!/usr/bin/env node
// scripts/brb.mjs — the command the agent runs while Jo is away. One verb:
//
//   node scripts/brb.mjs hold [--session <id>] "<one item, readable on its own>"
//
// Appends the item to the session's digest (the same digest.md the Stop hook writes) and bumps
// the held count; prints `held N`. The item is deduplicated by the Stop hook's own rule
// (lib/sections.mjs normalizeLine against away.json `seen`), so an item held here and restated
// under `## Needs you` lands once, and holding the same item twice prints `held N` with the
// count unchanged. Not away (no away.json for the session) → prints `not away; say it to Jo`,
// writes nothing, exits 0: the agent asks in its reply as usual.
//
// The session: --session <id> (the away instruction renders the command with it), else
// BRB_SESSION_ID, else CLAUDE_CODE_SESSION_ID, else the one session under the state directory
// that is away; several away and no id → `several holds are away; pass --session <id>` on
// stderr listing them, exit 1 (an item filed under the wrong hold is worse than a retry). The
// state directory is ${XDG_STATE_HOME:-~/.local/state}/brb, as for the hooks.
//
// How it fails: no item text or an unknown verb → usage on stderr, exit 1. A state directory
// that cannot be written → the error on stderr, exit 1, nothing held; the agent sees the exit
// and keeps the ask in its reply, where the Stop hook's backstop files it.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { invokedDirectly } from "../lib/hook-runner.mjs";
import { normalizeLine } from "../lib/sections.mjs";
import { appendDigest, readAway, stateRoot, withAwayLock, writeAway } from "../lib/state.mjs";

const SEEN_CAP = 500;
const USAGE = 'usage: brb.mjs hold [--session <id>] "<one item, readable on its own>"';

/**
 * Hold one item for the session. `{ status: "held", held, added }` with the count after (added
 * false when the item was already held), or `{ status: "home" }` when the session is not away.
 * The write happens under the session lock (lib/state.mjs withAwayLock) after a re-read: a
 * `back` that ended the hold, or a new `brb` that replaced it, after the first read is
 * `{ status: "home" }` with nothing written, never an append to a returned hold.
 */
export function hold(sessionId, text, { env = process.env, now = () => new Date().toISOString() } = {}) {
  const first = readAway(sessionId, env);
  if (!first) return { status: "home" };
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  const key = normalizeLine(line);
  if (!key) throw new Error("the item is empty");
  if (first.seen.includes(key)) return { status: "held", held: first.held, added: false };
  const at = now();
  return withAwayLock(sessionId, env, () => {
    const away = readAway(sessionId, env);
    if (!away || away.since !== first.since) return { status: "home" };
    if (away.seen.includes(key)) return { status: "held", held: away.held, added: false };
    appendDigest(sessionId, { at, lines: [line] }, env);
    away.seen = [...away.seen, key].slice(-SEEN_CAP);
    away.held += 1;
    writeAway(sessionId, away, env);
    return { status: "held", held: away.held, added: true };
  });
}

/** The session ids under the state root that are away (have an away.json). */
export function awaySessions(env = process.env) {
  const root = stateRoot(env);
  let names;
  try {
    names = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return names.filter((e) => e.isDirectory() && existsSync(join(root, e.name, "away.json"))).map((e) => e.name);
}

/** `{ session }` from the flag, the env or the one away session; `{ error }` when several are away and none was named. */
export function resolveSession(flag, env = process.env) {
  for (const candidate of [flag, env.BRB_SESSION_ID, env.CLAUDE_CODE_SESSION_ID]) {
    if (typeof candidate === "string" && candidate.trim()) return { session: candidate.trim() };
  }
  const away = awaySessions(env);
  if (away.length === 1) return { session: away[0] };
  if (away.length === 0) return { session: "" };
  return { error: `several holds are away (${away.join(", ")}); pass --session <id>` };
}

/** Parse argv after the verb: `{ session, text }` or `{ error }`. Positional words join with one space; `--` ends the flags. */
export function parseHoldArgs(argv) {
  let session = null;
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "--") {
      words.push(...argv.slice(i + 1).map(String));
      break;
    }
    if (a === "--session") {
      if (argv[i + 1] === undefined) return { error: "--session needs an id" };
      session = String(argv[++i]);
    } else if (a.startsWith("--session=")) session = a.slice("--session=".length);
    else words.push(a);
  }
  const text = words.join(" ").trim();
  if (!text) return { error: "no item text" };
  return { session, text };
}

export function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [verb, ...rest] = argv;
  if (verb !== "hold") {
    stderr.write(`${USAGE}\n`);
    return 1;
  }
  const args = parseHoldArgs(rest);
  if (args.error) {
    stderr.write(`${args.error}\n${USAGE}\n`);
    return 1;
  }
  const where = resolveSession(args.session, env);
  if (where.error) {
    stderr.write(`${where.error}\n`);
    return 1;
  }
  let r;
  try {
    r = hold(where.session, args.text, { env });
  } catch (err) {
    stderr.write(`brb hold: could not write the digest (${err instanceof Error ? err.message : String(err)}); say it to Jo\n`);
    return 1;
  }
  if (r.status === "home") {
    stdout.write("not away; say it to Jo\n");
    return 0;
  }
  stdout.write(`held ${r.held}\n`);
  return 0;
}

if (invokedDirectly(import.meta.url)) process.exitCode = main(process.argv.slice(2));
