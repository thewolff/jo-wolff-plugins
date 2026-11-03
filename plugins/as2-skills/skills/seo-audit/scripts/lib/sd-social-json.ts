// Source-level scan of a JSON-LD block's text for what JSON.parse hides or rejects without saying where: comments
// (rules.md SD-JLD-02) and keys repeated inside one object (SD-JLD-03, where JSON.parse keeps the last value).
// Paths use the jsonld.ts format (`$["@graph"][1]["name"]`), so locators line up with the parsed nodes.

export interface JsonSourceScan {
	comments: { line: number; text: string }[]; // line within the block text, 1-based
	duplicates: { path: string; key: string; line: number }[]; // path of the object that repeats the key
}

interface Frame {
	kind: "object" | "array";
	path: string;
	keys: Record<string, true>;
	key: string | null; // the object member being read
	expectKey: boolean;
	index: number; // the array element being read
}

export function scanJsonSource(text: string): JsonSourceScan {
	const out: JsonSourceScan = { comments: [], duplicates: [] };
	const stack: Frame[] = [];
	let line = 1;
	const childPath = (): string => {
		const f = stack[stack.length - 1];
		if (!f) return "$";
		return f.kind === "object" ? `${f.path}[${JSON.stringify(f.key ?? "")}]` : `${f.path}[${f.index}]`;
	};
	let i = 0;
	while (i < text.length) {
		const c = text[i] as string;
		if (c === "\n") {
			line++;
			i++;
			continue;
		}
		if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
			const block = text[i + 1] === "*";
			const end = block ? text.indexOf("*/", i + 2) : text.indexOf("\n", i);
			const stop = end === -1 ? text.length : block ? end + 2 : end;
			const body = text.slice(i, stop);
			out.comments.push({ line, text: body.trim() });
			line += body.split("\n").length - 1;
			i = stop;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			const literal = text.slice(i, j + 1);
			let value: string;
			try {
				value = JSON.parse(literal) as string;
			} catch {
				value = literal.slice(1, -1);
			}
			const f = stack[stack.length - 1];
			if (f?.kind === "object" && f.expectKey) {
				if (f.keys[value]) out.duplicates.push({ path: f.path, key: value, line });
				f.keys[value] = true;
				f.key = value;
				f.expectKey = false;
			}
			line += literal.split("\n").length - 1;
			i = j + 1;
			continue;
		}
		if (c === "{" || c === "[") {
			stack.push({ kind: c === "{" ? "object" : "array", path: childPath(), keys: {}, key: null, expectKey: c === "{", index: 0 });
		} else if (c === "}" || c === "]") {
			stack.pop();
		} else if (c === ",") {
			const f = stack[stack.length - 1];
			if (f?.kind === "object") f.expectKey = true;
			else if (f) f.index++;
		}
		i++;
	}
	return out;
}
