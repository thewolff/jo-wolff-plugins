// Unit tests for the evidence engine's hand-written parsers and its safety boundary: the RFC 9309 robots matcher
// (against the RFC's own examples, references/research/fetch-rfc9309.md sections 2.2.1, 2.2.2 and 5), the sitemap
// XML tokenizer, the head scanner, the Link header parser, the SSRF guard, the guard proxy and the
// --chrome-no-sandbox refusal. Everything runs offline against loopback servers on ephemeral ports.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { type AddressInfo, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { UsageError, parseArgs } from "../scripts/audit.ts";
import { type EngineResult, type Hit, type RuleContext, runRules } from "../scripts/lib/engine.ts";
import { type Evidence, type LayerEvidence, type PageEvidence, collect } from "../scripts/lib/evidence.ts";
import { type FetchResult, fetchChain } from "../scripts/lib/fetch.ts";
import { Budget, Guard, classifyAddress, isLoopbackFixtureOrigin } from "../scripts/lib/guard.ts";
import { extractSignals, scanHead } from "../scripts/lib/html.ts";
import { extractJsonLd } from "../scripts/lib/jsonld.ts";
import { GuardProxy } from "../scripts/lib/proxy.ts";
import { type RenderedMedia, type RenderedPage, chromeFlags, recordingKey, saveRecording } from "../scripts/lib/render.ts";
import { WriteRefused, renderReport, verdictOf, writeAt, writeOutputs } from "../scripts/lib/report.ts";
import { normalisePath, parseRobots, patternMatches, robotsVerdict } from "../scripts/lib/robots.ts";
import { NS, W3C_DATETIME, XmlError, parseSitemap, parseXml } from "../scripts/lib/sitemap.ts";
import { parseLinkHeader } from "../scripts/lib/url.ts";
import { rules as perfRules } from "../scripts/rules/perf-framework.ts";
import { runAudit } from "./harness.ts";

describe("robots.txt matcher (RFC 9309)", () => {
	// Section 5.1, verbatim.
	const simple = parseRobots(
		[
			"User-Agent: *",
			"Disallow: *.gif$",
			"Disallow: /example/",
			"Allow: /publications/",
			"",
			"User-Agent: foobot",
			"Disallow:/",
			"Allow:/example/page.html",
			"Allow:/example/allowed.gif",
			"",
			"User-Agent: barbot",
			"User-Agent: bazbot",
			"Disallow: /example/page.html",
			"",
			"User-Agent: quxbot",
			"",
			"EOF",
		].join("\n"),
	);
	const allowed = (token: string, path: string) => robotsVerdict(simple, [token], path).allowed;

	test("5.1: the * group applies to crawlers without a group", () => {
		expect(allowed("otherbot", "/publications/a.html")).toBe(true);
		expect(allowed("otherbot", "/example/x.html")).toBe(false);
		expect(allowed("otherbot", "/images/a.gif")).toBe(false);
		expect(allowed("otherbot", "/images/a.gif?x=1")).toBe(true); // `$` anchors the end of the path and query
		expect(allowed("otherbot", "/about")).toBe(true);
	});

	test("5.1: foobot reaches only its two allowed paths", () => {
		expect(allowed("foobot", "/example/page.html")).toBe(true);
		expect(allowed("foobot", "/example/allowed.gif")).toBe(true);
		expect(allowed("foobot", "/example/other.html")).toBe(false);
		expect(allowed("foobot", "/")).toBe(false);
	});

	test("5.1: a group with two user-agent lines applies to both", () => {
		expect(allowed("barbot", "/example/page.html")).toBe(false);
		expect(allowed("bazbot", "/example/page.html")).toBe(false);
		expect(allowed("bazbot", "/example/other.html")).toBe(true);
	});

	test("5.1: an empty group at the end of the file allows everything", () => {
		expect(allowed("quxbot", "/example/page.html")).toBe(true);
		expect(robotsVerdict(simple, ["quxbot"], "/x").group).toBe("quxbot");
	});

	test("user-agent matching is case-insensitive", () => {
		expect(allowed("FooBot", "/example/other.html")).toBe(false);
	});

	test("5.2: the longest match wins", () => {
		const r = parseRobots("User-Agent: foobot\nAllow: /example/page/\nDisallow: /example/page/disallowed.gif\n");
		expect(robotsVerdict(r, ["foobot"], "/example/page/disallowed.gif").allowed).toBe(false);
		expect(robotsVerdict(r, ["foobot"], "/example/page/other.gif").allowed).toBe(true);
	});

	test("2.2.2: an allow and an equivalent disallow resolve to allow", () => {
		const r = parseRobots("User-agent: *\nDisallow: /page\nAllow: /page\n");
		expect(robotsVerdict(r, ["Googlebot"], "/page").allowed).toBe(true);
	});

	test("Figure 2: groups naming the same product token are merged", () => {
		const r = parseRobots("user-agent: ExampleBot\ndisallow: /foo\ndisallow: /bar\n\nuser-agent: ExampleBot\ndisallow: /baz\n");
		for (const p of ["/foo", "/bar", "/baz"]) expect(robotsVerdict(r, ["ExampleBot"], p).allowed).toBe(false);
		expect(robotsVerdict(r, ["ExampleBot"], "/qux").allowed).toBe(true);
	});

	test("Figure 3: without a matching group the * group applies, not another bot's", () => {
		const r = parseRobots("user-agent: *\ndisallow: /foo\ndisallow: /bar\n\nuser-agent: BazBot\ndisallow: /baz\n");
		expect(robotsVerdict(r, ["ExampleBot"], "/foo").allowed).toBe(false);
		expect(robotsVerdict(r, ["ExampleBot"], "/baz").allowed).toBe(true);
		expect(robotsVerdict(r, ["ExampleBot"], "/foo").group).toBe("*");
	});

	test("no group at all: no rules apply, and /robots.txt is implicitly allowed", () => {
		expect(robotsVerdict(parseRobots(""), ["Googlebot"], "/anything").allowed).toBe(true);
		const r = parseRobots("User-agent: *\nDisallow: /\n");
		expect(robotsVerdict(r, ["Googlebot"], "/robots.txt").allowed).toBe(true);
		expect(robotsVerdict(r, ["Googlebot"], "/index.html").allowed).toBe(false);
	});

	test("Figure 4: percent-encoding normalisation before comparison", () => {
		expect(normalisePath("/foo/bar?baz=quz")).toBe("/foo/bar?baz=quz");
		expect(normalisePath("/foo/bar/\u30c4")).toBe("/foo/bar/%E3%83%84");
		expect(normalisePath("/foo/bar/%e3%83%84")).toBe("/foo/bar/%E3%83%84");
		expect(normalisePath("/foo/bar/%62%61%7A")).toBe("/foo/bar/baz");
		expect(patternMatches("/foo/bar/%62%61%7A", "/foo/bar/baz")).toBe(true);
		expect(patternMatches("/foo/bar/\u30c4", "/foo/bar/%E3%83%84")).toBe(true);
	});

	test("matching starts at the first octet and is case-sensitive; * spans any octets", () => {
		expect(patternMatches("/fish", "/fish.html")).toBe(true);
		expect(patternMatches("/fish", "/Fish.html")).toBe(false);
		expect(patternMatches("/fish", "/catfish")).toBe(false);
		expect(patternMatches("/*.php$", "/a/b/index.php")).toBe(true);
		expect(patternMatches("/*.php$", "/index.php?x")).toBe(false);
	});

	test("the more specific token decides before the * group", () => {
		const r = parseRobots("User-agent: Googlebot-Image\nDisallow: /photos\n\nUser-agent: *\nDisallow: /\n");
		expect(robotsVerdict(r, ["Googlebot-Image", "Googlebot"], "/page").allowed).toBe(true);
		expect(robotsVerdict(r, ["Googlebot-Image", "Googlebot"], "/photos/1").allowed).toBe(false);
		expect(robotsVerdict(r, ["Googlebot"], "/page").allowed).toBe(false);
	});

	test("the parser records orphan rules, invalid paths, sitemaps and noindex lines with line numbers", () => {
		const r = parseRobots("Disallow: /early\nUser-agent: *\nDisallow: private\nNoindex: /x\nSitemap: /s.xml\n");
		expect(r.orphanRules.map((l) => l.line)).toEqual([1]);
		expect(r.invalidPaths.map((l) => [l.line, l.value])).toEqual([[3, "private"]]);
		expect(r.noindexLines.map((l) => l.line)).toEqual([4]);
		expect(r.sitemaps).toEqual([{ value: "/s.xml", line: 5 }]);
	});
});

