# Structured data and social-preview rules: research for `skills/seo-audit/`

**Fetch date for every source: 2026-10-12.** Author: hand `sl-plan-seo-2`. Research only; no repository edited.

How to read this file:
- Every table row is a **CITE** unless the Severity column says otherwise. The check, layer and severity columns are my own design (GUESS(inference)) built on the quoted passage; the quote and URL are the receipt only for the sourced fact, not for my severity choice.
- Sources are written as keys `[S#]`. The index in section 14 gives the full URL for each key (all fetched this session, 2026-10-12). Quotes are verbatim, at most two sentences.
- "Last updated" dates are the dates the Google pages print about themselves.
- Rule-id prefixes: `SD-` structured data, `OG-` Open Graph, `TW-` X cards.

## 0. Blockers and questions (read first)

**GUESS(inference)** Blocker B1 — X/Twitter card docs. The live URLs `developer.x.com/en/docs/x-for-websites/cards/...` redirect to `docs.x.com/overview` (a generic API landing page, fetched, no card markup), and `docs.x.com/llms.txt` has no cards page (fetched, 40 lines, none mention cards). I therefore cite the Internet Archive copies of the same vendor pages ([S31], [S32]; snapshots dated 2026-01-16 and 2026-02-04). They are verbatim copies of X's page but are not the live URL; the skill should treat TW- rules as "as documented at last archive" and `low` severity.

**GUESS(inference)** Blocker B2 — no credential-free rich-results API. I found no documented public API for the Rich Results Test or for validator.schema.org. A schema.org maintainer says there are no plans for one ([S28]). The only documented programmatic route is the Search Console URL Inspection API ([S26]), which needs OAuth and a verified property. Absence of documentation is not proof of absence of an endpoint; the skill must not call undocumented endpoints.

**QUESTION** Should the skill ever recommend adding structured data for a type Google no longer shows (FAQ, HowTo, sitelinks search box)? Options: (a) never flag its absence and never recommend adding it (my default below, since Google says unsupported markup is harmless but gives no benefit); (b) flag as `info` only. Answer changes SD-DEP-* handling. Proceeding with (a).

**GUESS(inference)** Doc discrepancy: the Rich Results Test support page ([S25]) still lists "Practice Problems" among supported types while the Google changelog says Search Console/RRT support for several deprecated types was removed (see section 3). Treat the RRT type list as possibly stale; use the Search Gallery ([S3]) as the authority for "currently shown".

## 1. Authority order and layers

| Type | Statement | Receipt |
|---|---|---|
| CITE | Google's own docs, not schema.org, are definitive for Google Search behaviour | [S2], quote: "you should rely on the Google Search Central documentation as definitive for Google Search behavior, rather than the schema.org documentation." |
| CITE | Structured data is not required for generative AI search | [S14], quote: "Structured data isn't required for generative AI search, and there's no special schema.org markup you need to add." |
| GUESS(inference) | The skill should treat required-property tables below as "eligibility for a rich result", never as "ranking factor" | follows from [S1] quote "A structured data manual action means that a page loses eligibility for appearance as a rich result; it doesn't affect how the page ranks in Google web search." |

## 2. General structured data guidelines (SD-GEN)

Layers: structured data is read at **raw-html** (JSON-LD present in the server response) and **rendered** (after JS). Both are tested; see SD-GEN-08.

| rule-id | check (pass condition) | layer | severity + why | source | quoted passage |
|---|---|---|---|---|---|
| SD-GEN-01 | Markup uses JSON-LD, Microdata or RDFa. Prefer JSON-LD. Not a failure if Microdata/RDFa. | raw-html / rendered | low: all three work; JSON-LD is only the recommended default | [S1] [S2] | "all 3 formats are equally fine for Google, as long as the markup is valid and properly implemented per the feature's documentation." (S2) |
| SD-GEN-02 | Every structured-data field describes content that is visible on the same page (names, prices, ratings, performers). Check by diffing JSON-LD text values against the rendered DOM text. | rendered + structured-data | high: mismatch is a documented manual-action reason | [S1] [S23] | "Don't mark up content that is not visible to readers of the page. For example, if the JSON-LD markup describes a performer, the HTML body must describe that same performer." (S1) |
| SD-GEN-03 | No structured-data element is hidden (display:none, off-screen) just to hold markup. | rendered | high: Google lists hidden-content markup as a manual-action cause | [S23] | "Structured data found on elements that are not visible to the user. This is against our guidelines." |
| SD-GEN-04 | No blank pages created just to hold structured data. | rendered | medium: guideline violation but hard to test mechanically | [S2] | "Don't create blank or empty pages just to hold structured data, and don't add structured data about information that is not visible to the user, even if the information is accurate." |
| SD-GEN-05 | Pages carrying markup are not blocked from Googlebot by robots.txt, noindex or other access control. Test via robots layer + `X-Robots-Tag`/meta robots. | robots / headers / raw-html | high: blocked page cannot earn rich results | [S1] | "Don't block your structured data pages to Googlebot using robots.txt, noindex, or any other access control methods." |
| SD-GEN-06 | All required properties for the targeted rich-result type are present (use per-type tables below). Missing required property is `high` only if the page is plausibly targeting that feature; otherwise `info`. | structured-data | high: item is ineligible | [S1] | "Specify all required properties listed in the documentation for your specific rich result type. Items that are missing required properties are not eligible for rich results." |
| SD-GEN-07 | Recommended properties that are present are complete and accurate; do not add every recommended property with poor data. | structured-data | low: quality over quantity | [S2] | "it is more important to supply fewer but complete and accurate recommended properties rather than trying to provide every possible recommended property with less complete, badly-formed, or inaccurate data." |
| SD-GEN-08 | JSON-LD that exists only after JS runs: confirm it is in the rendered DOM. Google processes DOM-injected JSON-LD, but flag when raw HTML lacks it for Product/merchant pages. | raw-html vs rendered | medium for generic pages (works); high for Product on merchant pages (crawl reliability) | [S4] [S2] | "Google Search can understand and process structured data that's available in the DOM when it renders the page." (S4); product page doc: "dynamically-generated markup can make Shopping crawls less frequent and less reliable" (S6, verbatim from fetch) |
| SD-GEN-09 | If a type is not supported by the Rich Results Test, verify using the rendered HTML instead. | rendered | info: tool-usage rule | [S4] | "If you are testing a structured data type that is not supported by the Rich Results test, check the rendered HTML. If the rendered HTML contains the structured data, Google Search will be able to process it." |
| SD-GEN-10 | Markup goes on the page it describes; duplicates (e.g., variant URLs) carry the same markup. | structured-data | medium | [S1] | "Put the structured data on the page that it describes" (and the doc says to put the same markup on all duplicate pages.) |
| SD-GEN-11 | Every image URL inside structured data is crawlable and indexable (not blocked by robots.txt, returns 200, not noindex). | robots / headers | medium | [S1] | "All image URLs specified in structured data must be crawlable and indexable." |
| SD-GEN-12 | Use the most specific applicable schema.org type and property names. | structured-data | low | [S1] | "Try to use the most specific applicable type and property names defined by schema.org." |
| SD-GEN-13 | Reviews: no fake reviews or content unrelated to the page focus; if reviews are marked up, include all visible reviews. | rendered + structured-data | high: manual action cause | [S1] | "Don't mark up irrelevant or misleading content, such as fake reviews or content unrelated to the focus of a page." |
| SD-GEN-14 | Do not use GTM-style duplication of markup that already exists in HTML; mismatch risk. | rendered | low | [S4] | duplicating info in GTM "increases the risk of having a mismatch between page content and the structured data." (S4, verbatim from fetch) |
| SD-GEN-15 | `sameAs` may be used to link entity identities. | structured-data | info | [S2] | Google "can make general use of the `sameAs` property." (S2, verbatim from fetch) |

