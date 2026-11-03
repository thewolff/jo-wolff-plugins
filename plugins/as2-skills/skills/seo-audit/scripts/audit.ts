#!/usr/bin/env bun
// seo-audit entry point (SKILL.md step 1; plan section 3). Collects evidence for the --url targets, runs every
// mechanical rule module in scripts/rules/, and writes evidence.json, findings.json and report.md to --out (default
// ${TMPDIR:-/tmp}/seo-audit/<host>-<UTC timestamp>/), never into the audited project. Prints the output directory.
// Exit: 0 audit written (any verdict), 1 runtime error, 2 usage error or refusal.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runRules } from "./lib/engine.ts";
import { type CollectOptions, collect } from "./lib/evidence.ts";
import { isLoopbackFixtureOrigin } from "./lib/guard.ts";
import { DEFAULT_CHROME } from "./lib/render.ts";
import { WriteRefused, isInside, verdictOf, writeOutputs } from "./lib/report.ts";

export const USAGE = `usage: bun skills/seo-audit/scripts/audit.ts --url <u> [--url …] [--repo <path>] [--out <dir>]
  [--intent noindex=<url>]… [--no-render] [--no-lighthouse] [--rendered-from <dir>] [--lhr-from <file>]
  [--crux-from <file>] [--crux-key-env CRUX_API_KEY] [--sample N] [--budget N] [--allow-local <origin>]…
  [--record-rendered <dir>] [--record-lhr <file>] [--chrome-no-sandbox] [--chrome-trust-spki <base64 sha256>]…`;

export interface AuditArgs {
	collect: CollectOptions;
	out: string;
}

export class UsageError extends Error {}

function positiveInt(flag: string, v: string | undefined): number {
	const n = Number(v);
	if (!v || !Number.isInteger(n) || n < 0) throw new UsageError(`${flag} needs a non-negative integer, got ${v ?? "nothing"}`);
	return n;
}

