# WCAG 2.2 AA Checklist — React / TypeScript / CSS

Quick-reference of all WCAG 2.2 Level A and AA success criteria relevant to web app code audits. Organized by principle. Use this when the main SKILL.md audit categories need deeper context.

---

## Principle 1: Perceivable

| # | Criterion | Level | What to Check in Code |
|---|-----------|-------|----------------------|
| 1.1.1 | Non-text Content | A | `<img>` has `alt`, icon buttons have labels, SVGs have `<title>` or `aria-hidden` |
| 1.2.1 | Audio/Video-only (Prerecorded) | A | Transcripts or descriptions provided |
| 1.2.2 | Captions (Prerecorded) | A | `<track kind="captions">` on `<video>` |
| 1.2.3 | Audio Description or Media Alternative | A | Alt media for video content |
| 1.2.4 | Captions (Live) | AA | Live captions for streaming media |
| 1.2.5 | Audio Description (Prerecorded) | AA | Audio description track for video |
| 1.3.1 | Info and Relationships | A | Semantic HTML, proper heading hierarchy, `<label>`, `<fieldset>`, table headers |
| 1.3.2 | Meaningful Sequence | A | DOM order matches visual order |
| 1.3.3 | Sensory Characteristics | A | Instructions don't rely on shape, size, position, or sound alone |
| 1.3.4 | Orientation | AA | No CSS/JS locking to single orientation |
| 1.3.5 | Identify Input Purpose | AA | `autocomplete` on personal data inputs (name, email, address, etc.) |
| 1.4.1 | Use of Color | A | Color not sole indicator of meaning |
| 1.4.2 | Audio Control | A | Auto-playing audio can be paused/stopped |
| 1.4.3 | Contrast (Minimum) | AA | 4.5:1 normal text, 3:1 large text |
| 1.4.4 | Resize Text | AA | Text scales to 200% without content loss |
| 1.4.5 | Images of Text | AA | Real text not images, except logos |
| 1.4.10 | Reflow | AA | Content reflows at 320px width, no horizontal scroll |
| 1.4.11 | Non-text Contrast | AA | 3:1 for UI components and graphical objects |
| 1.4.12 | Text Spacing | AA | No content loss when overriding line-height (1.5×), letter-spacing (0.12em), word-spacing (0.16em), paragraph spacing (2×) |
| 1.4.13 | Content on Hover or Focus | AA | Hover/focus-triggered content is dismissable, hoverable, persistent |

## Principle 2: Operable

| # | Criterion | Level | What to Check in Code |
|---|-----------|-------|----------------------|
| 2.1.1 | Keyboard | A | All functionality available via keyboard |
| 2.1.2 | No Keyboard Trap | A | Focus can always move away from any component |
| 2.1.4 | Character Key Shortcuts | A | Single-char shortcuts can be remapped or disabled |
| 2.2.1 | Timing Adjustable | A | Time limits can be extended/disabled |
| 2.2.2 | Pause, Stop, Hide | A | Auto-moving/updating content can be controlled |
| 2.3.1 | Three Flashes or Below | A | Nothing flashes > 3 times/sec |
| 2.4.1 | Bypass Blocks | A | Skip nav or landmark regions |
| 2.4.2 | Page Titled | A | Descriptive `<title>` per page |
| 2.4.3 | Focus Order | A | Tab order matches visual/logical flow |
| 2.4.4 | Link Purpose (In Context) | A | Link text meaningful in context |
| 2.4.5 | Multiple Ways | AA | At least two ways to locate a page (nav, search, sitemap) |
| 2.4.6 | Headings and Labels | AA | Headings and labels are descriptive |
| 2.4.7 | Focus Visible | AA | Keyboard focus indicator visible |
| 2.4.11 | Focus Not Obscured (Minimum) | AA | Focused element not fully hidden behind sticky headers, modals, etc. |
| 2.5.1 | Pointer Gestures | A | Multi-point gestures have single-pointer alternatives |
| 2.5.2 | Pointer Cancellation | A | `mouseup`/`touchend` used, not `mousedown`/`touchstart` for activation |
| 2.5.3 | Label in Name | A | Visible label text included in accessible name |
| 2.5.4 | Motion Actuation | A | Shake/tilt features have button alternatives |
| 2.5.7 | Dragging Movements | AA | Drag interactions have click/tap alternatives |
| 2.5.8 | Target Size (Minimum) | AA | Interactive targets at least 24×24 CSS px (or have spacing/alternatives) |

