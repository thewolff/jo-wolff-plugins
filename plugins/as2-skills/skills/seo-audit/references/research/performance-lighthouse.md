# Research: Performance, Core Web Vitals, Lighthouse (rule prefixes CWV-, LH-)

Fetch date for every source below: **2026-10-12**. Every URL listed was fetched this session with the `read`/`grep`/`web_search` tools. Quoted passages are verbatim (markdown bold stripped). Severity values are *suggestions* for the skill's report, not claims from the sources.

## 0. Reading notes (blockers first)

- **Primary-source gap (PSI no-key limits):** no fetched Google primary page states the request limit for the PageSpeed Insights API without a key. Quota figures seen only in third-party search snippets (25,000/day; 400 per 100 s) are leads, not rules. See credential table and section 7.
- **Lighthouse version pin:** the current release at fetch time is `v13.5.0` (changelog heading "13.5.0 (2026-09-17)"). The SEO-category audit list below was read from `core/config/default-config.js` at tag `v13.5.0` and at `main`. The last commit touching that file at fetch time is `8bd6931f3de5b20e8428da71eae13a9165b1a582` (2026-09-01, "core(config): group llms.txt and ARD audits under agent discovery (#17210)"). `main` HEAD was `2ac69abc42f981c6e15254ef2fe563140ff4d7e6` (2026-10-09) when fetched.
- **Lighthouse (lab) cannot judge Core Web Vitals pass/fail.** Google's own docs say field data decides; Lighthouse results are diagnostics. Several rules below are therefore tagged `lab-metrics` with a severity cap.

---

## 1. Thresholds table (exact, as the sources state them)

| Metric | Good | Needs improvement | Poor | Percentile / segmentation | Source URL | Quoted passage |
|---|---|---|---|---|---|---|
| LCP | <= 2.5 s | <= 4 s | > 4 s | 75th percentile, mobile and desktop separately | https://support.google.com/webmasters/answer/9205520 | "LCP \| <=2.5s \| <=4s \| >4s" (row of the status-definitions table) |
| INP | <= 200 ms | <= 500 ms | > 500 ms | 75th percentile, mobile and desktop separately | https://web.dev/articles/inp | "An INP below or at 200 milliseconds means a page has good responsiveness. An INP above 200 milliseconds and below or at 500 milliseconds means a page's responsiveness needs improvement." (poor = "above 500 milliseconds") |
| CLS | <= 0.1 | <= 0.25 | > 0.25 | 75th percentile, mobile and desktop separately | https://support.google.com/webmasters/answer/9205520 | "CLS \| <=0.1 \| <=0.25 \| >0.25" |
| FCP (supporting, PSI) | [0, 1800 ms] | (1800 ms, 3000 ms] | over 3000 ms | PSI field data | https://developers.google.com/speed/docs/insights/v5/about | "FCP \| [0, 1800ms] \| (1800ms, 3000ms] \| over 3000ms" |
| TTFB (supporting, experimental, PSI) | [0, 800 ms] | (800 ms, 1800 ms] | over 1800 ms | PSI field data | https://developers.google.com/speed/docs/insights/v5/about | "TTFB (experimental) \| [0, 800ms] \| (800ms, 1800ms] \| over 1800ms" |
| Lighthouse category score (lab) | 90 or above | 50 to 89 | below 50 | single lab run | https://developers.google.com/speed/docs/insights/v5/about | "A score of 90 or above is considered good. 50 to 89 is a score that needs improvement, and below 50 is considered poor." |

Page passes CWV when the 75th percentile of all three metrics is Good (CWV-004).

---

## 2. Core Web Vitals rules (CWV-)

### 2.1 Definitions, thresholds, how to judge

| rule-id | check (element/header/file and pass condition) | layer | severity suggestion + why | source URL | quoted passage |
|---|---|---|---|---|---|
| CWV-001 | Field LCP p75 <= 2.5 s (CrUX/PSI/Search Console). Fail: > 2.5 s needs improvement, > 4 s poor. | any (field data; needs CrUX) | high when p75 > 4 s (poor); medium when 2.5-4 s. Google names CWV as used by ranking systems. | https://web.dev/articles/vitals | "LCP should occur within 2.5 seconds of when the page first starts loading." |
| CWV-002 | Field INP p75 <= 200 ms. Fail: > 200 ms needs improvement, > 500 ms poor. | any (field data) | high when > 500 ms; medium when 200-500 ms. | https://web.dev/articles/vitals | "pages should have a INP of 200 milliseconds or less." |
| CWV-003 | Field CLS p75 <= 0.1. Fail: > 0.1 needs improvement, > 0.25 poor. | any (field data) | high when > 0.25; medium when 0.1-0.25. | https://web.dev/articles/vitals | "pages should maintain a CLS of 0.1. or less." (source text has the stray period) |
| CWV-004 | Pass/fail uses the 75th percentile, segmented mobile vs desktop. A URL/origin passes only if LCP, INP and CLS are all Good at p75. Report mobile and desktop separately. | any (field data) | medium: wrong aggregation gives false passes. | https://web.dev/articles/vitals | "Tools that assess Core Web Vitals compliance should consider a page passing if it meets the recommended targets at the 75th percentile for all three of the Core Web Vitals metrics." |
| CWV-005 | PSI rule when INP data is insufficient: assessment uses LCP and CLS only. If LCP or CLS data is insufficient the page/origin "cannot be assessed" (report "no data", not "fail"). | any (PSI/CrUX) | low: correctness of the report. | https://developers.google.com/speed/docs/insights/v5/about | "If the aggregation has insufficient data for INP, then it will pass the assessment if both the 75th percentiles of LCP and CLS are Good. If either LCP or CLS have insufficient data, the page or origin-level aggregation cannot be assessed." |
| CWV-006 | Search Console CWV report status per URL group is the worst of its metrics (LCP, INP, CLS). Only indexed URLs appear; data is a 28-day window; groups lack data are omitted or fall back to an origin group. | any (Search Console) | low: interpretation guidance for the report. | https://support.google.com/webmasters/answer/9205520 | "Once a URL group has a threshold amount of data for both LCP and CLS, the URL group's status is its most poorly performing metric." |
| CWV-007 | INP counts only click, tap and key presses (not scroll, hover, zoom). A page with no interactions returns no INP (bots/headless never produce it). Do not infer "INP fine" from a bot/lab run. | lab-metrics / any | low | https://web.dev/articles/inp | "As the purposes of INP, only the following interaction types are observed: Clicking with a mouse. Tapping on a device with a touchscreen. Pressing a key on either a physical or onscreen keyboard." |
| CWV-008 | CLS is the largest burst (session window) of layout shifts: gaps < 1 s, window max 5 s. Shifts within 500 ms of user input are excluded (`hadRecentInput`). | any | low: explains why lab CLS differs from field CLS. | https://web.dev/articles/cls | "A burst of layout shifts, known as a session window, is when one or more individual layout shifts occur in rapid succession with less than 1-second in between each shift and a maximum of 5 seconds for the total window duration." |
| CWV-009 | Lab CLS from a page-load run can under-report: CrUX measures the full page lifetime, lab runs only initial load. A field-vs-lab CLS gap suggests post-load shifts (lazy-loaded content, SPA transitions > 500 ms). | lab-metrics | low | https://web.dev/articles/optimize-cls | "CrUX is the Google dataset of the Web Vitals program, and for that, CLS is measured throughout the full life of the page and not just during the initial page load that lab tools typically measure." |

