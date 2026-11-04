// throw-preload.mjs — loaded with `node --import` by hooks/fault-tolerance.test.mjs to make a hook
// throw from inside its own code, so the hook's last-resort catch is exercised as a real process.
// AUDHD_TEST_THROW picks the fault:
//   createHash        node:crypto createHash throws (the Stop hook hashes the message text)
//   pending-exists    fs.existsSync throws for the pending-warning file (the prompt hook)
//   skill-read        fs.readFileSync throws for SKILL.md (the session-start hook)
// Builtin ESM named imports are live bindings of the CommonJS module, refreshed by
// syncBuiltinESMExports, so patching before the hook loads reaches the hook's own imports.

import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const crypto = require("node:crypto");
const which = process.env.AUDHD_TEST_THROW;

if (which === "createHash") {
  crypto.createHash = () => {
    throw new Error("injected createHash failure");
  };
}
if (which === "pending-exists") {
  const real = fs.existsSync;
  fs.existsSync = (p) => {
    if (String(p).includes("pending-warn-")) throw new Error("injected existsSync failure");
    return real(p);
  };
}
if (which === "skill-read") {
  const real = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (String(p).endsWith("SKILL.md")) throw new Error("injected SKILL.md read failure");
    return real(p, ...rest);
  };
}
syncBuiltinESMExports();
