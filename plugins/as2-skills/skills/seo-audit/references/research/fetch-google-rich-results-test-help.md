# Fetch note: Google Search Console Help, "Rich Results Test" (comment support; syntax errors in items of unknown type)

- URL read: https://support.google.com/webmasters/answer/7445569 (read tool)
- Fetch date: 2026-10-12
- Fetched by: hand sl-seo-rules, workload wl-mv5jz4vewt8mbk
- Why: research/structured-data.md cites this page as [S25] but recorded its syntax-error list only as a summary, so SD-JLD-01 and SD-JLD-03 had no verbatim quote. The excerpts below are the passages those rows now quote.

## Verbatim excerpt

The text between the rule lines is two excerpts of the reader output for the page, separated by `[...]`; each excerpt is unchanged.

---

**Comment support in code blocks**

The Rich Results test tool ignores comments within JSON-LD blocks. However, that behavior is not supported by the JSON-LD standard and so might result in errors in actual usage. Be sure to remove any comments from JSON-LD before publishing your final page.

[...]

Syntax errors in items of unknown type

Certain errors can halt the parser before it can even determine the rich result type. If you have such an error, you will get a section labeled "Syntax errors in items of unknown type". Here are the errors that can cause this condition:

| Error type                                                  | Description                                                                                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid JSON document                                       | The JSON had a top-level syntax error.                                                                                                                                                                   |
| Incorrect value type                                        | The value specified for a field was of the wrong type. For example, you specified a string when a number or array was expected. See the [structured data documentation](https://developers.google.com/search/docs/guides/search-gallery) to learn the required value type for that specific field. |
| Parsing error: Missing ':'                                  | Missing a ':' mark between a field and value.                                                                                                                                                            |
| Parsing error: Missing ',' or '}'                           | Missing a comma or closing brace.                                                                                                                                                                        |
| Parsing error: Missing '}' or object member name            | Missing a closing brace or object member name.                                                                                                                                                           |
| Parsing error: Missing ',' or ']' in array declaration      | Error parsing an array value: missing a comma or closing bracket in an array declaration.                                                                                                                |
| Unable to parse token length                                | For some reason the start and end of a property or value could not be found.                                                                                                                             |
| Invalid number                                              | Property value expected to be a number, but another value type was used.                                                                                                                                 |
| Empty escape sequence in string                             | A string value include an empty escape sequence character: for example: `"description" : "Call me \ John"` rather than `"description" : "Call me \"John\"".`                                             |
| Bad escape sequence in string                               | An invalid escape sequence used in a string value. For example: "description" : "Some \q unknown sequence"                                                                                               |
| Truncated Unicode character                                 | Missing the last 6 characters in a Unicode surrogate pair.                                                                                                                                               |
| Invalid Unicode character                                   | Missing a \u token at the start of the second half of a Unicode surrogate pair.                                                                                                                          |
| Invalid Unicode escape sequence: four digits expected       | A Unicode escape sequence has a syntax error: it should contain four digits.                                                                                                                             |
| Invalid Unicode escape sequence: hexadecimal digit expected | A Unicode escape sequence has a syntax error: a hexadecimal digit was expected but not provided.                                                                                                         |
| Duplicate unique property                                   | You provided two definitions for a unique property in your structured data object. For example, two `@context` values.                                                                                   |
| Invalid top level element                                   | A top-level item in your JSON-LD is invalid.                                                                                                                                                             |
| Reference to nonexistent item                               | An `itemref` attribute points to a non-existent identifier.                                                                                                                                              |

---
