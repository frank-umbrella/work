# Sundial anti-slop audit 001: follow-up

Date: 2026-11-09 (pairs with `audit-001-2026-11-06.md`)
Shipped in: v0.10.0, committed, not pushed.
Mode: DURING (global preference). Every HIGH finding fixed; MEDIUM 10 fixed
in its safe half; MEDIUM 11 is the release's feature work. LOW 12 and the
compromises below are for the owner.

## Fixed, finding by finding

| # | Finding | Before | After |
|---|---|---|---|
| 1 | Amber text (R-25) | `--glow` #e0a300 as text: 2.23 card, 2.02 card2, 2.00 paused pill | new `--warnink` #8a5d00 for text only: 5.76 card, 5.22 card2, 5.16 paused pill. Dark keeps #e6b13a (8.27). Fills, borders and the demo bar keep `--glow` |
| 2 | Accent text on grey (R-25) | #1e6fd9: 4.48 bg, 4.40 card2, 4.07 chip | #1b67cc (same hue, one step darker): 5.03 bg, 4.93 card2, 4.57 chip; white on the blue buttons 4.85 to 5.44. `--go` follows. Dark accent untouched |
| 3 | Red text on grey and tints (R-25) | light 4.17 card2, 3.89 hard-limit chip; dark 4.27 card2, 3.90 hard-limit chip | new `--stopink`: light #b8322d 5.39 / 5.03, dark #f08a84 5.99 / 5.46. Used by `.err`, `.prob`, `.mk.off`, the hard-limit chip |
| 4 | Dark Stop button (R-25) | white on #e0655e 3.39 | new `--onstop`: #0b1420 in dark, 5.46; light stays white, 4.60 |
| 5 | Hover glyphs on play/pause (non-text) | 2.23 / 1.96 / 2.00 | new `--onsignal` ink: 7.12 light amber, 4.58 light green, 9.44 dark amber, 9.27 dark green |
| 6 | Calendar block text (R-25) | white on green 3.47, amber 2.86, teal 3.18, rose 4.31 | `inkOn()` picks white or black per block by ratio: black 6.05, 7.34, 6.61, 4.87. Blue, red, purple, slate stay white (4.85 to 5.48) |
| 7 | Tap targets (R-03) | 22 to 31px, see audit table | `@media (pointer: coarse)`: `.btn.sm`, every `.seg` button, chips and checkbox rows 44px tall; AM/PM 44x44; text links get a 44px hit area from padding cancelled by negative margin (line height unchanged); round icon buttons 36px with a transparent ring to 44px, 8px apart; modal X and swatches 44px. Mouse layouts unchanged |
| 8 | Loading and error states (R-27) | "Nothing logged" during a load; a 2.8s toast on failure | `state.entriesLoaded` / `state.loadError` and `dataEmpty()`: Today table, Day list, Week grid, Clients and both Reports tables say "Loading your entries..." until data arrives, and "Your entries could not load: <reason>. Reload the page to try again..." after a store error. The error also repaints, so it stays on screen after the toast goes |
| 9 | Header under the iPhone status bar (R-03) | no top inset; no side insets; toast at 14px | `.top` pads `env(safe-area-inset-top)` plus side insets (both the base and the 640px rule); `main`, footer and tab bar pad the side insets; the toast sits at `14px + inset-top`; modals and the sign-in wall pad top and bottom insets. All insets are 0 in a browser tab |
| 10 | Endless blink, no reduced motion (R-19) | blink always on | `prefers-reduced-motion: reduce` stops both blinks and the Edit details and toast transitions. The blink itself is left for the owner |
| 11 | No install path (C-2) | none | Settings "Add to home screen" card and the sign-in nudge (below) |

Found and fixed during verification, not in the audit: at exactly 800px the
header wrapped Sign out onto a second line (97px tall). The cause was the
version chip: "v0.10.0" is two characters wider than "v0.9.6", 3.7px too
many. The chip now hides at 900px and below, as it already did under 640px;
the footer still shows the version. Header back to 55px at 800 and 905.

Also caught in verification: on touch, the Now / Last stop / Clear links lost
their negative top margin to a more specific existing rule, which would have
grown the label line by 13px. A matching rule restores it.

## New contrast table (after)

