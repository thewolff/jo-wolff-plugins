# Fetch note: W3C WAI Images Tutorial, "Decorative Images" (Overview box)

- URL read: https://www.w3.org/WAI/tutorials/images/decorative/ (read tool)
- Fetch date: 2026-10-12
- Fetched by: hand sl-seo-rules, workload wl-mv5jz4vewt8mbk
- Why: research/google-core.md tagged HEU-06 (decorative images with empty alt) heuristic because this page was never fetched.

## Verbatim excerpt

The reader view of this page dropped the Overview box, so the text between the rule lines was taken from the raw HTML of the same URL (read with `:raw`): tags stripped, entities decoded, blank lines removed, one line per HTML block. The words are unchanged.

---

Overview
Decorative images don’t add information to the content of a page. For example, the information provided by the image might already be given using adjacent text, or the image might be included to make the website more visually attractive.
In these cases, a null (empty) alt text should be provided (alt="") so that they can be ignored by assistive technologies, such as screen readers. Text values for these types of images would add audible clutter to screen reader output or could distract users if the topic is different from that in adjacent text. Leaving out the alt attribute is also not an option because when it is not provided, some screen readers will announce the file name of the image instead.
Whether to treat an image as decorative or informative is a judgment that only the author can make, based on the reason for including the image on the page. Images may be decorative when they are:
Visual styling such as borders, spacers, and corners;
Supplementary to link text to improve its appearance or increase the clickable area;
Illustrative of adjacent text but not contributing information (“eye-candy”);
Identified and described by surrounding text.
The examples below show how to use the alt attribute when decorative images are provided using the <img> element. Where possible, decorative images should be provided using CSS background images instead.

---
