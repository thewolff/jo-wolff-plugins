// omp.mjs — an adapter factory for labs reached through the `omp` CLI. `omp --help` documents
// `-p, --print` (non-interactive: process the prompt and exit), `--profile`, `--model`,
// `--no-tools`, `--no-session`, and `@file` arguments that include a file in the message, so the
// diff is written to a temporary file and passed as `@<file>`; the instructions are the prompt
// argument. The temporary directory is removed afterwards.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binFor, parseReply, PROMPT, runProcess } from "./common.mjs";

/**
 * @param lab           the lab name (`review.labs` entry, row `lab`, env LEDGER_REVIEW_BIN_<LAB>)
 * @param defaultModel  `--model` when `review.models.<lab>` is unset
 * @param defaultProfile `--profile` when `review.profiles.<lab>` is unset (null: omp's default profile)
 */
export function ompAdapter({ lab, defaultModel, defaultProfile = null }) {
  return {
    lab,
    defaultBin: "omp",
    async run({ diff, cwd, timeoutMs, env = process.env, config = {} }) {
      const model = config.models?.[lab] ?? defaultModel;
      const profile = config.profiles?.[lab] ?? defaultProfile;
      const dir = mkdtempSync(join(tmpdir(), "ledger-review-"));
      try {
        const file = join(dir, "change.diff");
        writeFileSync(file, diff);
        const args = ["-p", "--no-session", "--no-tools", ...(profile ? ["--profile", profile] : []), "--model", model, `@${file}`, PROMPT];
        const { stdout } = await runProcess(binFor(lab, "omp", env), args, { cwd, timeoutMs, env });
        return { ...parseReply(stdout), model };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