### 2.2 Field vs lab; how Search uses CWV

| rule-id | check | layer | severity suggestion + why | source URL | quoted passage |
|---|---|---|---|---|---|
| CWV-010 | Prioritise field data over lab data when both exist. Report lab-only findings as diagnostics, not as CWV failures. | lab-metrics | medium (methodology) | https://web.dev/articles/lab-and-field-data-differences | "As a general rule, if you have both field data and lab data for a given page, field data is what you should use to prioritize your efforts." |
| CWV-011 | Lighthouse measures LCP and CLS but not INP; use TBT as a lab proxy for INP risk only. Never state an INP pass/fail from Lighthouse. | lab-metrics | low | https://web.dev/articles/vitals | Table row for Lighthouse: INP column "block (use TBT instead)"; and "Total Blocking Time (TBT) is a lab metrics is vital in catching and diagnosing potential interactivity issues that can impact INP." (source text, typo in source) |
| CWV-012 | Treat CWV as one ranking input among many; cap SEO-impact wording. Google: no single page-experience signal; good CWV scores do not guarantee top rankings; "trying to get a perfect score just for SEO reasons may not be the best use of your time". | any | informs severity: CWV findings should rarely be `critical` for ranking; `critical` only for user-experience reasons (poor field metrics). | https://developers.google.com/search/docs/appearance/page-experience | "Core Web Vitals are used by our ranking systems." and "There is no single signal." (two separate FAQ answers, joined) |
| CWV-013 | Search Console CWV report is built from CrUX field data, not lab. It needs a verified Search Console property (credential; see table). | any | n/a | https://support.google.com/webmasters/answer/9205520 | "The Core Web Vitals report shows how your pages perform, based on real world usage data (sometimes called field data)." |
| CWV-014 | Search Console also treats PSI as a separate view: PSI shows per-URL data, Search Console shows URL-group data, so values can disagree. Do not flag mismatch as an error. | any | low | https://support.google.com/webmasters/answer/9205520 | "PageSpeed Insights generally shows data for individual URLs (unless the URL doesn't have enough information by itself). The statistics for a specific URL in PageSpeed Insights might not match the group results in Core Web Vitals, because an individual URL might be an outlier in its group." |

### 2.3 LCP code-level causes (source / raw-html layers)

