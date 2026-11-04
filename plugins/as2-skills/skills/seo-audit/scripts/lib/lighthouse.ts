// Lab evidence: Lighthouse 13 (`npx --yes lighthouse@13.5.0`, pinned) against one URL, its Chrome launched with the
// same flags as the renderer so every request goes through the guard proxy, with a 120 s wall clock. A recorded LHR
// (`--lhr-from`) replaces the run offline. Any LHR whose lighthouseVersion major is not 13 is refused, because the
// audit ids the lab rules read only exist in 13 (do-not-flag PERF-DNF-04).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "./jsonld.ts";
import type { GuardProxy } from "./proxy.ts";

export const LIGHTHOUSE_PACKAGE = "lighthouse@13.5.0";
export const LIGHTHOUSE_WALL_MS = 120_000;

export interface LighthouseAudit {
	score: number | null;
	numericValue: number | null;
	details: Json | null;
}

export interface LighthouseEvidence {
	source: "lighthouse" | "recorded";
	url: string;
	lighthouseVersion: string | null;
	audits: Record<string, LighthouseAudit>;
	categories: Record<string, number | null>;
	networkRequests: number | null; // recorded from the LHR, never enforced (plan section 3)
	error: string | null;
	lhr: Json | null; // the whole LHR, kept for --record-lhr
}

function asObject(v: Json | undefined): { [k: string]: Json } {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
}

export function parseLhr(lhr: Json, source: LighthouseEvidence["source"], url: string): LighthouseEvidence {
	const root = asObject(lhr);
	const version = typeof root.lighthouseVersion === "string" ? root.lighthouseVersion : null;
	const out: LighthouseEvidence = {
		source,
		url,
		lighthouseVersion: version,
		audits: {},
		categories: {},
		networkRequests: null,
		error: null,
		lhr,
	};
	if (!version || version.split(".")[0] !== "13") {
		out.error = `LHR lighthouseVersion ${version ?? "missing"} is not 13.x; refused`;
		return out;
	}
	for (const [id, a] of Object.entries(asObject(root.audits))) {
		const audit = asObject(a);
		out.audits[id] = {
			score: typeof audit.score === "number" ? audit.score : null,
			numericValue: typeof audit.numericValue === "number" ? audit.numericValue : null,
			details: audit.details ?? null,
		};
	}
	for (const [id, c] of Object.entries(asObject(root.categories))) {
		const score = asObject(c).score;
		out.categories[id] = typeof score === "number" ? score : null;
	}
	const items = asObject(out.audits["network-requests"]?.details ?? null).items;
	out.networkRequests = Array.isArray(items) ? items.length : null;
	return out;
}

export function loadLhr(file: string, url: string): LighthouseEvidence {
	return parseLhr(JSON.parse(readFileSync(file, "utf8")) as Json, "recorded", url);
}

export interface LighthouseOptions {
	chromePath: string;
	proxy: GuardProxy;
	noSandbox: boolean;
	trustSpki: string[];
}

export async function runLighthouse(url: string, o: LighthouseOptions): Promise<LighthouseEvidence> {
	const dir = mkdtempSync(join(tmpdir(), "seo-audit-lh-"));
	const outPath = join(dir, "lhr.json");
	o.proxy.beginRun(`lighthouse ${url}`);
	const chromeFlags = [
		"--headless=new",
		"--no-first-run",
		"--disable-extensions",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-sync",
		...o.proxy.browserFlags(o), // loopback-only proxy when a fixture-only exception is on
	].join(" ");
	const failed = (error: string): LighthouseEvidence => ({
		source: "lighthouse",
		url,
		lighthouseVersion: null,
		audits: {},
		categories: {},
		networkRequests: null,
		error,
		lhr: null,
	});
	try {
		const proc = Bun.spawn(
			[
				"npx",
				"--yes",
				LIGHTHOUSE_PACKAGE,
				url,
				"--output=json",
				`--output-path=${outPath}`,
				"--quiet",
				"--only-categories=performance,seo",
				`--chrome-flags=${chromeFlags}`,
			],
			{ stdout: "ignore", stderr: "pipe", env: { ...process.env, CHROME_PATH: o.chromePath } },
		);
		const timer = setTimeout(() => proc.kill(), LIGHTHOUSE_WALL_MS);
		const code = await proc.exited;
		clearTimeout(timer);
		if (code !== 0) {
			const err = await new Response(proc.stderr).text();
			return failed(`lighthouse exited ${code}${proc.signalCode ? ` (${proc.signalCode}, 120 s wall clock)` : ""}: ${err.slice(0, 300)}`);
		}
		return parseLhr(JSON.parse(readFileSync(outPath, "utf8")) as Json, "lighthouse", url);
	} catch (e) {
		return failed(String(e));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
