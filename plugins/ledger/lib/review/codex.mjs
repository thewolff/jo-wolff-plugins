// codex.mjs — review through `codex exec` (non-interactive). The prompt and the diff go in on
// stdin (`-`: instructions are read from stdin), in a read-only sandbox (`-s read-only`), no
// session kept, run from the scratch folder (see common.mjs) so the repository's own
// instructions are not read. The final message is codex's stdout; its model comes from
// `review.models.codex`, else from the `model: …` line codex prints on stderr, else null.

import { binFor, parseReply, PROMPT, reviewerEnv, runProcess, withScratch } from "./common.mjs";

export const lab = "codex";
export const defaultBin = "codex";
export const envKeys = Object.freeze(["CODEX_*", "OPENAI_*"]);

export async function run({ diff, timeoutMs, env = process.env, config = {} }) {
  const model = config.models?.codex ?? null;
  const args = ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "--color", "never", ...(model ? ["-m", model] : []), "-"];
  return withScratch(async (dir) => {
    const { stdout, stderr } = await runProcess(binFor(lab, defaultBin, env), args, { input: `${PROMPT}\n\n${diff}`, cwd: dir, timeoutMs, env: reviewerEnv(env, envKeys) });
    const reported = /^model:\s*(\S+)/m.exec(stderr)?.[1] ?? null;
    return { ...parseReply(stdout), model: model ?? reported };
  });
}