| Pair | Light | Dark |
|---|---|---|
| text on bg / card / card2 / chip | 14.69 / 15.90 / 14.42 / 13.36 | 15.27 / 13.52 / 12.10 / 9.70 |
| muted on bg / card / card2 | 5.38 / 5.83 / 5.28 | 6.97 / 6.17 / 5.52 |
| accent on bg / card / card2 / chip / bg2 | 5.03 / 5.44 / 4.93 / 4.57 / 4.63 | 6.90 / 6.11 / 5.47 / n/a / 6.46 |
| chiptext on chip | 6.67 | 7.97 |
| warnink on bg / card / card2 / chip | 5.32 / 5.76 / 5.22 / 4.84 | 9.33 / 8.27 / 7.39 / 5.93 |
| warnink in paused pill / warning box | 5.16 / 5.21 | 6.47 |
| stopink on bg / card / card2 / chip | 5.49 / 5.95 / 5.39 / 5.00 | 7.56 / 6.69 / 5.99 / 4.80 |
| stopink in hard-limit chip | 5.03 | 5.46 |
| topbar text / muted | 15.90 / 5.83 | 14.59 / 6.66 |
| blue buttons (onaccent on accent / go) | 5.44 / 5.44 | 6.98 / 5.02 |
| Stop button (onstop on stop) | 4.60 | 5.46 |
| demo bar | 7.12 | 8.11 |
| sign-in nudge text / links (on card2) | 14.42 / 4.93 | 12.10 / 5.47 |

Every pairing that carries text now clears 4.5:1; every icon-only pairing
clears 3:1.

## The feature (v0.10.0)

