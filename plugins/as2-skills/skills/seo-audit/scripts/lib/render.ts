// Rendered DOM through system Chrome, headless, driven over the DevTools protocol with Bun's WebSocket. Chrome is
// launched with `--proxy-server` pointing at the guard proxy and `--proxy-bypass-list=<-loopback>`, so loopback goes
// through the proxy too. Each URL is one render run: its own browser, its own proxy transaction count, and a 30 s wall
// clock after which the browser is killed. Recordings (`--record-rendered`) and the offline replay (`--rendered-from`)
// use the same files: `<key>.html` for the DOM and `<key>.json` for the navigation and network log.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { GuardProxy } from "./proxy.ts";
import { writeContained } from "./report.ts";

export const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const RENDER_WALL_MS = 30_000;

export interface RenderedNavigation {
	url: string;
	reason: string | null; // CDP Page.frameRequestedNavigation reason for client navigations, null for the first
}

export interface RenderedRequest {
	url: string;
	type: string;
	status: number | null;
	failed: string | null;
}

export interface RenderedLog {
	url: string;
	finalUrl: string;
	navigations: RenderedNavigation[];
	requests: RenderedRequest[];
	proxy: { transactions: number; refused: number } | null;
	error: string | null;
	recordedWith: string | null; // Chrome product string
}

// One <img> or <video> of the rendered DOM, in document order: its src (poster for a video without src), its
// width/height attributes and its computed aspect-ratio (`getComputedStyle(el).aspectRatio`), which shows whether a
// stylesheet reserves the element's box.
export interface RenderedMedia {
	tag: string;
	src: string;
	width: string | null;
	height: string | null;
	aspectRatio: string;
}

export interface RenderedPage extends RenderedLog {
	html: string | null;
	source: "chrome" | "recorded";
	media?: RenderedMedia[]; // absent in recordings made before it was collected
}

export function recordingKey(url: string): string {
	const u = new URL(url);
	const path = `${u.pathname}${u.search}`.replace(/^\//, "").replace(/[^A-Za-z0-9._-]+/g, "_");
	return `${u.hostname}-${u.port || (u.protocol === "https:" ? "443" : "80")}__${path || "index"}`;
}

export function loadRecording(dir: string, url: string): RenderedPage | null {
	const key = recordingKey(url);
	const logPath = join(dir, `${key}.json`);
	if (!existsSync(logPath)) return null;
	const log = JSON.parse(readFileSync(logPath, "utf8")) as Omit<RenderedPage, "html" | "source">;
	const htmlPath = join(dir, `${key}.html`);
	return { ...log, html: existsSync(htmlPath) ? readFileSync(htmlPath, "utf8") : null, source: "recorded" };
}

export function saveRecording(dir: string, page: RenderedPage, repo: string | null): void {
	const key = recordingKey(page.url);
	const { html, source: _source, ...log } = page;
	writeContained(join(dir, `${key}.json`), `${JSON.stringify(log, null, "\t")}\n`, repo);
	if (html !== null) writeContained(join(dir, `${key}.html`), html, repo);
}

type CdpParams = Record<string, unknown>;
interface CdpMessage {
	id?: number;
	method?: string;
	params?: CdpParams;
	result?: CdpParams;
	error?: { message: string };
}

class Cdp {
	private next = 0;
	private readonly pending = new Map<number, { resolve: (v: CdpParams) => void; reject: (e: Error) => void }>();
	private readonly listeners: ((method: string, params: CdpParams) => void)[] = [];

	private constructor(private readonly ws: WebSocket) {
		ws.onmessage = (e) => {
			const msg = JSON.parse(String(e.data)) as CdpMessage;
			if (msg.id !== undefined) {
				const p = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				if (msg.error) p?.reject(new Error(msg.error.message));
				else p?.resolve(msg.result ?? {});
			} else if (msg.method) for (const l of this.listeners) l(msg.method, msg.params ?? {});
		};
	}

	static async open(url: string): Promise<Cdp> {
		const ws = new WebSocket(url);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("DevTools WebSocket failed to open"));
		await promise;
		return new Cdp(ws);
	}

	on(l: (method: string, params: CdpParams) => void): void {
		this.listeners.push(l);
	}

	send(method: string, params: CdpParams = {}): Promise<CdpParams> {
		const id = ++this.next;
		const { promise, resolve, reject } = Promise.withResolvers<CdpParams>();
		this.pending.set(id, { resolve, reject });
		this.ws.send(JSON.stringify({ id, method, params }));
		return promise;
	}

	close(): void {
		this.ws.close();
	}
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function obj(v: unknown): CdpParams {
	return typeof v === "object" && v !== null ? (v as CdpParams) : {};
}

async function devtoolsUrl(stderr: ReadableStream<Uint8Array>, deadline: number): Promise<string> {
	const reader = stderr.getReader();
	let buf = "";
	const decoder = new TextDecoder();
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value);
		const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
		if (m?.[1]) {
			reader.releaseLock();
			return m[1];
		}
	}
	throw new Error(`Chrome printed no DevTools URL: ${buf.slice(0, 300)}`);
}

export interface ChromeOptions {
	chromePath: string;
	proxy: GuardProxy;
	noSandbox: boolean;
	trustSpki: string[];
}

