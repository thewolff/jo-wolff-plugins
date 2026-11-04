// claude.mjs — review through `claude -p` (print mode). The diff goes in on stdin, the
// instructions as the prompt argument, with no session persisted.
//
// Tool-free (`claude --help`): `--tools ""` disables every built-in tool, `--strict-mcp-config`
// with no `--mcp-config` loads no MCP server, and `--disable-slash-commands` turns off skills and
// commands. The scratch folder is the working directory, so no project settings, hooks or
// CLAUDE.md from the repository under review are read.
//
// Model: `review.models.claude` (passed as `--model`), else Claude Code's default (recorded as null).

import { binFor, parseReply, PROMPT, reviewerEnv, runProcess, withScratch } from "./common.mjs";

export const lab = "claude";
export const defaultBin = "claude";
export const envKeys = Object.freeze([
  "ANTHROPIC_*", "CLAUDE_CODE_*", "CLAUDE_CONFIG_DIR",
  "AWS_*", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUD_ML_REGION", "VERTEX_*",
]);

export async function run({ diff, timeoutMs, env = process.env, config = {} }) {
  const model = config.models?.claude ?? null;
  const args = ["-p", PROMPT, "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", ...(model ? ["--model", model] : [])];
  return withScratch(async (dir) => {
    const { stdout } = await runProcess(binFor(lab, defaultBin, env), args, { input: diff, cwd: dir, timeoutMs, env: reviewerEnv(env, envKeys) });
    return { ...parseReply(stdout), model };
  });
}