- Settings card "Add to home screen" between You and Tracking (so after
  You and before Google Calendar). Reason line, then one of three branches:
  standalone ("Already installed: you are running Sundial from the home
  screen."), an Install Sundial button when `beforeinstallprompt` has been
  captured (module-level `a2hsPrompt`, listener registered before the
  Firebase await), or written steps for the detected platform with the other
  two under an "Other devices" details element. `appinstalled` clears the
  prompt, hides the nudge and toasts.
- Sign-in nudge directly under the Sign in button, shown only from
  `stopApp()` (Firebase has said nobody is signed in, so a device with a
  session never sees it, even while the SDK loads), never in standalone,
  never without `(pointer: coarse)` or a mobile UA, at most once per device
  (`sundial-a2hs-nudge` = `shown` on display, `dismissed` on Not now or
  install). How opens the shared steps in the house modal (X, Close, Escape;
  backdrop inert).
- New ids, grepped first, none existed: `a2hsCard`, `a2hsBody`,
  `a2hsInstall`, `a2hsNudge`, `a2hsHow`, `a2hsNot`.
- `apple-mobile-web-app-capable` is not in the head, so no
  `apple-mobile-web-app-status-bar-style` meta was added, per the brief. The
  manifest already declares `display: standalone`; nothing duplicated.

## Click-through (R-35)

Run in the Browser pane against `work-site` (port 8742), service worker
unregistered and caches cleared before each pass. Demo passes:
`/sundial/?demo=1&b=<random>`; sign-in wall passes: `/sundial/?b=<random>`.

- Title reads "Sundial v0.10.0"; footer "Sundial v0.10.0".
- Settings: card sits after You, before Tracking. Non-standalone branch
  rendered the Computer steps first (desktop UA), no Install button. PASS.
- Synthetic `beforeinstallprompt` with stubbed `prompt()` and
  `userChoice: accepted`: event `defaultPrevented` true, "Install Sundial"
  button appeared with its tooltip; click called `prompt()` once, toast
  "Sundial installed.", button removed (prompt spent). Second synthetic event
  with `dismissed`: toast "Install dismissed. The steps below still work."
  PASS.
- "Other devices" summary click: details opened, showing iPhone or iPad and
  Android phone or tablet. PASS.
- Standalone branch: cannot be forced in the pane (`display-mode` is not
  emulatable); verified by code: `paintA2hs()` returns the one-line message
  before anything else when `a2hsStandalone()` is true, and
  `maybeShowA2hsNudge()` returns early on the same check. Verified by code,
  not live.
- Sign-in wall, mobile preset (375x812, Pixel UA, coarse pointer): after
  Firebase resolved with no user, nudge shown directly under the Sign in
  button, `localStorage` = `shown`. How (real click) opened "Add Sundial to
  your home screen" with Android steps first. Backdrop mousedown and click:
  modal stayed (1). Escape: closed (0). How again then X: closed. How again
  then Close: closed. Not now: nudge hidden, `localStorage` = `dismissed`.
  Reload: nudge stays hidden. PASS.
- Desktop pointer (1024 and 1280, key cleared): nudge stays hidden. PASS.
- 360px with a coarse pointer and the key cleared: nudge shown, How hit area
  44x46. PASS.
- No horizontal overflow (`scrollWidth <= innerWidth`) at 360, 800 and 1280,
  light and dark: Clock, Timesheet Day / Week / Calendar, Clients, Export,
  Reports, Search, Settings, and the sign-in wall. PASS.
- Header height 63px at 360 (one line), 55px at 800, 905 and 1280. PASS.
- Touch sizes measured at 360 coarse: `.btn.sm` 70x44, chip 270x44, row
  icon buttons 36x36 plus a 4px ring (44), theme and search 36 plus ring,
  tab bar 59x46, AM/PM min 44x44 and morebtn min-width 44 / padding 13px 8px
  (computed style; the idle form is hidden while the demo timer runs).
- Calendar: amber client block rendered black ink, blue and red white.
- Dark Stop button label computed #0b1420; light `--warnink` #8a5d00.
- Console: no errors in the demo pass or the sign-in wall pass.
- Loading and error empty states: the demo store delivers entries
  synchronously, so "Loading your entries..." never appears there; verified
  by code (`dataEmpty()` and the `entries` / `error` handlers), not live.

Viewport reset to desktop and the server stopped afterwards.

## Delivery Gate

### Block 1: Hard Gate

- R-02 PASS: 0 em or en dashes in `index.html`, `roadmap.html`, `README.md`
  and both audit files (grep). New copy uses commas, colons, periods.
- R-03 PASS: no overflow at 360 / 800 / 1280 in both themes on every view;
  44px touch targets added; safe-area insets on header, main, footer, tab
  bar, toast, modals, sign-in wall. Compromise: day strip and skyline bars are
  40 / 38px wide at 360 (44+ from 390), recorded for the owner.
- R-17 PASS: no numbers without a source; demo data labelled fictional.
- R-18 PASS: no testimonials.
- R-23 PASS: no new assets; the install steps describe the browser's real UI
  in words, no screenshots or drawn mock UI.
- R-24 PASS: no new navigation; "Other devices" opens content that exists.
- R-25 PASS: every text pairing 4.5:1 or better, icons 3:1 or better, both
  themes (table above).
- R-26 PASS: Install calls the real prompt; How opens a modal that closes by
  X, Close, Escape; Not now hides and records; the details toggles.
- R-27 PASS: empty, loading and error states on Today, Day, Week, Clients and
  Reports; Search already had loading and empty.
- R-28 PASS: no FAQ.
- R-32 PASS: no `outline: none`; new controls are real buttons and a native
  `summary` with a focus-visible ring; Escape closes the modal.
- R-33 PASS: written in source. The release edits were applied with
  exact-match string replacements on `index.html` by the agent during the
  build, the same as hand edits; no patch script is left in the repo or
  runs at build or load time.
- R-34 PASS: light and dark checked for overflow and contrast; dark Stop
  label fixed.
- R-35 PASS: click-through above. Two branches verified by code only (the
  standalone message, the loading and error states), stated as such.
- R-36 PASS: no claims. The iPhone notification line is how Safari works
  (web notifications only from a home-screen app).
- R-37 PASS: direction is design C "Ledger" as built; Design Read declared.
- R-38 PASS: nothing fabricated.

### Block 2: Purpose-Gate

- R-01 PASS: no gradients added.
- R-04 PASS: no icons added; the card is text.
- R-06 PASS: no type changes.
- R-07, R-08, R-10, R-13, R-22 PASS: none used.
- R-09 PASS: no badges added.
- R-12 PASS: no new shadows.
- R-14 PASS: the card follows the other Settings cards, as RHYTHM 1 says.
- R-19 PASS with an owner question: no new motion; reduced motion now stops
  the existing blinks. Whether the running dot blinks at all is for the owner.

### Block 3: Liveliness

- Dials declared: ENERGY 1 / RHYTHM 1 / MOTION 1. PASS.
- Consistent with the dials: the new card and nudge are plain ledger blocks,
  no motion. PASS.
- Focal point per screen unchanged (the Clock's Now card); the nudge is a
  quiet secondary line under the Sign in button. PASS.
- Whitespace structural: the nudge uses the draft-offer spacing. PASS.
- One accent: blue only, for the How / Not now links and the Install button.
  PASS.
- Identity motif kept: monospace numbers and dated ledger rows untouched.
  PASS.
- Design Read declared before building. PASS.

### Block 4: Craftsmanship and Quality Locks

- C-1 PASS: every token change has its ratio written above.
- C-2 PASS: no dead controls.
- C-3 PASS: the card exists because installs were undiscoverable.
- C-4 PASS: both themes, three widths, touch and keyboard checked.
- C-5 PASS: no claims.
- R-05, R-11, R-20, R-21, R-29, R-30 PASS: layout, radii, palette and themes
  unchanged apart from the darker accent step and the two text inks.
- R-15 PASS: "Install Sundial", "How", "Not now", "Close" name their action.
- R-16 PASS: no buzzwords.
- R-31 PASS: reasons are in the CSS comments and this file.

Gate: PASS, with the owner questions below open.

## Still open (owner)

- Day strip and skyline bars at 360px: 40 / 38px wide. Accept, or redesign
  for 360px phones?
- Settings job type `.mk` markers: about 16px tall. Keep, or rebuild as
  toggles?
- Running-dot blink: keep (now off under reduced motion), or hold it still?
- Spaced hyphens as dashes in older copy (finding 12): keep as house voice,
  or convert over time?
- iPhone home-screen sign-in uses `signInWithPopup`; the steps warn that the
  first sign-in may open in Safari. Move to redirect sign-in?
- Not verified on a real iPhone: the safe-area insets and the iOS steps are
  computed and read correctly, but `env(safe-area-inset-*)` is 0 in the
  pane. Needs one check from the home screen on an iPhone.
