// Field evidence: the Chrome UX Report API, phone form factor, URL record first and origin record as fallback
// (rules.md CWV-001..003). The key comes from the environment variable `--crux-key-env` names (default CRUX_API_KEY);
// without one, or offline with `--crux-from`, no request is made. The request goes through the guard, the budget and a
// GuardProxy, which connects only to the address the guard approved.
// A recorded file holds the raw API bodies: { "records": { "<audited url>": { "url": <body>, "origin": <body> } } }.
import { readFileSync } from "node:fs";
import type { Budget, Guard } from "./guard.ts";
import type { Json } from "./jsonld.ts";
import { GuardProxy } from "./proxy.ts";

export const CRUX_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";

export interface CruxEvidence {
	source: "api" | "recorded" | "none";
	scope: "url" | "origin" | null; // which record the p75 values come from
	p75: { lcp: number | null; inp: number | null; cls: number | null };
	reason: string | null; // why there is no field data
	responses: { url: Json | null; origin: Json | null };
}

function asObject(v: Json | undefined): { [k: string]: Json } {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
}

function p75(body: Json | null, metric: string): number | null {
	const v = asObject(asObject(asObject(asObject(asObject(body).record).metrics)[metric]).percentiles).p75;
	if (typeof v === "number") return v;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	return null;
}

function hasRecord(body: Json | null): boolean {
	return Object.keys(asObject(asObject(body).record)).length > 0;
}

export function cruxFromResponses(source: CruxEvidence["source"], url: Json | null, origin: Json | null): CruxEvidence {
	const body = hasRecord(url) ? url : hasRecord(origin) ? origin : null;
	const scope = body === null ? null : body === url ? "url" : "origin";
	return {
		source,
		scope,
		p75: {
			lcp: p75(body, "largest_contentful_paint"),
			inp: p75(body, "interaction_to_next_paint"),
			cls: p75(body, "cumulative_layout_shift"),
		},
		reason: body === null ? "CrUX has too little data for the URL and the origin" : null,
		responses: { url, origin },
	};
}

export function loadCrux(file: string, auditedUrl: string): CruxEvidence {
	const records = asObject(asObject(JSON.parse(readFileSync(file, "utf8")) as Json).records);
	const entry = asObject(records[auditedUrl]);
	if (!Object.keys(entry).length)
		return { source: "recorded", scope: null, p75: { lcp: null, inp: null, cls: null }, reason: `no recorded CrUX response for ${auditedUrl}`, responses: { url: null, origin: null } };
	return cruxFromResponses("recorded", entry.url ?? null, entry.origin ?? null);
}

export function noCrux(reason: string): CruxEvidence {
	return { source: "none", scope: null, p75: { lcp: null, inp: null, cls: null }, reason, responses: { url: null, origin: null } };
}

async function query(key: string, body: Record<string, string>, guard: Guard, budget: Budget): Promise<Json | null> {
	const endpoint = `${CRUX_ENDPOINT}?key=${encodeURIComponent(key)}`;
	const decision = await guard.check(endpoint);
	if (!decision.allowed) {
		guard.refuse(CRUX_ENDPOINT, "fetch", decision.reason);
		return null;
	}
	if (!budget.take()) return null;
	const proxy = new GuardProxy(guard, Number.POSITIVE_INFINITY);
	await proxy.start();
	try {
		const res = await fetch(endpoint, {
			method: "POST",
			proxy: `http://127.0.0.1:${proxy.port}`,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...body, formFactor: "PHONE" }),
			signal: AbortSignal.timeout(15_000),
		});
		return (await res.json()) as Json;
	} catch {
		return null;
	} finally {
		await proxy.stop();
	}
}

export async function queryCrux(key: string, auditedUrl: string, guard: Guard, budget: Budget): Promise<CruxEvidence> {
	const url = await query(key, { url: auditedUrl }, guard, budget);
	const origin = hasRecord(url) ? null : await query(key, { origin: new URL(auditedUrl).origin }, guard, budget);
	return cruxFromResponses("api", url, origin);
}