Manual-action facts (all need Search Console to *see*; without it the skill can only pre-empt them with SD-GEN-02/03/13):

| rule-id | check | layer | severity + why | source | quoted passage |
|---|---|---|---|---|---|
| SD-GEN-16 | A "Structured data issue" manual action affects only rich-result eligibility, not ranking. Skill language: say "loses eligibility", never "loses rank". | any | info: calibration for report wording | [S1] | "A structured data manual action means that a page loses eligibility for appearance as a rich result; it doesn't affect how the page ranks in Google web search." |
| SD-GEN-17 | Quality guidelines (visibility, relevance, honesty) cannot be fully automated; the skill reports heuristic hits as "needs human review". | any | info | [S1] | Quality guidelines "are not easily testable using an automated tool." (S1, verbatim from fetch) |
| SD-GEN-18 | Named manual-action triggers: "Structured data does not match content", "Structured data found on hidden content", "Company marked as product", "Non-product labeled as product", "Review written by the site or person providing the service". Use as the check list for Product/Review pages. | rendered + structured-data | high | [S23] | "Reviews must not be written or provided by the business or content provider unless they are customer, independent, and unpaid editorial reviews." |

## 3. Deprecated / restricted rich-result types (SD-DEP) — do NOT flag their absence

Authority: Google Search Central changelog [S12], blog posts [S13a-d], Search Gallery [S3] (Last updated 2026-06-15).

| rule-id | Type | Status and date (as stated by source) | source | quoted passage | audit handling (GUESS(inference)) |
|---|---|---|---|---|---|
| SD-DEP-01 | FAQ rich result | Restricted 2023-08-08; no longer shown 2026-05-07; docs removed 2026-06-15 | [S13b] [S12] | Blog 2023: "FAQ rich results will only be shown for well-known, authoritative government and health websites." Changelog 2026-06-15: "The FAQ rich result feature is no longer shown in Google Search results." | Do not flag absence. Existing `FAQPage` markup: info "no visible benefit", not an error. |
| SD-DEP-02 | HowTo rich result | Mobile removed and desktop-only 2023-08-08; docs removed Sept 2023 | [S13b] [S12] | Changelog: "Removed the How-to structured data documentation, as this rich result is no longer shown in search results, on both desktop and mobile devices." | Same as above. |
| SD-DEP-03 | Sitelinks search box (`WebSite` + `SearchAction`) | Removal from 2024-11-21 (blog 2024-10-21); doc removed 2024-11-29 | [S13c] | "we'll be removing this visual element starting on November 21, 2024." Also: "Unsupported structured data like this won't cause issues in Search, and won't trigger errors in Search Console reports." | Never flag missing. Existing markup is harmless. Do NOT confuse with site names, which still use `WebSite` (see SD-WEB). |
| SD-DEP-04 | Seven features: Book Actions, Course Info, Claim Review, Estimated Salary, Learning Video, Special Announcement, Vehicle Listing | Announced 2025-06-12 to be phased out; removed from Search Console reports and RRT 2025-09-09 (except Book Actions); docs for course info, estimated salary, learning video, special announcement, vehicle listing removed 2025-09-09 | [S13a] [S12] | "will no longer be supported in Google Search results and will be phased out over the coming weeks and months." Also: "This update won't affect how pages are ranked." | Do not flag. |
| SD-DEP-05 | Book actions | Deprecation banner removed 2025-11-05 because "there's still a feature using the markup in Google Search." | [S12] | (as quoted) | Do not claim it is dead. |
| SD-DEP-06 | Practice problem, Dataset | Phase-out notice 2025-11-05; practice-problem docs removed 2026-01-06; Dataset is used only by Dataset Search | [S12] [S13d] | "we are phasing out the practice problem and dataset structured data types from Google Search results." Also "Dataset structured data is only used by Dataset Search, and not Google Search." | Do not flag. |
| SD-DEP-07 | Special announcement | Deprecated from 2025-07-31 (notice 2025-04-23) | [S12] | "This feature will be deprecated starting July 31, 2025." | Do not flag. |
| SD-DEP-08 | Critic review | Deprecated 2021-06-10 | [S12] | "This deprecation doesn't affect any other features on Google Search that use review markup. You can leave the markup on your site." | Do not flag; do not tell users to remove review markup. |
| SD-DEP-09 | Breadcrumb | Mobile removed 2025-01-22; remains on desktop | [S12] [S10] | "they only appear on desktop search results, not mobile." (S12). Breadcrumb doc: "This feature is available on desktop in all regions and languages where Google Search is available." (S10) | Keep as a valid but low-impact check (SD-BC). |
| SD-DEP-10 | Home activity | "The home activity feature no longer appears in Google Search results." | [S12] | (as quoted) | Do not flag. |
| SD-DEP-11 | Features still in the gallery (current list) | Search Gallery lists: Article, Breadcrumb, Carousel, Course list, Dataset, Discussion forum, Education Q&A, Employer aggregate rating, Event, Image metadata, Job posting, Local business, Math solver, Movie, Organization, Product, Profile page, Q&A, Recipe, Review snippet, Software app, Speakable, Subscription and paywalled content, Vacation rental, Video. Not listed: FAQ, HowTo, Sitelinks searchbox. | [S3] | Software app entry: "Information about a software app, including rating information, a description of the app, and a link to the app." | The skill's "supported types" list MUST be refreshed from the gallery; do not hard-code. |

