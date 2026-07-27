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
| **M1** | Ticket core: sequential IDs, create/edit/close, orgs + contacts, auto history | **0.2.0** ← current |
| M2 | Comment thread (public/private), attachments, CC, mute | 0.3.0 |
| M3 | Board power: sort, columns manager, filters, saved views, search, bulk update | 0.4.0 |
| M4 | Labor/time tracking + CSV export, tasks, devices | 0.5.0 |
| M5 | Admin-configurable custom attributes | 0.6.0 |
| M6 | Outbound email (Resend) | 0.7.0 |
| M7 | Spiceworks CSV import (tickets + labor) + real migration | 1.0.0 (parity) |
| M8 | Client portal | 1.1.0 |
| M9 | Inbound email-to-ticket (Cloudflare Email Routing → tickets-worker) | 1.2.0 |

See [PLAN.md](PLAN.md) for the full design.

## Changelog

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
