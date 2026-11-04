// glm.mjs — Z.ai GLM, which has no CLI of its own, through `omp` (see omp.mjs). Defaults:
// model `zai/glm-5.3`, profile `agent-system-2`; `review.models.glm` and `review.profiles.glm`
// override them.

import { ompAdapter } from "./omp.mjs";

const adapter = ompAdapter({ lab: "glm", defaultModel: "zai/glm-5.3", defaultProfile: "agent-system-2" });

export const lab = adapter.lab;
export const defaultBin = adapter.defaultBin;
export const run = adapter.run;
