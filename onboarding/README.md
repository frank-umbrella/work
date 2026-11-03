# Onboarding

The client onboarding system for Umbrella Automation's managed service
clients. A client's manager signs in and submits a New Hire, Rehire,
Termination or Position Change request; the MSP team works it from one queue,
talks back and forth on the request, and for new hires sends the welcome email
with the new account details when the work is done.

Single page, no build step: `index.html` holds the markup, the styles and the
script. Firebase is loaded as ES modules from Google's CDN. The page is
`noindex` and is linked from the staff hub (`../bench.html`), not the client
page.

## Roles

There are two kinds of people in the app, and they never see each other's
screens.

- **Client Manager.** Someone at a client company, invited by the MSP. They
  see **New Request** and **My Requests**, and only for their own company:
  they cannot list other clients or even learn that other clients exist. They
  can cancel their own request while it is still Submitted.
- **MSP Admin.** An Umbrella employee. They see **Queue** (every client's
  requests in one list), **Clients** (companies, logos, per-client forms and
  welcome templates), **Invitations** and **MSP Team**.

Each client's request forms are JSON schemas stored per client, so two
clients can ask different questions. `seeds/` holds the schemas used to set up
real clients; the schema editor's starter templates are generic.

## Sign-in

- **MSP team:** Google sign-in, restricted to `@umbrellaautomation.com`. An
  account from any other domain is signed straight back out. The very first
  admin is added by hand in the Firebase console (the no-access screen shows
  the UID to use); after that, admins add each other from the MSP Team tab.
- **Client Managers:** email and password. An admin creates an invitation,
  which produces a single-use link and a pre-written email to paste into a
  draft. The manager opens the link, confirms their details and sets a
  password. There is no self sign-up.

## Where the rules live

**`firestore.rules` in this folder is the deployed ruleset for the whole
`onboarding-a563d` project.** The Incident Response app (`../incidents/`)
shares the project, and Firebase allows one rules file per project, so its
rules are merged into this file. `../incidents/firestore.rules` is a
read-only excerpt for reviewers and is never deployed on its own.
`storage.rules` here is likewise the project's storage ruleset. Deploy both
with this folder's `firebase.json`.

## Email

Welcome emails go out through the Firebase **Trigger Email** extension with
Resend as the mail transport. The app writes one document to `/mail`; the
extension sends it and records the result on the same document.

Until `umbrellaautomation.com` is verified in Resend, the default sender is
Resend's sandbox address (`onboarding@resend.dev`). In that mode Resend only
delivers to the address that owns the Resend account, which is why the
completion screen lets you uncheck recipients. Once the domain is verified,
change `fromEmail` in `DEFAULT_COMPLETION_TEMPLATE` back to an
`@umbrellaautomation.com` address. A per-client template can also set its own
sender; it must be on a verified domain or delivery fails.

## Demo mode

Two URLs open the app on built-in sample data with no sign-in. Every write is
stubbed out, so nothing a visitor does reaches Firestore.

- Client Manager view: `?preview=mgr-7Q9k2-jem`
- MSP Admin view: `?preview=adm-8R3n4-msp`

Admins can copy both links from the **Sales demos** panel at the bottom of the
MSP Team tab. The sample companies and addresses use `example.com` domains on
purpose, so no real client shows up in a sales demo.

## Development

Serve the `work` folder with any static server, for example
`python -m http.server 8096 --bind 127.0.0.1` from `work/`, and open
`/onboarding/` with one of the demo parameters above. The real app needs a
signed-in account on the live Firebase project.

## Changelog

### v0.8.1 - 2026-11-03

The welcome email and the text around the app now read like a person wrote
them. The email opens by saying what it contains, its headings say what is
under them, and the closing line says who sent it and where a reply goes.
Filled-in first-day or HR details no longer leave template markers in the
welcome email. The invitation email for client managers drops the filler and
keeps the link, who it is for, and what to do if it fails. Small labels across
the app (sign-in, form sections, request details, the welcome email screen)
were in spaced-out capitals; they now use normal sentence case and stand out
by weight and color instead. Capitals stay where they help scanning: status
tags and table column headings. Code comments were cut down to the few that
explain something the code cannot say on its own.

### v0.8.0 - 2026-11-03

The queue keeps growing, and scanning it means putting the right requests at
the top and dropping the columns you never read. Click any column heading in
My Requests, Queue, Invitations or MSP Team to sort by it; click again to
reverse, and a third time to go back to the usual order. My Requests and Queue
also get a Columns button for hiding columns you don't need, with Reset layout
to undo it all. On a phone, where the headings are hidden, a Sort by menu sits
above the cards. Your sort and columns are remembered in this browser, so the
table looks the same next time you open it. Smaller fixes: the Forms button and
welcome template editor now work in the admin demo and every remaining write
in the demo is stubbed (including Remove admin and Delete invitation), the
invite form makes you pick a client instead of quietly picking the first, the
top bar no longer wraps on tablet widths (the client name moves into the small
subtitle there), the sign-in card keeps a margin on phones, and Tab stays
inside an open dialog.

