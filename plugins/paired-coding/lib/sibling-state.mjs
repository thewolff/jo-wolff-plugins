// sibling-state.mjs — the one list of sibling-plugin state every sandbox lets pair_run write.
//
// The ledger and pattern-check plugins end each reply with a Stop hook that demands their CLI
// run (`ledger.mjs ask`, `pattern-check.mjs record`). While pairing the host shell is refused
// and pair_run fences every write outside the agreement, so those CLIs failed against the
// fence (EPERM on `<worktree>/.pattern-check/`, "database read-only" on the ledger's SQLite
// file) and a reply could neither finish nor be allowed to. The paths here are what those two
// CLIs write, resolved on the host at pair_start from HOME and the ledger's own config, and
// they are granted by every backend (gate.mjs: profileFor, bwrapPlan, landlockPlan, all through
// usableCarveOuts) in both phases, boundary or no boundary.
//
// What is in the list, and why each entry:
//   files  the ledger's SQLite database and its WAL sidecars (`-wal`, `-shm`), for each place
//          the ledger might keep it: `~/.agent-system-2/ledger.db` (the layout the live failure
//          was measured on), the ledger's shipped default `${XDG_DATA_HOME:-~/.local/share}/
//          ledger/ledger.db`, `$LEDGER_DB`, the `db` key of the user config file (`$LEDGER_CONFIG`
//          or `${XDG_CONFIG_HOME:-~/.config}/ledger/config.json`) and of the nearest `.ledger.json`
//          at or above the worktree. A config file that is missing, unreadable, not JSON or has
//          no string `db` contributes nothing, silently: a wrong guess here costs one failed
//          Stop hook, not a write outside the agreement.
//   dirs   `<worktree>/.pattern-check/` (the receipt pattern-check writes next to the code; the
//          snapshot leaves it out too, verbs.mjs DEFAULT_EXCLUSIONS), and the two state
//          directories `${XDG_STATE_HOME:-~/.local/state}/ledger/` and `.../pattern-check/`.
// Nothing here is read by the gate's core: the list is data handed to pairStart as `carveOuts`.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** The ledger's SQLite file and the sidecars WAL mode keeps beside it. */
const SQLITE_SIDECARS = Object.freeze(["", "-wal", "-shm"]);

/** The directory pattern-check writes its receipt in, worktree-relative. */
export const PATTERN_CHECK_DIR = ".pattern-check";

function xdgDir(env, home, variable, fallback) {
  const v = env[variable];
  return v && isAbsolute(v) ? v : join(home, fallback);
}

/** `~` and `~/x` expanded against `home`; anything else unchanged (the ledger's own rule). */
function expandHome(p, home) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/** The string `db` of the JSON file at `path`, or null when the file is anything but that. */
function dbOfConfig(path, readFile) {
  let text;
  try { text = readFile(path); } catch { return null; }
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && typeof value.db === "string" && value.db.length > 0 ? value.db : null;
  } catch {
    return null;
  }
}

/** The nearest `.ledger.json` at or above `dir`, or null (the ledger's projectConfigPath). */
function nearestProjectConfig(dir, exists) {
  for (;;) {
    const candidate = join(dir, ".ledger.json");
    if (exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The carve-outs for a worktree, every path absolute, in a stable order with no duplicates.
 * @param {{ root: string, env?: NodeJS.ProcessEnv, home?: string, readFile?: (path: string) => string, exists?: (path: string) => boolean }} opts
 *   `root`: the worktree, absolute. `readFile` and `exists` are for tests; by default the host's.
 * @returns {{ files: string[], dirs: string[] }}
 */
export function siblingState({ root, env = process.env, home = homedir(), readFile = (p) => readFileSync(p, "utf8"), exists = isFile } = {}) {
  const dbs = [
    join(home, ".agent-system-2", "ledger.db"),
    join(xdgDir(env, home, "XDG_DATA_HOME", join(".local", "share")), "ledger", "ledger.db"),
    env.LEDGER_DB,
    dbOfConfig(env.LEDGER_CONFIG || join(xdgDir(env, home, "XDG_CONFIG_HOME", ".config"), "ledger", "config.json"), readFile),
  ];
  const project = nearestProjectConfig(root, exists);
  if (project) dbs.push(dbOfConfig(project, readFile));
  const files = new Set();
  for (const raw of dbs) {
    if (typeof raw !== "string" || raw === "") continue;
    const db = expandHome(raw, home);
    if (!isAbsolute(db)) continue;
    for (const suffix of SQLITE_SIDECARS) files.add(`${db}${suffix}`);
  }
  const state = xdgDir(env, home, "XDG_STATE_HOME", join(".local", "state"));
  const dirs = new Set([join(root, PATTERN_CHECK_DIR), join(state, "ledger"), join(state, "pattern-check")]);
  return { files: [...files], dirs: [...dirs] };
}

function isFile(path) {
  try { return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false; } catch { return false; }
}
