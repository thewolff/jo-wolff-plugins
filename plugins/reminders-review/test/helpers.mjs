// test/helpers.mjs — a sandbox per test: temp HOME and XDG dirs, and a fake `remindctl` on a
// PATH of its own. The real remindctl is never run under node --test.
//
// The stub answers `show <bucket> --list <name> --json` with fixtures/remindctl-show-<bucket>.json
// (or the file STUB_<BUCKET> names), and misbehaves on demand through STUB_REMINDCTL:
//   fail     exit 1 with a not-authorized line on stderr
//   slow     sleep 10 (longer than the 2 s bound)
//   badjson  print text that is not JSON
//   delay    sleep STUB_DELAY seconds (default 0.5), then answer as usual
//   flood    print 2 MiB of text (more than the 1 MiB stdout cap)

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURES = join(PLUGIN_DIR, "test", "fixtures");
/** 02:30 PST on the fixtures' day. */
export const NOW = Date.parse("2026-11-04T10:30:00Z");
export const TZ = "America/Los_Angeles";

const STUB = `#!/bin/sh
echo "$*" >> "$STUB_CALLS"
case "\${STUB_REMINDCTL:-}" in
  fail) echo "Reminders access denied. Grant access in System Settings, or run remindctl authorize." >&2; exit 1 ;;
  slow) exec sleep 10 ;;
  badjson) echo "this is not json"; exit 0 ;;
  delay) sleep "\${STUB_DELAY:-0.5}" ;;
  flood) yes xxxxxxxxxxxxxxx | head -c 2097152; exit 0 ;;
esac
case "$2" in
  overdue) f="\${STUB_OVERDUE:-$STUB_FIXTURES/remindctl-show-overdue.json}" ;;
  today) f="\${STUB_TODAY:-$STUB_FIXTURES/remindctl-show-today.json}" ;;
  *) echo "unknown bucket $2" >&2; exit 2 ;;
esac
cat "$f"
`;

/**
 * A sandbox: `{ root, env, calls, stateDir, configDir, release }`. `env` holds only HOME, the XDG
 * dirs, TZ and a PATH of the stub's directory plus node's (and /usr/bin:/bin for sh, cat, sleep).
 * `withStub: false` leaves remindctl off PATH.
 */
export function sandbox({ withStub = true, extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rr-due-"));
  const bin = join(root, "bin");
  const dirs = { HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data") };
  for (const d of [bin, ...Object.values(dirs)]) mkdirSync(d, { recursive: true });
  if (withStub) {
    writeFileSync(join(bin, "remindctl"), STUB);
    chmodSync(join(bin, "remindctl"), 0o755);
  }
  const calls = join(root, "calls.log");
  const env = { ...dirs, TZ, PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"), STUB_FIXTURES: FIXTURES, STUB_CALLS: calls, ...extra };
  return {
    root,
    env,
    calls,
    stateDir: join(dirs.XDG_STATE_HOME, "reminders-review"),
    configDir: join(dirs.XDG_CONFIG_HOME, "reminders-review"),
    release: () => rmSync(root, { recursive: true, force: true }),
  };
}
