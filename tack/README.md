# Tack - sticky notes on any site

A Tampermonkey userscript that puts Post-it style notes on top of any website.
Notes are draggable, resizable and collapsible, come in six colors and six
skins, and stick to the current page, the current site, or everywhere. They
are saved in the browser (Tampermonkey storage, shared across tabs) and can
optionally back up to the user's own Google Drive.

Live: https://frank-umbrella.github.io/work/tack/ (unlinked from the hub, noindex)
Install: https://frank-umbrella.github.io/work/tack/tack.user.js

## Files

- `tack.user.js` - the userscript. Single file, no dependencies.
- `index.html` - install page with the Google Drive one-time setup steps.
- `auth.html` - OAuth redirect target. The userscript also runs on this page,
  reads the token from the URL hash, stores it, and closes the popup.
- `design-preview.html` - click-through switcher showing the six skins on a
  fake host page (light and dark). Open locally, no server needed.
- `favicon.svg`

## How it is built

- All notes live in one Tampermonkey value, `tack.notes`. Settings in `tack.cfg`.
  Deletions are recorded in `tack.tombstones` so Drive sync never resurrects
  a note.
- The UI is a Shadow DOM inside a `<tack-notes>` element that is shown with
  the popover API (browser top layer), so it sits above host overlays with
  huge z-indexes. Styles are a constructed stylesheet, which host CSP cannot
  block. Keystrokes inside notes are stopped so host shortcuts do not fire.
- Google Drive uses the OAuth implicit flow with the `drive.file` scope. The
  only file it can see is the one it creates, `tack-notes.json`. Merge rule:
  newest change wins per note. Tokens last about an hour; the user reconnects
  from the launcher menu.
- The OAuth client ID is entered by the user in Settings. It belongs to a
  Google Cloud project in the work account and is a public identifier.

## Testing locally

There is no build step. To try the script without Tampermonkey, load it in a
page that defines `GM_getValue`, `GM_setValue`, `GM_addValueChangeListener`,
`GM_registerMenuCommand` and `GM_xmlhttpRequest` shims (localStorage-backed
is enough) and includes `tack.user.js` with a script tag.

## Changelog

### 0.1.0 - 2026-09-22

First release. Notes with drag, resize, collapse, six colors, three pin
scopes, six skins picked in Settings, launcher button with right-click menu,
Alt+N shortcut, hide-per-site, JSON export and import, and optional Google
Drive backup with auto-sync. Built because OneNote Stickies live in their own
window; these live on the page you are actually working on.