| rule-id | check | layer | severity suggestion + why | source URL | quoted passage |
|---|---|---|---|---|---|
| CWV-020 | The LCP element's resource is discoverable in the initial HTML: an `<img>` with `src`/`srcset` in the served markup. Fail: image injected by JS, `data-src`/`data-srcset` lazy-loader, or a CSS background image without a preload. | raw-html (fetched without JS) + rendered (to identify the LCP element) | high: delays resource start; common for React/Vite client-rendered pages. | https://web.dev/articles/optimize-lcp | "To eliminate unnecessary resource load delay, your LCP resource should be discoverable from the HTML source." |
| CWV-021 | LCP `<img>` has no `loading="lazy"`. Also avoid lazy-loading any above-the-fold images. | raw-html / rendered | high: delays LCP. | https://developer.chrome.com/docs/performance/insights/lcp-discovery | "Avoid loading=lazy for the image." |
| CWV-022 | LCP `<img>` (or its preload) has `fetchpriority="high"`; no more than one or two images carry high priority. | raw-html | medium | https://web.dev/articles/optimize-lcp | "It's a good idea to set fetchpriority=\"high\" on an `<img>` element if you think it's likely to be your page's LCP element. However, setting a high priority on more than one or two images makes priority setting unhelpful in reducing LCP." |
| CWV-023 | When the LCP image is referenced only from external CSS/JS, the HTML head has `<link rel="preload" as="image" fetchpriority="high" href=...>` (or a `Link` header). | raw-html / headers | medium | https://web.dev/articles/optimize-lcp | "In cases where the resource is only referenced from an external CSS or JavaScript file, the LCP resource should be preloaded with a high fetch priority" |
| CWV-024 | No synchronous `<script src>` (no `async`/`defer`) in `<head>` that is not tiny and inline. | raw-html | medium | https://web.dev/articles/optimize-lcp | "It is almost never necessary to add synchronous scripts (scripts without the async or defer attributes) to the head of your pages, and doing so will almost always have a negative impact on performance." |
| CWV-025 | Render-blocking stylesheets are small enough not to outlast the LCP resource: inline small critical CSS, otherwise reduce size (remove unused, defer non-critical, minify/compress). | raw-html + lab-metrics | medium | https://web.dev/articles/optimize-lcp | "if the style sheet is so large that it takes significantly longer to load than the LCP resource, then it will prevent the LCP element from rendering—even after its resource has finished loading" |
| CWV-026 | Pages that render main content only via client-side JS (typical React/Vite SPA without SSR/SSG) deliver the LCP image/text in the server HTML. Test: the raw HTML (no JS) contains the LCP element and its `src`. | raw-html vs rendered | high for content pages: LCP resource undiscoverable until JS runs. | https://web.dev/articles/optimize-lcp | "Your image resources will be discoverable from the HTML source (as discussed in step 1 earlier). Your page content won't require additional JavaScript requests to finish before it can render." |
| CWV-027 | Redirect chains and uncacheable HTML (unique query params defeating CDN cache) before the document: minimise redirects; high TTFB makes 2.5 s LCP hard. | headers | medium | https://web.dev/articles/optimize-lcp | "A high TTFB can make achieving a 2.5 second LCP challenging, or even impossible." |
| CWV-028 | If the LCP element is text using a web font, `@font-face` uses `font-display` other than `auto`/`block` (`swap` or `optional`), so text shows during load. | source (CSS) / raw-html | medium | https://web.dev/articles/optimize-lcp | "If you set a font-display value of anything other than auto or block, then text will always be visible during load, and LCP won't be blocked on an additional network request." |
| CWV-029 | LCP subpart guideline (heuristic target, not pass/fail): TTFB ~40 %, resource load delay < 10 %, resource load duration ~40 %, element render delay < 10 % of LCP. Report only as diagnostic. | lab-metrics | low: the source itself says these are guidelines. | https://web.dev/articles/optimize-lcp | "Note that these time breakdowns are guidelines, not strict rules." |
| CWV-030 | Cache-Control on LCP resources lets repeat visits skip the network. | headers | low | https://web.dev/articles/optimize-lcp | "If you serve your resources with an efficient cache-control policy, then visitors who request those resources a second time will have them served from the cache—bringing the resource load duration to essentially zero!" |
| CWV-031 | Lazy loading evidence: pages that lazy-load above-the-fold images load slower. Support for CWV-021. | any | context only | https://web.dev/articles/lcp-lazy-loading | "The median page without lazy loading has a 75th percentile LCP of 2,922 milliseconds, compared to 3,546 milliseconds for the median page with lazy loading." (correlational; article says so) |

### 2.4 CLS code-level causes

| rule-id | check | layer | severity suggestion + why | source URL | quoted passage |
|---|---|---|---|---|---|
| CWV-040 | Every `<img>` and `<video>` has `width` and `height` attributes, or CSS `aspect-ratio` reserves space. With `srcset`, all candidate images share one aspect ratio. `<picture><source>` may carry `width`/`height`. | raw-html / rendered | high: the most common CLS cause. | https://web.dev/articles/optimize-cls | "Always include width and height size attributes on your images and video elements. Alternatively, reserve the required space with CSS aspect-ratio or similar." |
| CWV-041 | Ads, embeds, iframes and other late-loaded content sit in containers with reserved space (`min-height` or `aspect-ratio`). Do not collapse reserved space when no ad returns. | rendered / raw-html | high | https://web.dev/articles/optimize-cls | "When placing late-loading content in the content flow, layout shifts can be avoided by reserving the space for them in the initial layout." |
| CWV-042 | No banners/forms/cookie notices inserted into document flow after load without user input; reserve space or overlay out of flow. | rendered | medium | https://web.dev/articles/optimize-cls | "If you need to display these types of UI affordances, reserve sufficient space in the viewport for it in advance (for example, using a placeholder or skeleton UI) so that when it loads, it does not cause content in the page to surprisingly shift around." |
| CWV-043 | Web fonts: `font-display: optional` avoids re-layout; fallback font stack declared (`font-family: "X", sans-serif`); metrics aligned with `size-adjust`/`ascent-override`/`descent-override`/`line-gap-override`; critical fonts preloaded (`<link rel=preload as=font>`). | source (CSS) / raw-html | medium: both FOUT and FOIT can shift layout. | https://web.dev/articles/optimize-cls | "Both approaches can cause layout shifts. Even if the text is invisible, it's still laid out using the fallback font, so when the web font loads, the text block and the surrounding content shift in the same way as for the visible font." |
| CWV-044 | Animations use `transform` (translate/scale/rotate), not `top`/`left`/`box-shadow` etc. | source (CSS) | low | https://web.dev/articles/optimize-cls | "Changing the top and left properties also cause layout shifts, even when the element being moved is on its own layer. Avoid animating using these properties." |
| CWV-045 | Pages are bfcache-eligible (lowers repeat-load CLS). | rendered / headers | low | https://web.dev/articles/optimize-cls | "A highly effective technique for keeping CLS scores low is to ensure your web pages are eligible for the back/forward cache (bfcache)." |
| CWV-046 | Dynamic content (load more, live feeds): replace in fixed-size container, or let the user trigger the load (shifts within 500 ms of input are not counted). | rendered | low | https://web.dev/articles/optimize-cls | "Have the user initiate the load of new content, so they are not surprised by the shift (for example with a \"Load more\" or \"Refresh\" button)." |

### 2.5 Credentials and degradation for CWV checks

| check | credential | degradation without it |
|---|---|---|
| CWV-001..006 field verdicts | CrUX API key (free) or PSI API; Search Console property for the Search Console report | Without any field source, report "field data unavailable" and fall back to lab-only findings (CWV-010 rule). Do not claim pass or fail. |
| CWV-020..046 code-level checks | none | Run on raw HTML, rendered DOM and CSS. Impact stays unquantified without field data. |

---

## 3. INP replacing FID (do NOT flag FID)

