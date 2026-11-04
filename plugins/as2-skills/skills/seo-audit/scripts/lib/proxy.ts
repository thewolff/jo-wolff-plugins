// The guard proxy (plan section 3). Every network request the audit makes goes through it: Chrome and Lighthouse are
// launched with `--proxy-server` pointing here (`browserFlags`), and the skill's own fetches (`fetchChain`) use it as
// their HTTP proxy. A plain HTTP request is checked by origin; a CONNECT tunnel by host and port after DNS resolution,
// and the upstream socket connects to the resolved address the guard approved (no second lookup, so a host cannot
// rebind between the check and the connection). HTTPS inside a tunnel is opaque, so the enforced limits are stated in
// proxy terms: at most `maxTransactions` transactions per run (one plain request or one CONNECT establishment each)
// and an idle timeout per tunnel. The run's wall clock is enforced by the caller, which kills the browser.
// When Chrome runs with a fixture-only exception (--chrome-no-sandbox, --chrome-trust-spki; Jo's ruling
// q-mv5ow6pae1fsow), the proxy refuses every destination that does not resolve to loopback only, so the exception never
// applies to a public subresource or redirect.
import { type Server, type Socket, connect, createServer } from "node:net";
import { type Guard, type GuardDecision, classifyAddress } from "./guard.ts";

export interface ProxyRunStats {
	label: string;
	transactions: number;
	refused: number;
}

const HEAD_LIMIT = 64 * 1024;

export class GuardProxy {
	port = 0;
	readonly runs: ProxyRunStats[] = [];
	private server: Server | null = null;
	private run: ProxyRunStats = { label: "default", transactions: 0, refused: 0 };
	private readonly sockets = new Set<Socket>();
	private loopbackOnly: string[] = []; // the fixture-only exception flags in force; non-empty means loopback only
	// What the proxy answered itself for the latest transaction: a guard refusal, or an error (a request it could not
	// forward, an upstream it could not reach). Every response the proxy writes itself sets one of the two.
	private outcome: { refused: string | null; error: string | null } = { refused: null, error: null };

	constructor(
		private readonly guard: Guard,
		private readonly maxTransactions = 300,
		private readonly idleMs = 30_000,
	) {
		this.runs.push(this.run);
	}

	// Starts counting a new render or Lighthouse run; the transaction cap applies per run.
	beginRun(label: string): ProxyRunStats {
		this.run = { label, transactions: 0, refused: 0 };
		this.runs.push(this.run);
		return this.run;
	}

	// The Chrome flags that send every request through this proxy (loopback included), plus the fixture-only exceptions
	// the caller asked for. Asking for an exception switches this proxy to loopback-only for the rest of its life, before
	// any browser holding the exception can send it a request.
	browserFlags(o: { noSandbox: boolean; trustSpki: string[] }): string[] {
		const exceptions = [...(o.noSandbox ? ["--chrome-no-sandbox"] : []), ...(o.trustSpki.length ? ["--chrome-trust-spki"] : [])];
		for (const e of exceptions) if (!this.loopbackOnly.includes(e)) this.loopbackOnly.push(e);
		return [
			`--proxy-server=http://127.0.0.1:${this.port}`,
			"--proxy-bypass-list=<-loopback>",
			...(o.noSandbox ? ["--no-sandbox"] : []),
			...(o.trustSpki.length ? [`--ignore-certificate-errors-spki-list=${o.trustSpki.join(",")}`] : []),
		];
	}

	// The latest transaction's guard refusal or proxy error, then cleared. Meaningful for a client that sends one
	// transaction at a time (fetchChain); a browser's concurrent transactions overwrite each other's.
	takeOutcome(): { refused: string | null; error: string | null } {
		const o = this.outcome;
		this.outcome = { refused: null, error: null };
		return o;
	}

