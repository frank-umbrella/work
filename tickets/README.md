# Umbrella Help Desk (`work/tickets`)

Internal IT help-desk / ticket system for Umbrella Automation — the in-house
replacement for the Spiceworks Cloud Help Desk. Single-file vanilla HTML/CSS/JS
SPA on Firebase, deployed to `https://frank-umbrella.github.io/work/tickets/`.

## Architecture

- **Frontend:** one `index.html` (no build step), Firebase v12 modular SDK from
  the gstatic CDN. Same stack as the sibling `onboarding` / `incidents` apps.
- **Backend:** Firebase project **`onboarding-a563d`** (shared, not a new
  project). Reuses that project's `/msp_admins` staff roster, its external-user
  invitation flow (for the future client portal), and its installed
  **Trigger Email → Resend** extension for outbound mail. Every collection this
  app owns is namespaced **`tix_*`** to avoid colliding with onboarding /
  incidents data in the same project.
- **Security rules:** because a Firebase project has a single ruleset, the
  `tix_*` rules live in **`work/onboarding/firestore.rules`** and are deployed
  from `work/onboarding/` (the same arrangement `backups` uses inside
  `work/watchtower/`). Do **not** add a `firestore.rules` here.

## Roles

- **Staff** — members of `/msp_admins/{uid}` (Umbrella employees, Google
  sign-in restricted to `umbrellaautomation.com`). Full access.
- **Manager** — a staff member with `tixManager: true` on their `/msp_admins`
  doc. Extra powers: delete tickets, edit settings / custom attributes, run
  imports, manage portal invitations. *(wiring lands with those features)*
- **Client portal user** — external client contact, scoped to one
  organization. *(milestone M8)*

## Milestones

| M | Ships | Version |
|---|---|---|
| M0 | Scaffold, standards, staff auth, empty board | 0.1.0 |
| M1 | Ticket core: sequential IDs, create/edit/close, orgs + contacts, auto history | 0.2.0 |
| **M2** | Comment thread (public/private), attachments, CC, mute | **0.3.0** ← current |
| M3 | Board power: sort, columns manager, filters, saved views, search, bulk update | 0.4.0 |
| M4 | Labor/time tracking + CSV export, tasks, devices | 0.5.0 |
| M5 | Admin-configurable custom attributes | 0.6.0 |
| M6 | Outbound email (Resend) | 0.7.0 |
| M7 | Spiceworks CSV import (tickets + labor) + real migration | 1.0.0 (parity) |
| M8 | Client portal | 1.1.0 |
| M9 | Inbound email-to-ticket (Cloudflare Email Routing → tickets-worker) | 1.2.0 |

See [PLAN.md](PLAN.md) for the full design.

## Changelog

### 0.3.1 — 2026-07-28
Fix: a cold load on `#/t/<num>` landed on the board instead of the ticket.
**Why:** sign-in called `backToList()` to reset the view, and that helper
clears the hash by design (correct when a user presses Back, wrong during
startup) — so the deep link was erased before the tickets snapshot arrived to
resolve it. Startup now resets the view without touching the hash.

### 0.3.0 — 2026-07-28
M2 — the comment thread. **Why:** a tracker you can't hold a conversation in
still leaves the actual back-and-forth in someone's inbox, which is the whole
problem with the status quo. This makes the ticket the record.

- **Public replies vs private notes.** The composer toggles between the two,
  and private notes are visually distinct (amber) so nobody posts an internal
  aside to a client by accident. Visibility is immutable after posting — an
  edit can never flip a private note into a public one.
- **All / Comments / History tabs**, matching Spiceworks, so you can read just
  the conversation or just the audit trail.
- **Attachments** (25 MB each) on comments, stored under `tix/<ticket>/<event>/`.
- **Pin** a comment to the top of the thread; **edit** your own (marked edited,
  original timestamp and author preserved).
- **CC list** and a per-user **mute** toggle — both wired for the M6
  notification emails, so muting already means something when mail turns on.
- **Deep links**: opening a ticket sets `#/t/<num>`, and that URL now restores
  the ticket on a cold load. Prerequisite for the notifier extension and for
  linking straight to a ticket from an email.

Adds an `activity` update clause (narrow: body/editedAt/attachments by the
author, `pinned` by any staff) and a Storage rule for the `tix/` path.

### 0.2.2 — 2026-07-28
Add a Computer / PC name field to the New Ticket form and the ticket detail
rail. **Why:** most tickets are about a specific machine, and the tech's first
question is always "which PC?" — capturing it at creation (like Spiceworks'
Computer Name attribute) saves a round-trip with the client. Stored as the
first custom attribute (`customAttrs.computerName`); edits are recorded in
History. The full admin-configurable custom-attributes system is still M5 —
this field just lands early because it's the one that matters daily.

### 0.2.1 — 2026-07-28
Fix: after signing in, the page appeared stuck on the sign-in card. **Why:**
the auth screens use the `hidden` attribute, but their `.center-screen` class
sets an explicit `display: grid`, which overrides `hidden` — so the "hidden"
sign-in screen kept rendering at full viewport height and pushed the real app
below the fold. Added a `[hidden] { display: none !important; }` guard so
`hidden` always wins. Sign-in itself was working the whole time.

### 0.2.0 — 2026-07-11
Ticket core. **Why:** turn the scaffold into a working tracker — the smallest
thing the team can actually run tickets in — before layering comments, labor,
and import on top. Ships: sequential ticket numbers (a transaction-guarded
`tix_counters/ticket`, starting at #5000 so app-created tickets never collide
with Spiceworks' ~1900s numbers at import time), New Ticket creation with
org/contact/assignee/priority/category, a board with status filters + search, a
ticket detail view with inline edit of status/priority/assignee/category/due, an
append-only History thread that records every change automatically, and
organization management (with contacts auto-created from ticket requesters).
Adds the first `tix_*` collections and their security rules (appended to
`../onboarding/firestore.rules`). Comments/replies are M2.

### 0.1.0 — 2026-07-11
Initial scaffold. **Why:** stand up the shell before any ticket logic so the
house standards (versioning, toast, persistent data-entry modals, responsive
no-h-scroll layout, tooltips) and the staff auth gate are proven end-to-end and
every later milestone builds on a known-good base rather than retrofitting.
Ships: the SPA shell with topbar/tabs, Google staff sign-in gated on
`/msp_admins`, an empty Tickets board with an empty-state, and placeholder tabs
for the milestones to come. No ticket data model yet — that's M1.
