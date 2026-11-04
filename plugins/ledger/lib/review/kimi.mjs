// kimi.mjs — review through the Kimi Code CLI. `kimi --help` documents `-p, --prompt <prompt>`
// ("Run one prompt non-interactively and print the response") with `--output-format text`, and
// says nothing about stdin, so the prompt and the diff travel in the `-p` argument. A diff larger
// than MAX_ARG_BYTES would overrun the OS argument limit and is reported as unavailable instead.
// Model: `review.models.kimi` (passed as `-m`), else Kimi's configured default (recorded as null).

import { binFor, parseReply, PROMPT, runProcess } from "./common.mjs";

export const lab = "kimi";
export const defaultBin = "kimi";
export const MAX_ARG_BYTES = 200_000;

export async function run({ diff, cwd, timeoutMs, env = process.env, config = {} }) {
  const model = config.models?.kimi ?? null;
  const prompt = `${PROMPT}\n\n${diff}`;
  if (Buffer.byteLength(prompt) > MAX_ARG_BYTES) throw new Error(`diff too large for kimi -p (${Buffer.byteLength(prompt)} bytes, limit ${MAX_ARG_BYTES})`);
  const args = ["-p", prompt, "--output-format", "text", ...(model ? ["-m", model] : [])];
  const { stdout } = await runProcess(binFor(lab, defaultBin, env), args, { cwd, timeoutMs, env });
  return { ...parseReply(stdout), model };
}