function absoluteUrl(flag: string, v: string | undefined): string {
	let u: URL;
	try {
		u = new URL(v ?? "");
	} catch {
		throw new UsageError(`${flag} needs an absolute http(s) URL, got ${v ?? "nothing"}`);
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new UsageError(`${flag} needs an http(s) URL, got ${v}`);
	return u.href;
}

function timestamp(d: Date): string {
	return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// Parses argv (without the runtime and script) into collect options. Throws UsageError on bad input, including the
// loopback-only refusals: Chrome without its sandbox (--chrome-no-sandbox), and Chrome trusting a certificate by its
// SPKI hash (--chrome-trust-spki, for TLS fixtures with a self-signed certificate), are accepted only against loopback
// fixture origins.
export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env, now = new Date()): AuditArgs {
	const targets: string[] = [];
	const intent: string[] = [];
	const allowLocal: string[] = [];
	let repo: string | null = null;
	let out: string | null = null;
	let noRender = false;
	let noLighthouse = false;
	let renderedFrom: string | null = null;
	let lhrFrom: string | null = null;
	let cruxFrom: string | null = null;
	let cruxKeyEnv = "CRUX_API_KEY";
	let sample = 10;
	let budget = 60;
	let recordRendered: string | null = null;
	let recordLhr: string | null = null;
	let noSandbox = false;
	const trustSpki: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i] ?? "";
		const value = () => {
			const v = argv[++i];
			if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
			return v;
		};
		switch (flag) {
			case "--url":
				targets.push(absoluteUrl(flag, value()));
				break;
			case "--repo":
				repo = resolve(value());
				break;
			case "--out":
				out = resolve(value());
				break;
			case "--intent": {
				const v = value();
				if (!v.startsWith("noindex=")) throw new UsageError(`--intent supports noindex=<url> only, got ${v}`);
				intent.push(absoluteUrl("--intent noindex=", v.slice("noindex=".length)));
				break;
			}
			case "--no-render":
				noRender = true;
				break;
			case "--no-lighthouse":
				noLighthouse = true;
				break;
			case "--rendered-from":
				renderedFrom = resolve(value());
				break;
			case "--lhr-from":
				lhrFrom = resolve(value());
				break;
			case "--crux-from":
				cruxFrom = resolve(value());
				break;
			case "--crux-key-env":
				cruxKeyEnv = value();
				break;
			case "--sample":
				sample = positiveInt(flag, value());
				break;
			case "--budget":
				budget = positiveInt(flag, value());
				break;
			case "--allow-local": {
				const v = value();
				let origin: string;
				try {
					origin = new URL(v).origin;
				} catch {
					throw new UsageError(`--allow-local needs an origin such as http://127.0.0.1:8080, got ${v}`);
				}
				if (origin === "null") throw new UsageError(`--allow-local needs an http(s) origin, got ${v}`);
				allowLocal.push(origin);
				break;
			}
			case "--record-rendered":
				recordRendered = resolve(value());
				break;
			case "--record-lhr":
				recordLhr = resolve(value());
				break;
			case "--chrome-no-sandbox":
				noSandbox = true;
				break;
			case "--chrome-trust-spki": {
				const v = value();
				if (!/^[A-Za-z0-9+/]{43}=$/.test(v)) throw new UsageError(`--chrome-trust-spki needs a base64 SHA-256 SPKI hash, got ${v}`);
				trustSpki.push(v);
				break;
			}
			case "--help":
			case "-h":
				throw new UsageError(USAGE);
			default:
				throw new UsageError(`unknown argument ${flag}\n${USAGE}`);
		}
	}
	if (!targets.length) throw new UsageError(`at least one --url is required\n${USAGE}`);
	for (const [flag, used, what] of [
		["--chrome-no-sandbox", noSandbox, "runs Chrome without its sandbox"],
		["--chrome-trust-spki", trustSpki.length > 0, "makes Chrome trust a certificate it cannot verify"],
	] as const) {
		if (!used) continue;
		const outside = [...targets.map((t) => new URL(t).origin), ...allowLocal].filter((o) => !isLoopbackFixtureOrigin(o));
		if (outside.length)
			throw new UsageError(
				`refused: ${flag} ${what} and is accepted only when every --url and every --allow-local origin is a loopback fixture origin (127.0.0.1, ::1 or localhost); not loopback: ${[...new Set(outside)].join(", ")}`,
			);
	}
	if (recordRendered && (renderedFrom || noRender)) throw new UsageError("--record-rendered needs a live render: drop --rendered-from and --no-render");
	if (recordLhr && (lhrFrom || noLighthouse)) throw new UsageError("--record-lhr needs a live Lighthouse run: drop --lhr-from and --no-lighthouse");
	const host = new URL(targets[0] ?? "").host.replace(/[^A-Za-z0-9.-]+/g, "_");
	const outDir = out ?? join(env.TMPDIR || tmpdir(), "seo-audit", `${host}-${timestamp(now)}`);
	// The destinations are checked here so a bad one fails before any fetch; every file write is checked again
	// (writeContained), since a destination directory's own files can be symlinks.
	if (repo) {
		for (const [flag, dest] of [
			["--out", outDir],
			["--record-rendered", recordRendered],
			["--record-lhr", recordLhr],
		] as const) {
			if (!dest) continue;
			let inside: boolean;
			try {
				inside = isInside(repo, dest);
			} catch (e) {
				if (e instanceof WriteRefused) throw new UsageError(`${flag} ${dest}: ${e.message}`);
				throw e;
			}
			if (inside) throw new UsageError(`${flag} ${dest} is inside the audited project ${repo}; outputs never go there`);
		}
	}
	const chromePath = env.CHROME_PATH || DEFAULT_CHROME;
	const cruxKey = env[cruxKeyEnv] || null;
	return {
		out: outDir,
		collect: {
			targets,
			intentNoindex: intent,
			allowLocal,
			budget,
			sample,
			render: renderedFrom
				? { mode: "recorded", from: renderedFrom, recordTo: null }
				: noRender
					? { mode: "off", from: null, recordTo: null }
					: { mode: existsSync(chromePath) ? "chrome" : "off", from: null, recordTo: recordRendered },
			lighthouse: lhrFrom
				? { mode: "recorded", from: lhrFrom, recordTo: null }
				: noLighthouse
					? { mode: "off", from: null, recordTo: null }
					: { mode: "run", from: null, recordTo: recordLhr },
			crux: cruxFrom
				? { mode: "recorded", from: cruxFrom, key: null, keyEnv: cruxKeyEnv }
				: { mode: cruxKey ? "api" : "none", from: null, key: cruxKey, keyEnv: cruxKeyEnv },
			chromePath,
			chromeNoSandbox: noSandbox,
			chromeTrustSpki: trustSpki,
			repo,
			now,
		},
	};
}

export async function main(argv: string[]): Promise<number> {
	let args: AuditArgs;
	try {
		args = parseArgs(argv);
	} catch (e) {
		if (e instanceof UsageError) {
			console.error(e.message);
			return 2;
		}
		throw e;
	}
	if (args.collect.render.recordTo && args.collect.render.mode !== "chrome") {
		console.error(`--record-rendered needs Chrome at ${args.collect.chromePath} (set CHROME_PATH)`);
		return 2;
	}
	try {
		const evidence = await collect(args.collect);
		const result = await runRules(evidence);
		const paths = writeOutputs(args.out, evidence, result, args.collect.repo);
		const v = verdictOf(evidence, result);
		console.log(args.out);
		console.error(
			`seo-audit: verdict=${v.verdict} critical=${v.critical} high=${v.high} medium=${v.medium} low=${v.low} observations=${v.observations}; ${paths.report}`,
		);
		return 0;
	} catch (e) {
		if (e instanceof WriteRefused) {
			console.error(`refused: ${e.message}`);
			return 2;
		}
		console.error(`seo-audit failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
		return 1;
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
