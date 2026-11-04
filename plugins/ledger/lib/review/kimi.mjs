// kimi.mjs — review through the Kimi Code CLI. `kimi --help` documents `-p, --prompt <prompt>`
// ("Run one prompt non-interactively and print the response") and says nothing about stdin, so the
// prompt and the diff travel in the `-p` argument. A diff larger than MAX_ARG_BYTES would overrun
// the OS argument limit and is reported as unavailable instead.
//
// Tool-free: `-p` runs under Kimi's `auto` permission policy, and an agent file discovered in the
// repository may replace the default agent and keep every tool. So the review runs with
// `--agent-file` pointing at REVIEWER_AGENT, written to the scratch folder: an explicit agent file
// outranks every discovered one, and its `tools: []` disables all tools (enforced again before
// execution) and `subagents: []` all delegation. `--skills-dir` names an empty folder, replacing
// skill discovery. The scratch folder is the working directory, so no project scope is found.
//
// Output: `--output-format stream-json`, one JSON object per line. Assistant text arrives as
// `{"role":"assistant","content":"…"}`; a tool call as an assistant line with `tool_calls`; plus
// `{"role":"meta",…}` and `{"role":"tool",…}` lines. The reply is the last assistant line's content.
// (The text format prefixes assistant text with `• ` and indents wrapped lines, which the reply
// parser would misread.) A tool call means the containment failed, and the review is unavailable.
//
// Model: `review.models.kimi` (passed as `-m`), else Kimi's configured default (recorded as null).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { binFor, parseReply, PROMPT, reviewerEnv, runProcess, withScratch } from "./common.mjs";

export const lab = "kimi";
export const defaultBin = "kimi";
export const envKeys = Object.freeze(["KIMI_*", "MOONSHOT_*"]);
export const MAX_ARG_BYTES = 200_000;

export const REVIEWER_AGENT = [
  "---",
  "name: ledger-reviewer",
  "description: Reviews the unified diff in the prompt and replies with findings; has no tools.",
  "tools: []",
  "subagents: []",
  "---",
  "",
  "You review code changes. You have no tools: read the diff in the prompt and reply with text only.",
  "",
].join("\n");

/** The final assistant text of a stream-json transcript; throws on a tool call or no assistant text. */
export function finalText(stdout) {
  let text = null;
  for (const line of String(stdout).split("\n")) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg?.role !== "assistant") continue;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) throw new Error("kimi tried to call a tool; the review is not trusted");
    if (typeof msg.content === "string") text = msg.content;
  }
  if (text === null) throw new Error("empty reply");
  return text;
}

export async function run({ diff, timeoutMs, env = process.env, config = {} }) {
  const model = config.models?.kimi ?? null;
  const prompt = `${PROMPT}\n\n${diff}`;
  if (Buffer.byteLength(prompt) > MAX_ARG_BYTES) throw new Error(`diff too large for kimi -p (${Buffer.byteLength(prompt)} bytes, limit ${MAX_ARG_BYTES})`);
  return withScratch(async (dir) => {
    const agentFile = join(dir, "ledger-reviewer.md");
    const skills = join(dir, "skills");
    writeFileSync(agentFile, REVIEWER_AGENT);
    mkdirSync(skills);
    const args = ["-p", prompt, "--output-format", "stream-json", "--agent-file", agentFile, "--skills-dir", skills, ...(model ? ["-m", model] : [])];
    const { stdout } = await runProcess(binFor(lab, defaultBin, env), args, { cwd: dir, timeoutMs, env: reviewerEnv(env, envKeys) });
    return { ...parseReply(finalText(stdout)), model };
  });
}