Note on Search Console: the 2025-11-05 blog says "Starting in January 2026, we'll remove support for the structured data types in Search Console and its API." ([S13d]).

## 4. SoftwareApplication (SD-SW) — highest relevance for this skill

Source of truth for Google behaviour: [S5] (Last updated 2026-09-08).

| rule-id | check | layer | severity + why | source | quoted passage |
|---|---|---|---|---|---|
| SD-SW-01 | Rich-result required: `name` present. | structured-data | high if targeting software-app rich result | [S5] | `name` — "The name of the app." (S5, verbatim from fetch) |
| SD-SW-02 | Required: `offers.price` present. Free app: price must be `0`. | structured-data | high | [S5] | "If the app is available without payment, set `offers.price` to `0`." |
| SD-SW-03 | Required: at least one of `aggregateRating` or `review`. | structured-data | high for rich result; but see SD-SW-07 before recommending adding | [S5] | "You must include one of the following properties" — `aggregateRating` / `review` (S5, verbatim) |
| SD-SW-04 | Recommended: `applicationCategory` with one of the supported values (GameApplication, SocialNetworkingApplication, TravelApplication, ShoppingApplication, SportsApplication, LifestyleApplication, BusinessApplication, DesignApplication, DeveloperApplication, DriverApplication, EducationalApplication, HealthApplication, FinanceApplication, SecurityApplication, BrowserApplication, CommunicationApplication, DesktopEnhancementApplication, EntertainmentApplication, MultimediaApplication, HomeApplication, UtilitiesApplication, ReferenceApplication). | structured-data | medium | [S5] | "The value must be a supported app type." |
| SD-SW-05 | Recommended: `operatingSystem`. | structured-data | low | [S5] | listed as recommended property (S5) |
| SD-SW-06 | If price > 0, include `offers.priceCurrency`. | structured-data | medium | [S5] | "If the app has a price greater than 0, we recommend also including the `offers.priceCurrency` property." |
| SD-SW-07 | `aggregateRating`/`review` values appear visibly on the page and come from real users. A rating in JSON-LD with no visible rating on the page is a violation. Never recommend adding a rating to satisfy SD-SW-03 unless real visible reviews exist. | rendered + structured-data | critical when fabricated/invisible (manual-action risk); that is the check, not the omission | [S1] [S7] | "If you use `AggregateRating`, users should be able to see that aggregate rating on the page." (S7, verbatim) |
| SD-SW-08 | Use `MobileApplication` or `WebApplication` subtype when apt. | structured-data | low | [S5] | "For mobile applications and web applications, Google also supports `MobileApplication` and `WebApplication`." |
| SD-SW-09 | `VideoGame` alone gets no rich result; co-type with another type. | structured-data | low | [S5] | "Google doesn't show a rich result for Software Apps that only have the `VideoGame` type... co-type the `VideoGame` type with another type." (S5, ellipsis in source quote as fetched) |
| SD-SW-10 | Markup is on a web page body describing the app; it cannot be tested via site-name features in RRT. | any | info | [S5] | markup goes "in the body of a web page." (S5, verbatim) |

