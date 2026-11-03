// Source layer (`--repo`): framework detection and the files the framework rules read, as text. The audited
// project's code, build and config are never run, imported or modified.
import { type Stats, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface SourceFile {
	path: string; // relative to the repo root, forward slashes
	bytes: number;
	text: string | null; // null when over the size cap
}

export interface SourceEvidence {
	root: string;
	packageJson: boolean;
	dependencies: Record<string, string>; // dependencies and devDependencies, as declared
	framework: { next: string | null; vite: string | null; react: string | null };
	router: { app: string | null; pages: string | null }; // the app/ and pages/ directories found (src/ prefix kept)
	files: SourceFile[];
	truncated: boolean;
}

const SKIP_DIRS: Record<string, true> = {
	node_modules: true,
	".git": true,
	".next": true,
	dist: true,
	build: true,
	out: true,
	coverage: true,
	".turbo": true,
	".vercel": true,
};
const MAX_FILES = 2000;
const MAX_BYTES = 256 * 1024;
const RELEVANT = /(^|\/)(app|pages)\/.*\.(js|jsx|ts|tsx|mdx)$|(^|\/)(index\.html|next\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|package\.json)$|(^|\/)public\/(robots\.txt|sitemap[^/]*\.xml|llms\.txt)$/;

export function scanSource(root: string): SourceEvidence {
	const ev: SourceEvidence = {
		root,
		packageJson: false,
		dependencies: {},
		framework: { next: null, vite: null, react: null },
		router: { app: null, pages: null },
		files: [],
		truncated: false,
	};
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		ev.packageJson = true;
		ev.dependencies = { ...pkg.devDependencies, ...pkg.dependencies };
	} catch {
		// no package.json, or unreadable: framework detection falls back to file layout
	}
	ev.framework = { next: ev.dependencies.next ?? null, vite: ev.dependencies.vite ?? null, react: ev.dependencies.react ?? null };
	const walk = (dir: string) => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names.sort()) {
			if (ev.files.length >= MAX_FILES) {
				ev.truncated = true;
				return;
			}
			const full = join(dir, name);
			let st: Stats;
			try {
				st = lstatSync(full);
			} catch {
				continue;
			}
			const rel = relative(root, full).split("\\").join("/");
			if (st.isDirectory()) {
				if (SKIP_DIRS[name] || name.startsWith(".")) continue;
				if (name === "app" && (rel === "app" || rel === "src/app")) ev.router.app ??= rel;
				if (name === "pages" && (rel === "pages" || rel === "src/pages")) ev.router.pages ??= rel;
				walk(full);
			} else if (st.isFile() && RELEVANT.test(rel)) {
				ev.files.push({ path: rel, bytes: st.size, text: st.size <= MAX_BYTES ? readFileSync(full, "utf8") : null });
			}
		}
	};
	walk(root);
	return ev;
}
