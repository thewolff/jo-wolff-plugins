// UA probes (plan section 3): one GET per crawler user agent for each `--url` target, sequential, through the guard
// and the budget. Every result carries the label "UA probe, not the real crawler (vendors verify by IP)". The probe
// strings name each vendor's product token; a site that verifies crawlers by IP may answer them differently from the
// real crawler.
import { fetchChain } from "./fetch.ts";
import type { Budget, Guard } from "./guard.ts";
import { extractSignals } from "./html.ts";
import { robotsDirectives } from "./directives.ts";

export const UA_PROBE_LABEL = "UA probe, not the real crawler (vendors verify by IP)";

export const UA_PROBES: Record<string, string> = {
	"googlebot-smartphone":
		"Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
	"googlebot-desktop":
		"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/130.0.0.0 Safari/537.36",
	bingbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/130.0.0.0 Safari/537.36",
	"oai-searchbot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
	gptbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot",
	claudebot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
	"claude-searchbot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)",
	perplexitybot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
	ccbot: "CCBot/2.0 (https://commoncrawl.org/faq/)",
};

export interface UaProbe {
	probe: string;
	ua: string;
	label: string;
	status: number | null;
	finalUrl: string;
	redirects: number;
	error: string | null;
	title: string | null;
	description: string | null;
	robots: string[]; // robots directives as `scope:name`
	headings: { level: number; text: string }[];
	imageAlts: (string | null)[];
	mainTextLength: number;
	challenge: boolean; // the body looks like a bot challenge page
}

const CHALLENGE = /(cf-chl|challenge-platform|captcha|are you a robot|verify you are human|access denied)/i;

export async function probeUserAgents(url: string, guard: Guard, budget: Budget): Promise<UaProbe[]> {
	const out: UaProbe[] = [];
	for (const [probe, ua] of Object.entries(UA_PROBES)) {
		const f = await fetchChain(url, { guard, budget, ua, maxRedirects: 10 });
		const html = f.body && /html/i.test(f.headers["content-type"] ?? "html") ? f.body : null;
		const sig = html ? await extractSignals(html) : null;
		out.push({
			probe,
			ua,
			label: UA_PROBE_LABEL,
			status: f.status,
			finalUrl: f.finalUrl,
			redirects: Math.max(f.hops.length - 1, 0),
			error: f.error ?? f.refused ?? (f.budgetExhausted ? "budget exhausted" : null),
			title: sig?.titles[0]?.text ?? null,
			description: sig?.metas.find((m) => m.key === "name" && m.name === "description")?.content ?? null,
			robots: robotsDirectives(sig, f.headers).map((d) => `${d.scope}:${d.name}`),
			headings: sig?.headings ?? [],
			imageAlts: sig?.images.map((i) => i.alt) ?? [],
			mainTextLength: sig?.mainText.length ?? 0,
			challenge: html ? CHALLENGE.test(html.slice(0, 20_000)) : false,
		});
		if (f.budgetExhausted) break;
	}
	return out;
}
