// The skill's own HTTP client: sequential GETs with manual redirects, every hop checked by the guard and charged to
// the budget, a per-request timeout and a body cap. The whole chain is recorded for the redirect rules.
// Every hop goes through a GuardProxy of its own (one per chain), the same proxy Chrome uses: the proxy checks the
// destination again and connects only to the addresses that check approved, so a host whose DNS answer changes after
// the guard's check (rebinding) is refused, never reached.
import type { Budget, Guard } from "./guard.ts";
import { GuardProxy } from "./proxy.ts";

export const AUDIT_UA = "Mozilla/5.0 (compatible; seo-audit/1.0; +agent-system skills/seo-audit; audit-only)";

export interface Hop {
	url: string;
	status: number;
	location: string | null;
	headers: Record<string, string>;
}

export interface FetchResult {
	requestedUrl: string;
	ua: string;
	hops: Hop[]; // every response received, redirects first, the final response last
	finalUrl: string;
	status: number | null; // null when no final response was received
	headers: Record<string, string>;
	body: string | null;
	bytes: number;
	truncated: boolean;
	loop: boolean;
	tooManyRedirects: boolean;
	error: string | null; // network, timeout or body error
	refused: string | null; // the guard refused a hop
	budgetExhausted: boolean;
}

export interface FetchOptions {
	guard: Guard;
	budget: Budget;
	ua?: string;
	maxRedirects?: number;
	timeoutMs?: number;
	maxBytes?: number;
}

const REDIRECT: Record<number, true> = { 301: true, 302: true, 303: true, 307: true, 308: true };

// Lowercased header map; repeated headers are joined with ", " as the Fetch API does.
function headerRecord(h: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	h.forEach((v, k) => {
		out[k.toLowerCase()] = v;
	});
	return out;
}

async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; total: number; truncated: boolean }> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	let kept = 0;
	let truncated = false;
	const reader = res.body?.getReader();
	if (!reader) return { bytes: new Uint8Array(), total: 0, truncated: false };
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		total += value.length;
		if (kept < maxBytes) {
			const take = value.subarray(0, maxBytes - kept);
			chunks.push(take);
			kept += take.length;
		}
		if (total > maxBytes) {
			truncated = true;
			await reader.cancel();
			break;
		}
	}
	const out = new Uint8Array(kept);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return { bytes: out, total, truncated };
}

export async function fetchChain(start: string, o: FetchOptions): Promise<FetchResult> {
	const proxy = new GuardProxy(o.guard, Number.POSITIVE_INFINITY); // the budget, not the proxy, caps the skill's fetches
	await proxy.start();
	try {
		return await fetchVia(proxy, start, o);
	} finally {
		await proxy.stop();
	}
}

async function fetchVia(proxy: GuardProxy, start: string, o: FetchOptions): Promise<FetchResult> {
	const ua = o.ua ?? AUDIT_UA;
	const maxRedirects = o.maxRedirects ?? 20;
	const r: FetchResult = {
		requestedUrl: start,
		ua,
		hops: [],
		finalUrl: start,
		status: null,
		headers: {},
		body: null,
		bytes: 0,
		truncated: false,
		loop: false,
		tooManyRedirects: false,
		error: null,
		refused: null,
		budgetExhausted: false,
	};
	const seen = new Set<string>();
	let current = start;
	for (;;) {
		r.finalUrl = current;
		if (seen.has(current)) {
			r.loop = true;
			return r;
		}
		seen.add(current);
		const decision = await o.guard.check(current);
		if (!decision.allowed) {
			r.refused = decision.reason;
			o.guard.refuse(current, "fetch", decision.reason);
			return r;
		}
		if (!o.budget.take()) {
			r.budgetExhausted = true;
			return r;
		}
		let res: Response;
		try {
			res = await fetch(current, {
				redirect: "manual",
				proxy: `http://127.0.0.1:${proxy.port}`,
				headers: { "user-agent": ua, accept: "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8" },
				signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
			});
		} catch (e) {
			const { refused, error } = proxy.takeOutcome();
			if (refused) r.refused = refused;
			else r.error = error ?? String(e);
			return r;
		}
		// Any response the proxy writes itself (a refusal, an oversized request head, a failed connection) is its own
		// answer, not the site's: it is never a hop or the final status.
		const { refused, error } = proxy.takeOutcome();
		if (refused || error) {
			await res.body?.cancel();
			if (refused) r.refused = refused;
			else r.error = error;
			return r;
		}
		const headers = headerRecord(res.headers);
		const location = res.headers.get("location");
		r.hops.push({ url: current, status: res.status, location, headers });
		if (REDIRECT[res.status] && location) {
			await res.body?.cancel();
			if (r.hops.length > maxRedirects) {
				r.tooManyRedirects = true;
				return r;
			}
			try {
				current = new URL(location, current).href;
			} catch {
				r.error = `unparseable Location: ${location}`;
				return r;
			}
			continue;
		}
		r.status = res.status;
		r.headers = headers;
		try {
			const { bytes, total, truncated } = await readCapped(res, o.maxBytes ?? 10 * 1024 * 1024);
			const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? Bun.gunzipSync(bytes) : bytes;
			r.body = new TextDecoder().decode(raw);
			r.bytes = raw === bytes ? total : raw.length;
			r.truncated = truncated;
		} catch (e) {
			r.error = `body: ${String(e)}`;
		}
		return r;
	}
}

// The number of redirects before the final response (or before the chain stopped).
export function redirectCount(f: FetchResult): number {
	return f.hops.filter((h) => REDIRECT[h.status] && h.location).length;
}

// The error that cut off reading the final response's body, or null. fetchVia keeps the status it received and
// records the read failure in `error`, so a status beside an error means the headers arrived and the body did not.
export function bodyError(f: FetchResult): string | null {
	return f.status !== null ? f.error : null;
}
