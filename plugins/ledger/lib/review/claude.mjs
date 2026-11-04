// claude.mjs — review through `claude -p` (print mode). The diff goes in on stdin, the
// instructions as the prompt argument, with no session persisted. Model: `review.models.claude`
// (passed as `--model`), else Claude Code's default (recorded as null).

import { binFor, parseReply, PROMPT, runProcess } from "./common.mjs";

export const lab = "claude";
export const defaultBin = "claude";

export async function run({ diff, cwd, timeoutMs, env = process.env, config = {} }) {
  const model = config.models?.claude ?? null;
  const args = ["-p", PROMPT, "--no-session-persistence", ...(model ? ["--model", model] : [])];
  const { stdout } = await runProcess(binFor(lab, defaultBin, env), args, { input: diff, cwd, timeoutMs, env });
  return { ...parseReply(stdout), model };
}
