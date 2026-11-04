# Fetch note: Google Search Central, "Understand JavaScript SEO basics" (rendering queue, soft 404, robots meta sections; page last updated 2026-03-04 UTC)

- URL read: https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics (read tool)
- Fetch date: 2026-10-12
- Fetched by: hand sl-seo-rules, workload wl-mv5jz4vewt8mbk
- Why: research/google-core.md tagged HEU-08 (JavaScript removing a raw-HTML noindex) heuristic because the page does not describe the removal case. This re-read confirms that: the page states that a page whose robots meta tag or header says noindex is not queued for rendering, and that adding noindex with JavaScript is a documented pattern for client-side error pages, but it has no sentence about removing noindex with JavaScript. JS-009 is admitted on the rendering-queue sentence (the observable consequence), and HEU-08 itself is dropped.

## Verbatim excerpt

The text between the rule lines is three excerpts of the reader output for the page, separated by `[...]`; each excerpt is unchanged.

---

Googlebot queues all pages with a `200` HTTP status code for rendering, unless a [robots `meta` tag or header](/search/docs/crawling-indexing/robots-meta-tag) tells Google not to index the page.
The page may stay on this queue for a few seconds, but it can take longer than that. Once Google's resources allow, a headless Chromium renders the page and executes the JavaScript.
Googlebot parses the rendered HTML for links again and queues the URLs it finds for crawling. Google also uses the rendered HTML to index the page.

[...]

To avoid [`soft 404` errors](/search/docs/crawling-indexing/troubleshoot-crawling-errors#soft-404-errors) when using client-side rendering and routing, use one of the following strategies:

- Use a [JavaScript redirect](/search/docs/crawling-indexing/301-redirects#jslocation) to a URL for which the server responds with a `404` HTTP status code (for example `/not-found`).
- Add a `<meta name="robots" content="noindex">` to error pages using JavaScript.

[...]

## Use robots `meta` tags carefully

You can prevent Google from indexing a page or following links through the robots `meta` tag.
For example, adding the following `meta` tag to the top of your page blocks Google from indexing the page:

```
<!-- Google won't index this page or follow links on this page -->
<meta name="robots" content="noindex, nofollow">
```

You can use JavaScript to add a robots `meta` tag to a page or change its content.
The following example code shows how to change the robots `meta` tag with JavaScript to prevent indexing of the current page if an API call doesn't return content.

```
fetch('/api/products/' + productId)
  .then(function (response) { return response.json(); })
  .then(function (apiResponse) {
    if (apiResponse.isError) {
      // get the robots meta tag
      var metaRobots = document.querySelector('meta[name="robots"]');
      // if there was no robots meta tag, add one
      if (!metaRobots) {
        metaRobots = document.createElement('meta');
        metaRobots.setAttribute('name', 'robots');
        document.head.appendChild(metaRobots);
      }
      // tell Google to exclude this page from the index
      metaRobots.setAttribute('content', 'noindex');
      // display an error message to the user
      errorMsg.textContent = 'This product is no longer available';
      return;
    }
    // display product information
    // ...
  });
```

---
