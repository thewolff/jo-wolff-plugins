// model-routing.mjs — the model routing table (lib/model-routing.json) and the one warning line
// the spawn gate builds from it. The table is data in that one file; nothing here names a model
// or an agent. Never throws: a table that cannot be read or is malformed is `{ table: null,
// fault }`, and the caller then says nothing about models.
//
// WHAT IS COMPARED: the spawn's `tool_input.model` against the ceiling of its `subagent_type`.
// The agent name is compared bare (lib/brief.mjs agentKey: `plugin:reader` is `reader`). A model
// string is reduced to its family: the one name in the table's `order` it contains, so `sonnet`,
// `claude-sonnet-5-5` and `Sonnet[1m]` are all `sonnet`. A string that contains none of them, or
// more than one, is not judged.
//
// WHAT THIS CANNOT SEE: the effort level (the Agent tool's input has no such field), the model
// of the session doing the spawning, and, when a spawn sets no model, the model the agent's
// definition pins. So a spawn with no model is told the table's model for its type, not judged.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentKey } from "./brief.mjs";

export const TABLE_URL = new URL("./model-routing.json", import.meta.url);

/**
 * Validate a parsed table.
 * @returns {{ table: { order: string[], agents: Record<string, { model: string, ceiling: string }> }|null, fault: string|null }}
 */
export function checkTable(parsed) {
  const bad = (why) => ({ table: null, fault: why });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad("the table is not a JSON object");
  const { order, agents } = parsed;
  if (!Array.isArray(order) || !order.length || !order.every((s) => typeof s === "string" && s && s === s.toLowerCase())) return bad("`order` must be a non-empty array of lower-case names");
  if (new Set(order).size !== order.length) return bad("`order` names a model twice");
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return bad("`agents` must be an object");
  const out = {};
  for (const [name, row] of Object.entries(agents)) {
    if (!row || typeof row !== "object" || !order.includes(row.model) || !order.includes(row.ceiling)) return bad(`agents.${name} needs a \`model\` and a \`ceiling\` from \`order\``);
    if (order.indexOf(row.model) > order.indexOf(row.ceiling)) return bad(`agents.${name}: model ${row.model} is above its ceiling ${row.ceiling}`);
    out[agentKey(name)] = { model: row.model, ceiling: row.ceiling };
  }
  return { table: { order: [...order], agents: out }, fault: null };
}

/** Read and validate the table file. Never throws. Every fault names the file. */
export function loadTable(url = TABLE_URL) {
  let path;
  try {
    path = fileURLToPath(url);
  } catch {
    path = String(url);
  }
  let raw;
  try {
    raw = readFileSync(url, "utf8");
  } catch (err) {
    return { table: null, fault: `the routing table ${path} cannot be read (${err.code ?? err.message})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { table: null, fault: `the routing table ${path} is not JSON (${err.message})` };
  }
  const checked = checkTable(parsed);
  return checked.table ? checked : { table: null, fault: `the routing table ${path}: ${checked.fault}` };
}

/** The family in `order` that `model` names, or null when it names none or more than one. */
export function modelFamily(model, order) {
  if (typeof model !== "string") return null;
  const text = model.toLowerCase();
  const hits = order.filter((name) => text.includes(name));
  return hits.length === 1 ? hits[0] : null;
}

const short = (s) => (s.length > 40 ? `${s.slice(0, 37)}...` : s);

/**
 * The warning for one spawn, if any.
 * @param table         a table from loadTable/checkTable
 * @param subagentType  `tool_input.subagent_type` as given (may be undefined)
 * @param model         `tool_input.model` as given (may be undefined)
 * @returns {{ warning: string|null, skipped: string|null }}  `warning` is one line; `skipped`
 *   says why a model that was set could not be judged
 */
export function routingWarning(table, subagentType, model) {
  const none = { warning: null, skipped: null };
  const key = agentKey(subagentType);
  const row = key && Object.hasOwn(table.agents, key) ? table.agents[key] : null;
  if (!row) return none;
  const type = short(String(subagentType).trim());
  if (model === undefined || model === null || (typeof model === "string" && model.trim() === "")) {
    return { warning: `delegation model routing (warn-only): this "${type}" spawn sets no model; the routing table's model for ${key} is ${row.model}. The spawn proceeds on the model its agent definition pins.`, skipped: null };
  }
  const family = modelFamily(model, table.order);
  if (!family) return { warning: null, skipped: `model ${JSON.stringify(typeof model === "string" ? short(model) : model)} for "${type}" names no single family in the routing table; not judged` };
  if (table.order.indexOf(family) <= table.order.indexOf(row.ceiling)) return none;
  return { warning: `delegation model routing (warn-only): this "${type}" spawn asks for ${short(String(model).trim())}; the routing table's ceiling for ${key} is ${row.ceiling}. The spawn proceeds.`, skipped: null };
}
