# Fetch note: Google Search Central Blog, "Changes to HowTo and FAQ rich results" (2023-08-08)

- URL read: https://developers.google.com/search/blog/2023/08/howto-faq-changes (read tool)
- Fetch date: 2026-10-12
- Fetched by: hand sl-seo-rules, workload wl-mv5jz4vewt8mbk
- Why: research/structured-data.md cites this post as [S13b] and its author was unsure the slug was exact. The slug resolved (the page canonical is the same URL) and the passages below back the do-not-flag rows on FAQPage and HowTo markup.

## Verbatim excerpt

The text between the rule lines is the reader output for the page, unchanged.

---

# Changes to HowTo and FAQ rich results

Tuesday, August 8, 2023

To provide a cleaner and more consistent search experience, we're changing how some rich results types are shown in Google's search results.
In particular, we're reducing the visibility of FAQ rich results, and limiting How-To rich results to desktop devices.
This change should finish rolling out globally within the next week.

## Overview of the changes

For site owners, these changes primarily affect the use of [FAQ](/search/docs/appearance/structured-data/faqpage) and [How-To](/search/docs/appearance/structured-data/how-to) structured data.

Going forward, [FAQ](/search/docs/appearance/structured-data/faqpage) (from `FAQPage` structured data) rich results will only be shown for well-known, authoritative government and health websites.
For all other sites, this rich result will no longer be shown regularly.
Sites may automatically be considered for this treatment depending on their eligibility.

While you can drop this structured data from your site, there's no need to proactively remove it.
Structured data that's not being used does not cause problems for Search, but also has no visible effects in Google Search.

![A search result showing a full FAQ rich result, and one without](/static/search/blog/images/faq-snippet-change.png)

[How-To](/search/docs/appearance/structured-data/how-to) (from `HowTo` structured data) rich results will only be shown for desktop users, and not for users on mobile devices.
Note that with mobile indexing, Google indexes the mobile version of a website as the basis for indexing: to have How-To rich results shown on desktop, the mobile version of your website must include the appropriate markup.

---