describe("sitemap tokenizer", () => {
	test("resolves namespaces by prefix and default namespace", () => {
		const root = parseXml(
			`<?xml version="1.0"?>\n<urlset xmlns="${NS.sitemap}" xmlns:i="${NS.image}"><url><loc>http://a.test/</loc><i:image><i:loc>http://a.test/1.png</i:loc></i:image></url></urlset>`,
		);
		expect([root.ns, root.local]).toEqual([NS.sitemap, "urlset"]);
		const img = root.children[0]?.children[1];
		expect([img?.ns, img?.local]).toEqual([NS.image, "image"]);
	});

	test("decodes entities and CDATA and skips comments", () => {
		const root = parseXml(`<a><!-- note --><b>x &amp; y &#65;&#x42;<![CDATA[<raw>]]></b></a>`);
		expect(root.children[0]?.text).toBe("x & y AB<raw>");
	});

	test("reports the first well-formedness error with its line", () => {
		const cases: [string, number][] = [
			["<a>\n<b></a>", 2],
			["<a>\n\n</a><b/>", 3],
			["<a>&bogus;</a>", 1],
			["<a>\n<p:b/></a>", 2],
			["<a x='1' x='2'/>", 1],
		];
		for (const [doc, line] of cases) {
			let err: unknown = null;
			try {
				parseXml(doc);
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(XmlError);
			expect((err as XmlError).line).toBe(line);
		}
	});

	test("models urlset, sitemapindex and text sitemaps", () => {
		const set = parseSitemap(
			`<urlset xmlns="${NS.sitemap}">\n<url><loc> http://a.test/x </loc><lastmod>2024-01-02</lastmod></url>\n</urlset>`,
			"http://a.test/sitemap.xml",
		);
		expect(set.type).toBe("urlset");
		expect(set.urls[0]).toMatchObject({ loc: "http://a.test/x", lastmod: "2024-01-02", locLine: 2 });
		const index = parseSitemap(`<sitemapindex xmlns="${NS.sitemap}"><sitemap><loc>http://a.test/1.xml</loc></sitemap></sitemapindex>`, "http://a.test/i.xml");
		expect([index.type, index.sitemaps[0]?.loc]).toEqual(["sitemapindex", "http://a.test/1.xml"]);
		const text = parseSitemap("http://a.test/\n\nnot-a-url\n", "http://a.test/urls.txt");
		expect(text.type).toBe("text");
		expect(text.textLines).toEqual([
			{ line: 1, value: "http://a.test/" },
			{ line: 3, value: "not-a-url" },
		]);
		const broken = parseSitemap(`<urlset xmlns="${NS.sitemap}">\n<url><loc>x</url>`, "http://a.test/b.xml");
		expect(broken.error?.line).toBe(2);
	});

	test("W3C Datetime accepts the profile's forms only", () => {
		for (const ok of ["2024", "2024-05", "2024-05-01", "2024-05-01T10:00Z", "2024-05-01T10:00:30.5+01:00"]) expect(W3C_DATETIME.test(ok)).toBe(true);
		for (const bad of ["2024-13-01", "2024-05-01T10:00", "yesterday", "01/05/2024", "2024-05-01 10:00Z"]) expect(W3C_DATETIME.test(bad)).toBe(false);
	});
});

describe("head scanner", () => {
	test("the first element not valid in <head> ends it, and later head elements are ignored", () => {
		const s = scanHead(
			`<!doctype html>\n<html><head>\n<title>t</title>\n<link rel="canonical" href="/a">\n<div>x</div>\n<meta name="robots" content="noindex">\n</head><body><p>b</p></body></html>`,
		);
		expect(s.invalid?.name).toBe("div");
		expect(s.invalid?.line).toBe(5);
		expect(s.headEnd.reason).toBe("invalid-element");
		expect(s.ignoredAfterInvalid.map((t) => t.name)).toEqual(["meta"]);
		expect(s.tags.find((t) => t.name === "link")?.region).toBe("head");
		expect(s.tags.find((t) => t.name === "meta")?.region).toBe("body");
	});

	test("a clean head ends at </head> and keeps every element in head", () => {
		const s = scanHead(`<html><head><title>t</title><meta name="x" content="y"><script>var a="<div>";</script></head><body><div></div></body></html>`);
		expect(s.invalid).toBeNull();
		expect(s.headEnd.reason).toBe("end-tag");
		expect(s.tags.filter((t) => t.region === "head").map((t) => t.name)).toEqual(expect.arrayContaining(["title", "meta", "script"]));
		expect(s.tags.find((t) => t.name === "div")?.region).toBe("body");
	});

	test("non-whitespace text ends an implied head", () => {
		const s = scanHead(`<title>t</title>hello<link rel="canonical" href="/a">`);
		expect(s.headEnd.reason).toBe("text");
		expect(s.tags.find((t) => t.name === "link")?.region).toBe("body");
	});
});

describe("Link header parser (RFC 8288)", () => {
	test("splits entries and lowercases rel", () => {
		expect(parseLinkHeader('<https://a.test/x>; rel="Canonical", <https://a.test/de>; rel=alternate; hreflang="de"')).toEqual([
			{ href: "https://a.test/x", params: { rel: "canonical" } },
			{ href: "https://a.test/de", params: { rel: "alternate", hreflang: "de" } },
		]);
	});
	test("tolerates a missing header and commas inside the URI", () => {
		expect(parseLinkHeader(undefined)).toEqual([]);
		expect(parseLinkHeader("<https://a.test/a,b>; rel=canonical")[0]?.href).toBe("https://a.test/a,b");
	});
});

describe("SSRF guard", () => {
	test("classifies addresses", () => {
		const cases: [string, string][] = [
			["127.0.0.1", "loopback"],
			["::1", "loopback"],
			["10.1.2.3", "private"],
			["172.16.0.1", "private"],
			["172.32.0.1", "public"],
			["192.168.1.1", "private"],
			["100.64.0.1", "private"],
			["169.254.1.1", "link-local"],
			["169.254.169.254", "metadata"],
			["100.100.100.200", "metadata"],
			["fd00:ec2::254", "metadata"],
			["::ffff:169.254.169.254", "metadata"],
			["::ffff:10.0.0.1", "private"],
			["fd12:3456::1", "private"],
			["fe80::1", "link-local"],
			["0.0.0.0", "reserved"],
			["::", "reserved"],
			["8.8.8.8", "public"],
			["2001:4860:4860::8888", "public"],
		];
		for (const [ip, cls] of cases) expect(`${ip} ${classifyAddress(ip)}`).toBe(`${ip} ${cls}`);
	});

	test("refuses private, loopback and metadata targets unless --allow-local names them; metadata always", async () => {
		const resolver = async (host: string) => ({ "intranet.test": ["10.0.0.7"], "public.test": ["93.184.215.14"], "rebind.test": ["93.184.215.14", "127.0.0.1"] })[host] ?? [];
		const g = new Guard(["http://intranet.test:8080", "http://169.254.169.254"], resolver);
		expect((await g.check("http://public.test/")).allowed).toBe(true);
		expect((await g.check("http://intranet.test:8080/x")).allowed).toBe(true);
		expect((await g.check("http://intranet.test/x")).allowed).toBe(false); // other port: not the named origin
		expect((await g.check("http://rebind.test/")).reason).toContain("loopback");
		expect((await g.check("http://127.0.0.1:9/")).allowed).toBe(false);
		expect((await g.check("http://169.254.169.254/latest/meta-data/")).reason).toContain("metadata");
		expect((await g.check("http://metadata.google.internal/")).allowed).toBe(false);
		expect((await g.check("file:///etc/passwd")).allowed).toBe(false);
		expect((await g.check("http://user:pw@public.test/")).allowed).toBe(false);
	});

	test("loopback fixture origins", () => {
		for (const o of ["http://127.0.0.1:47101", "http://localhost:8080", "http://[::1]:3000", "https://127.0.0.1:47209"]) expect(isLoopbackFixtureOrigin(o)).toBe(true);
		for (const o of ["http://10.0.0.5:8080", "https://example.com", "http://127.0.0.1.nip.io", "ftp://127.0.0.1"]) expect(isLoopbackFixtureOrigin(o)).toBe(false);
	});
});

// Two loopback servers: `allowed` is named by --allow-local, `forbidden` is not. Every test below must leave the
// forbidden server's hit counter at zero.
describe("guard boundary on the wire", () => {
	let allowed: Server<undefined>;
	let forbidden: Server<undefined>;
	let forbiddenHits = 0;
	let allowedOrigin = "";
	let forbiddenOrigin = "";
	beforeAll(() => {
		forbidden = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch() {
				forbiddenHits++;
				return new Response("secret");
			},
		});
		forbiddenOrigin = `http://127.0.0.1:${forbidden.port}`;
		allowed = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req) {
				const path = new URL(req.url).pathname;
				if (path === "/to-forbidden") return new Response(null, { status: 302, headers: { location: `${forbiddenOrigin}/` } });
				if (path === "/to-private") return new Response(null, { status: 301, headers: { location: "http://10.255.255.1/admin" } });
				if (path === "/to-metadata") return new Response(null, { status: 301, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
				return new Response("ok");
			},
		});
		allowedOrigin = `http://127.0.0.1:${allowed.port}`;
	});
	afterAll(() => {
		allowed.stop(true);
		forbidden.stop(true);
	});

	test("fetchChain refuses a redirect hop to a private address before connecting", async () => {
		const guard = new Guard([allowedOrigin]);
		const r = await fetchChain(`${allowedOrigin}/to-private`, { guard, budget: new Budget(10) });
		expect(r.hops.map((h) => h.status)).toEqual([301]);
		expect(r.refused).toContain("private");
		expect(guard.refusals[0]).toMatchObject({ target: "http://10.255.255.1/admin", via: "fetch" });
	});

	test("fetchChain refuses a redirect hop to a metadata address", async () => {
		const guard = new Guard([allowedOrigin]);
		const r = await fetchChain(`${allowedOrigin}/to-metadata`, { guard, budget: new Budget(10) });
		expect(r.refused).toContain("metadata");
	});

	test("fetchChain refuses a redirect to an unnamed loopback origin", async () => {
		const guard = new Guard([allowedOrigin]);
		const r = await fetchChain(`${allowedOrigin}/to-forbidden`, { guard, budget: new Budget(10) });
		expect(r.refused).toContain("not named by --allow-local");
		expect(r.status).toBeNull();
	});

	test("the budget stops the skill's own fetches", async () => {
		const guard = new Guard([allowedOrigin]);
		const budget = new Budget(1);
		expect((await fetchChain(`${allowedOrigin}/a`, { guard, budget })).status).toBe(200);
		const second = await fetchChain(`${allowedOrigin}/b`, { guard, budget });
		expect([second.budgetExhausted, second.status]).toEqual([true, null]);
	});

	// DNS rebinding: the guard's lookup answers a public address, and any later lookup answers loopback. `localhost`
	// resolves to loopback for the system resolver, so a fetch that resolves again at connect time reaches `forbidden`.
	test("fetchChain refuses a host that rebinds to loopback after the guard approved it", async () => {
		let lookups = 0;
		const guard = new Guard([], async () => (lookups++ === 0 ? ["203.0.113.7"] : ["127.0.0.1"]));
		const hits = forbiddenHits;
		const r = await fetchChain(`http://localhost:${forbidden.port}/`, { guard, budget: new Budget(10), timeoutMs: 3000 });
		expect(forbiddenHits).toBe(hits);
		expect(r.status).toBeNull();
		expect(r.refused).toContain("resolves to loopback address 127.0.0.1");
		expect(guard.refusals.at(-1)).toMatchObject({ target: `http://localhost:${forbidden.port}/`, via: "proxy-http" });
	});

	// Pinning: the guard approves ::1 for an --allow-local localhost origin, while `forbidden` listens on 127.0.0.1 only,
	// which a fresh system lookup of localhost also answers. A pinned connection to [::1] is refused at once.
	test("fetchChain connects only to the address the guard approved, never to a fresh lookup", async () => {
		const guard = new Guard([`http://localhost:${forbidden.port}`], async () => ["::1"]);
		const hits = forbiddenHits;
		const r = await fetchChain(`http://localhost:${forbidden.port}/`, { guard, budget: new Budget(10), timeoutMs: 3000 });
		expect(forbiddenHits).toBe(hits);
		expect(r.status).toBeNull();
		expect(r.hops).toEqual([]);
		expect(r.error).toContain(`could not connect to [::1]:${forbidden.port}`);
	});

	// A response the proxy writes itself (here 431 for a request head over its limit) is the proxy's answer, never the
	// site's: no status, no hop, and an error or refusal naming the proxy.
	test("fetchChain never records a proxy-generated response as the site's status or a hop", async () => {
		const guard = new Guard([allowedOrigin]);
		const r = await fetchChain(`${allowedOrigin}/${"a".repeat(100_000)}`, { guard, budget: new Budget(10), timeoutMs: 3000 });
		expect(r.status).toBeNull();
		expect(r.hops).toEqual([]);
		expect(r.error ?? r.refused ?? "").toContain("guard proxy");
	});

	// Sends one raw request through the proxy and returns everything the proxy answers.
	async function viaProxy(port: number, head: string): Promise<string> {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const chunks: Buffer[] = [];
		const s = connect(port, "127.0.0.1", () => s.write(head));
		s.on("data", (c: Buffer) => chunks.push(c));
		s.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
		s.on("error", reject);
		return promise;
	}
	const get = (url: string) => `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nConnection: close\r\n\r\n`;

	// The proxy's first answer line, or "" when it has not answered within `ms`. The wall-clock bound is deliberate: the
	// failure it detects is a proxy that is still connecting to an unroutable address, which emits no event to await.
	async function firstLine(port: number, head: string, ms = 1500): Promise<string> {
		const { promise, resolve } = Promise.withResolvers<string>();
		let buf = "";
		const s = connect(port, "127.0.0.1", () => s.write(head));
		const done = () => {
			clearTimeout(timer);
			s.destroy();
			resolve(buf.split("\r\n")[0] ?? "");
		};
		const timer = setTimeout(done, ms);
		s.on("data", (c: Buffer) => {
			buf += c.toString("latin1");
			if (buf.includes("\r\n")) done();
		});
		s.on("close", done);
		s.on("error", done);
		return promise;
	}

	// Jo's ruling q-mv5ow6pae1fsow: --chrome-no-sandbox and --chrome-trust-spki are fixtures-only, so once Chrome is
	// launched with either, the proxy refuses every destination that is not loopback, public ones included.
	for (const [flag, exceptions] of [
		["--chrome-no-sandbox", { noSandbox: true, trustSpki: [] }],
		["--chrome-trust-spki", { noSandbox: false, trustSpki: [`${"A".repeat(43)}=`] }],
	] as const) {
		test(`with ${flag} in Chrome's flags the proxy refuses every non-loopback destination`, async () => {
			const guard = new Guard([allowedOrigin], async () => ["203.0.113.7"]);
			const proxy = new GuardProxy(guard);
			const port = await proxy.start();
			try {
				const flags = chromeFlags({ chromePath: "", proxy, noSandbox: exceptions.noSandbox, trustSpki: [...exceptions.trustSpki] }, "/nonexistent-profile");
				expect(flags).toContain(exceptions.noSandbox ? "--no-sandbox" : `--ignore-certificate-errors-spki-list=${exceptions.trustSpki[0]}`);
				expect(await firstLine(port, "CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n")).toBe("HTTP/1.1 403 Forbidden");
				expect(await firstLine(port, get("http://public.example/"))).toBe("HTTP/1.1 403 Forbidden");
				expect(guard.refusals.map((r) => [r.via, r.reason])).toEqual([
					["proxy-connect", `public.example resolves to public address 203.0.113.7; ${flag} allows loopback destinations only`],
					["proxy-http", `public.example resolves to public address 203.0.113.7; ${flag} allows loopback destinations only`],
				]);
				expect(await viaProxy(port, get(`${allowedOrigin}/page`))).toMatch(/^HTTP\/1\.1 200[\s\S]*ok$/);
			} finally {
				await proxy.stop();
			}
		});
	}

	test("the proxy forwards an allowed plain request and refuses an unnamed origin", async () => {
		const guard = new Guard([allowedOrigin]);
		const proxy = new GuardProxy(guard);
		const port = await proxy.start();
		try {
			expect(await viaProxy(port, get(`${allowedOrigin}/page`))).toMatch(/^HTTP\/1\.1 200[\s\S]*ok$/);
			expect(await viaProxy(port, get(`${forbiddenOrigin}/`))).toStartWith("HTTP/1.1 403");
			expect(await viaProxy(port, get("http://169.254.169.254/latest/meta-data/"))).toStartWith("HTTP/1.1 403");
			expect(guard.refusals.map((r) => r.via)).toEqual(["proxy-http", "proxy-http"]);
		} finally {
			await proxy.stop();
		}
	});

	test("the proxy refuses CONNECT to unnamed, private and metadata destinations", async () => {
		const guard = new Guard([allowedOrigin]);
		const proxy = new GuardProxy(guard);
		const port = await proxy.start();
		try {
			for (const target of [`127.0.0.1:${forbidden.port}`, "10.0.0.1:443", "169.254.169.254:80", "[::1]:443"]) {
				const answer = await viaProxy(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
				expect(`${target} ${answer.split("\r\n")[0]}`).toBe(`${target} HTTP/1.1 403 Forbidden`);
			}
			expect(guard.refusals.every((r) => r.via === "proxy-connect")).toBe(true);
		} finally {
			await proxy.stop();
		}
	});

	test("the proxy refuses transaction 301 of a run, and a new run starts a new count", async () => {
		const guard = new Guard([allowedOrigin]);
		const proxy = new GuardProxy(guard);
		const port = await proxy.start();
		try {
			for (let batch = 0; batch < 300; batch += 50) {
				const answers = await Promise.all(Array.from({ length: 50 }, (_, i) => viaProxy(port, get(`${allowedOrigin}/n${batch + i}`))));
				expect(answers.every((a) => a.startsWith("HTTP/1.1 200"))).toBe(true);
			}
			const over = await viaProxy(port, get(`${allowedOrigin}/n300`));
			expect(over).toStartWith("HTTP/1.1 403");
			expect(over).toContain("transaction 301 exceeds the 300 per run");
			expect(guard.refusals).toHaveLength(1);
			expect(guard.refusals[0]?.via).toBe("proxy-limit");
			proxy.beginRun("second");
			expect(await viaProxy(port, get(`${allowedOrigin}/again`))).toStartWith("HTTP/1.1 200");
		} finally {
			await proxy.stop();
		}
	});

	test("no request reached the unnamed origin", () => {
		expect(forbiddenHits).toBe(0);
	});
});

