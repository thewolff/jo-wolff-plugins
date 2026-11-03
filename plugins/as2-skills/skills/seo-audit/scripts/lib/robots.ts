// robots.txt parser and matcher, hand-written to RFC 9309 (references/research/fetch-rfc9309.md): groups of one or
// more user-agent lines followed by rules; matching groups merged; the `*` group only when no group matches; longest
// match wins, and an allow wins a tie (Google: "the least restrictive rule"); `*` matches any run of octets and a
// trailing `$` anchors the end; octets are compared after RFC 3986 percent-encoding normalisation.

export interface RobotsRule {
	allow: boolean;
	path: string;
	line: number;
}

export interface RobotsGroup {
	agents: string[]; // product tokens as written, `*` included
	agentLines: number[];
	rules: RobotsRule[];
}

export interface RobotsLine {
	line: number;
	key: string; // lowercased
	value: string;
	raw: string;
}

export interface ParsedRobots {
	groups: RobotsGroup[];
	sitemaps: { value: string; line: number }[];
	orphanRules: RobotsLine[]; // allow/disallow before the first user-agent line
	invalidPaths: RobotsLine[]; // non-empty allow/disallow values starting with neither `/` nor `*`
	noindexLines: RobotsLine[];
	lines: RobotsLine[]; // every key: value line
}

export interface RobotsVerdict {
	allowed: boolean;
	group: string | null; // the product token whose group decided, `*`, or null when no group applies
	rule: RobotsRule | null;
}

export function parseRobots(text: string): ParsedRobots {
	const out: ParsedRobots = { groups: [], sitemaps: [], orphanRules: [], invalidPaths: [], noindexLines: [], lines: [] };
	let current: RobotsGroup | null = null;
	let inAgents = false;
	const rawLines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
	rawLines.forEach((raw, i) => {
		const line = i + 1;
		const hash = raw.indexOf("#");
		const body = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
		const colon = body.indexOf(":");
		if (!body || colon < 0) return;
		const key = body.slice(0, colon).trim().toLowerCase();
		const value = body.slice(colon + 1).trim();
		const entry: RobotsLine = { line, key, value, raw };
		out.lines.push(entry);
		if (key === "user-agent") {
			if (!current || !inAgents) {
				current = { agents: [], agentLines: [], rules: [] };
				out.groups.push(current);
			}
			current.agents.push(value);
			current.agentLines.push(line);
			inAgents = true;
			return;
		}
		if (key === "allow" || key === "disallow") {
			if (value && !value.startsWith("/") && !value.startsWith("*")) out.invalidPaths.push(entry);
			if (!current) {
				out.orphanRules.push(entry);
				return;
			}
			inAgents = false;
			current.rules.push({ allow: key === "allow", path: value, line });
			return;
		}
		if (key === "sitemap") out.sitemaps.push({ value, line });
		else if (key === "noindex") out.noindexLines.push(entry);
		// Other records (sitemap, crawl-delay, noindex, …) never terminate a group (RFC 9309 section 2.2.4).
	});
	return out;
}

// The product token of a user-agent value: its leading run of letters, `_` and `-` (RFC 9309 section 2.2.1), or `*`.
function productToken(value: string): string {
	if (value.trim() === "*") return "*";
	return (value.match(/^[A-Za-z_-]+/)?.[0] ?? "").toLowerCase();
}

// Rules that apply to `token`: every group naming it merged, or the `*` group(s) when none does, or null when no group
// applies (then everything is allowed).
export function rulesFor(robots: ParsedRobots, token: string): { group: string; rules: RobotsRule[] } | null {
	const want = token.toLowerCase();
	const named = robots.groups.filter((g) => g.agents.some((a) => productToken(a) === want));
	if (named.length) return { group: token, rules: named.flatMap((g) => g.rules) };
	const star = robots.groups.filter((g) => g.agents.some((a) => productToken(a) === "*"));
	if (star.length) return { group: "*", rules: star.flatMap((g) => g.rules) };
	return null;
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;

// RFC 3986 normalisation for comparison: octets outside printable ASCII are percent-encoded, percent-encoded
// unreserved octets are decoded, and remaining escapes use upper-case hex. `*` and `$` pass through unchanged.
export function normalisePath(s: string): string {
	let out = "";
	const bytes = new TextEncoder().encode(s);
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i] ?? 0;
		if (b === 0x25 && i + 2 < bytes.length) {
			const hex = String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0);
			if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
				const ch = String.fromCharCode(Number.parseInt(hex, 16));
				out += UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
				i += 2;
				continue;
			}
		}
		if (b > 0x7e || b < 0x21) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
		else out += String.fromCharCode(b);
	}
	return out;
}

// Does the rule pattern match the path from its first octet? `*` is any run of octets, a final `$` the end of the path.
export function patternMatches(pattern: string, path: string): boolean {
	const anchored = pattern.endsWith("$");
	const body = normalisePath(anchored ? pattern.slice(0, -1) : pattern);
	const target = normalisePath(path);
	const parts = body.split("*");
	const first = parts[0] ?? "";
	if (!target.startsWith(first)) return false;
	if (parts.length === 1) return anchored ? target === first : true;
	let at = first.length;
	for (let i = 1; i < parts.length; i++) {
		const part = parts[i] ?? "";
		const last = i === parts.length - 1;
		if (last && anchored) return target.length - part.length >= at && target.endsWith(part);
		const found = target.indexOf(part, at);
		if (found < 0) return false;
		at = found + part.length;
	}
	return true;
}

// RFC 9309 verdict for `path` (path plus query) and a crawler identified by `tokens`, most specific first: the first
// token with a named group decides, then the `*` group.
export function robotsVerdict(robots: ParsedRobots, tokens: string[], path: string): RobotsVerdict {
	if (path === "/robots.txt") return { allowed: true, group: null, rule: null };
	let applied: { group: string; rules: RobotsRule[] } | null = null;
	for (const t of tokens) {
		const r = rulesFor(robots, t);
		if (r && r.group !== "*") {
			applied = r;
			break;
		}
		applied ??= r;
	}
	if (!applied) return { allowed: true, group: null, rule: null };
	let best: RobotsRule | null = null;
	for (const rule of applied.rules) {
		if (!rule.path || !patternMatches(rule.path, path)) continue;
		const len = normalisePath(rule.path).length;
		const bestLen = best ? normalisePath(best.path).length : -1;
		if (len > bestLen || (len === bestLen && rule.allow && best && !best.allow)) best = rule;
	}
	return { allowed: best ? best.allow : true, group: applied.group, rule: best };
}