	async start(): Promise<number> {
		const { promise, resolve, reject } = Promise.withResolvers<number>();
		const server = createServer((client) => this.onClient(client));
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			this.port = typeof addr === "object" && addr ? addr.port : 0;
			resolve(this.port);
		});
		this.server = server;
		return promise;
	}

	async stop(): Promise<void> {
		for (const s of this.sockets) s.destroy();
		this.sockets.clear();
		const server = this.server;
		if (!server) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		server.close(() => resolve());
		this.server = null;
		return promise;
	}

	private track(s: Socket): void {
		this.sockets.add(s);
		s.on("close", () => this.sockets.delete(s));
		s.on("error", () => s.destroy());
		s.setTimeout(this.idleMs, () => s.destroy());
	}

	private onClient(client: Socket): void {
		this.track(client);
		let buf = Buffer.alloc(0);
		// The head limit holds however the head arrives: in pieces with no end yet, or whole in one chunk.
		const onData = (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			const end = buf.indexOf("\r\n\r\n");
			if ((end < 0 ? buf.length : end) > HEAD_LIMIT) {
				client.off("data", onData);
				this.fail(client, "431 Request Header Fields Too Large", `request head exceeds ${HEAD_LIMIT} bytes`);
				return;
			}
			if (end < 0) return;
			client.off("data", onData);
			client.pause();
			void this.handle(client, buf.subarray(0, end).toString("latin1"), buf.subarray(end + 4));
		};
		client.on("data", onData);
	}

	private deny(client: Socket, status: string, target: string, via: "proxy-http" | "proxy-connect" | "proxy-limit", reason: string): void {
		this.run.refused++;
		this.outcome.refused = reason;
		this.guard.refuse(target, via, reason);
		client.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nseo-audit guard proxy: ${reason}\n`);
	}

	// A transaction the proxy cannot forward for a reason other than the guard: answered by the proxy itself and recorded
	// as the transaction's error, so a client never reads the answer as the destination's.
	private fail(client: Socket, status: string, reason: string): void {
		this.outcome.error = `guard proxy: ${reason}`;
		if (!client.destroyed) client.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nseo-audit guard proxy: ${reason}\n`);
	}

	// The guard's decision, narrowed to loopback-only destinations while a fixture-only Chrome exception is in force.
	private decide(host: string, d: GuardDecision): GuardDecision {
		if (!d.allowed || !this.loopbackOnly.length) return d;
		const outside = d.addresses.find((a) => classifyAddress(a) !== "loopback");
		if (outside === undefined) return d;
		const flags = this.loopbackOnly.join(" and ");
		return {
			allowed: false,
			reason: `${host} resolves to ${classifyAddress(outside)} address ${outside}; ${flags} ${this.loopbackOnly.length > 1 ? "allow" : "allows"} loopback destinations only`,
			addresses: d.addresses,
		};
	}

	private async handle(client: Socket, head: string, rest: Buffer): Promise<void> {
		const lines = head.split("\r\n");
		const [method = "", target = "", version = "HTTP/1.1"] = (lines[0] ?? "").split(" ");
		this.run.transactions++;
		const via = method === "CONNECT" ? "proxy-connect" : "proxy-http";
		if (this.run.transactions > this.maxTransactions) {
			this.deny(client, "403 Forbidden", target, "proxy-limit", `transaction ${this.run.transactions} exceeds the ${this.maxTransactions} per run`);
			return;
		}
		if (method === "CONNECT") {
			const m = target.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
			if (!m?.[1] || !m[2]) {
				this.deny(client, "400 Bad Request", target, via, "malformed CONNECT target");
				return;
			}
			const decision = this.decide(m[1], await this.guard.checkHostPort(m[1], m[2], null));
			if (!decision.allowed) {
				this.deny(client, "403 Forbidden", target, via, decision.reason);
				return;
			}
			this.pipe(client, decision.addresses, Number(m[2]), "HTTP/1.1 200 Connection Established\r\n\r\n", null, rest);
			return;
		}
		let url: URL;
		try {
			url = new URL(target);
		} catch {
			this.deny(client, "400 Bad Request", target, via, "proxy request is not in absolute form");
			return;
		}
		if (url.protocol !== "http:") {
			this.deny(client, "400 Bad Request", target, via, `scheme ${url.protocol} over a plain proxy request`);
			return;
		}
		const decision = this.decide(url.hostname, await this.guard.check(url));
		if (!decision.allowed) {
			this.deny(client, "403 Forbidden", target, via, decision.reason);
			return;
		}
		const headers = lines
			.slice(1)
			.filter((l) => !/^(proxy-connection|proxy-authorization|connection|keep-alive)\s*:/i.test(l));
		const upstreamHead = [`${method} ${url.pathname}${url.search} ${version}`, ...headers, "Connection: close", "", ""].join("\r\n");
		this.pipe(client, decision.addresses, Number(url.port || 80), null, upstreamHead, rest);
	}

	// Connects to the approved addresses in order (e.g. ::1 then 127.0.0.1 for localhost), never to a fresh lookup. The
	// guard never approves a destination without an address.
	private pipe(client: Socket, addresses: string[], port: number, reply: string | null, upstreamHead: string | null, rest: Buffer): void {
		const [address = "", ...others] = addresses;
		const upstream = connect({ host: address, port });
		let connected = false;
		this.track(upstream);
		upstream.once("connect", () => {
			connected = true;
			if (reply) client.write(reply);
			if (upstreamHead) upstream.write(upstreamHead, "latin1");
			if (rest.length) upstream.write(rest);
			client.pipe(upstream);
			upstream.pipe(client);
			client.resume();
		});
		upstream.once("error", (e) => {
			if (!connected && others.length) this.pipe(client, others, port, reply, upstreamHead, rest);
			else if (!connected) this.fail(client, "502 Bad Gateway", `could not connect to ${address.includes(":") ? `[${address}]` : address}:${port}: ${e.message}`);
			// After the connection, the destination's bytes are already relayed: closing the client cuts its response
			// short as a transport error, where an appended status line would read as part of it.
			else client.destroy();
		});
		upstream.once("close", () => {
			if (connected) client.end();
		});
		client.once("close", () => upstream.destroy());
	}
}