describe("--chrome-no-sandbox refusal", () => {
	const loopback = ["--url", "http://127.0.0.1:47101/", "--allow-local", "http://127.0.0.1:47101", "--chrome-no-sandbox"];

	test("parseArgs accepts it when every --url and --allow-local origin is loopback", () => {
		expect(parseArgs(loopback, {}).collect.chromeNoSandbox).toBe(true);
	});

	test("parseArgs refuses it for a public --url or a non-loopback --allow-local origin", () => {
		expect(() => parseArgs(["--url", "https://example.com/", "--chrome-no-sandbox"], {})).toThrow(UsageError);
		expect(() => parseArgs([...loopback, "--allow-local", "http://10.0.0.5:8080"], {})).toThrow(/^refused: --chrome-no-sandbox/);
		expect(() => parseArgs([...loopback, "--url", "https://example.com/"], {})).toThrow(/not loopback: https:\/\/example\.com/);
	});

	test("audit.ts exits 2 with the refusal and fetches nothing", async () => {
		const r = await runAudit(["--url", "https://example.com/", "--chrome-no-sandbox", "--no-lighthouse"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toStartWith("refused: --chrome-no-sandbox");
		expect(r.stdout).toBe("");
	});
});

describe("--chrome-trust-spki refusal", () => {
	const spki = `${"A".repeat(43)}=`;
	const loopback = ["--url", "https://127.0.0.1:47220/", "--allow-local", "https://127.0.0.1:47220", "--chrome-trust-spki", spki];

	test("parseArgs accepts it when every --url and --allow-local origin is loopback", () => {
		expect(parseArgs(loopback, {}).collect.chromeTrustSpki).toEqual([spki]);
	});

	test("parseArgs refuses it for a public --url or a non-loopback --allow-local origin, and a malformed hash", () => {
		expect(() => parseArgs(["--url", "https://example.com/", "--chrome-trust-spki", spki], {})).toThrow(/^refused: --chrome-trust-spki/);
		expect(() => parseArgs([...loopback, "--allow-local", "https://10.0.0.5:8443"], {})).toThrow(/not loopback: https:\/\/10\.0\.0\.5:8443/);
		expect(() => parseArgs([...loopback, "--chrome-trust-spki", "not-a-hash"], {})).toThrow(/base64 SHA-256 SPKI hash/);
	});
});

describe("argument parsing", () => {
	test("outputs default to $TMPDIR/seo-audit/<host>-<UTC timestamp>", () => {
		const a = parseArgs(["--url", "https://shop.example:8443/x"], { TMPDIR: "/tmp/t" }, new Date("2026-03-04T05:06:07Z"));
		expect(a.out).toMatch(/^\/tmp\/t\/seo-audit\/shop\.example_8443-20260304T050607Z$/);
	});

	test("--out inside --repo is refused", () => {
		expect(() => parseArgs(["--url", "https://a.example/", "--repo", "/tmp/proj", "--out", "/tmp/proj/out"], {})).toThrow(/inside the audited project/);
	});

	test("every write destination inside --repo is refused, through symlinks and for children named ..x", () => {
		const root = mkdtempSync(join(tmpdir(), "seo-audit-units-repo-"));
		const repo = join(root, "proj");
		mkdirSync(repo);
		symlinkSync(repo, join(root, "link"));
		try {
			const base = ["--url", "https://a.example/", "--repo", repo];
			for (const extra of [
				["--out", join(repo, "..cache")],
				["--out", join(root, "link", "out")],
				["--out", repo],
				["--record-rendered", join(repo, "rendered")],
				["--record-lhr", join(repo, "package.json")],
				["--record-lhr", join(root, "link", "nested", "lhr.json")],
			])
				expect(() => parseArgs([...base, ...extra], {})).toThrow(new RegExp(`^${extra[0]} .* is inside the audited project`));
			expect(() => parseArgs(["--url", "https://a.example/", "--repo", join(root, "link")], { TMPDIR: join(repo, "tmp") })).toThrow(
				/^--out .* is inside the audited project/,
			);
			const ok = parseArgs([...base, "--out", join(root, "out"), "--record-rendered", join(root, "..rendered"), "--record-lhr", join(repo, "..", "lhr.json")], {});
			expect(ok.out).toBe(join(root, "out"));
			expect(ok.collect.render.recordTo).toBe(join(root, "..rendered"));
			expect(ok.collect.lighthouse.recordTo).toBe(join(root, "lhr.json"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// One real collection of a port-0 page (no render, no Lighthouse), for the write-path and Not-checked tests.
describe("collected outputs", () => {
	let server: Server<undefined>;
	let evidence: Evidence;
	let result: EngineResult;
	let root = "";
	let repo = "";
	let inRepo = "";
	beforeAll(async () => {
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response("<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>", { headers: { "content-type": "text/html" } }),
		});
		const origin = `http://127.0.0.1:${server.port}`;
		evidence = await collect(parseArgs(["--url", `${origin}/`, "--allow-local", origin, "--no-render", "--no-lighthouse"], {}).collect);
		result = await runRules(evidence);
		root = mkdtempSync(join(tmpdir(), "seo-audit-units-out-"));
		repo = join(root, "proj");
		mkdirSync(repo);
		inRepo = join(repo, "existing.txt");
		writeFileSync(inRepo, "keep\n");
	});
	afterAll(() => {
		server.stop(true);
		rmSync(root, { recursive: true, force: true });
	});
	const unchanged = () => {
		expect(readdirSync(repo).sort()).toEqual(["existing.txt"]);
		expect(readFileSync(inRepo, "utf8")).toBe("keep\n");
	};

	test("Not checked no longer lists own-fetch DNS rebinding, which the pinned proxy closes", () => {
		expect(evidence.notChecked.map((n) => n.item).join("\n")).not.toMatch(/rebinding/i);
	});

	test("an output file that is a symlink to an existing project file is refused, with or without --repo", () => {
		const out = join(root, "out-leaf");
		mkdirSync(out);
		symlinkSync(inRepo, join(out, "report.md"));
		expect(() => writeOutputs(out, evidence, result, repo)).toThrow(/is a symlink/);
		expect(() => writeOutputs(out, evidence, result, null)).toThrow(/is a symlink/);
		unchanged();
	});

	test("a dangling symlink pointing into the project is refused, as a recording file and as --record-lhr", () => {
		const out = join(root, "rec-dangling");
		mkdirSync(out);
		const url = "http://127.0.0.1:1/";
		symlinkSync(join(repo, "planted.json"), join(out, `${recordingKey(url)}.json`));
		const page: RenderedPage = { url, finalUrl: url, navigations: [], requests: [], proxy: null, error: null, recordedWith: null, html: "<p>x</p>", source: "chrome" };
		expect(() => saveRecording(out, page, repo)).toThrow(/is a symlink/);
		const lhr = join(root, "lhr-dangling.json");
		symlinkSync(join(repo, "lhr.json"), lhr);
		expect(() => parseArgs(["--url", "https://a.example/", "--repo", repo, "--record-lhr", lhr], {})).toThrow(/^--record-lhr .*symlink/);
		unchanged();
	});

	test("an --out directory that is a symlink into the project is refused at write time", () => {
		const out = join(root, "out-link");
		symlinkSync(repo, out);
		expect(() => writeOutputs(out, evidence, result, repo)).toThrow(/inside the audited project/);
		expect(() => writeOutputs(join(out, "nested"), evidence, result, repo)).toThrow(/inside the audited project/);
		unchanged();
	});

	test("an output file hard-linked to a project file is refused before anything is truncated", () => {
		const out = join(root, "out-hardlink");
		mkdirSync(out);
		linkSync(inRepo, join(out, "report.md"));
		expect(() => writeOutputs(out, evidence, result, repo)).toThrow(/another hard link/);
		unchanged();
	});

	// The race writeContained closes: its directory resolved and checked, then replaced by a symlink into the project
	// before the open. writeAt is the open step, handed the resolved path whose component is now that symlink.
	test("an ancestor swapped for a symlink into the project after the check is refused at the open, leaving the file intact", () => {
		const swapped = join(realpathSync(root), "swapped-ancestor");
		symlinkSync(repo, swapped);
		expect(() => writeAt(join(swapped, "existing.txt"), "overwritten\n", repo)).toThrow(WriteRefused);
		unchanged();
	});
});

// CWV-040 on constructed evidence: one audited page at https://example.test/, its raw and rendered layers, and the
// rendered media list (src as the element's attribute, computed aspect-ratio). Only `audited` is read by the rule.
describe("CWV-040 matches rendered media to markup by resolved src", () => {
	const base = "https://example.test/";
	const doc = (body: string) => `<!doctype html><html><head><title>t</title><style>#hero { aspect-ratio: 2 / 1 }</style></head><body>${body}</body></html>`;
	async function layer(html: string): Promise<LayerEvidence> {
		const signals = await extractSignals(html);
		return { html, signals, jsonld: extractJsonLd(signals), directives: [] };
	}
	async function cwv040(rawBody: string, renderedBody: string, media: RenderedMedia[]): Promise<Hit[]> {
		const fetch: FetchResult = {
			requestedUrl: base,
			ua: "test",
			hops: [],
			finalUrl: base,
			status: 200,
			headers: {},
			body: doc(rawBody),
			bytes: 0,
			truncated: false,
			loop: false,
			tooManyRedirects: false,
			error: null,
			refused: null,
			budgetExhausted: false,
		};
		const page: PageEvidence = {
			url: base,
			role: "audited",
			fetch,
			raw: await layer(doc(rawBody)),
			rendered: {
				...(await layer(doc(renderedBody))),
				page: { url: base, finalUrl: base, navigations: [], requests: [], proxy: null, error: null, recordedWith: null, source: "recorded", media },
			},
			renderNote: null,
			uaProbes: [],
			lighthouse: null,
			crux: null,
		};
		const ctx: RuleContext = {
			evidence: { pages: [page] } as unknown as Evidence, // constructed: CWV-040 reads only `audited`
			auditTime: new Date(),
			audited: [page],
			page: () => page,
			site: () => undefined,
			isIntentNoindex: () => false,
			robotsAllowed: () => null,
		};
		return perfRules["CWV-040"]?.(ctx) ?? [];
	}

	test("a relative raw src and the absolute rendered src of the same element match, so a computed aspect-ratio credits it", async () => {
		const hits = await cwv040('<img id="hero" src="/hero.svg">', '<img id="hero" src="https://example.test/hero.svg">', [
			{ tag: "img", src: "https://example.test/hero.svg", width: null, height: null, aspectRatio: "2 / 1" },
		]);
		expect(hits).toEqual([]);
	});

	test("an element with no rendered counterpart is flagged without claiming a measured absence of CSS", async () => {
		const [hit, ...more] = await cwv040('<img id="a" src="/a.png">', "", []);
		expect(more).toEqual([]);
		expect(hit?.locator).toBe("html:img#a");
		expect(hit?.layer).toBe("raw-html");
		expect(hit?.observed).not.toContain("no stylesheet aspect-ratio");
		expect(hit?.observed).toContain("rendered computed style could not be matched");
	});

	test("a matched element whose computed aspect-ratio is auto is flagged as measured", async () => {
		const [hit] = await cwv040('<img src="a.png">', '<img src="/a.png">', [{ tag: "img", src: "/a.png", width: null, height: null, aspectRatio: "auto" }]);
		expect(hit?.observed).toContain("no stylesheet aspect-ratio in the rendered computed style");
	});

	test("reordered duplicate sources are matched by id, so each element is credited with its own computed style", async () => {
		const hits = await cwv040('<img id="hero" src="/same.svg"><img id="bad" src="/same.svg">', '<img id="bad" src="/same.svg"><img id="hero" src="/same.svg">', [
			{ tag: "img", src: "/same.svg", width: null, height: null, aspectRatio: "auto" },
			{ tag: "img", src: "/same.svg", width: null, height: null, aspectRatio: "2 / 1" },
		]);
		expect(hits.map((h) => [h.locator, h.layer])).toEqual([["html:img#bad", "raw-html"]]);
		expect(hits[0]?.observed).toContain("no stylesheet aspect-ratio in the rendered computed style");
	});

	test("duplicate sources no id disambiguates are flagged as unmatched, never as measured", async () => {
		const hits = await cwv040('<img src="/same.svg"><img src="/same.svg">', '<img src="/same.svg"><img src="/same.svg">', [
			{ tag: "img", src: "/same.svg", width: null, height: null, aspectRatio: "auto" },
			{ tag: "img", src: "/same.svg", width: null, height: null, aspectRatio: "2 / 1" },
		]);
		expect(hits.map((h) => [h.locator, h.layer])).toEqual([
			["html:img:nth(1)", "raw-html"],
			["html:img:nth(2)", "raw-html"],
		]);
		for (const h of hits) {
			expect(h.observed).toContain("rendered computed style could not be matched");
			expect(h.observed).not.toContain("no stylesheet aspect-ratio");
		}
	});

	test("a raw id shared by two elements establishes no correspondence, so the one hydration removed is still flagged", async () => {
		const hits = await cwv040('<img id="dup" src="/a.svg"><img id="dup" src="/b.svg">', '<img id="dup" src="/b.svg">', [
			{ tag: "img", src: "/b.svg", width: null, height: null, aspectRatio: "2 / 1" },
		]);
		expect(hits.length).toBe(1);
		expect(hits[0]?.layer).toBe("raw-html");
		expect(hits[0]?.observed).toContain("rendered computed style could not be matched");
	});

	test("a rendered image matched by id is not also credited to another raw image by source", async () => {
		const hits = await cwv040('<img id="hero" src="/a.svg"><img src="/b.svg">', '<img id="hero" src="/b.svg">', [
			{ tag: "img", src: "/b.svg", width: null, height: null, aspectRatio: "2 / 1" },
		]);
		expect(hits.map((h) => [h.locator, h.layer])).toEqual([["html:img:nth(2)", "raw-html"]]);
		expect(hits[0]?.observed).toContain("rendered computed style could not be matched");
	});
});

// A port-0 TCP server that answers / and /robots.txt with 200 headers, `Content-Length: 1000` and one body byte, then
// closes the connection; anything else is a 404. Both mandatory bodies are lost after their status arrived. The close
// waits a moment on the real clock: the cut has to land after the client has parsed the headers, which the server
// cannot observe across the guard proxy, and closing with the headers lets the fetch fail before any status.
describe("a mandatory response body cut off after the headers", () => {
	test("on the audited page and on robots.txt makes the verdict incomplete with both reasons, and robots is not ok", async () => {
		const server = createServer((sock) => {
			sock.once("data", (d) => {
				const path = new URL(String(d).split(" ")[1] ?? "/", "http://h").pathname;
				if (path === "/" || path === "/robots.txt") {
					sock.write(`HTTP/1.1 200 OK\r\ncontent-type: ${path === "/" ? "text/html" : "text/plain"}\r\ncontent-length: 1000\r\nconnection: close\r\n\r\nx`);
					setTimeout(() => sock.end(), 50);
				} else sock.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
			});
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		try {
			const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const evidence = await collect(parseArgs(["--url", `${origin}/`, "--allow-local", origin, "--no-render", "--no-lighthouse"], {}).collect);
			const result = await runRules(evidence);
			expect(verdictOf(evidence, result).verdict).toBe("incomplete");
			expect(evidence.incomplete).toEqual([
				expect.stringContaining(`raw fetch of ${origin}/ answered 200 but its body could not be read`),
				expect.stringContaining(`robots.txt fetch for ${origin} failed: answered 200 but its body could not be read`),
			]);
			expect(evidence.sites[0]?.robots.state).toBe("failed");
			expect(result.emissions.filter((e) => e.rule.startsWith("RBT-"))).toEqual([]);
		} finally {
			server.close();
		}
	});
});

// bun.sh's live run (accept/live/20261013T034210Z) emitted SMP-007 18,225 times for one cause: its sitemap lists bun.com
// URLs. Repeated hits of one rule with one root cause collapse into one emission with a count and sample locators.
describe("repeated hits with one root cause", () => {
	test("one cross-host sitemap becomes one SMP-007 finding per foreign host, with a count and samples", async () => {
		const locs = [
			...Array.from({ length: 30 }, (_, i) => `https://other.test/p${i}`),
			"https://third.test/a",
			"https://third.test/b",
		];
		const sitemap = `<?xml version="1.0"?>\n<urlset xmlns="${NS.sitemap}">\n${locs.map((l) => `<url><loc>${l}</loc></url>`).join("\n")}\n</urlset>\n`;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) =>
				new URL(req.url).pathname === "/sitemap.xml"
					? new Response(sitemap, { headers: { "content-type": "application/xml" } })
					: new Response("<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>", { headers: { "content-type": "text/html" } }),
		});
		try {
			const origin = `http://127.0.0.1:${server.port}`;
			const evidence = await collect(parseArgs(["--url", `${origin}/`, "--allow-local", origin, "--no-render", "--no-lighthouse"], {}).collect);
			const result = await runRules(evidence);
			const smp = result.emissions.filter((e) => e.rule === "SMP-007");
			expect(smp.map((e) => ({ locator: e.locator, count: e.count, samples: e.samples }))).toEqual([
				{ locator: "line:3", count: 30, samples: ["line:3", "line:4", "line:5", "line:6", "line:7"] },
				{ locator: "line:33", count: 2, samples: ["line:33", "line:34"] },
			]);
			expect(smp[0]?.observed).toContain("other.test");
			expect(renderReport(evidence, result)).toContain("  - count: 30 (samples: `line:3`, `line:4`, `line:5`, `line:6`, `line:7`)");
		} finally {
			server.stop(true);
		}
	});

	test("malformed <lastmod> values collapse per form, so two generators' formats stay two SMP-005 findings", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) => {
				const origin = new URL(req.url).origin;
				const lastmods = ["03/04/2024", "05/06/2023", "yesterday"];
				return new URL(req.url).pathname === "/sitemap.xml"
					? new Response(
							`<?xml version="1.0"?>\n<urlset xmlns="${NS.sitemap}">\n${lastmods.map((m, i) => `<url><loc>${origin}/p${i}</loc><lastmod>${m}</lastmod></url>`).join("\n")}\n</urlset>\n`,
							{ headers: { "content-type": "application/xml" } },
						)
					: new Response("<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>", { headers: { "content-type": "text/html" } });
			},
		});
		try {
			const origin = `http://127.0.0.1:${server.port}`;
			const evidence = await collect(parseArgs(["--url", `${origin}/`, "--allow-local", origin, "--no-render", "--no-lighthouse"], {}).collect);
			const result = await runRules(evidence);
			const smp = result.emissions.filter((e) => e.rule === "SMP-005");
			expect(smp.map((e) => ({ locator: e.locator, count: e.count, samples: e.samples }))).toEqual([
				{ locator: "line:3", count: 2, samples: ["line:3", "line:4"] },
				{ locator: "line:5", count: 1, samples: ["line:5"] },
			]);
		} finally {
			server.stop(true);
		}
	});
});
