#!/usr/bin/env node
// offer-scan.mjs — a one-off, run by hand, never by `node --test`. `node --test` runs every .mjs
// under test/, this file included, so it exits at once when NODE_TEST_CONTEXT is set (the
// variable the test runner gives each file it runs).
//
// Run by hand, it reads the top-level session transcripts `~/.claude/projects/*/*.jsonl` (not
// the subagent folders below them), takes as one reply the last assistant text before each typed
// or injected `user` entry and at the end of the file (what a Stop hook sees as
// last_assistant_message), runs lib/stop-rules.mjs offerSentences on it, and writes a Markdown
// report: files and replies read, replies with at least one offer (an upper bound on the offer
// check's bounces, since the scan cannot see which offers a ledger question recorded), bounces
// per 100 replies and per active day, counts per pattern, and 40 sample sentences.
//
//   node test/offer-scan.mjs --out <path> [--root <dir>]

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { OFFER_PATTERNS, offerSentences } from "../lib/stop-rules.mjs";

if (process.env.NODE_TEST_CONTEXT) process.exit(0);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** The text of an assistant entry, or "" when it has none (tool calls only). */
function textOf(entry) {
  const c = entry?.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

/** The replies of one transcript: `{ text, day }`, the last assistant text before each user entry. */
export function repliesOf(raw) {
  const out = [];
  let last = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "assistant") {
      const t = textOf(e);
      if (t.trim()) last = { text: t, day: String(e.timestamp ?? "").slice(0, 10) };
    } else if (e.type === "user" && last) {
      out.push(last);
      last = null;
    }
  }
  if (last) out.push(last);
  return out;
}

function main() {
  const outPath = arg("--out");
  if (!outPath) {
    console.error("usage: node test/offer-scan.mjs --out <path> [--root <dir>]");
    process.exit(2);
  }
  const root = arg("--root", join(homedir(), ".claude", "projects"));
  const files = [];
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) files.push(join(dir, f));
  }
  let replies = 0;
  let bouncing = 0;
  const days = new Set();
  const bounceDays = new Set();
  const perPattern = Object.fromEntries(OFFER_PATTERNS.map(([id]) => [id, 0]));
  const samples = Object.fromEntries(OFFER_PATTERNS.map(([id]) => [id, []]));
  let unreadable = 0;
  for (const f of files) {
    let raw;
    try {
      raw = readFileSync(f, "utf8");
    } catch {
      unreadable++;
      continue;
    }
    for (const r of repliesOf(raw)) {
      replies++;
      if (r.day) days.add(r.day);
      const offers = offerSentences(r.text);
      if (!offers.length) continue;
      bouncing++;
      if (r.day) bounceDays.add(r.day);
      for (const o of offers) {
        perPattern[o.pattern]++;
        if (samples[o.pattern].length < 40) samples[o.pattern].push(o.sentence.replace(/\s+/g, " ").slice(0, 200));
      }
    }
  }
  // 40 samples, round-robin across patterns so a rare pattern is still seen.
  const picked = [];
  for (let i = 0; picked.length < 40 && i < 40; i++) {
    for (const [id] of OFFER_PATTERNS) {
      if (picked.length >= 40) break;
      if (samples[id][i]) picked.push([id, samples[id][i]]);
    }
  }
  const per100 = replies ? ((bouncing / replies) * 100).toFixed(2) : "0";
  const perDay = days.size ? (bouncing / days.size).toFixed(2) : "0";
  const md = [
    `# Offer scan, ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Population: ${files.length} transcript files under \`${root}/*/*.jsonl\` (top level only; subagent transcripts in subfolders not read); ${unreadable} unreadable.`,
    "",
    "A reply is the last assistant text before each `user` entry and at the end of a file. A reply with at least one offer sentence is counted as one bounce; this is an upper bound, because the scan cannot see which offers a ledger question already recorded.",
    "",
    "| Measure | Value |",
    "| :- | -: |",
    `| files read | ${files.length - unreadable} |`,
    `| replies read | ${replies} |`,
    `| replies that would bounce | ${bouncing} |`,
    `| bounces per 100 replies | ${per100} |`,
    `| active days (a reply that day) | ${days.size} |`,
    `| days with a bounce | ${bounceDays.size} |`,
    `| bounces per active day | ${perDay} |`,
    "",
    "## Per pattern (offer sentences, a reply can hold several)",
    "",
    "| Pattern | Sentences |",
    "| :- | -: |",
    ...OFFER_PATTERNS.map(([id]) => `| ${id} | ${perPattern[id]} |`),
    "",
    "## 40 samples",
    "",
    ...picked.map(([id, s], i) => `${i + 1}. ${id}: ${s.replace(/\|/g, "\\|")}`),
    "",
  ].join("\n");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md);
  console.log(`wrote ${outPath}: files ${files.length}, replies ${replies}, bouncing ${bouncing}, per 100 replies ${per100}, active days ${days.size}, per active day ${perDay}`);
  console.log(`per pattern: ${OFFER_PATTERNS.map(([id]) => `${id} ${perPattern[id]}`).join(", ")}`);
}

main();
