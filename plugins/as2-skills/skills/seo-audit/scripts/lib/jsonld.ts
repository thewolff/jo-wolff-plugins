// JSON-LD evidence: every `<script type="application/ld+json">` block of a layer, parsed, with its nodes walked
// through arrays and `@graph` (plan section 3, structured-data validation boundary). Validation against Google's
// required properties belongs to the structured-data rules; this adapter only records what is there.
import type { HtmlSignals } from "./html.ts";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface JsonLdNode {
	block: number; // index of the block in document order
	path: string; // JSON path of the node inside the block, e.g. `$["@graph"][1]`
	topLevel: boolean; // a top-level item or a top-level `@graph` member
	types: string[];
	node: { [k: string]: Json };
}

export interface JsonLdBlock {
	index: number;
	line: number;
	region: "head" | "body";
	raw: string;
	parsed: Json | undefined;
	error: string | null;
}

export interface JsonLdEvidence {
	blocks: JsonLdBlock[];
	nodes: JsonLdNode[];
}

function isObject(v: Json | undefined): v is { [k: string]: Json } {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typesOf(v: Json | undefined): string[] {
	if (typeof v === "string") return [v];
	if (Array.isArray(v)) return v.filter((t): t is string => typeof t === "string");
	return [];
}

function walk(v: Json, block: number, path: string, topLevel: boolean, out: JsonLdNode[]): void {
	if (Array.isArray(v)) {
		v.forEach((item, i) => walk(item, block, `${path}[${i}]`, topLevel, out));
		return;
	}
	if (!isObject(v)) return;
	if (v["@type"] !== undefined || topLevel) out.push({ block, path, topLevel, types: typesOf(v["@type"]), node: v });
	for (const [k, child] of Object.entries(v)) {
		if (k === "@context") continue;
		walk(child, block, `${path}[${JSON.stringify(k)}]`, topLevel && k === "@graph", out);
	}
}

export function extractJsonLd(signals: HtmlSignals): JsonLdEvidence {
	const blocks: JsonLdBlock[] = [];
	const nodes: JsonLdNode[] = [];
	for (const s of signals.scripts) {
		if (s.type !== "application/ld+json") continue;
		const index = blocks.length;
		let parsed: Json | undefined;
		let error: string | null = null;
		try {
			parsed = JSON.parse(s.text) as Json;
		} catch (e) {
			error = String(e);
		}
		blocks.push({ index, line: s.line, region: s.region, raw: s.text, parsed, error });
		if (parsed !== undefined) walk(parsed, index, "$", true, nodes);
	}
	return { blocks, nodes };
}