| rule-id | check | layer | severity suggestion + why | source URL | quoted passage |
|---|---|---|---|---|---|
| CWV-050 | INP replaced FID as a Core Web Vital on **2024-03-12** (page "Last updated 2024-03-12 UTC"; post text "Today's the day!"). Never report FID as a Core Web Vital. | n/a (knowledge rule) | n/a: gates the "do not flag" list | https://web.dev/blog/inp-cwv-launch | "Interaction to Next Paint is now a stable Core Web Vital metric, replacing First Input Delay." |
| CWV-051 | FID removal from CrUX/PSI APIs: "developers will have until September 9, 2024 to transition over to INP". Treat any consumer of `FIRST_INPUT_DELAY_MS` / `first_input_delay` as outdated. | n/a | low | https://web.dev/blog/inp-cwv-launch | "Applications that process FID data from either of these APIs must be transitioned over to INP by September 9 to avoid any breakages or disruptions in service." |

Note on the date: the blog page shows only "Last updated 2024-03-12 UTC"; the sentence naming March 2024 comes from the image alt text in the same page ("it was announced that INP would become a Core Web Vital in March 2024"). The "2024-03-12" day is read from the page's last-updated line, which is consistent with "Today's the day!" but is inferred from that line.

---

## 4. Lighthouse: SEO category audit ids (current)

**Source:** `https://raw.githubusercontent.com/GoogleChrome/lighthouse/v13.5.0/core/config/default-config.js` (tag v13.5.0, 2026-09-17) and `.../main/core/config/default-config.js` (last touching commit `8bd6931f3de5b20e8428da71eae13a9165b1a582`, 2026-09-01). Both show the same `'seo'` auditRefs block. Quoted block (verbatim):

> `{id: 'is-crawlable', weight: 93 / 23, group: 'seo-crawl'},` `{id: 'document-title', weight: 1, group: 'seo-content'},` `{id: 'meta-description', ...}` `{id: 'http-status-code', ...}` `{id: 'link-text', ...}` `{id: 'crawlable-anchors', ...}` `{id: 'robots-txt', ...}` `{id: 'image-alt', ...}` `{id: 'hreflang', ...}` `{id: 'canonical', ...}` and "// Manual audits" `{id: 'structured-data', weight: 0},`