// The proxy flags and fixture-only exceptions come from the proxy, which turns loopback-only when an exception is on.
export function chromeFlags(o: ChromeOptions, profile: string): string[] {
	return [
		"--headless=new",
		`--user-data-dir=${profile}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-sync",
		"--disable-default-apps",
		"--metrics-recording-only",
		"--mute-audio",
		...o.proxy.browserFlags(o),
	];
}

// Renders one URL in a fresh headless Chrome. Never throws: a failure is recorded in `error`.
export async function renderUrl(url: string, o: ChromeOptions): Promise<RenderedPage> {
	const page: RenderedPage = {
		url,
		finalUrl: url,
		navigations: [],
		requests: [],
		proxy: null,
		error: null,
		recordedWith: null,
		html: null,
		source: "chrome",
	};
	const run = o.proxy.beginRun(`render ${url}`);
	const profile = mkdtempSync(join(tmpdir(), "seo-audit-chrome-"));
	const started = Date.now();
	const deadline = started + RENDER_WALL_MS;
	let proc: Subprocess | null = null;
	let cdp: Cdp | null = null;
	const killer = setTimeout(() => proc?.kill(), RENDER_WALL_MS);
	try {
		proc = Bun.spawn([o.chromePath, ...chromeFlags(o, profile), "--remote-debugging-port=0", "about:blank"], {
			stdout: "ignore",
			stderr: "pipe",
		});
		const stderr = proc.stderr;
		if (!(stderr instanceof ReadableStream)) throw new Error("Chrome stderr is not readable");
		const ws = await devtoolsUrl(stderr, deadline);
		const port = new URL(ws).port;
		const version = obj(await (await fetch(`http://127.0.0.1:${port}/json/version`)).json());
		page.recordedWith = str(version.Browser) || null;
		const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as CdpParams[];
		const target = targets.find((t) => t.type === "page");
		if (!target) throw new Error("no page target");
		cdp = await Cdp.open(str(target.webSocketDebuggerUrl));
		const requests = new Map<string, RenderedRequest>();
		let inflight = 0;
		let loaded = false;
		let lastActivity = Date.now();
		let pendingReason: string | null = null;
		let mainFrame: string | null = null;
		cdp.on((method, p) => {
			lastActivity = Date.now();
			if (method === "Page.frameRequestedNavigation") {
				if (!mainFrame || str(p.frameId) === mainFrame) pendingReason = str(p.reason) || null;
			} else if (method === "Page.frameNavigated") {
				const frame = obj(p.frame);
				if (frame.parentId) return;
				mainFrame = str(frame.id);
				page.navigations.push({ url: str(frame.url), reason: page.navigations.length ? pendingReason : null });
				pendingReason = null;
				loaded = false;
			} else if (method === "Page.loadEventFired") loaded = true;
			else if (method === "Network.requestWillBeSent") {
				const id = str(p.requestId);
				const req = obj(p.request);
				if (!requests.has(id)) inflight++;
				const r: RenderedRequest = { url: str(req.url), type: str(p.type), status: null, failed: null };
				requests.set(id, r);
				page.requests.push(r);
			} else if (method === "Network.responseReceived") {
				const r = requests.get(str(p.requestId));
				const status = obj(p.response).status;
				if (r && typeof status === "number") r.status = status;
			} else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
				const r = requests.get(str(p.requestId));
				if (r && method === "Network.loadingFailed") r.failed = str(p.errorText) || "failed";
				if (requests.delete(str(p.requestId))) inflight--;
			}
		});
		await cdp.send("Page.enable");
		await cdp.send("Network.enable");
		const nav = await cdp.send("Page.navigate", { url });
		if (str(nav.errorText)) page.error = `navigation failed: ${str(nav.errorText)}`;
		while (Date.now() < deadline - 1000) {
			await Bun.sleep(100);
			if (loaded && inflight <= 0 && Date.now() - lastActivity >= 700) break;
		}
		if (!(loaded && inflight <= 0)) page.error ??= "page did not settle before the 30 s render wall clock";
		const evaluated = await cdp.send("Runtime.evaluate", {
			expression:
				"JSON.stringify({ href: location.href, html: (document.doctype ? new XMLSerializer().serializeToString(document.doctype) + '\\n' : '') + document.documentElement.outerHTML, media: [...document.querySelectorAll('img,video')].map((e) => ({ tag: e.localName, src: e.getAttribute('src') ?? e.getAttribute('poster') ?? '', width: e.getAttribute('width'), height: e.getAttribute('height'), aspectRatio: getComputedStyle(e).aspectRatio })) })",
			returnByValue: true,
		});
		const value = str(obj(evaluated.result).value);
		if (value) {
			const v = JSON.parse(value) as { href: string; html: string; media: RenderedMedia[] };
			page.finalUrl = v.href;
			// A failed navigation (TLS error, refused connection) leaves Chrome's own error page, which is not the
			// site's DOM: it is recorded as a render failure, never as rendered evidence.
			if (v.href.startsWith("chrome-error:")) page.error ??= "navigation failed: Chrome showed its error page";
			else {
				page.html = v.html;
				page.media = v.media;
			}
		}
	} catch (e) {
		page.error = Date.now() >= deadline ? "render wall clock (30 s) exceeded; browser killed" : String(e);
	} finally {
		clearTimeout(killer);
		cdp?.close();
		proc?.kill();
		await proc?.exited;
		rmSync(profile, { recursive: true, force: true });
		page.proxy = { transactions: run.transactions, refused: run.refused };
	}
	return page;
}