### v0.7.0 - 2026-11-03

An accessibility and phone pass. Everything now works from the keyboard:
request rows open with Enter or Space, Escape closes the top dialog and puts
you back where you were, and every focused control shows a clear ring. Grey
help text, input borders and the warning and success colors were darkened to
meet contrast standards. On a phone the request tables turn into cards, the
tabs get their own full-width row, and buttons are large enough to tap. The
demo banner no longer overlaps the top bar, its link goes to a page that
exists, and the demo uses invented companies instead of real client names.
Required dropdowns that are still unset get an amber outline. The app can be
added to a home screen.

### v0.6.0 - 2026-08-25

Every request form gained an optional "Related ticket #" field, so a manager
can tie an onboarding request to a help desk ticket that was already open.
Admins get a one-click link into Spiceworks; managers, who have no Spiceworks
access, see the number as plain text.

### v0.5.5 - 2026-05-06

The tabs used to look like one highlighted button beside plain text. They now
read as tabs of equal weight, with an underline on the current one.

### v0.5.4 - 2026-05-06

A demo new hire shared a name with a real test submission, which looked like
real data leaking into the demo. The demo name was changed.

### v0.5.3 - 2026-05-06

The demo banner sat on top of the top bar. It now comes first on the page so
both stay visible.

### v0.5.2 - 2026-05-03

A manager's "Cancel this request" button moved down beside Close, where a
destructive action belongs, instead of floating in the middle of the request.

### v0.5.1 - 2026-05-03

A client's logo now fills the height of the top bar without a frame, and the
company name only shows when there is no logo or it fails to load.

### v0.5.0 - 2026-05-03

Demo mode, so prospects can click around a working copy with sample data and
nothing saved. Admins get a Sales demos panel with both links.

### v0.4.0 - 2026-05-03

Each client can have its own welcome email: sender, subject, body and the
fields the admin fills in. Clients without one use the default.

### v0.3.0 - 2026-05-03

Admins can upload a logo per client, shown to that client's managers in the
top bar, so the tool feels like part of their own company.

### v0.2.4 - 2026-05-03

Three fixes from real use. Welcome email recipients became checkboxes, which
the Resend sandbox needs. A form pasted with its wrapper JSON now still
renders. Managers can cancel a request they submitted by mistake.

### v0.2.3 - 2026-05-03

Typing in the completion form no longer loses focus after one letter, and
dialogs that hold a lot of typing no longer close on a stray click outside
them.

### v0.2.2 - 2026-05-03

Welcome emails send from Resend's sandbox address until the company domain is
verified, so the flow could be tested end to end.

### v0.2.1 - 2026-05-03

Requests show the specific kind the manager picked (New Hire or Rehire)
rather than the form's combined name, and date fields refuse five-digit
years.

### v0.2.0 - 2026-05-02

Complete and send welcome: when a new hire's accounts are ready, the admin
fills in the details once and the app emails the new hire, their manager and
the client manager who asked, with a preview before sending.

### v0.1.8 - 2026-05-01

When the database needs a new index, admins get a link that creates it in one
click instead of a wall of error text.

### v0.1.7 - 2026-05-01

Managers land on My Requests, so the first thing they see is the work
already in progress.

### v0.1.6 - 2026-05-01

Refreshing the page no longer flashes the sign-in screen while the app checks
who you are, and the admin queue stopped needing a special database index.

### v0.1.5 - 2026-05-01

Error messages became plain language for managers while admins keep the
detail they need to fix things. Admin profiles fill in their name from Google
on first sign-in.

### v0.1.4 - 2026-05-01

Creating an invitation also produces a ready-to-send email with the link in
it, so admins paste instead of writing one each time.

### v0.1.3 - 2026-05-01

The New Client form's placeholders looked like filled-in values. They now
read as obvious examples.

### v0.1.2 - 2026-05-01

"Manager" became "Client Manager" everywhere a person reads it, so the role
cannot be confused with an MSP admin or a new hire's own manager.

### v0.1.1 - 2026-05-01

The MSP team signs in with their Google work accounts instead of a separate
password.

### v0.1.0 - 2026-05-01

First release. Invite-only client managers submit onboarding requests on
per-client forms, and the MSP team works them from a shared queue with
statuses and comments. Each client's data is walled off from every other
client.
