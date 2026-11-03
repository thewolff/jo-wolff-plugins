// SSRF guard and request budget (plan section 3). Every request the skill makes, and every request Chrome or
// Lighthouse makes through the guard proxy, is checked here first: a target that resolves to a loopback, private,
// link-local or otherwise non-public address is refused unless `--allow-local` names its origin exactly. Cloud
// metadata endpoints are refused even when named: no audit needs them.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type AddressClass = "public" | "loopback" | "private" | "link-local" | "metadata" | "reserved";

export interface GuardDecision {
	allowed: boolean;
	reason: string;
	addresses: string[];
}

export interface Refusal {
	at: string;
	target: string;
	via: "fetch" | "proxy-http" | "proxy-connect" | "proxy-limit";
	reason: string;
}

export type Resolver = (host: string) => Promise<string[]>;

const METADATA_HOSTS: Record<string, true> = {
	"metadata.google.internal": true,
	metadata: true,
	"instance-data": true,
	"instance-data.ec2.internal": true,
};
const METADATA_IPS: Record<string, true> = {
	"169.254.169.254": true,
	"169.254.170.2": true,
	"100.100.100.200": true,
	"fd00:ec2::254": true,
};

function v4Octets(ip: string): number[] | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
	return n.every((x) => x >= 0 && x <= 255) ? n : null;
}

function classifyV4(o: number[]): AddressClass {
	const [a, b] = [o[0] ?? 0, o[1] ?? 0];
	if (a === 127) return "loopback";
	if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
	if (a === 100 && b >= 64 && b <= 127) return "private"; // carrier-grade NAT, RFC 6598
	if (a === 169 && b === 254) return "link-local";
	if (a === 0 || a >= 224) return "reserved"; // this-network, multicast, reserved, broadcast
	if (a === 192 && b === 0 && o[2] === 0) return "reserved"; // IETF protocol assignments
	if (a === 198 && (b === 18 || b === 19)) return "reserved"; // benchmarking
	return "public";
}

// Expands an IPv6 literal to eight 16-bit groups; an embedded dotted IPv4 tail becomes the last two groups.
function v6Groups(ip: string): number[] | null {
	let s = ip.toLowerCase();
	const zone = s.indexOf("%");
	if (zone >= 0) s = s.slice(0, zone);
	const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (tail?.[1]) {
		const o = v4Octets(tail[1]);
		if (!o) return null;
		s = `${s.slice(0, -tail[1].length)}${((o[0] ?? 0) * 256 + (o[1] ?? 0)).toString(16)}:${((o[2] ?? 0) * 256 + (o[3] ?? 0)).toString(16)}`;
	}
	const halves = s.split("::");
	if (halves.length > 2) return null;
	const parse = (h: string | undefined) => (h ? h.split(":").map((g) => Number.parseInt(g, 16)) : []);
	const head = parse(halves[0]);
	const rest = parse(halves[1]);
	const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
	const groups = [...head, ...Array<number>(Math.max(fill, 0)).fill(0), ...rest];
	if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
	return groups;
}

export function classifyAddress(ip: string): AddressClass {
	if (METADATA_IPS[ip.toLowerCase()]) return "metadata";
	const o = v4Octets(ip);
	if (o) return classifyV4(o);
	const g = v6Groups(ip);
	if (!g) return "reserved";
	const embedded = [(g[6] ?? 0) >> 8, (g[6] ?? 0) & 255, (g[7] ?? 0) >> 8, (g[7] ?? 0) & 255];
	const v4 = embedded.join(".");
	if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return METADATA_IPS[v4] ? "metadata" : classifyV4(embedded); // ::ffff:a.b.c.d
	if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return METADATA_IPS[v4] ? "metadata" : classifyV4(embedded); // NAT64
	if (g.slice(0, 7).every((x) => x === 0)) return g[7] === 1 ? "loopback" : "reserved"; // ::1, ::
	const first = g[0] ?? 0;
	if ((first & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique local
	if ((first & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
	if ((first & 0xff00) === 0xff00) return "reserved"; // multicast
	return "public";
}

const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function bareHost(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

// A loopback fixture origin: plain http on 127.0.0.1, ::1 or localhost. `--chrome-no-sandbox` is accepted only when
// every target and every `--allow-local` origin is one.
export function isLoopbackFixtureOrigin(origin: string): boolean {
	let u: URL;
	try {
		u = new URL(origin);
	} catch {
		return false;
	}
	const host = bareHost(u.hostname);
	return (u.protocol === "http:" || u.protocol === "https:") && (host === "localhost" || (isIP(host) > 0 && classifyAddress(host) === "loopback"));
}

export class Guard {
	readonly refusals: Refusal[] = [];
	private readonly allowed: Record<string, true> = {};
	private readonly allowedHostPorts: Record<string, true> = {};
	private readonly resolve: Resolver;

	constructor(allowLocal: string[], resolve: Resolver = systemResolver) {
		for (const o of allowLocal) {
			const u = new URL(o);
			this.allowed[u.origin] = true;
			this.allowedHostPorts[`${bareHost(u.hostname)}:${u.port || (u.protocol === "https:" ? "443" : "80")}`] = true;
		}
		this.resolve = resolve;
	}

	// Checks a destination given as host and port (a CONNECT target, or a URL's authority). `origin` is set when the
	// scheme is known; a CONNECT target matches an allowed origin by host and port alone.
	async checkHostPort(hostname: string, port: string, origin: string | null): Promise<GuardDecision> {
		const host = bareHost(hostname).toLowerCase();
		if (METADATA_HOSTS[host]) return { allowed: false, reason: `metadata host ${host}`, addresses: [] };
		let addresses: string[];
		if (isIP(host)) addresses = [host];
		else {
			try {
				addresses = await this.resolve(host);
			} catch (e) {
				return { allowed: false, reason: `DNS lookup failed for ${host}: ${String(e)}`, addresses: [] };
			}
		}
		if (!addresses.length) return { allowed: false, reason: `no address for ${host}`, addresses };
		const named = origin ? this.allowed[origin] === true : this.allowedHostPorts[`${host}:${port}`] === true;
		for (const a of addresses) {
			const c = classifyAddress(a);
			if (c === "metadata") return { allowed: false, reason: `${host} resolves to metadata address ${a}`, addresses };
			if (c !== "public" && !named)
				return { allowed: false, reason: `${host} resolves to ${c} address ${a}; not named by --allow-local`, addresses };
		}
		return { allowed: true, reason: named ? "named by --allow-local" : "public", addresses };
	}

	async check(target: string | URL): Promise<GuardDecision> {
		let u: URL;
		try {
			u = new URL(target);
		} catch {
			return { allowed: false, reason: `not a URL: ${String(target)}`, addresses: [] };
		}
		if (u.protocol !== "http:" && u.protocol !== "https:")
			return { allowed: false, reason: `scheme ${u.protocol} is not http or https`, addresses: [] };
		if (u.username || u.password) return { allowed: false, reason: "URL carries credentials", addresses: [] };
		return this.checkHostPort(u.hostname, u.port || (u.protocol === "https:" ? "443" : "80"), u.origin);
	}

	refuse(target: string, via: Refusal["via"], reason: string): void {
		this.refusals.push({ at: new Date().toISOString(), target, via, reason });
	}
}

// The skill's own sequential fetches share one request budget (`--budget`, default 60).
export class Budget {
	used = 0;
	exhausted = 0;
	constructor(readonly max: number) {}

	take(): boolean {
		if (this.used >= this.max) {
			this.exhausted++;
			return false;
		}
		this.used++;
		return true;
	}
}
