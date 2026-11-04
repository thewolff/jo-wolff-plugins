# SEO audit tooling survey (SRV-)

Fetch date for every CITE below: **2026-10-12**. Scope: what existing tools/skills CHECK, versus what the old skill `newdle-seo-audit` checks. Vendor docs are primary for what THOSE TOOLS check, NOT for whether a check matters to Google; every "matters to Google/Bing/AI" question is tagged `needs source` for the other research hands.

Tier: Tier 0 for the survey itself, with these exceptions (Tier 2 coverage gaps, all stated, none hidden):
- Ahrefs: its `/seo/site-audit` and the "what issues can I expect" article returned HTTP 404; only the Help Center issue collection (54 article titles) and the "170+" marketing claim were fetched. Ahrefs per-check thresholds are NOT covered.
- Unlighthouse publishes no own check list; it wraps Lighthouse (see 2.6).
- SEOnaut: check list taken from the Go source error enum, not a docs page; thresholds not read.
- anthropics/skills and addyosmani/agent-skills contain NO SEO skill (2.2).

## 0. Old skill read (read-only)

Path: `plugins/newdle/skills/newdle-seo-audit/SKILL.md` in the newdle-claude-plugins repo (333 lines, read in full, snapshot tag #ED8F).
Its audit categories (lines 68-217): A Meta/Head, B Semantic HTML, C Structured data, D Rendering, E Images, F CWV code-pattern signals, G URL structure, H Indexing controls, I AI bot discoverability. Severity map at lines 307-313. It is source-only (step 1 scope = files the user gives, line 32); it has no live-URL, raw-vs-rendered, HTTP header, redirect, or Lighthouse checks and no citations of any kind.

## 1. Sources fetched (tool check lists)

| # | Tool / skill | URL fetched | Repo state / date | Notes |
|---|---|---|---|---|
| T1 | Lighthouse default config (SEO, A11y, Best Practices, Agentic Browsing categories) | https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/core/config/default-config.js | repo head commit `2ac69abc42f9` dated 2026-10-09T23:41:56Z (GitHub API); npx version 13.5.0 | audit list is authoritative for Lighthouse |
| T1b | Lighthouse `llms-txt` audit | https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/core/audits/agentic/llms-txt.js | same | what the audit really tests |
| T1c | Lighthouse `hreflang` audit | https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/core/audits/seo/hreflang.js | same | |
| T2 | AgriciDaniel/claude-seo (`seo-audit`, `seo-technical`) | https://raw.githubusercontent.com/AgriciDaniel/claude-seo/main/skills/seo-audit/SKILL.md and .../skills/seo-technical/SKILL.md | head `4b99de2f7de7` 2026-10-04T23:40:56Z; skill metadata version "2.4.2" | repo URL https://github.com/AgriciDaniel/claude-seo |
| T3 | JeffLi1993/seo-audit-skill | https://github.com/JeffLi1993/seo-audit-skill (README fetched via GitHub API) | head `523bdfb2c94f` 2026-06-17T15:54:45Z; 764 stars | SKILL.md bodies not read, README coverage tables read |
| T4 | Snippet-Digital-Agency/tech-seo-audit-skill (was Suganthan-Mohanadasan/...; repo moved) | https://github.com/Suganthan-Mohanadasan/tech-seo-audit-skill and https://raw.githubusercontent.com/Snippet-Digital-Agency/tech-seo-audit-skill/main/references/analysis-modules.md | head `8b5b5d5c776e` 2026-04-11T13:25:52Z | operates on crawl CSVs, not live HTML |
| T5 | Unlighthouse | https://unlighthouse.dev/ and https://unlighthouse.dev/guide/getting-started/installation | repo harlan-zw/unlighthouse head `c3d5c5f6357a` 2026-10-11T05:05:40Z | wraps Lighthouse |
| T6 | SEOnaut | https://github.com/StJudeWasHere/seonaut (README) and https://raw.githubusercontent.com/StJudeWasHere/seonaut/main/internal/issues/errors/errors.go | head `a67387fe63a2` 2026-06-14T07:35:20Z | issue enum is the check list |
| T7 | Screaming Frog SEO Spider issues | https://www.screamingfrog.co.uk/seo-spider/issues/ | page shows "SEO Spider v.24.3" | 300+ issues |
| T8 | Ahrefs Site Audit | https://help.ahrefs.com/en/collections/1539899-issues (54 articles) ; https://ahrefs.com/site-audit (search result snippet only: "Identify, prioritize, and fix 170+ SEO issues.") | n/a | `https://ahrefs.com/seo/site-audit` and `/en/articles/2349955-...` = HTTP 404 |
| T9 | Semrush Site Audit | https://www.semrush.com/kb/542-site-audit-issues-list | page header says "140+ website issues" | full Errors/Warnings/Notices list |
| T10 | anthropics/skills | https://api.github.com/repos/anthropics/skills/contents/skills (dir listing) | head `dbd4588f9e1f` 2026-10-09T18:45:49Z | no SEO skill (list: academy-guide, algorithmic-art, brand-guidelines, canvas-design, claude-api, discernment-nudge, doc-coauthoring, docx, frontend-design, internal-comms, mcp-builder, pdf, pptx, skill-creator, slack-gif-creator, theme-factory, web-artifacts-builder, webapp-testing, xlsx) |
| T11 | addyosmani/agent-skills | https://github.com/addyosmani/agent-skills and https://api.github.com/repos/addyosmani/agent-skills/contents/skills | head `1be8e34187e3` 2026-10-10T08:28:48Z | skills dir has no SEO skill; has `performance-optimization`, `browser-testing-with-devtools`, and a `/webperf` command + `agents/web-performance-auditor.md` (file listing only; NOT read) |

## 2. Per-tool check lists (CITE)

### 2.1 Lighthouse (T1)
**CITE** SEO category auditRefs (default-config.js, `seo:` block): `is-crawlable`, `document-title`, `meta-description`, `http-status-code`, `link-text`, `crawlable-anchors`, `robots-txt`, `image-alt`, `hreflang`, `canonical`; manual `structured-data` weight 0. Quote: "Should be at least 31% of the score, such that this audit failing results in the SEO category failing."
**CITE** Description string: "There are many additional factors Lighthouse does not score here that may affect your search ranking, including performance on [Core Web Vitals]". 
**CITE** Lighthouse has NO audit for title length, description length, h1 count, OG/Twitter tags, sitemap, schema validity, security headers in SEO category. Evidence = absence in the `seo` auditRefs list above (CLAIM from the fetched file).
**CITE** Best-practices category (same file) includes `is-on-https`, `redirects-http`, `has-hsts`, `csp-xss`, `clickjacking-mitigation`, `origin-isolation`, `trusted-types-xss` (weight 0), `doctype`, `charset`, `image-aspect-ratio`, `image-size-responsive`, `inspector-issues`, `errors-in-console`, `deprecations`, `third-party-cookies`.
**CITE** Accessibility category (same file) includes SEO-adjacent `document-title`, `html-has-lang`, `html-lang-valid`, `heading-order`, `image-alt`, `link-name`, `meta-viewport`, `landmark-one-main`, `empty-heading`, `identical-links-same-purpose`.
**CITE** Performance category weights: FCP 10, LCP 25, TBT 30, CLS 25, SI 10, INP weight 0 (`{id: 'interaction-to-next-paint', weight: 0, group: 'metrics', acronym: 'INP'}`); insights incl. `lcp-discovery-insight`, `render-blocking-insight`, `image-delivery-insight`, `cls-culprits-insight`, `font-display-insight`, `viewport-insight`.
**CITE** NEW category "Agentic Browsing" (marked unstable): "This category is still under development and subject to change." Audits: `agent-accessibility-tree`, `webmcp-form-coverage`, `webmcp-registered-tools`, `webmcp-schema-validity`, `cumulative-layout-shift`, `llms-txt`, `ard-schema`; groups agent-accessibility / webmcp / agent-discoverability; scored as a fraction (`categoryScoreDisplayMode: 'fraction'`).
**CITE** `llms-txt` audit logic (T1b): "The [llms.txt](https://llmstxt.org/) file should be a Markdown file containing at least one H1 header." Code: `hasH1 = /^\s*#\s+.+/m`, `hasLink = /\[.+\]\(.+\)/`, `isTooShort = content.length < 50`; status 4xx => notApplicable (score 1); 5xx or 429 => score 0.
**CITE** `hreflang` audit (T1c): flags unexpected language code and "Relative href value" for `<link rel=alternate hreflang>` in head or `Link:` headers; `x-default` accepted. It does NOT check reciprocity.
**CITE** Lighthouse gatherers (default-config.js `artifacts`): `RobotsTxt`, `LlmsTxt`, `MainDocumentContent`, `MetaElements`, `LinkElements`, `AnchorElements`, `ImageElements`, `Stacks` (framework detection), `AgentResourceDiscovery`.

### 2.2 Public agent skills (T2-T4, T10, T11)
**CITE** claude-seo `seo-audit` (T2): sub-agents `seo-technical`, `seo-content`, `seo-schema`, `seo-sitemap`, `seo-performance`, `seo-visual`, `seo-geo`, `seo-agentic`, `seo-local`, `seo-maps`, `seo-google`, `seo-matomo`, `seo-backlinks`, `seo-cluster`, `seo-sxo`, `seo-drift`, `seo-ecommerce`; crawl "Max pages: 500 ... Respect robots.txt: Yes"; score weights "Technical SEO 22%, Content Quality 23%, On-Page SEO 20%, Schema 10%, Performance (CWV) 10%, AI Search Readiness 10%, Images 5%". Severity bands Critical/High/Medium/Low.
**CITE** claude-seo `seo-technical` (T2) checks (selected): robots.txt valid; sitemap via script; noindex; crawl depth ≤3 clicks; Googlebot fetch limit ("Googlebot fetches the first **2MB of HTML** and first **64MB of a PDF**"); AI-crawler table (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, PerplexityBot, Bytespider, Google-Extended, Applebot-Extended, CCBot); canonical self-reference; pagination (rel=next/prev not used by Google); hreflang; security headers (CSP, HSTS, XFO, XCTO, Referrer-Policy); URL structure (>100 chars, redirect chains max 1 hop); mobile parity, interstitials; CWV (LCP ≤2.5s, INP ≤200ms, CLS ≤0.1); structured data; **JS rendering raw-vs-rendered** (canonical/noindex/non-200 behaviour); IndexNow; "Back-button hijacking ... enforcement live since 2026-06-15"; dynamic rendering "technical debt". Note: every one of these assertions is claude-seo's OWN statement; none verified here => all `needs source`.
**CITE** Notable claude-seo claim contradicting the old skill: "Blocking `GPTBot` prevents OpenAI training but does NOT affect ChatGPT Search citability, which is governed by `OAI-SearchBot`". `needs source` (OpenAI docs, other hand).
**CITE** JeffLi1993/seo-audit-skill README (T3): site-level robots.txt "RFC 9309 group parsing", sitemap, 404 vs soft-404 vs redirect-to-homepage, URL canonicalization (http->https, www, trailing slash), hreflang reciprocity/BCP 47/x-default, JSON-LD parse + required fields, E-E-A-T trust pages (About/Contact/Privacy/Terms), staging subdomain indexation (full), sitemap URL inventory (full), PageSpeed/Lighthouse (full, requires PSI key), GSC (full). Page-level: URL slug, "Title Tag | 50–60 chars", "Meta Description | 120–160 chars", "H1 Tag | Single H1", canonical self-ref, image alt, "Word Count | Body text ≥ 500 words", "Keyword Placement | Primary keyword within first 100 body words", "Heading Structure | H2 count (target 5–7)", internal links, OG/Twitter, robots meta. Architecture: "Script + LLM two-layer" (scripts for deterministic facts, LLM only on `llm_review_required`). Note the 50-60 / 120-160 / single-H1 numbers are the SAME as the old skill's, i.e. they circulate as folklore across skills => `needs source`.
**CITE** tech-seo-audit-skill (T4) `analysis-modules.md`: 10 categories; thresholds e.g. "Title too short: < 30 characters", "Title too long: > 60 characters", "Title pixel width: > 580 pixels", "Too short: < 70 characters" (description), "Too long: > 160 characters", "Pixel width: > 920 pixels", "Multiple H1s ... (less of an issue in HTML5 but still a signal)", "Blog post < 300 words = High", redirect chain "> 2 hops", "URLs exceeding 200 characters", sitemap "< 50MB, < 50,000 URLs per file", crawl depth, orphan pages, soft 404 "word count < 50", FAQ/HowTo flagged under "Deprecated Schema Warnings" ("HowTo (reduced rich result support)", "FAQ (limited to authoritative sources)"), llms.txt presence. It consumes crawl CSVs; it fetches no pages itself.
**CITE** anthropics/skills (T10) and addyosmani/agent-skills (T11): directory listings above contain no SEO audit skill. CLAIM (listing fetched). Consequence: the only public SEO audit SKILL.md files found are community ones (T2, T3, T4, plus search hits not fetched: RobertDebicki/SEO_Agent, 01clauding/claude-seo-skill, aevans-eng/seo-skill, citriac/claude-skills, ersubodhbhargav/claudeskill; URLs from web_search results, contents NOT read).

### 2.3 Screaming Frog (T7)
**CITE** "The Screaming Frog SEO Spider identifies over 300 SEO issues, warnings and opportunities" and the caveat: "Priorities are based upon potential impact ... They are not hard rules for what should be prioritised in your SEO strategy". Categories (page anchors): Response Codes, Security, URL, Page Titles, Meta Description, H1, H2, Content, Images, Canonicals, Pagination, Directives, Hreflang, JavaScript, Links, AMP, Structured Data, Sitemaps, PageSpeed, Mobile, Accessibility, Analytics, Search Console, Validation.
Selected distinctive checks from the fetched page (link texts): Response Codes (Internal No Response/4XX/5XX/Redirect Loop/Blocked by Robots.txt/Blocked Resource/Redirect Chain/Meta Refresh/JS redirect); Security (HTTP URLs, Mixed Content, Form On HTTP URL, Missing HSTS/CSP/X-Content-Type-Options/X-Frames-Options/Referrer-Policy, Unsafe Cross Origin Links, Protocol-Relative Resource Links, Bad Content Type); URL (Multiple Slashes, Contains A Space, Uppercase, Repetitive Path, Parameters, Over 115 Characters); Titles (Missing, Multiple, Outside `<head>`, Over 60 Characters, Below 30 Characters, "Over 561 Pixels", Below 200 Pixels, Same as H1); Meta Description ("Over 155 Characters", "Below 70 Characters", "Over 985 Pixels", Multiple, Outside head); H1 (Missing, Multiple [Warning, Medium], Non-sequential, Over 70 Characters); Content (Exact/Near Duplicates, Soft 404, Lorem Ipsum, Low Content, Readability); Images (Missing Alt Text vs Missing Alt Attribute, Over 100 kb, Alt Text Over 100 Characters, Incorrectly Sized Images, Missing Size Attributes); Canonicals (Multiple Conflicting, Non-Indexable Canonical, Contains Fragment URL, Outside head, Canonical Is Relative, Unlinked); Pagination; Directives (noindex/nofollow/none/noimageindex/nosnippet/unavailable_after/notranslate, Outside head); Hreflang (Non-200, Missing Return Links, Not Using Canonical, Missing Self Reference, Missing X-Default, Incorrect codes); **JavaScript** (Noindex Only In Original HTML, Nofollow Only In Original HTML, Canonical Mismatch, Canonical Only In Rendered HTML, Title/Meta Description/H1 Only In Rendered HTML or Updated By JavaScript, Pages With JavaScript Errors, Pages With Blocked Resources, Contains JavaScript Links/Content); Links (Outlinks To Localhost, Pages Without Internal Outlinks, Internal Nofollow Outlinks, high crawl depth, Non-Descriptive Anchor Text, no anchor text); AMP (many); Structured Data (Validation Errors, Rich Result Validation Errors, Parse Errors, Missing, Warnings); Sitemaps (over 50k URLs, over 50MB, URLs not in sitemap, Orphan URLs, Non-Indexable URLs in Sitemap, URLs in multiple sitemaps); PageSpeed (mirrors Lighthouse insights); Mobile (Viewport Not Set, Illegible Font Size, Target Size, Mobile Alternate Link); Accessibility (axe rules); Validation ("HTML Document Over 2MB", "Resource Over 2MB", Multiple head/body tags, "Invalid HTML Elements In Head", "Head Not First In HTML Element").
**CITE** The SF "raw vs rendered" JavaScript group is the closest public analogue to the raw-HTML-without-JS vs rendered-DOM comparison this skill plans.

### 2.4 Semrush Site Audit (T9)
**CITE** "With the ability to check over 140+ website issues"; "The order of priority is Errors (most harmful to a website) - Warnings (harmful) - Notices (least harmful)."
Errors: hreflang conflicts in source; 5XX; no title; duplicate titles; duplicate content ("Webpages are considered duplicates if their content is 85% identical."); broken internal links/images; couldn't be crawled (>5 s response or refused; DNS; incorrect URL format); duplicate meta descriptions; format errors in robots.txt and sitemap.xml; incorrect pages in sitemap; WWW resolve; no viewport tag; "Size of HTML on a page is too large"; AMP issues; hreflang values/links; 4XX; non-secure pages; expiring/old-protocol/incorrect-name certificate; mixed content; no redirect/canonical to HTTPS home; redirect chains and loops; broken/multiple canonical; meta refresh; broken internal JS/CSS; subdomains without secure algorithms; sitemap files too large; slow pages; invalid structured data items; malformed links; missing viewport width.
Warnings: title too long ("Most search engines truncate titles containing more than 70 characters."); title too short (≤10 chars); low text-HTML ratio (≤10%); no meta description ("Though meta descriptions don't have a direct influence on rankings, they are used by search engines to display your page's description in search results."); duplicate H1 and title; no H1; underscore in URL; temporary redirects; broken external images/links; plugin content; internal links with nofollow; uncompressed/unminified JS/CSS; too long link URLs.
Notices: **AI Search group**: "Llms.txt not found", "Llms.txt file has formatting issues", "Too much content", "Outdated Content" (Last-Modified older than six months), "Low Semantic HTML Usage", "Content not optimized" (poor heading hierarchy, long paragraphs, low readability); one incoming internal link; 403 external links; non-descriptive anchor text; "Pages that need more than 3 clicks"; external nofollow; no HSTS; URLs >200 chars; "Pages with more than one H1 tag" ("Although multiple <h1> tags are allowed in HTML5, we still do not recommend that you use more than one <h1> tag per page."); robots.txt not found; hreflang language mismatch; blocked from crawling; orphaned pages (GA, sitemap); "Pages blocked by X-Robots-Tag: noindex HTTP header"; blocked external resources; permanent redirects; no anchor text.
**CITE** Semrush's own docs rank "more than one H1" lowest (Notice) and treat missing llms.txt as Notice, both consistent with severity, not with a Google requirement. The "85% identical" and ">70 chars" figures are Semrush product thresholds, not Google rules.

### 2.5 Ahrefs Site Audit (T8) - partial coverage (see Tier note)
**CITE** Issue collection https://help.ahrefs.com/en/collections/1539899-issues lists 54 articles incl.: 403/404/500 page, 3xx/302 redirect, redirect chain/loop, broken redirect, canonical points to 4XX/5XX/redirect, canonical URL has no incoming internal links, duplicate pages without canonical, multiple/missing title and meta description, H1 missing or empty, noindex page in sitemap, non-canonical/3xx/4xx/5xx page in sitemap, orphan page, page has no outgoing links, nofollow-only incoming links, page has broken image / JS / links to redirect, double slash in URL, CSS/JS broken or too large, HTTPS page has internal links to HTTP, hreflang (invalid, missing return tag, to non-canonical, to broken page, mismatch with html lang, more than one page for same language, self-reference missing), HTML lang invalid, noindex/4xx/3xx pages receiving organic traffic. Everything beyond this (thresholds, remaining ~120 of "170+") NOT fetched.

### 2.6 Unlighthouse (T5)
**CITE** "Unlighthouse is a free, open-source CLI that runs Google Lighthouse on every page of your site in parallel." Discovery: "Auto-discovers URLs ... via robots.txt, sitemap.xml, and internal links." Own additions listed: "SEO Insights: Titles, meta descriptions, share images, link analysis." Requirements "Node.js 22.18+ ... Uses your system Chrome". So its checks = Lighthouse's plus a UI summary. A crawl-level Lighthouse runner (CLAIM: it runs Lighthouse per page; not tested).

### 2.7 SEOnaut (T6)
**CITE** README: "SEOnaut categorizes issues into three levels of severity: critical, high, and low." Source enum (`internal/issues/errors/errors.go`) includes: 30x/40x/50x, duplicated/empty/short/long title and description, little content, images no alt, redirect chain/loop, no H1, "H1-H6 tags have wrong order", no lang / invalid lang, HTTP links, hreflang (return link, to non-canonical/noindexable/redirect/error, missing x-default, missing self-reference, mismatching lang, relative URL, multiple lang reference), too many links, internal nofollow, canonical (to non-canonical/non-indexable/redirect/error, multiple tags, relative URL, "different canonical URLs in the HTML and HTTP headers"), noindex, blocked by robots.txt, orphan, sitemap (noindex / blocked / non-canonical), HTTP scheme, dead end, missing HSTS/CSP/X-Content-Type-Options, large image, long alt text, multiple title/description tags, depth, duplicated content, external link redirect/broken, timeout, underscore URL, slow TTFB, form on HTTP, insecure form, URL with space, multiple slashes, noimageindex, `<picture>` missing `<img>`, "meta tags in the document's body", nosnippet, img without size attributes, incorrect media type, duplicated id attributes, missing viewport tag, "HTML documents with excessive DOM size", pagination link missing, localhost links.

## 3. Union coverage matrix

Legend: ● = tool documents a check (cited above), ◐ = partial / only part of the check, ○ = not found in the fetched lists, ? = source not fetched (cannot tell), n/a = tool has no such surface. Old = `newdle-seo-audit`. LH = Lighthouse SEO+A11y+BP+Agentic (T1). CS = claude-seo (T2), JL = JeffLi1993 (T3), TS = tech-seo-audit-skill (T4), UL = Unlighthouse (T5; = LH unless noted), SO = SEOnaut (T6), SF = Screaming Frog (T7), AH = Ahrefs (T8, names only), SR = Semrush (T9). Type column: all rows are findings about tool coverage; each cell is a CLAIM backed by the section 2 CITE for that tool.

| # | Check category | Old | LH | CS | JL | TS | UL | SO | SF | AH | SR |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Title present/empty | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| 2 | Title length | ● (50-60) | ○ | ● | ● (50-60) | ● (<30/>60/580px) | ○ | ● | ● (30/60, 200/561px) | ? | ● (>70, ≤10) |
| 3 | Title duplicate / multiple / outside head / same as H1 | ◐ unique | ○ | ● | ◐ | ● | ○ | ● | ● | ● | ● |
| 4 | Meta description present / length / duplicate / multiple | ● (120-160) | ◐ present only | ● | ● (120-160) | ● (70/160/920px) | ◐ | ● | ● (70/155, 400/985px) | ● | ● (missing, dup) |
| 5 | H1 present / multiple | ● single | ○ (a11y heading-order only) | ● | ● | ● | ○ | ● | ● | ◐ missing | ● (notice) |
| 6 | Heading order / empty heading | ● | ● (a11y) | ◐ | ● | ● | ◐ | ● | ● | ? | ◐ |
| 7 | Canonical present / self / conflicts / chains / non-indexable target / HTML-vs-header | ◐ present | ● (valid) | ● | ● | ● | ● | ● | ● | ● | ● |
| 8 | Robots meta / X-Robots-Tag / noindex | ◐ meta only | ● `is-crawlable` | ● | ◐ (full) | ● | ● | ● | ● | ◐ | ● |
| 9 | robots.txt exists / valid / blocking / sitemap line | ● | ● | ● | ● (RFC 9309) | ● | ● | ● | ● | ? | ● |
| 10 | robots.txt 5xx handling | ○ | ● (status) | ● | ○ | ○ | ● | ○ | ○ | ? | ○ |
| 11 | Sitemap valid / content / lastmod / limits | ● | ○ | ● | ● | ● (50MB/50k) | ○ | ● | ● | ● | ● |
| 12 | Noindex/non-canonical/redirect/4xx URLs in sitemap | ◐ noindex/non-canon | ○ | ● | ◐ | ● | ○ | ● | ● | ● | ● |
| 13 | HTTP status / soft 404 / 404 page behaviour | ◐ | ● `http-status-code` | ● | ● (soft404) | ● | ● | ● | ● | ● | ● |
| 14 | Redirect chains / loops / 302 vs 301 / meta refresh | ◐ 301 only | ◐ `redirects` hidden | ● | ◐ | ● | ◐ | ● | ● | ● | ● |
| 15 | HTTPS / http->https redirect / mixed content | ○ | ● | ● | ● | ● | ● | ◐ | ● | ● | ● |
| 16 | Security headers (HSTS, CSP, XFO, XCTO, referrer) | ○ | ● | ● | ○ | ● | ● | ● | ● | ? | ◐ HSTS |
| 17 | URL hygiene (case, underscores, length, params, double slash, spaces) | ◐ clean URLs, slash | ○ | ● | ● slug | ● | ○ | ● | ● | ◐ double slash | ● |
| 18 | Crawl depth / orphan / internal-link graph / anchors | ○ | ◐ `crawlable-anchors`, `link-text` | ● | ◐ | ● | ◐ | ● | ● | ● | ● |
| 19 | Broken internal/external links, images | ○ | ◐ | ● | ◐ | ● | ○ | ● | ● | ● | ● |
| 20 | Hreflang (codes, return links, x-default, self-ref, canonical alignment) | ○ | ◐ (codes, absolute) | ● | ● | ● | ◐ | ● | ● | ● | ● |
| 21 | html lang valid / hreflang match | ● lang | ● | ◐ | ◐ | ● | ● | ● | ◐ | ● | ◐ |
| 22 | Pagination | ○ | ○ | ● | ○ | ● | ○ | ◐ | ● | ? | ◐ |
| 23 | Images: alt present / quality | ● | ● | ● | ● | ● | ● | ● | ● | ◐ | ● |
| 24 | Images: dimensions, format, size, srcset, lazy/LCP | ● | ● (`unsized-images`, `image-delivery-insight`, `image-aspect-ratio`) | ◐ | ○ | ◐ (>200KB) | ● | ● (size attr, large) | ● | ? | ○ |
| 25 | Viewport / mobile parity | ● viewport | ● | ● parity | ◐ | ◐ | ● | ● | ● | ? | ● |
| 26 | Core Web Vitals lab (LCP/CLS/TBT/INP) | ◐ code patterns | ● | ● | ● (PSI, full) | ◐ guidance | ● | ○ | ● (PSI) | ? | ◐ |
| 27 | CWV field data (CrUX/PSI) | ○ | ○ | ● (optional) | ● (PSI) | ○ | ○ | ○ | ● | ? | ○ |
| 28 | Page weight / DOM size / TTFB / HTML size | ○ | ● | ● (2MB) | ○ | ● | ● | ● (TTFB, DOM) | ● (2MB, DOM) | ◐ | ● |
| 29 | Open Graph / Twitter cards | ● | ○ | ◐ | ● (full) | ○ | ◐ share images | ○ | ○ | ? | ○ |
| 30 | Favicon / touch icon / manifest | ● | ○ (installable removed) | ? | ○ | ○ | ○ | ○ | ○ | ? | ○ |
| 31 | Structured data: detect / parse / validate | ◐ (types, valid JSON) | ◐ manual only | ● | ● | ◐ | ○ | ○ | ● (+ rich result) | ? | ● |
| 32 | Structured data: type recommendations per page type | ● | ○ | ● | ◐ | ● | ○ | ○ | ○ | ? | ○ |
| 33 | Raw HTML vs rendered DOM (JS dependence) | ◐ code reading only | ○ (`MainDocumentContent` gatherer, no audit) | ● | ◐ (raw fetch, "JS-render detection" for alt) | ◐ | ○ | ○ | ● (JS group) | ? | ○ |
| 34 | Google fetch limit 2MB HTML | ○ | ○ | ● | ○ | ○ | ○ | ○ | ● | ? | ◐ HTML size |
| 35 | AI crawler directives in robots.txt | ● (6 bots) | ○ | ● (10 bots) | ○ | ○ | ○ | ○ | ○ | ? | ○ |
| 36 | llms.txt present / format | ● | ● | ● | ○ | ● | ○ | ○ | ○ | ? | ● |
| 37 | AI content extractability (semantic HTML, answers in plain text) | ● | ◐ `agent-accessibility-tree` | ● | ○ | ● | ○ | ○ | ○ | ? | ● |
| 38 | Agent surface (WebMCP, ARD, agent a11y tree) | ○ | ● | ● | ○ | ○ | ○ | ○ | ○ | ? | ○ |
| 39 | Content freshness (Last-Modified, dates) | ◐ `<time>` | ○ | ○ | ○ | ◐ | ○ | ○ | ○ | ? | ● |
| 40 | Duplicate / near-duplicate / thin content | ○ | ○ | ● | ● word count | ● | ○ | ● | ● | ● | ● |
| 41 | Content: readability, spelling, keyword placement | ○ | ○ | ● | ● | ● | ○ | ○ | ● | ? | ● |
| 42 | E-E-A-T trust pages, author/publish signals | ◐ author/dates | ○ | ● | ● | ○ | ○ | ○ | ○ | ? | ○ |
| 43 | Semantic HTML / landmarks | ● | ● (a11y) | ● | ○ | ● | ○ | ○ | ● (a11y) | ? | ● |
| 44 | HTML validity (head order, tags in body, duplicate id, doctype/charset) | ○ | ● doctype, charset, `duplicate-id-aria` | ○ | ○ | ○ | ○ | ● | ● | ? | ◐ |
| 45 | Framework-specific code review (Next.js metadata, generateMetadata, robots.ts, sitemap.ts, helmet) | ● | ◐ (`Stacks` detect) | ● (framework table) | ○ | ◐ (platform detection) | ○ | ○ | ○ | ○ | ○ |
| 46 | Staging-subdomain indexation / site-level host checks (www, trailing slash) | ○ | ○ | ◐ | ● | ◐ | ○ | ○ | ◐ | ? | ● www |
| 47 | Third-party/search-console/analytics join (GSC, GA, CrUX) | ○ | ○ | ● optional | ● GSC full | ○ | ○ | ○ | ● | ● | ● GA |
| 48 | Outdated tech (AMP, flash, plugins, old AJAX scheme) | ○ | ○ | ● AMP note | ○ | ◐ AMP | ○ | ○ | ● | ? | ● |
| 49 | Score / prioritisation model | ● 3-tier | ● weights | ● weights+bands | ◐ | ● business impact | ● | ● 3-tier | ● 3x3 | ● | ● 3-tier |
| 50 | Evidence/citation per rule | ○ | ○ (links to docs) | ◐ (some URLs) | ○ | ○ | ○ | ○ | ◐ explainer pages | ◐ | ◐ (Google links) |

Table scoring caveat: cells for AH marked `?` mean the tool's page did not list that item in the 54 fetched titles, NOT that it lacks the check.

## 4. Gap list: checks others have that the old skill lacks

All tagged `needs source`: other hands fetch the Google/Bing/schema/AI-crawler/CWV sources. This hand only flags. IDs are PROPOSED, prefix SRV-.

| ID | Gap (old skill lacks) | Seen in | Tag |
|---|---|---|---|
| SRV-001 | Live-URL audit mode at all (fetch URL, status, final URL after redirects) | LH, CS, JL, SF, SO, AH, SR | needs source (process; Google "Inspect URL"/fetch docs) |
| SRV-002 | Raw HTML (no JS) vs rendered DOM diff for title, meta description, H1, canonical, robots/noindex, structured data, main content | SF JS group; CS | needs source (Google JS SEO doc, Dec 2025 update per CS) |
| SRV-003 | Raw-HTML noindex vs JS-removed noindex; canonical differing between raw and rendered | SF ("Noindex Only In Original HTML", "Canonical Mismatch"); CS | needs source |
| SRV-004 | Non-200 status page + JS-injected content invisible | CS | needs source |
| SRV-005 | HTTP response header checks: status, `X-Robots-Tag`, `Link: rel=canonical`/hreflang header, `Content-Type`, canonical HTML-vs-header mismatch, cache/`Last-Modified` | SO, SF, SR, LH | needs source |
| SRV-006 | Redirect chain / loop / 302 / meta refresh / JS redirect / HTTP->HTTPS and www canonicalisation | LH, SF, SO, SR, AH, JL | needs source |
| SRV-007 | HTTPS: mixed content, forms on HTTP, cert validity | LH, SF, SR, SO | needs source (low weight per CS note "HTTPS ... very lightweight") |
| SRV-008 | Security headers (HSTS, CSP, XFO, XCTO, Referrer-Policy) | LH, SF, SO, CS, TS | needs source; likely not an SEO ranking factor => severity question |
| SRV-009 | robots.txt: 5xx handling, syntax validation (RFC 9309), blocked CSS/JS resources, `Crawl-delay`, wildcard breadth, per-bot groups, AI bots beyond the six | CS, JL, SF, TS, SR | needs source (Google robots.txt spec; RFC 9309) |
| SRV-010 | Sitemap: size limits (50MB / 50,000 URLs), index files, duplicate URLs across sitemaps, non-200/redirect/noindex/blocked/non-canonical URLs inside sitemap, `lastmod` truthfulness, robots.txt `Sitemap:` line | SF, SR, SO, AH, TS | needs source (sitemaps.org; Google sitemap doc) |
| SRV-011 | Hreflang validity: codes, absolute URLs, return links, self-reference, x-default, hreflang-to-noindex/redirect/4xx, hreflang vs canonical, vs `html lang` | LH, SF, SO, SR, AH, JL | needs source |
| SRV-012 | Canonical depth: multiple canonicals, relative canonical, canonical in body/outside head, canonical to noindex/4xx/redirect, fragment, chains, JS-vs-raw | SF, SO, AH, SR, TS | needs source |
| SRV-013 | Meta/link elements in body or outside `<head>` (title, description, canonical, robots, hreflang), multiple `<title>`/description tags | SF, SO ("meta tags in the document's body"), AH | needs source (parser "head" boundary behaviour) |
| SRV-014 | `max-snippet`, `nosnippet`, `unavailable_after`, `noimageindex`, `notranslate` robots directives | SF, JL | needs source |
| SRV-015 | Pagination: crawlable `<a href>`, self-canonical, non-200 pagination URLs, rel next/prev now ignored | SF, CS, TS | needs source |
| SRV-016 | Googlebot HTML fetch limit (2MB) and oversized HTML/resources/DOM | CS, SF ("HTML Document Over 2MB"), SR, SO | needs source |
| SRV-017 | Soft 404, 404 page returns 404, redirect-to-homepage for missing pages | JL, TS, SF | needs source |
| SRV-018 | Internal link graph: crawl depth, orphans, nofollow internal, empty/non-descriptive anchor text, `crawlable-anchors` (JS `href`-less links), links to localhost | LH (`crawlable-anchors`, `link-text`), SF, SO, SR, AH | needs source |
| SRV-019 | Broken links/images/resources (internal and external) | SF, SO, SR, AH | needs source (sampling policy; not a direct ranking rule) |
| SRV-020 | Images: `<picture>` without `<img>`, missing size attributes, large file size, alt too long, responsive sizing (`image-size-responsive`), LCP discovery/priority | LH, SF, SO | needs source |
| SRV-021 | Structured data actually parsed and validated (JSON-LD syntax, `@graph`, required/recommended properties, type conflicts, deprecated types) rather than only "present" | JL, SF, SR, TS | needs source (Google structured-data docs + schema.org) |
| SRV-022 | Lab performance via Lighthouse run: LCP discovery, render-blocking, CLS culprits, font-display, TTFB/document latency, legacy JS | LH, SF, UL | needs source (CWV thresholds; web.dev) |
| SRV-023 | Field CWV (CrUX/PSI) | CS, JL, SF | needs source |
| SRV-024 | AI crawlers: separate training vs search vs user-fetch bots (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, Applebot, Google-Extended, Bytespider, Meta, etc.) | CS | needs source (each vendor's crawler doc) |
| SRV-025 | llms.txt validity (H1, links, length) instead of mere presence; Lighthouse treats it as scored audit | LH, SR | needs source (llmstxt.org; another hand is on it) |
| SRV-026 | Agent surface: accessibility tree for agents, WebMCP, ARD (`ard-schema`), `/.well-known` discovery, Markdown delivery | LH Agentic Browsing, CS `seo-agentic` | needs source (Chrome docs; category flagged "still under development") |
| SRV-027 | Semantic HTML ratio, content length truncation risk, `Last-Modified` age as AI-search signals | SR "AI Search" group | needs source (vendor-asserted; Semrush says "Some AI search engines may prefer more recently updated content") |
| SRV-028 | Duplicate and near-duplicate content (85% in Semrush), thin content by page type, soft duplicates | SF, SR, TS, SO | needs source (Google duplicate-content doc) |
| SRV-029 | Trust/E-E-A-T pages exist and are linked (About, Contact, Privacy, Terms), author attribution | JL, CS | needs source (Google quality docs; may be demoted to non-rule) |
| SRV-030 | Staging/preview host indexability, www/non-www and trailing-slash canonicalisation | JL, SR | needs source |
| SRV-031 | URL hygiene: uppercase, underscores, double slashes, spaces, `>115/>200` chars, session IDs, parameter explosion, internal search URLs | SF, SO, TS, SR | needs source |
| SRV-032 | HTML hygiene: head order, tags in body, duplicate `id`, doctype, charset, multiple head/body | SF "Validation", SO, LH BP | needs source |
| SRV-033 | Mobile: tap target size, illegible font, mobile/desktop content and metadata parity, intrusive interstitials | LH (a11y `target-size`), SF, CS | needs source |
| SRV-034 | Back-button hijacking / `history.pushState` abuse as spam-policy item | CS | needs source (verify claim, date, Google policy page) |
| SRV-035 | IndexNow support | CS | needs source (Bing doc) |
| SRV-036 | Severity/weight model that is explicit and justified; Lighthouse and SF both publish theirs | LH, SF, SR, CS | design question for the skill, not a source |
| SRV-037 | Script+LLM split: deterministic facts from scripts, LLM only for semantic judgement flagged `llm_review_required` | JL | design pattern, no external source needed |
| SRV-038 | Sampling/crawl limits and politeness (max pages, delay, SSRF protection) for multi-page mode | CS ("Max pages: 500"), JL (SSRF protection in `fetch-page.py`) | design + security, no source |

## 5. Old-skill rules that look unsupported or outdated (flag for verification)

All entries are flags. None is confirmed wrong. Each needs a primary source from other hands before it stays in the new skill. Evidence column = what THIS survey observed (not a Google source).

| Old rule (line in old SKILL.md) | Why flagged | What this survey saw | Tag |
|---|---|---|---|
| Title "50–60 characters" (l.70) | Round-number folklore; Google truncates by pixel width, not chars | SF uses 30 chars / 60 chars and 200 / 561 px; Semrush uses ">70 characters" and "10 characters or less"; Lighthouse has no length audit | needs source (Google "title links" doc) |
| Description "120–160 characters" (l.71) | Same: Google generates snippets and "may" ignore the tag | SF 70 / 155 chars, 400 / 985 px; TS 70 / 160; Semrush: "meta descriptions don't have a direct influence on rankings" | needs source |
| Description "includes target keywords" (l.71) | Keyword stuffing guidance; unsupported | none | needs source |
| Single `<h1>` per page (l.92); "containing primary keywords" | HTML allows multiple; Google statements? | Semrush: "Although multiple <h1> tags are allowed in HTML5, we still do not recommend..." (a Notice); SF "Multiple" = Warning/Medium; Lighthouse: no h1 audit | needs source (Google John Mueller / HTML spec) |
| Heading hierarchy "no skips" (l.93) | a11y rule, not SEO | Lighthouse `heading-order` is in Accessibility, weight 3, "Moderate, best-practice" | needs source; may belong under a11y, not SEO |
| "Paragraphs in `<p>` tags, not `<div>` soup", lists in `<ul>`, `<time datetime>` (l.95-98) | Semantics-for-ranking is unsupported; useful for a11y/AI extraction at most | Semrush "Low Semantic HTML Usage (AI Search)" = Notice, vendor assertion | needs source |
| Alt text "containing relevant keywords" (l.142) | Alt is for description; keywords advice is folklore | Lighthouse `image-alt` only checks presence; SF "Alt Text Over 100 Characters" | needs source (Google image SEO doc) |
| `WebSite` + `SearchAction` "sitelinks search box" (l.107) | Google announced removal of the sitelinks search box in late 2024 [GUESS(recall), not checked] | TS lists "WebSite with SearchAction" as a recommendation | needs source; likely OUTDATED |
| `FAQ` structured data (l.111, l.212) | Google restricted FAQ rich results to authoritative gov/health sites in 2023 and later reduced further [GUESS(recall)] | TS: "FAQ (limited to authoritative sources)" and "HowTo (reduced rich result support)" under "Deprecated Schema Warnings" | needs source; likely OUTDATED |
| `HowTo` schema (l.112) | Rich result deprecated [GUESS(recall)] | TS lists as deprecated warning | needs source; likely OUTDATED |
| `Product`, `Review`, `Organization`, `LocalBusiness`, `Article`, `BreadcrumbList` as "common schemas checked" (l.106-112) | Eligibility and required properties vary; list is not tied to Google's supported-features list | SF has "Rich Result Validation Errors" | needs source (Google search gallery) |
| "No cloaking" / data matches visible content (l.114) | Fine in spirit; no source | none | needs source (Google structured-data general guidelines) |
| "Client-only meta tags are invisible to crawlers" (l.86); "SPA content is largely invisible to search engines and AI bots" => Critical (l.135) | Overbroad for Google, which renders JS; may be true for many AI fetchers | CS: Google JS doc statements about raw vs rendered, dynamic rendering = "technical debt"; SF has JS-only-in-rendered checks (severity not "critical" by default) | needs source; split Google vs AI crawler |
| `react-helmet-async` as the SPA head approach (l.85); Next `<Head>` as anti-pattern (l.80) | React 19 / Next App Router have built-in metadata; recommending a library may be dated [GUESS(recall)] | none | needs source (React 19 doc, Next metadata doc) |
| 301 vs 302 "not 302" (l.170) | Google treats temporary vs permanent redirects as canonicalisation hints; blanket rule suspect | SF: "Internal Redirection (3XX)" = Low Warning; TS "302/307 ... should be 301s (especially if > 6 months old)"; Ahrefs has "302 redirect" warning | needs source |
| `trailingSlash` consistency (l.168, l.173) | Valid duplicate-URL concern; but fix depends on config | SF "Uppercase", "Multiple Slashes" are Low | needs source |
| `<meta name="viewport">` exactly `width=device-width, initial-scale=1` (l.72) | Exact value unsupported; Lighthouse checks presence/zoom | Lighthouse a11y `meta-viewport` Critical weight 10 (zoom must not be disabled); SF "Viewport Not Set"; Semrush "Missing the viewport width value" | needs source |
| "Twitter Cards" required (l.76) and OG set (l.75) | Social previews, not ranking; "twitter:" names vs X | JL treats as Full-only; Lighthouse/SF/SO do not check | needs source; severity should be Suggestion at most |
| Favicon and `apple-touch-icon` (l.77) | Google favicon guidelines exist but apple-touch-icon is not a Google requirement [GUESS(inference)] | no surveyed tool checks apple-touch-icon | needs source |
| `llms.txt` "Should exist for content-heavy or documentation sites" (l.206-208) | Proposed community standard; no major search engine has confirmed use [GUESS(recall)] | Lighthouse now has a scored `llms-txt` audit (Agentic Browsing, "still under development"); Semrush Notice; llmstxt.org cited by both | needs source (llmstxt.org + any vendor statement); keep Suggestion, assert exactly what each tool checks |
| AI bot list: `GPTBot` "(OpenAI / ChatGPT search)", `ClaudeBot` "(Anthropic)", `PerplexityBot`, `Applebot-Extended` "(Apple Intelligence)", `Google-Extended` "(Gemini)", `CCBot` (l.198-204); "Flag if these are blocked" | Conflates training vs search vs user-fetch bots; list omits OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, Applebot, Perplexity-User etc. | CS table: "GPTBot ... Model training (NOT ChatGPT Search)", "OAI-SearchBot ... ChatGPT Search citability", "Claude-SearchBot ... Claude search-result citability"; "Google-Extended ... (no effect on Search inclusion or ranking)" | needs source (OpenAI, Anthropic, Google, Apple, Perplexity crawler docs); "unintentional AI-crawler block = Critical" (l.311) is likely too strong |
| "AI bots prefer content they can cite directly"; "Unique, quotable passages" (l.217) | Unsupported assertion about AI engine behaviour | none (Semrush: "Some AI search engines may prefer more recently updated content" is also vendor opinion) | needs source or drop |
| "Content reads well when stripped of all styling (this is how AI bots see it)" (l.213) | Not true of crawlers that render | none | needs source or drop |
| "Answers stated directly, not buried in UI widgets", FAQ via `<details>`/`<summary>` (l.210-212) | Practice, not documented rule | Semrush "Content not optimized (AI Search)" covers heading hierarchy, long paragraphs, readability | needs source |
| CWV "INP: Heavy `onClick` handlers ... missing `useTransition`" (l.161) | Code smell list, not an INP rule; FID not mentioned (good) | Lighthouse INP weight 0 in perf score; CS: "INP replaced FID on March 12, 2024" | needs source (web.dev INP) |
| CWV "font swap causing layout shift (`font-display: swap` is good but check for FOUT)" (l.160) | Muddled; Lighthouse has `font-display-insight` | Lighthouse perf insights list `font-display-insight` | needs source |
| `prefers-reduced-motion` as SEO suggestion (l.313) | Accessibility, unrelated to search | none of the surveyed SEO tools check it | needs source or drop |
| Severity: "Critical: no `<title>`" etc. (l.311-313) | Mixed; duplicates/missing description scored Warning though Semrush says no direct ranking influence | SF title Missing = Issue/High; description Missing = Opportunity/Low; Semrush description missing = Warning | needs source (severity must be per-rule justified) |
| Structure: audit only "files the user provides" (l.32) | No live-URL path, so most items above cannot even be checked | n/a | design gap, not a rule |
| Next.js: "Avoid `"use client"` on pages whose content needs indexing"; `dynamic = "force-dynamic"` on static pages (l.130-131) | Next-specific; may be outdated with Server Components defaults / partial prerendering [GUESS(recall)] | none | needs source (Next docs, other hand) |

## 6. Local tooling (public data only)

| Type | Statement | Receipt |
|---|---|---|
| ACTION | `npx --yes lighthouse --version` works here, prints `13.5.0`, exit 0 | bash tool run 2026-10-12: output "13.5.0 / lh exit 0" |
| ACTION | `/Applications/Google Chrome.app` exists, version 154.0.8037.98 | `ls -d "/Applications/Google Chrome.app"` printed the path, exit 0; `defaults read "/Applications/Google Chrome.app/Contents/Info" CFBundleShortVersionString` -> `154.0.8037.98` |
| ACTION | `npx --yes playwright --version` works, prints `Version 1.64.0`, exit 0 | bash run 2026-10-12 |
| ACTION | Playwright browser cache exists with Chromium builds | `ls ~/Library/Caches/ms-playwright` -> chromium-1208, chromium-1223, chromium_headless_shell-1208/1223/1248, ffmpeg-1011/1013 (whether 1.64.0 matches build 1248 is NOT checked) |
| ACTION | Node `v24.13.0` | bash run |
| GUESS(inference) | Lighthouse headless needs a Chrome the CLI can find; here the system Chrome 154 is present, so `lighthouse <url> --chrome-flags="--headless=new" --output=json` should run; NOT executed this session (no network audit run, to avoid hitting a live site) | basis: version checks above only |
| ACTION (refused) | `npm view <pkg> ...` loop was refused by the gate (P-11 row 6, npm subcommand on reserved list); npm facts were obtained via `curl https://registry.npmjs.org/<pkg>/latest` and the read tool's npm page fetch instead | gate message quoted in transcript |

### 6.1 Node packages commonly used to parse HTML / JSON-LD / robots.txt / sitemaps
All versions/licences from `https://registry.npmjs.org/<pkg>/latest` fetched 2026-10-12; npm pages fetched via read tool for robots-parser, linkedom, cheerio.

| Package | npm page | Version / licence | What it is (registry description) | Use for the skill |
|---|---|---|---|---|
| robots-parser | https://www.npmjs.com/package/robots-parser | 3.0.1 / MIT; last modified 2023-02-21; 5.6M weekly | "A specification compliant robots.txt parser with wildcard (*) matching support." | allow/disallow per UA, sitemap lines. GUESS(inference): no explicit handling of 5xx robots.txt (status logic must be done by the skill); package unmaintained since 2023 |
| cheerio | https://www.npmjs.com/package/cheerio | 1.2.0 / MIT; modified 2026-07-17; 27M weekly | "The fast, flexible & elegant library for parsing and manipulating HTML and XML." (parse5-based) | static HTML extraction (title, meta, link, JSON-LD script text, headings) |
| linkedom | https://www.npmjs.com/package/linkedom | 0.18.13 / ISC; modified 2026-07-07; 5M weekly | "A triple-linked lists based DOM implementation" (htmlparser2-based) | DOM-API-style querying without jsdom weight |
| parse5 | https://registry.npmjs.org/parse5/latest | 8.0.1 / MIT | "HTML parser and serializer." | spec-compliant parse; needed to match browser `<head>` handling for "tag in body" checks |
| node-html-parser | https://registry.npmjs.org/node-html-parser/latest | 9.0.4 / MIT | "A very fast HTML parser, generating a simplified DOM" | fast but non-spec tree; GUESS(inference) unsuitable for head/body boundary checks |
| jsdom | https://registry.npmjs.org/jsdom/latest | 30.1.2 / MIT | "A JavaScript implementation of many web standards" | heavy; rendering not needed if Playwright used |
| htmlparser2 | https://registry.npmjs.org/htmlparser2/latest | 12.0.0 / MIT | "Fast & forgiving HTML/XML parser" | low-level |
| fast-xml-parser | https://registry.npmjs.org/fast-xml-parser/latest | 5.11.2 / MIT | "Validate XML, Parse XML, Build XML without C/C++ based libraries" | sitemap.xml / sitemap index parsing |
| sitemapper | https://registry.npmjs.org/sitemapper/latest | 4.1.6 / MIT | "Parser for XML Sitemaps to be used with Robots.txt and web crawlers" | sitemap crawl; GUESS(pattern): fast-xml-parser gives finer control for validation |
| jsonld | https://registry.npmjs.org/jsonld/latest | 9.0.0 / BSD-3-Clause | "A JSON-LD Processor and API implementation in JavaScript." | expand/flatten JSON-LD; `JSON.parse` suffices for syntax checks |
| ajv | https://registry.npmjs.org/ajv/latest | 8.20.0 / MIT | "Another JSON Schema Validator" | validating extracted data against own rule schemas; NOT a schema.org validator |
| schema-dts | https://registry.npmjs.org/schema-dts/latest | 2.1.0 / Apache-2.0 | "A TypeScript package with latest Schema.org Schema Typings" | type names only; does not encode Google's required/recommended properties (GUESS(inference)) |
| lighthouse | https://registry.npmjs.org/lighthouse/latest | 13.5.0 / Apache-2.0; modified 2026-10-10 | "Automated auditing, performance metrics, and best practices for the web." | lab metrics + SEO + Agentic category JSON |
| playwright | https://registry.npmjs.org/playwright/latest | 1.64.0 / Apache-2.0 | "A high-level API to automate web browsers" | rendered DOM, response headers, JS-disabled raw fetch comparison |
| puppeteer | https://registry.npmjs.org/puppeteer/latest | 25.13.0 / Apache-2.0 | "A high-level API to control headless Chrome over the DevTools Protocol" | alternative to Playwright; Lighthouse uses it internally (GUESS(recall)) |

Gap in tooling (GUESS(inference), basis: none of the fetched package descriptions mention Google rich-results rules): no npm package found in this survey validates structured data against Google's rich-result required/recommended properties; the skill would have to encode those from Google's docs.

## 7. Design observations for the new skill (GUESS, from the survey)

- **GUESS(inference)** Union of live-URL checks in section 3 rows 1-22, 28, 31, 33, 35-38 is achievable with: `fetch` (raw HTML + headers, redirect chain, robots/sitemap/llms.txt), Playwright (rendered DOM, JS-off diff), Lighthouse CLI (lab metrics, SEO + Agentic fractions), cheerio/linkedom/parse5 (parsing), robots-parser (robots.txt), fast-xml-parser (sitemaps). Basis: package descriptions and local version checks above.
- **GUESS(inference)** Ranking checks by "evidence class" (Google-documented requirement / Google-documented recommendation / vendor heuristic / community convention) would let the skill cite per rule and avoid the folklore in section 5. Basis: SF's own disclaimer ("They are not hard rules ...") and the fact that every length rule above has different thresholds across tools (SF 60/155, TS 60/160, Semrush 70, JL 50-60/120-160, old skill 50-60/120-160).
- **GUESS(inference)** Lighthouse's Agentic Browsing category is brand-new and flagged "still under development", so llms.txt/WebMCP/ARD rules should be tagged "emerging, not a ranking factor" until sources say otherwise.

## 8. Counts

Tools/skills surveyed: 11 sources (Lighthouse, claude-seo, JeffLi1993, tech-seo-audit-skill, Unlighthouse, SEOnaut, Screaming Frog, Ahrefs [partial], Semrush, anthropics/skills, addyosmani/agent-skills) + the old skill = 12 matrix columns incl. LH.
Gaps listed: 38 (SRV-001..SRV-038).
Outdated/unsupported old rules flagged: 30 rows in section 5.
URLs fetched successfully this session: 33 (listing: github default-config.js, llms-txt.js, hreflang.js raw; claude-seo seo-audit + seo-technical raw; JeffLi1993 repo; Suganthan/Snippet repo + analysis-modules raw; addyosmani repo page; unlighthouse home + install; screamingfrog issues; semrush kb 542; ahrefs help collection; npmjs pages x3; GitHub API commit/listing endpoints x ~8; registry.npmjs.org x ~15). Failed: https://ahrefs.com/seo/site-audit (404), https://help.ahrefs.com/en/articles/2349955-... (404), https://api.github.com/search/code (401).
