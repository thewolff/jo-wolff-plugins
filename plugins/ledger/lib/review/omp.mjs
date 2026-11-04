// omp.mjs — an adapter factory for labs reached through the `omp` CLI. `omp --help` documents
// `-p, --print` (non-interactive: process the prompt and exit), `--profile`, `--model`,
// `--no-tools`, `--no-session`, and `@file` arguments that include a file in the message, so the
// diff is written to the scratch folder (see common.mjs, also the working directory) and passed
// as `@<file>`; the instructions are the prompt argument. `--no-tools` keeps the reviewer
// tool-free.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { binFor, parseReply, PROMPT, reviewerEnv, runProcess, withScratch } from "./common.mjs";

export const envKeys = Object.freeze(["OMP_*", "ZAI_*", "ZHIPU_*", "GLM_*"]);

/**
 * @param lab           the lab name (`review.labs` entry, row `lab`, env LEDGER_REVIEW_BIN_<LAB>)
 * @param defaultModel  `--model` when `review.models.<lab>` is unset
 * @param defaultProfile `--profile` when `review.profiles.<lab>` is unset (null: omp's default profile)
 */
export function ompAdapter({ lab, defaultModel, defaultProfile = null }) {
  return {
    lab,
    defaultBin: "omp",
    envKeys,
    async run({ diff, timeoutMs, env = process.env, config = {} }) {
      const model = config.models?.[lab] ?? defaultModel;
      const profile = config.profiles?.[lab] ?? defaultProfile;
      return withScratch(async (dir) => {
        const file = join(dir, "change.diff");
        writeFileSync(file, diff);
        const args = ["-p", "--no-session", "--no-tools", ...(profile ? ["--profile", profile] : []), "--model", model, `@${file}`, PROMPT];
        const { stdout } = await runProcess(binFor(lab, "omp", env), args, { cwd: dir, timeoutMs, env: reviewerEnv(env, envKeys) });
        return { ...parseReply(stdout), model };
      });
    },
  };
}
