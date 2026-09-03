# Phase 10 — Layout and interaction pass

Read `docs/prompts/_CONVENTIONS.md` first.
**Model:** Sonnet 5, medium effort. **Expect ~40k tokens.**

## Why

The terracotta design system in `style.css` is genuinely good and stays. What is
missing is **POS ergonomics**: this is a screen used by a tired person, one-handed,
at speed, on a greasy 10" tablet, under a fan, in a hurry. Audit #32–35.

Keep the palette, the type scale, the radii, the shadows. Change the layout and the
interactions.

## Files

Read: `public/style.css`, `public/index.html`, `public/js/pos.js`,
`public/js/kitchen.js`, `public/customer/*`. Create: `public/js/i18n.js`.

## Do

**1. Non-negotiable ergonomics.**
- **Minimum touch target 44×44 px**, 56 px for anything on the main order path.
  Today's quantity buttons are 30 px — too small for a thumb in a hurry.
- **No hover-dependent affordance.** Everything reachable by hover must be visible
  without it; a tablet has no hover. Keep the hover polish, do not rely on it.
- **Every control keeps an explicit `color`** (see `_CONVENTIONS.md`).
- Disable double-tap-to-zoom on controls (`touch-action: manipulation`).
- Destructive actions (void, cancel, comp) are never adjacent to a common action.
  Put a gap and a colour change between "Send" and anything destructive.

**2. Order screen.** Three panes on a tablet in landscape: tables/categories left,
items centre, running bill right. The bill is **always visible** — never behind a
tab — with a persistent total and a large primary "Send". Search/filter items by
name for a 200-item menu (a mamak menu is long; scrolling is not a strategy).
Show a per-item recent/favourites row: the top 8 items by today's sales cover most
orders and turn 3 taps into 1.

**3. Table grid.** Fix the inverted colours (#33). Semantics, stated once:
grey = free · amber = order open, food not yet served · green = served, awaiting
payment · red outline = open more than 30 minutes without progress. Show per table:
name, elapsed time, item count, running total. A waiter should be able to read the
floor in one glance from two metres away.

**4. Kitchen display.** Optimise for a wall screen read at 2+ metres: order cards in
columns by status, item lines at ≥20 px, **qty first and bold**, modifiers and notes
clearly subordinate but legible, and a colour-shifting age badge (green <5 min,
amber 5–10, red >10). VOID tickets flash once and sit at the top. Single tap
advances status with an **undo** window of 5 seconds (phase 03 added backward
transitions — surface them here as undo, not as a status menu). No tiny buttons.

**5. Customer QR page.** It is a stranger's first and only encounter with this
software: keep it obvious. Sticky category bar, big prices, an always-visible cart
bar, clear modifier requirements ("Choose 1 kuah"), and after ordering show a
**live status** ("Preparing… / Ready") via the phase 06 stream rather than a dead
success screen. Add an "add more items" path that appends to the same order.

**6. Bilingual (BM/EN).** `public/js/i18n.js` with a flat `{key: {en, ms}}` map,
a header toggle, and the choice persisted per device. Translate **UI chrome only** —
menu item names are entered by the restaurant and must render exactly as typed.
Never machine-translate a food name.

**7. Accessibility that matters here.** Contrast ≥4.5:1 in both themes (check the
dark-mode overrides — several current pairs are below it), focus-visible outlines
for keyboard use at the counter, `aria-live` on the toast so it is announced, and
labels on every input.

## Do not

Do not add a CSS framework. Do not replace the palette or fonts. Do not restructure
JS modules — that was phase 01.

## Verify

```bash
npx playwright test
```

Then: run the app at 1024×768 (a common cheap tablet) and at 390×844 (a phone, for
the customer page) and confirm no horizontal scrolling and no control under 44 px.
Take a screenshot of the kitchen display and read it from two metres away. Check
contrast in both light and dark mode.
