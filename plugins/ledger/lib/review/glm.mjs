// glm.mjs — Z.ai GLM, which has no CLI of its own, through `omp` (see omp.mjs). Defaults:
// model `zai/glm-5.3`, no profile (omp's base profile: a `--profile` is passed only when
// `review.profiles.glm` names one); `review.models.glm` overrides the model.

import { ompAdapter } from "./omp.mjs";

const adapter = ompAdapter({ lab: "glm", defaultModel: "zai/glm-5.3", defaultProfile: null });

export const lab = adapter.lab;
export const defaultBin = adapter.defaultBin;
export const run = adapter.run;
export const envKeys = adapter.envKeys;