schema.org definitions (vocabulary only; Google's doc wins where they differ — see section 1):

| rule-id | schema.org fact | source | quoted passage |
|---|---|---|---|
| SD-SCH-01 | `SoftwareApplication`: "A software application." Chain Thing > CreativeWork > SoftwareApplication. Properties include `applicationCategory`, `operatingSystem`, `softwareVersion`, `downloadUrl`, `installUrl`, `screenshot`, `featureList`, `softwareRequirements`, `releaseNotes`, inherited `aggregateRating`, `offers`, `review`. | [S15] | `applicationCategory`: "Type of software application, e.g. 'Game, Multimedia'." |
| SD-SCH-02 | `WebApplication` is a subtype of SoftwareApplication; adds `browserRequirements`. | [S16] | "Specifies browser requirements in human-readable text. For example, 'requires HTML5 support'." |
| SD-SCH-03 | `Product`: any offered product or service. | [S17] | "Any offered product or service." |
| SD-SCH-04 | `Offer`: offer to transfer rights or provide a service; default function is sell. | [S18] | an Offer without a defined `businessFunction` "can be assumed to be an offer to sell." |
| SD-SCH-05 | `Organization`. | [S19] | "An organization such as a school, NGO, corporation, club, etc." |
| SD-SCH-06 | `WebSite`. | [S20] | "A WebSite is a set of related web pages and other items typically served from a single web domain and accessible via URLs." |
| SD-SCH-07 | `WebPage` is implicit; declare explicitly when using `breadcrumb`. | [S21] | "Every web page is implicitly assumed to be declared to be of type WebPage, so the various properties about that webpage, such as `breadcrumb` may be used." |
| SD-SCH-08 | `BreadcrumbList`, `position` integers from 1. | [S22] | "A BreadcrumbList is an ItemList consisting of a chain of linked Web pages, typically described using at least their URL and their name, and typically ending with the current page." |

schema.org pages carry a "development version" banner (V30.1 | 2026-09-16 seen on BreadcrumbList). Usage bands printed on the pages: SoftwareApplication 1M–10M domains, WebApplication 100K–1M, Product 10M+, Organization 10M+ (source: [S15] [S16] [S17] [S19]).

## 5. Product, Offer, AggregateRating, Review (SD-PRD, SD-REV)

Sources: [S6] Product snippet (Last updated 2026-09-08), [S7] Review snippet (Last updated 2026-09-08).

| rule-id | check | layer | severity + why | source | quoted passage |
|---|---|---|---|---|---|
| SD-PRD-01 | Product required: `name`, plus at least one of `review`, `aggregateRating`, `offers`. | structured-data | high if targeting product snippet | [S6] | "Product snippets require either `review` or `aggregateRating` or `offers`" (S6, verbatim from fetch) |
| SD-PRD-02 | Offer required: `price` (or `priceSpecification.price`); free = 0. | structured-data | high | [S6] | the doc example shows `"price": 0` for free offers |
| SD-PRD-03 | Offer recommended: `priceCurrency` always; `availability` (one most-appropriate value); `priceValidUntil` not in the past. | structured-data | medium | [S6] | "currently recommended for product snippets ... but required for merchant listing experiences. It is therefore best to always provide this property."; "Your product snippet may not display if the `priceValidUntil` property indicates a past date." |
| SD-PRD-04 | `AggregateOffer` requires `lowPrice` and `priceCurrency`; recommended `highPrice`, `offerCount`. Not used for variants. | structured-data | medium | [S6] | "Don't use `AggregateOffer` to describe a set of product variants." |
| SD-PRD-05 | Page focuses on a single product (or variants of one). Category/list pages must not carry Product markup for the list. | structured-data | high: SD-GEN-18 "non-product labeled as product" | [S6] [S23] | "product rich results only support pages that focus on a single product (or multiple variants of the same product)." |
| SD-PRD-06 | Multiple currencies: one URL per currency. | structured-data | low | [S6] | "When offering products for sale in multiple currencies, have a distinct URL per currency." |
| SD-PRD-07 | Pros/cons markup only on editorial review pages, at least two statements. | structured-data | low | [S6] | "Only editorial product review pages are eligible" |
| SD-REV-01 | Review required: `author` (<100 chars), `itemReviewed` (unless nested), `reviewRating.ratingValue`; recommended `datePublished`, `bestRating`, `worstRating` (default scale 1–5). | structured-data | high if targeting | [S7] | `author` "must be shorter than 100 characters" (S7, verbatim) |
| SD-REV-02 | AggregateRating required: `itemReviewed` (unless nested), `ratingValue`, and at least one of `ratingCount` / `reviewCount`; recommended `bestRating`, `worstRating`. | structured-data | high | [S7] | "At least one" of `ratingCount`/`reviewCount` "is required" (S7, verbatim) |
| SD-REV-03 | Reviewed content is visible on the page. | rendered | high | [S7] | "Make sure the review content you mark up are readily available to users from the marked-up page." |
| SD-REV-04 | Review is about one specific item, not a category or list. | structured-data | medium | [S7] | "Provide review information about a specific item, not about a category or a list of items." |
| SD-REV-05 | Multiple individual reviews implies an aggregate rating. | structured-data | low | [S7] | "If you include multiple individual reviews, also include an aggregate rating of the individual reviews." |
| SD-REV-06 | No ratings copied from other sites. | structured-data | high | [S7] | "Don't aggregate reviews or ratings from other websites." |
| SD-REV-07 | No fake or undisclosed incentivized reviews (guideline added in changelog 2026-07-24). | rendered | high | [S7] | "Don't include fake or undisclosed incentivized reviews on your page or in your structured data markup." |
| SD-REV-08 | **Self-serving restriction**: reviews of an entity marked up by the entity itself (LocalBusiness / any Organization type) are ineligible for star results. Organization/LocalBusiness review markup is allowed only on sites that capture reviews about other organizations. | structured-data | high: flag `Organization` or `LocalBusiness` with own `aggregateRating`/`review`. Does not apply to Product/SoftwareApplication reviews of a product the site sells (not stated by source; see note). | [S7] | "If the entity that's being reviewed controls the reviews about itself, their pages that use `LocalBusiness` or any other type of `Organization` structured data are ineligible for star review feature." |
| SD-REV-09 | Ratings must be sourced directly from users. | rendered | high | [S7] | Ratings "must be sourced directly from users." (S7, verbatim from fetch) |
| SD-REV-10 | Nesting: avoid more than one way of indicating the reviewed item (changelog 2025-11-12). | structured-data | low | [S12] | "avoid using multiple ways of indicating what's being reviewed" (S12, verbatim from fetch) |
| SD-REV-11 | Reviewer name valid `Person` or `Team` (for Product pros/cons). | structured-data | low | [S6] | "the reviewer's name must be a valid name for a `Person` or `Team`." |

**GUESS(inference)** The self-serving restriction text names `Organization`/`LocalBusiness`. The SoftwareApplication doc ([S5]) does not repeat it. Whether a vendor's own reviews of its own software app are "self-serving" is not stated by the sources I fetched; the skill should flag only the explicit LocalBusiness/Organization case at `high` and flag invisible/fabricated ratings (SD-SW-07, SD-REV-03) at `critical`.

## 6. Organization (SD-ORG)

Source: [S8] (Google Organization structured data).

| rule-id | check | layer | severity + why | source | quoted passage |
|---|---|---|---|---|---|
| SD-ORG-01 | No required properties; do not flag absence of Organization markup as an error. | structured-data | info | [S8] | "There are no required properties; instead, we recommend adding as many properties that are relevant to your organization." |
| SD-ORG-02 | Placed on home page or one page describing the org; not needed on every page. | structured-data | low: do not flag its absence on inner pages | [S8] | "We recommend placing this information on your home page, or a single page that describes your organization... You don't need to include it on every page of your site." |
| SD-ORG-03 | `logo` at least 112x112px, crawlable, indexable, readable on white background. | raw-html + headers (image fetch) | low | [S8] | "The image must be 112x112px, at minimum. The image URL must be crawlable and indexable..." |
| SD-ORG-04 | `name`/`alternateName` consistent with the site name used for WebSite markup. | structured-data | low | [S8] | "Use the same `name` and `alternateName` that you're using for your site name." |
| SD-ORG-05 | Other recommended: `url`, `sameAs`, `address` (PostalAddress, country ISO 3166-1 alpha-2), `contactPoint`, `legalName`, `description`, `foundingDate`, `iso6523Code` (prefix 0060 DUNS, 0088 GLN, 0199 LEI), `vatID`, `taxID`, `naics`, `numberOfEmployees`, merchant-return/shipping/member-program properties. | structured-data | low | [S8] | (list in doc; as summarised) |
| SD-ORG-06 | Use the most specific subtype, e.g. `OnlineStore` over `OnlineBusiness` for e-commerce. | structured-data | low | [S8] | "if you have an ecommerce site, then we recommend using the `OnlineStore` subtype instead of `OnlineBusiness`." |

## 7. WebSite and site names (SD-WEB)

Source: [S9] (Google site names doc).

| rule-id | check | layer | severity + why | source | quoted passage |
|---|---|---|---|---|---|
| SD-WEB-01 | `WebSite` markup on the home page with `name` and `url` (canonical home page); optional `alternateName` array ordered by preference. | structured-data | medium: site-name preference signal, not required | [S9] | "`WebSite` structured data is most important, if you want to specify a preference." |
| SD-WEB-02 | `WebSite` is on the home page, i.e. domain or subdomain root URI, not on inner pages or subdirectories. | structured-data | medium | [S9] | "WebSite structured data must be on the home page of the site. By home page, we mean the domain or subdomain level root URI." |
| SD-WEB-03 | Only one site name per site; subdirectory-level site names are unsupported. | any | info | [S9] | "Currently, Google Search only supports one site name per site ... Google Search does not support site names at the subdirectory level." |
| SD-WEB-04 | Avoid an additional `WebSite` block on the home page. | structured-data | low | [S9] | "avoid creating an additional `WebSite` structured data block on your home page if you can help it." |
| SD-WEB-05 | Site name is not generic; domain-as-name must be lowercase. | structured-data | low | [S9] | "Avoid using a generic name." |
| SD-WEB-06 | Duplicate home pages (http/https, www, etc.) carry the same structured data. | structured-data | low | [S9] | (doc states duplicate home pages should carry the same structured data; summarised) |
| SD-WEB-07 | Google also uses `og:site_name`, `<title>` and headings for site names; keep them consistent with the `WebSite.name`. | raw-html | low | [S9] | (doc names `og:site_name`, title, headings as inputs; summarised) |
| SD-WEB-08 | Site names cannot be validated with the Rich Results Test; use Schema Markup Validator. | any | info | [S9] | "Site names aren't supported in the Rich Results Test" (S9, verbatim) |

## 8. BreadcrumbList (SD-BC)

Source: [S10]. Desktop-only display (SD-DEP-09).

| rule-id | check | layer | severity + why | source | quoted passage |
|---|---|---|---|---|---|
| SD-BC-01 | `BreadcrumbList` has `itemListElement` with at least two `ListItem`s. | structured-data | medium | [S10] | "define a `BreadcrumbList` that contains at least two `ListItems`." |
| SD-BC-02 | Each `ListItem` has `name`, `position` and `item` (URL). The last crumb may omit `item`. | structured-data | medium | [S10] | doc requires `item`, `name`, `position`; its example's last item omits `item` (as read). |
| SD-BC-03 | No need for a crumb for the domain root or the page itself. | structured-data | info | [S10] | "It is not required to include a breadcrumb `ListItem` for the top level path (your site's domain or host name), nor for the page itself." |
| SD-BC-04 | Crumbs follow a typical user path, not necessarily the URL structure. | any | info | [S10] | "We recommend providing breadcrumbs that represent a typical user path to a page, instead of mirroring the URL structure." |

## 9. Article (SD-ART)

Source: [S11] (Last updated 2026-09-08).

| rule-id | check | layer | severity + why | source | quoted passage |
|---|---|---|---|---|---|
| SD-ART-01 | No required properties; do not flag missing Article markup as an error. Types: `Article`, `NewsArticle`, `BlogPosting`. | structured-data | info | [S11] | "There are no required properties; instead, add the properties that apply to your content." |
| SD-ART-02 | Recommended: `author` (Person/Organization with `name` and `url`), `datePublished`, `dateModified` (ISO 8601, include timezone), `headline`, `image`. | structured-data | low | [S11] | "We recommend that you provide timezone information" (S11, verbatim) |
| SD-ART-03 | `image`: multiple images, "minimum of 50K pixels when multiplying width and height", aspect ratios 16x9, 4x3, 1x1. | structured-data + image fetch | low | [S11] | "minimum of 50K pixels when multiplying width and height" (S11, verbatim) |
| SD-ART-04 | One author per `author` entry; `author.name` is only the name; use `Person` type for people. | structured-data | low | [S11] | "Don't merge multiple authors in the same `author` field." |
| SD-ART-05 | Multi-part articles: `rel=canonical` on each page or on a view-all page. | raw-html | low | [S11] | "For multi-part articles, make sure that the `rel=canonical` points at either each individual page or a 'view-all' page." |

## 10. VideoObject (SD-VID)

Source: [S24] (changelog 2026-09-24 added `creator`/`author`).

| rule-id | check | layer | severity + why | source | quoted passage |
|---|---|---|---|---|---|
| SD-VID-01 | Required: `name` (unique per video), `thumbnailUrl`, `uploadDate` (ISO 8601; timezone recommended). | structured-data | high if targeting video rich result | [S24] | `name`: "unique text ... for each video" (S24, verbatim) |
| SD-VID-02 | Recommended: `contentUrl` (actual file bytes URL), `creator`/`author`, `description`, `duration`, `embedUrl`, `expires`, `hasPart` (Clip), `ineligibleRegion`, `regionsAllowed`, `interactionStatistic`. | structured-data | low | [S24] | "Don't link to the page where the video lives; this must be the URL of the video file's actual content bytes" |
| SD-VID-03 | Clip: `name`, `startOffset`, `url` required; `endOffset` recommended; video at least 30 seconds, no two clips share a start time. | structured-data | low | [S24] | (as summarised from doc) |
| SD-VID-04 | Page lets users watch the video. | rendered | high | [S24] | "VideoObject structured data must be added to a page where users can watch the video." |

## 11. JSON-LD syntax checks (SD-JLD) — mechanical, no credentials

| rule-id | check | layer | severity + why | source | quoted passage |
|---|---|---|---|---|---|
| SD-JLD-01 | Each `<script type="application/ld+json">` parses as JSON (no trailing commas, no comments, balanced). Failure is a syntax error. | raw-html / rendered | high: unparseable markup is not read | [S25] [S29] | RRT syntax errors include: invalid JSON document, missing `:`/`,`/`}` (S25, summarised); "JSON-LD content can be easily embedded in HTML by placing it in a script element with the type attribute set to application/ld+json." (S29) |
| SD-JLD-02 | No comments inside JSON-LD. RRT tolerates them but they are not valid. | raw-html | low | [S25] | "The Rich Results test tool ignores comments within JSON-LD blocks. However, that behavior is not supported by the JSON-LD standard and so might result in errors in actual usage." |
| SD-JLD-03 | `@context` present (schema.org) in each top-level node; no duplicate `@context` key in one object. | structured-data | high | [S29] [S25] | "`@context` Used to define the short-hand names that are used throughout a JSON-LD document." (S29, verbatim); RRT flags "duplicate unique property (e.g. two `@context`)" (S25, summarised) |
| SD-JLD-04 | `@type` present on every node and is a schema.org type. | structured-data | high | [S29] | "`@type` Used to set the type of a node or the datatype of a typed value." |
| SD-JLD-05 | `@id`-linked graph nodes resolve inside the same block (avoid dangling refs). | structured-data | low | heuristic, see section 13 | none sourced |
| SD-JLD-06 | Values are correct types (price as number or numeric string, dates ISO 8601, URLs absolute). | structured-data | medium | [S25] [S6] [S11] | RRT lists "incorrect value type" as a syntax error (S25, summarised); ISO 8601 per [S11], [S24] |
| SD-JLD-07 | A JSON-LD processor extracts a script block as a standalone document and does not merge it with other markup. Several blocks per page are fine. | raw-html | info | [S29] | "A JSON-LD processor MUST extract only the specified data block's contents parsing it as a standalone JSON-LD document and MUST NOT merge the result with any other markup from the same HTML document." (applies to targeting a specific script element) |

## 12. Validation tools: availability, credentials, degradation

| rule-id | tool / check | credentials | behaviour without credentials | source | quoted passage |
|---|---|---|---|---|---|
| SD-VAL-01 | Rich Results Test (search.google.com/test/rich-results): web UI, supports JSON-LD, RDFa, Microdata; can test an arbitrary code snippet. | none for the UI; **no documented API found** | Skill cannot call it; fall back to local JSON parse + required-property tables (sections 4–10) | [S25] | "You can test an arbitrary code snippet using this tool." |
| SD-VAL-02 | RRT fetches as Google-InspectionTool; a page blocked by robots.txt or noindex cannot be tested. | n/a | Local check of robots/noindex first | [S25] | "If Google is prevented from crawling the page ... (robots.txt rule or noindex directive), the page cannot be tested with this tool." |
| SD-VAL-03 | Schema Markup Validator (validator.schema.org): extracts JSON-LD 1.0, RDFa 1.1, Microdata; identifies syntax mistakes; run by Google for the schema.org community; does not interpret external `@context` URLs. | none; **no public API** | Cannot be automated by the skill; do not scrape | [S27] [S28] | "Do not try to scrape validator.schema.org - it is a service run and hosted by Google as a contribution to the project." and "There are no resources or plans for Google to make an API." (S28, maintainer reply Feb 2023) |
| SD-VAL-04 | URL Inspection API gives `richResultsResult` (detected rich result types, issues, verdict) for the indexed version of a URL only. | **OAuth, verified Search Console property (scopes `webmasters` / `webmasters.readonly`)** | Skill reports "not run: no credentials"; never fabricates | [S26] [S26b] | "Presently only the status of the version in the Google index is available; you cannot test the indexability of a live URL." |
| SD-VAL-05 | Search Console structured-data / rich-result reports and the Manual actions report. | verified property | Skill cannot see manual actions; state "unknown without Search Console" | [S23] | "If a site has a manual action, some or all of that site will not be shown in Google search results." |
| SD-VAL-06 | RRT results are kept about 90 days; the supported-type list on the RRT help page may be stale (SD-DEP discrepancy). | n/a | n/a | [S25] | (as read; no quote beyond summary) |

Local fallback implemented by the skill without credentials: parse every JSON-LD script from the raw HTML and the rendered DOM, check SD-JLD-01..04, compare to per-type tables, diff against visible text. **GUESS(inference)** this covers syntax and completeness but not Google's eligibility decisions.

## 13. Social-preview rules (OG- and TW-): NOT Google ranking signals

Severity guidance (GUESS(inference), basis: purpose stated by the specs): both are link-preview features for third-party platforms. The skill reports them as `low`, `medium` only when the page is meant to be shared. The AI-optimization guide ([S14]) does not list OG tags as a Google ranking requirement. Source for the one Google use: site names consider `og:site_name` ([S9]).

| rule-id | check | layer | severity + why | source | quoted passage |
|---|---|---|---|---|---|
| OG-01 | `og:title`, `og:type`, `og:image`, `og:url` all present as `<meta property="og:..." content="...">` in `<head>`. | raw-html | medium (shared links lose preview); low otherwise | [S30] | "The four required properties for every page are: `og:title`, `og:type`, `og:image`, `og:url`." |
| OG-02 | `og:url` is the canonical URL (matches `<link rel=canonical>`). | raw-html | low | [S30] | "The canonical URL of your object that will be used as its permanent ID in the graph." |
| OG-03 | `og:type` is a valid value. Default is `website` for unmarked pages. Types: `article`, `book`, `profile`, `website` (plus Beta `payment.link`). Types may require more properties. | raw-html | low | [S30] | "Depending on the type you specify, other properties may also be required." And: "Any non-marked up webpage should be treated as `og:type` website." |
| OG-04 | If `og:image` is present, `og:image:alt` is present. | raw-html | low | [S30] | "If the page specifies an og:image it should specify `og:image:alt`." |
| OG-05 | `og:image` URL absolute, and optional `og:image:width`/`og:image:height`/`og:image:type`/`og:image:secure_url` consistent with the image. | raw-html + image fetch | low | [S30] | image structured properties listed (`og:image:url`, `:secure_url`, `:type`, `:width`, `:height`, `:alt`) |
| OG-06 | Recommended: `og:description` (one to two sentences), `og:site_name`, `og:locale` (default `en_US`). | raw-html | low | [S30] | `og:description`: "A one to two sentence description of your object." |
| OG-07 | `article` type properties (`article:published_time`, `article:modified_time`, `article:author`, `article:section`, `article:tag`) when `og:type=article`; date type is ISO 8601. | raw-html | low | [S30] | `article:published_time`: "When the article was first published." |
| OG-08 | Duplicate/conflicting OG tags: first tag from top to bottom wins on conflict. | raw-html | low | [S30] | "The first tag (from top to bottom) is given preference during conflicts." |
| OG-09 | Markup form: `prefix="og: https://ogp.me/ns#"` on `<html>` (or `<head>`) plus meta tags. Many consumers work without the prefix; do not flag a missing prefix above `info`. | raw-html | info | [S30] | markup example in the spec uses `<html prefix="og: https://ogp.me/ns#">` (as read) |
| TW-01 | `twitter:card` present with a valid card type. If absent but `og:type`, `og:title`, `og:description` exist, a summary card may still render. | raw-html | low | [S31] | "If an og:type, og:title and og:description exist in the markup but twitter:card is absent, then a summary card may be rendered." |
| TW-02 | `summary_large_image` requires `twitter:card` and `twitter:title`; `twitter:description`, `twitter:image` are optional per that card's reference table. | raw-html | low | [S32] | `twitter:card` "Must be set to a value of “summary_large_image”" (S32, verbatim) |
| TW-03 | Falls back to OG tags: `twitter:title`->`og:title`, `twitter:description`->`og:description`, `twitter:image`->`og:image`, `twitter:image:alt`->`og:image:alt`. So duplicate `twitter:*` tags are unnecessary when OG tags exist. | raw-html | info | [S31] | fallback table in [S31] |
| TW-04 | `twitter:title` max 70 characters; `twitter:description` max 200 characters (markup reference). | raw-html | low | [S31] | "Description of content (maximum 200 characters)" and "Title of content (max 70 characters)" (S31, verbatim) |
| TW-05 | Image: under 5MB; JPG, PNG, WEBP or GIF; no SVG; summary_large_image aspect ratio 2:1, minimum 300x157, maximum 4096x4096. | headers (image fetch) | low | [S32] | "Images for this Card support an aspect ratio of 2:1 with minimum dimensions of 300x157 or maximum of 4096x4096 pixels. Images must be less than 5MB in size." |
| TW-06 | `twitter:image:alt` max 420 characters. | raw-html | low | [S31] | "Maximum 420 characters." |
| TW-07 | `twitter:image` is a unique image for the content, not a generic logo. | raw-html | low | [S32] | "You should not use a generic image such as your website logo, author photo, or other image that spans multiple pages." |
| TW-08 | `twitter:site` / `twitter:site:id`: the markup table says one of them is required for summary, summary_large_image, player and app cards, while the large-image reference table says `twitter:site` is "No". The two statements conflict within X's own docs; flag only at `info`. | raw-html | info | [S31] [S32] | "Either twitter:site or twitter:site:id is required." (S31) vs `twitter:site` Required: "No" (S32, table) |

Credentials: none needed for any OG-/TW- check; all run against raw HTML. The X Card Validator at `cards-dev.twitter.com/validator` is linked from [S32] but was not fetched; do not cite it as working.

## 14. Do NOT flag (myths, outdated rules)

| id | statement | source | quoted passage |
|---|---|---|---|
| NF-01 | Missing FAQPage/HowTo markup is not an error; those rich results are gone. | [S12] [S13b] | "The FAQ rich result feature is no longer shown in Google Search results." |
| NF-02 | Missing sitelinks `SearchAction` markup is not an error; existing markup is harmless. | [S13c] | "Unsupported structured data like this won't cause issues in Search, and won't trigger errors in Search Console reports." |
| NF-03 | No special schema.org markup, llms.txt or AI-only files are needed for generative AI search. | [S14] | "LLMS.txt files and other 'special' markup: You don't need to create new machine readable files, AI text files, markup, or Markdown to appear in Google Search." |
| NF-04 | Structured data does not directly raise ranking; manual actions affect eligibility only. | [S1] | "it doesn't affect how the page ranks in Google web search." |
| NF-05 | Do not insist on JSON-LD over Microdata/RDFa. | [S2] | "all 3 formats are equally fine for Google" |
| NF-06 | Do not require JSON-LD in raw HTML for ordinary pages; Google reads DOM-injected JSON-LD (Product on merchant pages is the caution case, SD-GEN-08). | [S2] | "Google can read JSON-LD data when it is dynamically injected into the page's contents." |
| NF-07 | Missing Organization or Article markup is not an error (no required properties). | [S8] [S11] | "There are no required properties" |
| NF-08 | Do not demand Organization markup on every page. | [S8] | "You don't need to include it on every page of your site." |
| NF-09 | Do not tell users to remove critic-review or other review markup merely because a feature was deprecated. | [S12] | "You can leave the markup on your site." |
| NF-10 | Do not treat missing BreadcrumbList as a mobile-search defect; breadcrumbs show on desktop only. | [S12] | "they only appear on desktop search results, not mobile." |
| NF-11 | Do not require "chunking" or special content shapes for AI search. | [S14] | "There's no requirement to break your content into tiny pieces for AI." |
| NF-12 | Do not call OG/Twitter tags Google ranking factors. | [S1] [S14] | Neither doc lists OG/Twitter tags as search requirements (inference from absence; GUESS(inference)); OG spec describes link-preview graph use [S30]. |
| NF-13 | Do not flag a missing `og:image:alt` as above `low`; spec says "should". | [S30] | "it should specify `og:image:alt`." |

## 15. Heuristics / unsourced

| id | statement | reason it is a heuristic |
|---|---|---|
| H-01 | Severity values in every table (critical/high/medium/low) | design choice (GUESS(inference)); sources define eligibility rules, not severity |
| H-02 | `@id`-linked graph references must resolve (SD-JLD-05) | no fetched primary source states a Google requirement; skill may flag as `low` |
| H-03 | Diffing JSON-LD text against visible DOM text as the way to test "visible content match" | method is mine; the requirement is sourced (SD-GEN-02), the algorithm is not |
| H-04 | Whether a vendor's own reviews on its own SoftwareApplication page are "self-serving" | Not stated in fetched docs; see section 5 note |
| H-05 | No documented Rich Results Test API | absence of evidence only (B2) |
| H-06 | OG/Twitter severity | design choice; purpose derived from specs |
| H-07 | Any claim about how X renders cards today beyond the archived docs | live docs not fetchable (B1) |

## 16. Credentials and degradation summary

| Check group | Needs credentials? | Without them |
|---|---|---|
| All SD-GEN, SD-SW, SD-PRD, SD-REV, SD-ORG, SD-WEB, SD-BC, SD-ART, SD-VID, SD-JLD, OG-, TW- checks | No | Fully local on raw HTML + rendered DOM |
| Manual-action status, Search Console rich-result reports | Yes (verified Search Console property) | Report "not checked"; list SD-GEN-02/03/13/18 as pre-emptive checks |
| URL Inspection API `richResultsResult` | Yes (OAuth) | Skip; no live-URL mode exists even with credentials ([S26]) |
| Rich Results Test, Schema Markup Validator | No login for UI, but no API | Not automatable; local fallback |

## 17. Coverage

**ACTION** What was fetched and read: see index below. Not fetched or only partly read: the schema.org validator UI is a JS shell (only its doc page and a maintainer thread were read); X docs only via archive copies; the X Card Validator, Google spam-policies page and the Google Search Console help pages for per-type reports were not fetched; I did not read the full ogp.me "structured properties" (audio, video) beyond what is cited; the Google video doc's Clip/SeekToAction thresholds and the Organization property detail are summarised from my reading earlier in the session, not re-quoted here (marked "as summarised").

## 18. Source index (all fetched 2026-10-12)

| Key | URL | Note |
|---|---|---|
| S1 | https://developers.google.com/search/docs/appearance/structured-data/sd-policies | General guidelines, Last updated 2026-07-10 |
| S2 | https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data | Last updated 2025-12-10 |
| S3 | https://developers.google.com/search/docs/appearance/structured-data/search-gallery | Last updated 2026-06-15 |
| S4 | https://developers.google.com/search/docs/appearance/structured-data/generate-structured-data-with-javascript | Last updated 2025-12-10 |
| S5 | https://developers.google.com/search/docs/appearance/structured-data/software-app | Last updated 2026-09-08 |
| S6 | https://developers.google.com/search/docs/appearance/structured-data/product-snippet | Last updated 2026-09-08 |
| S7 | https://developers.google.com/search/docs/appearance/structured-data/review-snippet | Last updated 2026-09-08 |
| S8 | https://developers.google.com/search/docs/appearance/structured-data/organization | |
| S9 | https://developers.google.com/search/docs/appearance/site-names | |
| S10 | https://developers.google.com/search/docs/appearance/structured-data/breadcrumb | |
| S11 | https://developers.google.com/search/docs/appearance/structured-data/article | Last updated 2026-09-08 |
| S12 | https://developers.google.com/search/updates | Search Central changelog (Oct 2026 entries visible) |
| S13a | https://developers.google.com/search/blog/2025/06/simplifying-search-results | |
| S13b | https://developers.google.com/search/blog/2023/08/howto-faq-changes | (blog 2023-08 on FAQ/HowTo; URL slug as fetched this session) |
| S13c | https://developers.google.com/search/blog/2024/10/sitelinks-search-box | (blog 2024-10-21; URL slug as fetched this session) |
| S13d | https://developers.google.com/search/blog/2025/11/update-on-our-efforts | |
| S14 | https://developers.google.com/search/docs/fundamentals/ai-optimization-guide | Last updated 2026-07-10 |
| S15 | https://schema.org/SoftwareApplication | |
| S16 | https://schema.org/WebApplication | |
| S17 | https://schema.org/Product | |
| S18 | https://schema.org/Offer | |
| S19 | https://schema.org/Organization | |
| S20 | https://schema.org/WebSite | |
| S21 | https://schema.org/WebPage | |
| S22 | https://schema.org/BreadcrumbList | |
| S23 | https://support.google.com/webmasters/answer/9044175 | Manual actions report |
| S24 | https://developers.google.com/search/docs/appearance/structured-data/video | |
| S25 | https://support.google.com/webmasters/answer/7445569 | Rich Results Test help |
| S26 | https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect | Last updated 2024-07-23 |
| S26b | https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult | `richResultsResult` |
| S27 | https://meta.schema.org/docs/validator.html | validator doc page |
| S28 | https://github.com/schemaorg/schemaorg/discussions/3261 | maintainer reply, Feb 2023; GitHub discussion, not a vendor doc but the schema.org project's own maintainer |
| S29 | https://www.w3.org/TR/json-ld11/ | W3C Recommendation 2020-07-16 |
| S30 | https://ogp.me/ | Open Graph protocol |
| S31 | https://web.archive.org/web/20260116124848/https://developer.x.com/en/docs/x-for-websites/cards/overview/markup | archive copy of X cards markup reference |
| S32 | https://web.archive.org/web/20260204074639/https://developer.x.com/en/docs/x-for-websites/cards/overview/summary-card-with-large-image | archive copy |
| (also fetched, not cited) | https://validator.schema.org/ | JS shell only |
| (also fetched, not cited) | https://developer.x.com/en/docs/x-for-websites/cards/overview/abouts-cards, https://docs.x.com/llms.txt | redirected to / index of X API landing; no cards content |

**GUESS(inference)** For S13b and S13c the slugs above are what I believe I fetched; my notes recorded the blog titles and quotes, not the exact slugs. Verify the slugs before shipping citations; the quoted text is verbatim from the fetch.

## 19. Bottom line

**CLAIM** The file holds 5 general-guideline groups, a 11-row deprecated/restricted-types table with dates, per-type required/recommended tables for SoftwareApplication, Product/Offer/AggregateRating/Review, Organization, WebSite/site names, BreadcrumbList, Article, VideoObject, JSON-LD syntax checks, validation-tool and credential notes, OG and X card rules, 13 do-not-flag entries and 7 heuristics.

**GUESS(inference)** The most valuable audit logic for a SoftwareApplication page: flag invisible or fabricated `aggregateRating` as critical, flag missing required properties only when a rich result is targeted, and never flag FAQ/HowTo/sitelinks absence.