| rule-id | audit id (SEO category, v13.5.0) | weight | group | what it checks (from the audit's own `UIStrings` description, `core/audits/seo/<id>.js`) | layer | severity suggestion | quoted passage |
|---|---|---|---|---|---|---|---|
| LH-S01 | `is-crawlable` | 93/23 (about 4.04; comment says the audit must be >= 31 % of the score so failing it fails the category) | seo-crawl | blocked-from-indexing detection (meta robots / `X-Robots-Tag` / robots.txt; artifacts `MetaElements`, `RobotsTxt`, `URL`, `DevtoolsLog`) | raw-html / headers / robots | critical | "Search engines are unable to include your pages in search results if they don't have permission to crawl them." |
| LH-S02 | `document-title` | 1 | seo-content | `<title>` present (the axe accessibility audit, reused in the SEO category) | raw-html | high | (config line `{id: 'document-title', weight: 1, group: 'seo-content'}`; the accessibility category also lists it at weight 7) |
| LH-S03 | `meta-description` | 1 | seo-content | meta description present and non-empty | raw-html | medium | "Meta descriptions may be included in search results to concisely summarize page content." |
| LH-S04 | `http-status-code` | 1 | seo-crawl | main document returned a successful status code | headers | critical when the page is an error | "Pages with unsuccessful HTTP status codes may not be indexed properly." |
| LH-S05 | `link-text` | 1 | seo-content | anchors have descriptive (non-generic) text | rendered | low | "Descriptive link text helps search engines understand your content." |
| LH-S06 | `crawlable-anchors` | 1 | seo-crawl | `<a>` elements have crawlable `href` | rendered | high | "Search engines may use href attributes on links to crawl websites." |
| LH-S07 | `robots-txt` | 1 | seo-crawl | robots.txt is valid | robots | medium | "If your robots.txt file is malformed, crawlers may not be able to understand how you want your website to be crawled or indexed." |
| LH-S08 | `image-alt` | 1 | seo-content | images have alt text (the axe accessibility audit, reused) | raw-html | medium | (config line `{id: 'image-alt', weight: 1, group: 'seo-content'}`) |
| LH-S09 | `hreflang` | 1 | seo-content | `hreflang` links valid | raw-html | medium | "hreflang links tell search engines what version of a page they should list in search results for a given language or region." |
| LH-S10 | `canonical` | 1 | seo-content | `rel=canonical` valid | raw-html / headers | high | "Canonical links suggest which URL to show in search results." |
| LH-S11 | `structured-data` | 0 (manual) | none | manual audit only; Lighthouse does not validate structured data | structured-data | n/a: do not rely on it | (config comment "// Manual audits" and `{id: 'structured-data', weight: 0}`) |

Category settings: `supportedModes: ['navigation', 'snapshot']` for SEO. Groups: `seo-mobile`, `seo-content`, `seo-crawl` are defined (no audit uses `seo-mobile` any more).

**Related audits outside the SEO category:**

| rule-id | audit id / category | note | source |
|---|---|---|---|
| LH-S12 | `llms-txt`, `ard-schema` in the new **`agentic-browsing`** category (group `agent-discoverability`) | Not SEO. `llms-txt` description: "The llms.txt file should be a Markdown file containing at least one H1 header." Added in 13.2.0 (changelog "config: implement llms.txt check for AI agents (#16970)"); category added in 13.3.0 ("New agentic browsing category added to default config (#17002)"); `ard-schema` added in 13.5.0 ("ard-schema: add Agent Resource Discovery audit (#17168)"). Lighthouse's own wording: "llms.txt follows recommendations" (title) with the "community recommendations" caveat. PSI viewer excluded the category: "viewer: disable agentic-browsing in PSI api call (#17041)". | https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/core/audits/agentic/llms-txt.js ; https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/changelog.md |
| LH-S13 | `image-aspect-ratio`, `image-size-responsive` in best-practices (`best-practices-ux`) | Image display ratio / resolution, not SEO. | default-config.js v13.5.0 |
| LH-S14 | `viewport` (now `viewport-insight` in Performance "insights" group, weight 0) | See LH-R01. | default-config.js v13.5.0 |
| LH-S15 | `font-display-insight`, `cls-culprits-insight`, `lcp-discovery-insight`, `render-blocking-insight`, `inp-breakdown-insight`, `lcp-breakdown-insight` in Performance category (group `insights`, weight 0) | Diagnostics for LCP/CLS/INP; weight 0 means they do not change the score. | default-config.js v13.5.0 lines 428-443 |

---

## 5. Removed or moved Lighthouse audits (version-stamped)

Source for versions and dates: `https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/changelog.md` (headings "12.0.0 (2024-04-22)", "13.0.0 (2025-10-10)").

| rule-id | audit | change | version / date | source URL | quoted passage |
|---|---|---|---|---|---|
| LH-R01 | `viewport`, `font-size` | moved out of SEO to Best Practices (12.0.0), later `font-size` deleted (13.0.0); `viewport` became `viewport-insight` (13.0.0) | 12.0.0 (2024-04-22); 13.0.0 (2025-10-10) | https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/changelog.md | "The `viewport` and `font-size` audits are no longer priorities for SEO, but are still important for UX in general so they have been moved to the best practices category." |
| LH-R02 | `plugins` | removed | 12.0.0 (2024-04-22) | same | "The `plugins` audit is no longer a priority for SEO and has been removed." |
| LH-R03 | `tap-targets` | replaced by accessibility `target-size` | 12.0.0 (2024-04-22) | same | "The `tap-targets` audit is no longer a priority for SEO and has been replaced with the `target-size` audit in accessibility." |
| LH-R04 | `is-crawlable` | weight raised so it alone fails the SEO category | 12.0.0 | same | "The `is-crawlable` audit is now weighted high enough to fail the SEO category on its own." |
| LH-R05 | `font-size` (SEO) | removed with no replacement | 13.0.0 (2025-10-10) | https://developer.chrome.com/blog/lighthouse-13-0 | "While small fonts is a legibility issue, there are no signals that this remains an SEO concern today. Additionally, this audit was very expensive to run and maintain." |
| LH-R06 | `lcp-lazy-loaded`, `prioritize-lcp-image` | replaced by `lcp-discovery-insight` | 13.0.0 | https://developer.chrome.com/blog/lighthouse-13-0 | Table row: "lcp-discovery-insight \| prioritize-lcp-image lcp-lazy-loaded" (new insight id vs replaced ids) |
| LH-R07 | `render-blocking-resources` | replaced by `render-blocking-insight` | 13.0.0 | same | Table row: "render-blocking-insight \| render-blocking-resources" |
| LH-R08 | `layout-shifts` | replaced by `cls-culprits-insight` | 13.0.0 | same | Table row: "cls-culprits-insight \| layout-shifts" |
| LH-R09 | `font-display` | replaced by `font-display-insight` | 13.0.0 | same | Table row: "font-display-insight \| font-display" |
| LH-R10 | `work-during-interaction` | replaced by `interaction-to-next-paint-insight` (config names it `inp-breakdown-insight`) | 13.0.0 | same | Table row: "interaction-to-next-paint-insight \| work-during-interaction" |
| LH-R11 | `largest-contentful-paint-element` | replaced by `lcp-phases-insight` (config names it `lcp-breakdown-insight`) | 13.0.0 | same | Table row: "lcp-phases-insight \| largest-contentful-paint-element" |
| LH-R12 | removed with no replacement: `first-meaningful-paint`, `no-document-write`, `offscreen-images`, `preload-fonts`, `third-party-facades`, `uses-passive-event-listeners`, `uses-rel-preload` | removed | 13.0.0 | same | "In addition to the aforementioned replacements, the following audits have been removed with no replacements as it was felt these no longer served useful purposes" |
| LH-R13 | PWA category | removed | 12.0.0 | changelog.md | "As per Chrome's updated Installability Criteria, Lighthouse has removed the PWA category." |

Note: the id `interaction-to-next-paint-insight` / `lcp-phases-insight` in the 13.0 article differ from the config ids `inp-breakdown-insight` / `lcp-breakdown-insight` seen at v13.5.0. Use the config ids when reading LHR JSON. (observed difference, cause not investigated)

---

## 6. Lighthouse performance audits relevant to LCP and CLS (v13.5.0)

| rule-id | audit id | role | pass condition (as source states) | layer | source URL | quoted passage |
|---|---|---|---|---|---|---|
| LH-P01 | `largest-contentful-paint` | scored metric, weight 25 | lab metric (Lighthouse thresholds not fetched this session) | lab-metrics | default-config.js v13.5.0 | `{id: 'largest-contentful-paint', weight: 25, group: 'metrics', acronym: 'LCP'}` |
| LH-P02 | `cumulative-layout-shift` | scored metric, weight 25 | lab metric | lab-metrics | default-config.js v13.5.0 | `{id: 'cumulative-layout-shift', weight: 25, ...}` |
| LH-P03 | `total-blocking-time` | scored metric, weight 30 (the largest weight); INP proxy | lab metric | lab-metrics | default-config.js v13.5.0 | `{id: 'total-blocking-time', weight: 30, ...}` |
| LH-P04 | `first-contentful-paint` (10), `speed-index` (10), `interaction-to-next-paint` (0) | `interaction-to-next-paint` has weight 0 in the performance category | n/a | lab-metrics | default-config.js v13.5.0 | `{id: 'interaction-to-next-paint', weight: 0, group: 'metrics', acronym: 'INP'}` |
| LH-P05 | `lcp-discovery-insight` | LCP image discoverable, prioritised, not lazy | "Use fetchpriority=high on the image element, or on its preload directive. Ensure the image is discoverable from the main document ... Avoid loading=lazy for the image." | raw-html / lab-metrics | https://developer.chrome.com/docs/performance/insights/lcp-discovery | "Optimize LCP by making the LCP image discoverable from the HTML immediately, prioritizing it, and avoiding lazy-loading." |
| LH-P06 | `render-blocking-insight` | requests that blocked first paint | "To pass this insight, remove all such render-blocking requests." | lab-metrics | https://developer.chrome.com/docs/performance/insights/render-blocking | "Requests are blocking the page's initial render, which may delay LCP." |
| LH-P07 | `unsized-images` | image elements missing explicit size. Weight 0, group diagnostics. Pass if explicit width+height, or width+aspect-ratio, or height+aspect-ratio (HTML attributes or CSS) | rule from audit source code | rendered / lab-metrics | https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/core/audits/unsized-images.js | "Set an explicit width and height on image elements to reduce layout shifts and improve CLS." |
| LH-P08 | `cls-culprits-insight` | lists shifts and likely cause | "Have a \"good\" (0.1) or better CLS." | lab-metrics | https://developer.chrome.com/docs/performance/insights/cls-culprit | "Some common culprits of layout shifts include: Unsized images; Injected iframes (such as from ads); Unoptimized animations; Web fonts - either flash of unstyled text (FOUT) or flash of invisible text (FOIT)" |
| LH-P09 | `font-display-insight` | `font-display` declared | "Set font-display to either swap or optional to pass this insight." | source (CSS) | https://developer.chrome.com/docs/performance/insights/font-display | "Consider setting font-display to swap or optional to ensure text is consistently visible." |
| LH-P10 | `non-composited-animations`, `bf-cache` | diagnostics (weight 0) for CLS-related animation and bfcache | lab diagnostics | lab-metrics | default-config.js v13.5.0 | `{id: 'non-composited-animations', weight: 0, group: 'diagnostics'}` `{id: 'bf-cache', weight: 0, group: 'diagnostics'}` |

---

## 7. Running Lighthouse headless from the CLI (repo README)

Source: `https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/readme.md` (read 2026-10-12; `main` at fetch time).

| rule-id | fact | quoted passage |
|---|---|---|
| LH-C01 | Install and basic run: `npm install -g lighthouse`; `lighthouse https://example.com/`. Requires Node 22 (LTS) or later. Lighthouse 13 needs Node 22.19 or higher (release article). By default writes an HTML report. | "Lighthouse requires Node 22 (LTS) or later." (README) ; "Lighthouse 13 requires Node 22.19 or higher." (https://developer.chrome.com/blog/lighthouse-13-0) |
| LH-C02 | JSON to stdout: `lighthouse <url> --output json` (default output path for JSON is stdout). To file: `--output=json --output-path=./report.json`. Multiple outputs append the standard extension. | "lighthouse --output json" then "# json output sent to stdout" |
| LH-C03 | Subset of categories: `--only-categories=performance,seo` ("Available categories: accessibility, best-practices, performance, seo"). Audits: `--only-audits`, `--skip-audits`. | "lighthouse <url> --only-categories=performance,seo  Only run the specified categories. Available categories: accessibility, best-practices, performance, seo" |
| LH-C04 | Headless Chrome: `lighthouse <url> --quiet --chrome-flags="--headless"`. For CI/problem connections the README suggests `--chrome-flags="--no-sandbox --headless --disable-gpu"`. `CHROME_PATH` selects a binary. | "lighthouse <url> --quiet --chrome-flags=\"--headless\"  Launch Headless Chrome, turn off logging" |
| LH-C05 | Form factor: `--form-factor` mobile/desktop; for desktop use `--preset=desktop`. Presets: `perf`, `experimental`, `desktop`. Throttling flags: `--throttling-method` (`devtools`, `provided`, `simulate`), `--throttling.cpuSlowdownMultiplier`, etc. | "--form-factor ... For desktop, use --preset=desktop instead." |
| LH-C06 | Save trace/devtools log with `--save-assets`; split run with `-G` (gather) and `-A` (audit). | "lighthouse <url> --output=json --output-path=./report.json --save-assets  Save trace, screenshots, and named JSON report." |
| LH-C07 | Auth/extra headers: `--extra-headers` JSON or file path. Block URLs: `--blocked-url-patterns`. | "lighthouse <url> --extra-headers \"{\\\"Cookie\\\":\\\"monster=blue\\\", \\\"x-men\\\":\\\"wolverine\\\"}\"" |
| LH-C08 | Suggested skill command (derived from LH-C02..C04, not a quoted example): `npx lighthouse <url> --only-categories=performance,seo --output=json --output-path=stdout --quiet --chrome-flags="--headless"` and a second run with `--preset=desktop`. | derived; each flag appears in the README help text above |

Open point: the README help text lists categories "accessibility, best-practices, performance, seo" only; the config at v13.5.0 also defines an `agentic-browsing` category. Whether `--only-categories=agentic-browsing` works on the CLI was not tested. (GUESS(inference): it probably works, because `--only-categories` takes ids from the config; not verified.)

---

## 8. API facts: CrUX API and PageSpeed Insights API

### 8.1 Endpoints and data returned

| rule-id | fact | source URL | quoted passage |
|---|---|---|---|
| LH-A01 | CrUX API: single endpoint `POST https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=API_KEY`. Body: `origin` **or** `url`, optional `formFactor` (`PHONE`/`TABLET`/`DESKTOP`), optional `metrics[]`. | https://developer.chrome.com/docs/crux/api | "There is a single endpoint for the CrUX API which accepts POST HTTP requests." |
| LH-A02 | CrUX API returns histograms (3 bins), p75 percentiles, and fractions for `largest_contentful_paint`, `interaction_to_next_paint`, `cumulative_layout_shift`, `first_contentful_paint`, `experimental_time_to_first_byte`, LCP resource type and LCP image sub-parts, `navigation_types`, `round_trip_time`, `form_factors`. Metric `cumulative_layout_shift` is a string-encoded double. | same | "If the `metrics` property is not set then all available metrics will be returned" (followed by the list) |
| LH-A03 | Origin vs URL: origin requests aggregate all pages; URL requests return only that page. | same | "When the identifier is a URL, only data for that specific URL will be returned." |
| LH-A04 | Data is a 28-day rolling window, updated daily around 04:00 UTC, no SLA. `collectionPeriod` is always 28 days even for newer pages. | same | "The data in the Chrome UX Report is a 28-day rolling average of aggregated metrics." |
| LH-A05 | PSI API: `GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=...` (older docs) / `https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed` (REST reference). Params: `url` (required), `category` (`accessibility`, `best-practices`, `performance`, `seo`), `strategy` (`desktop` default, or `mobile`), `locale`. If no `category` is given only Performance runs: pass `category=seo` explicitly. | https://developers.google.com/speed/docs/insights/v5/reference/pagespeedapi/runpagespeed | "A Lighthouse category to run; if none are given, only Performance category will be run" |
| LH-A06 | PSI response contains `loadingExperience` (URL-level CrUX), `originLoadingExperience` (origin-level CrUX), `lighthouseResult` (full LHR: `audits`, `categories`, `lighthouseVersion`, `configSettings`). `loadingExperience.origin_fallback` is true when URL data fell back to origin. | https://developers.google.com/speed/docs/insights/rest/v5/pagespeedapi/runpagespeed | "True if the result is an origin fallback from a page, false otherwise." |
| LH-A07 | PSI falls back to origin data when URL data is thin; if origin data is also thin, no field data at all. Lab: Lighthouse emulates Moto G4 on a mobile network for `mobile`, emulated desktop with wired connection for `desktop`. | https://developers.google.com/speed/docs/insights/v5/about | "When this happens, PSI will fall back to origin-level granularity, which encompasses all user experiences on all pages of the website." |
| LH-A08 | CrUX/PSI eligibility: URL must be public ("crawlable and indexable") and have enough distinct samples. | same | "requires that a URL must be public (crawlable and indexable) and have sufficient number of distinct samples" |
| LH-A09 | The PSI API field names for INP: `INTERACTION_TO_NEXT_PAINT` in `loadingExperience.metrics` (JS example). `FIRST_INPUT_DELAY_MS` appears only in the stale cURL sample response on the same page. | https://developers.google.com/speed/docs/insights/v5/get-started | "'Interaction to Next Paint': json.loadingExperience.metrics.INTERACTION_TO_NEXT_PAINT?.category" |

### 8.2 Credential table (needed / optional / degradation)

| Data source / tool | Credential | Status | Limit stated by primary source | Degradation without it |
|---|---|---|---|---|
| CrUX API (`records:queryRecord`) | Google Cloud API key provisioned for "Chrome UX Report API" | **needed** | "limited to 150 queries per minute per Google Cloud project" (free; "not possible to pay for an increased quota") | No field data via this route. Fall back to PSI API (field data comes with it) or report "field data unavailable". |
| PageSpeed Insights API (`runPagespeed`) | API key `key=` query parameter | **optional for light use, recommended for automation** (GUESS(inference): the docs show a sample JS fetch with no key, and the page summary says a key is recommended for frequent automated queries; the no-key limit is not stated in any primary page I fetched) | Not stated in fetched primary docs (see blocker in section 0). Third-party snippets claim 25,000/day and 400 per 100 s (lead only, `heuristic`). | Without a key, expect HTTP 429 on repeated calls. Keyless call still returns lab + field data when it succeeds. If it fails, run local Lighthouse CLI (no credential) and report field data as unavailable. |
| Search Console CWV report | Verified Search Console property (user OAuth session) | **needed**, cannot be automated from a skill without user access | Report row limit: "The table has a limit of 200 rows." | Skill omits the Search Console section and says so. |
| Lighthouse CLI (local) | none (needs Chrome and Node >= 22; 22.19 for v13) | none | none | Lab data only: no field data, no INP value. |
| Lighthouse/PSI lab on a page behind login | session cookie via `--extra-headers` or a user flow | needed for gated pages | none | Audit only public pages; state the limitation. |
| CrUX BigQuery / CrUX Vis / CrUX History API | not fetched | out of scope | not fetched | not researched |

Quoted passages for the table: CrUX key — "Using the CrUX API requires a Google Cloud API key provisioned for Chrome UX Report API usage." (https://developer.chrome.com/docs/crux/api); rate limit as above; PSI key — "After you have an API key, your application can append the query parameter key=yourAPIKey to all request URLs." (https://developers.google.com/speed/docs/insights/v5/get-started); Search Console 200 rows — https://support.google.com/webmasters/answer/9205520.

---

## 9. Do NOT flag (myths and outdated rules)

| id | do NOT flag | why | source URL | quoted passage |
|---|---|---|---|---|
| DNF-01 | First Input Delay (FID) as a Core Web Vital | INP replaced FID (2024-03-12). | https://web.dev/blog/inp-cwv-launch | "Interaction to Next Paint is now a stable Core Web Vital metric, replacing First Input Delay." |
| DNF-02 | A missing INP value in a lab/bot run as "INP failed" | Bots and headless runs without scripted interaction return no INP. | https://web.dev/articles/inp | "The page is being accessed by a bot such as a search crawler or headless browser that has not been scripted to interact with the page." |
| DNF-03 | Tap targets, plugins, `font-size`, `viewport` as SEO failures from the Lighthouse SEO category | Removed from SEO in Lighthouse 12/13 (LH-R01..R05). Note `viewport` is still worth a UX note. Do not report `tap-targets`/`font-size`/`plugins` audit ids: they no longer exist. | https://developer.chrome.com/blog/lighthouse-13-0 ; changelog.md | "there are no signals that this remains an SEO concern today" (for `font-size`) |
| DNF-04 | The old performance audit ids (`prioritize-lcp-image`, `lcp-lazy-loaded`, `render-blocking-resources`, `uses-rel-preload`, `offscreen-images`, `font-display`, `layout-shifts`) when reading Lighthouse 13+ JSON | Not in LHR since 13.0.0. For PSI results check `lighthouseResult.lighthouseVersion` before assuming ids. | https://developer.chrome.com/blog/lighthouse-13-0 | "in Lighthouse 13 we are removing the old audits from both the report and the underlying JSON." |
| DNF-05 | "Perfect Lighthouse score = ranking boost" | Google: good scores do not guarantee ranking; chasing a perfect score for SEO is not the best use of time. | https://developers.google.com/search/docs/appearance/page-experience | "getting good results in reports like Search Console's Core Web Vitals report or third-party tools doesn't guarantee that your pages will rank at the top of Google Search results" |
| DNF-06 | "A single page experience signal" / "page experience update" as a distinct ranking switch | Google: "There is no single signal." Only CWV is named among page-experience aspects used in ranking; other aspects "don't directly help your website rank higher". | https://developers.google.com/search/docs/appearance/page-experience | "Beyond Core Web Vitals, other page experience aspects don't directly help your website rank higher in search results." |
| DNF-07 | Lab LCP/CLS differing from field values as an error | Expected: different devices, caches, bfcache, LCP element, post-load CLS. | https://web.dev/articles/lab-and-field-data-differences | "Lab data from the same page shows an LCP value of 3.0 second. While this value is greater than the 1.8 seconds shown in the field data, it's still a valid LCP value for this page" |
| DNF-08 | PSI per-URL numbers differing from Search Console CWV group numbers | Groups vs URLs; PSI strips URL parameters, Search Console keeps them. | https://support.google.com/webmasters/answer/9205520 | "Core Web Vitals URLs include URL parameters when distinguishing the page; PageSpeed Insights strips all parameter data from the URL, and then assigns all results to the bare URL." |
| DNF-09 | Compressing the LCP image as a guaranteed LCP win | Time can shift to element render delay when render is gated by JS. | https://web.dev/articles/optimize-lcp | "In some cases, an optimization applied to one part won't improve LCP, it will just shift the time saved to another part." |
| DNF-10 | Page-weight and request-count rules of thumb (500 KB, 50 resources) as hard rules | The Search Console help gives them as "best practice" for non-technical users; no threshold appears in CWV definitions. Mark at most low. | https://support.google.com/webmasters/answer/9205520 | "Reduce your page size: best practice is less than 500KB for a page and all its resources." |
| DNF-11 | "Hidden" `agentic-browsing` Lighthouse score as an SEO ranking factor | New Lighthouse category (13.3.0+); not part of SEO; the Lighthouse description of the `llms.txt` audit says "community recommendations". No Google Search doc fetched states llms.txt affects ranking. | https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/core/audits/agentic/llms-txt.js | "llms.txt follows recommendations" (audit title) |

---

## 10. Heuristics / unsourced

| id | statement | reason it is heuristic |
|---|---|---|
| H-01 | PSI API without key: 25,000 requests/day and 400 per 100 seconds | Only from third-party pages (unlighthouse.dev, apis.io, Google Groups thread in `web_search` snippets). Not fetched on a primary Google page. Treat as `heuristic`. |
| H-02 | `--only-categories=agentic-browsing` works on the CLI | Not tested; README help lists four categories only. |
| H-03 | The severity labels in every table | Suggestions by the researcher; the sources give thresholds, not severities. |
| H-04 | Lighthouse lab metric thresholds (LCP/CLS/TBT scoring curves) | Not fetched this session (performance-scoring doc not read). Do not quote scoring curves without fetching it. |
| H-05 | Lab TBT thresholds as a stand-in for an INP verdict | web.dev says TBT "may be a reasonable proxy metric for INP, but it's not a substitute for INP in and of itself" (https://web.dev/articles/inp). No numeric TBT-to-INP mapping is sourced. |

---

## 11. Sources fetched this session (2026-10-12)

1. https://web.dev/articles/vitals
2. https://web.dev/articles/inp
3. https://web.dev/articles/cls (grep of definitions)
4. https://web.dev/articles/optimize-lcp
5. https://web.dev/articles/optimize-cls
6. https://web.dev/articles/lcp-lazy-loading
7. https://web.dev/articles/lab-and-field-data-differences (grep)
8. https://web.dev/blog/inp-cwv-launch
9. https://developers.google.com/search/docs/appearance/page-experience
10. https://developers.google.com/search/docs/appearance/core-web-vitals
11. https://support.google.com/webmasters/answer/9205520
12. https://developer.chrome.com/docs/crux/api
13. https://developers.google.com/speed/docs/insights/v5/get-started
14. https://developers.google.com/speed/docs/insights/v5/about
15. https://developers.google.com/speed/docs/insights/v5/reference/pagespeedapi/runpagespeed
16. https://developers.google.com/speed/docs/insights/rest/v5/pagespeedapi/runpagespeed
17. https://developer.chrome.com/blog/lighthouse-13-0
18. https://developer.chrome.com/docs/performance/insights/lcp-discovery
19. https://developer.chrome.com/docs/performance/insights/render-blocking
20. https://developer.chrome.com/docs/performance/insights/cls-culprit
21. https://developer.chrome.com/docs/performance/insights/font-display
22. https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/core/config/default-config.js
23. https://raw.githubusercontent.com/GoogleChrome/lighthouse/v13.5.0/core/config/default-config.js
24. https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/changelog.md
25. https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/readme.md
26. https://github.com/GoogleChrome/lighthouse/releases (atom feed: versions only)
27. https://api.github.com/repos/GoogleChrome/lighthouse/commits?path=core/config/default-config.js&per_page=1
28. Lighthouse audit sources (grep): core/audits/seo/{is-crawlable,meta-description,http-status-code,link-text,crawlable-anchors,hreflang,canonical,robots-txt}.js, core/audits/agentic/llms-txt.js, core/audits/unsized-images.js

**Fetch failures:** https://developer.chrome.com/docs/lighthouse/performance/unsized-images (HTTP 404), https://developers.google.com/speed/docs/insights/v5/faq (HTTP 404). Neither was cited.
**Not fetched:** Lighthouse performance-scoring doc, `web.dev/articles/lcp` and `/cls` full pages (CLS partially via grep), CrUX methodology/eligibility doc, Search Central INP blog post.