## Principle 3: Understandable

| # | Criterion | Level | What to Check in Code |
|---|-----------|-------|----------------------|
| 3.1.1 | Language of Page | A | `<html lang="en">` (or correct language) |
| 3.1.2 | Language of Parts | AA | `lang` attr on elements in different languages |
| 3.2.1 | On Focus | A | No context change on focus alone |
| 3.2.2 | On Input | A | No unexpected context change on input |
| 3.2.3 | Consistent Navigation | AA | Navigation order consistent across pages |
| 3.2.4 | Consistent Identification | AA | Same function = same label across pages |
| 3.2.6 | Consistent Help | A | Help mechanisms in same relative location |
| 3.3.1 | Error Identification | A | Errors identified in text, not just color |
| 3.3.2 | Labels or Instructions | A | Labels/instructions provided for input |
| 3.3.3 | Error Suggestion | AA | Suggested corrections for errors |
| 3.3.4 | Error Prevention (Legal, Financial, Data) | AA | Confirm/review/undo for consequential actions |
| 3.3.7 | Redundant Entry | A | Don't re-ask info already provided in same process |
| 3.3.8 | Accessible Authentication (Minimum) | AA | No cognitive function test for auth (allow paste, password managers) |

## Principle 4: Robust

| # | Criterion | Level | What to Check in Code |
|---|-----------|-------|----------------------|
| 4.1.2 | Name, Role, Value | A | Custom components have accessible name, role, and state |
| 4.1.3 | Status Messages | AA | Dynamic messages use `role="status"` or `aria-live` |

---

## React-Specific Patterns

### Common Violations

| Pattern | Problem | Fix |
|---------|---------|-----|
| `<div onClick={...}>` | Not keyboard accessible, no role | Use `<button>` or add `role="button"` + `tabIndex={0}` + `onKeyDown` |
| `<a>` without `href` | Not a real link, not focusable | Use `<button>` if it triggers an action, add `href` if it navigates |
| `<img src={...} />` | Missing alt text | Add `alt="description"` or `alt=""` with `aria-hidden="true"` |
| `outline: none` in CSS | Removes focus indicator | Replace with custom `:focus-visible` styles |
| `{show && <Modal>}` | No focus management | Trap focus inside, return focus on close |
| `aria-label` mismatches visible text | Breaks voice control | `aria-label` must include visible text content |
| `onChange` without `onBlur` | Fails keyboard users on some screen readers | Include both event handlers |
| `autoFocus` prop | Disorients screen reader users | Avoid unless in a modal/dialog context |
| `tabIndex={5}` | Unpredictable tab order | Use `tabIndex={0}` or `tabIndex={-1}` only |
| `role="button"` on `<button>` | Redundant ARIA | Remove the role — native element already has it |
| Dynamic content update | Screen reader misses change | Add `aria-live="polite"` region |
| `placeholder` as label | Disappears on input, low contrast | Use visible `<label>` element |

### CSS Patterns to Flag

| Pattern | Risk | WCAG |
|---------|------|------|
| `outline: none` / `outline: 0` without replacement | No focus indicator | 2.4.7 |
| `display: none` on focus styles | Hidden focus | 2.4.7 |
| `user-select: none` on content | Blocks assistive tech copy | Best practice |
| Fixed/sticky elements without `z-index` consideration | May obscure focus | 2.4.11 |
| No `prefers-reduced-motion` query alongside animations | Motion sensitivity | 2.3.3 |
| Hardcoded small font sizes (`10px`, `11px`) | Fails at 200% zoom | 1.4.4 |
| `overflow: hidden` on containers | May clip reflowed content | 1.4.10 |
| `:hover` styles without `:focus-visible` equivalent | Keyboard users miss state | 2.4.7 |
| `height`/`max-height` on text containers | Clips on text spacing override | 1.4.12 |
