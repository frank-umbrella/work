# canned

Canned replies for the Work hub - the client-facing responses that come up on
nearly every ticket, written to be sent as-is. Open `index.html`, click **Copy**
on the reply you need, paste it into the email or ticket, tweak the greeting,
and send. This folder is the home for all of them; add new replies to the page
so everyone sends the same, consistent wording.

## Index

| Reply                        | Send when...                                                        |
| ---------------------------- | ------------------------------------------------------------------- |
| Gmail - email header         | A client needs to pull the full message header from a Gmail email   |
| Locate PC name               | You need a client's computer name (Windows 10, Windows 11, or Mac)  |
| Local admin setup            | A client must create a local admin account before remote takeover   |
| 365 delegate access          | A client needs to open a delegated mailbox in Outlook on the Web    |
| Enable Google 2FA            | A Google account is missing mandatory 2-Step Verification           |

## Notes

- Each reply lives in a light `pre.reply` block; the Copy button copies exactly
  what's shown, so what the tech sends matches what's on screen.
- **Source** links under a reply are for the tech's reference only - they are
  not included when the reply is copied.
- Multi-platform replies (Locate PC name) are split into one copyable block per
  platform so you only send the one that applies.

## Adding a reply

1. Copy a `<section class="panel">` block in `index.html` and edit the tag,
   title, `.purpose`, and the `pre.reply` body.
2. Give the section a unique `id` and add a matching `<li>` to `nav.toc`.
3. The Copy button and scrollspy are wired up automatically - no JS changes
   needed.
4. Bump `<meta name="version">` and the footer version.
