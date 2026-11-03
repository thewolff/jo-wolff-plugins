# Fetch note: Google Search Central Blog, "Farewell, Sitelinks Search Box" (2024-10-21)

- URL read: https://developers.google.com/search/blog/2024/10/sitelinks-search-box (read tool)
- Fetch date: 2026-10-12
- Fetched by: hand sl-seo-rules, workload wl-mv5jz4vewt8mbk
- Why: research/structured-data.md cites this post as [S13c] and its author was unsure the slug was exact. The slug resolved (the page canonical is the same URL) and the passages back the do-not-flag row on absent sitelinks-search-box (SearchAction) markup.

## Verbatim excerpt

The text between the rule lines is the reader output for the page, unchanged.

---

# Farewell, Sitelinks Search Box

Monday, October 21, 2024

It's been over ten years since we initially announced the [sitelinks search box in Google Search](/search/blog/2014/09/improved-sitelinks-search-box),
and over time, we've noticed that usage has dropped. With that, and to help simplify the search
results, we'll be removing this visual element starting on November 21, 2024.

![Search result showing a sitelinks search box](/static/search/blog/images/slsb-example-2024.png)

(Search result showing a sitelinks search box)

This change will apply globally across all search results, in all languages and countries.
This doesn't affect rankings or the [other sitelinks visual element](/search/docs/appearance/sitelinks), and won't be listed in the Search status dashboard.
Once we stop showing sitelinks search box elements in Search, we'll remove the [Search Console rich results report](https://support.google.com/webmasters/answer/7552505) for it and stop highlighting the markup in the [Rich Results Test](https://search.google.com/test/rich-results).

While you can remove [sitelinks search box structured data](/search/docs/appearance/structured-data/sitelinks-searchbox) from your site, there's no need to do so.
Unsupported structured data like this won't cause issues in Search, and won't trigger errors in
Search Console reports.
If you decide to remove sitelinks search box structured data, note that [site names](/search/docs/appearance/site-names#add-structured-data) also uses a
variation of `WebSite` structured data, which continues to be supported.

---
