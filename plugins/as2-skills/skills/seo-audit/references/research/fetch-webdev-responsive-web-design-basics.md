# Fetch note: web.dev, "Responsive web design basics" (section "Set the viewport", last updated 2019-02-12 UTC per the page footer)

- URL read: https://web.dev/articles/responsive-web-design-basics (read tool)
- Fetch date: 2026-10-12
- Fetched by: hand sl-seo-rules, workload wl-mv5jz4vewt8mbk
- Why: research/google-core.md tagged HEU-05 (viewport content) heuristic because this page was never fetched. The section below states the viewport requirement and the recommended value.

## Verbatim excerpt

The text between the rule lines is the reader output for the page, unchanged.

---

## Set the viewport

Pages optimized for a variety of devices must include a meta viewport tag in the
head of the document. This tag tells the browser how to control the page's
dimensions and scaling.

To try to provide the best experience, mobile browsers render the page at a
desktop screen width (usually about `980px`, though this varies across devices),
and then try to make the content look better by increasing font sizes and
scaling the content to fit the screen. This can make fonts look inconsistent and
require users to zoom in to see and interact with the content.

```
<!DOCTYPE html>
<html lang="en">
  <head>
    …
    <meta name="viewport" content="width=device-width, initial-scale=1">
    …
  </head>
  …
```

Using the meta viewport value `width=device-width` tells the page to match the
screen's width in device-independent pixels (DIP), a standard visual pixel unit
(which can be made up of many physical pixels on a high-density screen). This
lets the page reflow content to match different screen sizes.

![A
    page with the text hard to read because it's very zoomed out.](/static/articles/responsive-web-design-basics/image/screenshot-a-page-the-t-faa09126e69d.png)

*A page without the viewport meta tag loads very zoomed out, making the text
hard to read.*

![The same page with the text at a size that can be read.](/static/articles/responsive-web-design-basics/image/screenshot-the-same-page-9ac43367e5e0c.png)

*With the viewport meta tag set, you can read the page without zooming in.*

[Some browsers](https://css-tricks.com/probably-use-initial-scale1/) keep the
page's width constant when rotating to landscape mode, and zoom to fill the
screen instead of reflowing. Adding the value `initial-scale=1` tells browsers
to set a 1:1 relationship between CSS pixels and device-independent pixels
regardless of device orientation, letting the page take advantage of the full
landscape width.

The [Does not have a `<meta name="viewport">` tag with `width` or `initial-scale`](https://developer.chrome.com/docs/lighthouse/pwa/viewport) Lighthouse audit can help you automate the process of making sure your HTML
documents use the viewport meta tag correctly.

---

## Passages used by catalogue rows

Each passage below is one sentence or clause from the excerpt above with its hard line wraps joined by single spaces and nothing else changed.

- Pages optimized for a variety of devices must include a meta viewport tag in the head of the document.
- Using the meta viewport value `width=device-width` tells the page to match the screen's width in device-independent pixels (DIP), a standard visual pixel unit (which can be made up of many physical pixels on a high-density screen).
