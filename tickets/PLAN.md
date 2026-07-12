# Umbrella Help Desk — Implementation Plan

Modeled on Spiceworks Cloud Help Desk. Lives under the `frank-umbrella/work`
monorepo at `work/tickets`, deploys to `frank-umbrella.github.io/work/tickets/`.

## Confirmed product decisions
1. **v1 = full Spiceworks parity** (tickets, public/private comments, history,
   labor/time, related devices, tasks, bulk update, saved views, search, custom
   attributes, CSV import). Outbound notification email is in core.
2. **Inbound email-to-ticket = later phase (M9)** — an inbound mail pipeline
   (Cloudflare Email Routing → a Worker that parses messages, threads replies
   onto tickets by a `#N-token` in the subject, creates tickets from fresh
   senders). Schema carries the hooks from the start so M9 needs no rework.
3. **Access = internal MSP techs/managers AND a client portal.** Client
   contacts log in scoped to their Organization; see only Public comments.

## Firebase: join `onboarding-a563d`
Reuses the exact dual-principal model (staff `/msp_admins` + external-user
invitation flow), the installed Trigger Email → Resend extension, and Blaze
billing. Collections namespaced `tix_*`. Rules append to
`work/onboarding/firestore.rules` and `storage.rules`, deployed from
`work/onboarding/`.

## Data model (Firestore, `tix_*`, flat + `orgId`)
- `tix_orgs/{orgId}` — client organizations. `{name, active, emailDomains[],
  notes, defaultAssigneeUid, spiceworksName, createdAt}`.
- `tix_contacts/{contactId}` — requesters (exist without logins).
  `{orgId, email (lowercased), firstName, lastName, phone, location,
  portalUid|null, source, createdAt}`.
- `tix_portal_users/{uid}` — client logins (clone of onboarding `/managers`),
  created via `tix_invitations/{token}` redemption.
- `tix_tickets/{autoId}` — `{num, summary, description, orgId, contactId,
  contactEmail, ccEmails[], assigneeUid, assigneeEmail, status, priority,
  category, dueDate, customAttrs{}, deviceIds[], mutedBy[], createdAt,
  createdByUid/Email, updatedAt, lastPublicActivityAt, closedAt, timeSpentSec,
  taskCounts{}, commentCount, publicCommentCount, spiceworksId|null,
  inbound:{token}}`.
- `tix_tickets/{id}/activity/{eventId}` — unified append-only thread; `kind`
  = `comment` (visibility public/private, body, pinned, attachments,
  emailMessageId/inReplyTo hooks) or `history` (event {type, from, to}).
- `tix_tickets/{id}/labor/{entryId}` — `{seconds, note, byUid, byEmail,
  workDate, at}`; denorm sum on ticket.
- `tix_tickets/{id}/tasks/{taskId}` — `{text, done, order, ...}`.
- `tix_devices/{deviceId}` — `{orgId, name, kind, notes, createdAt}`.
- `tix_attr_defs/{attrKey}` — admin-configurable custom attributes
  `{label, type, options[], required, order, active, showOnPortalForm, tooltip}`.
- `tix_views/{viewId}` — saved views. `tix_userprefs/{uid}` — column layouts.
- `tix_settings/global` — statuses, categories, email snippets.
- `tix_counters/ticket` — `{next}`, sequential IDs via `runTransaction`.
  Imported tickets keep Spiceworks numbers; `next = max(imported, next) + 1`.
- `/mail` — existing Resend queue, reused.
- Storage: `tix/{ticketId}/{eventId}/{filename}`, 25 MB cap + content-type
  allowlist; portal reads gated by `firestore.get()` org match.

## Roles / rules
- **Staff** = `/msp_admins`. **Manager** = `tixManager:true` on that doc
  (deletes, settings, imports, invites). **Portal** = per-org scoped, public
  comments only, enforced via mandatory query filters (onboarding pattern).

## Milestones
M0 scaffold+auth (0.1.0) · M1 ticket core (0.2.0) · M2 thread (0.3.0) ·
M3 board power+bulk (0.4.0) · M4 labor/tasks/devices (0.5.0) · M5 custom attrs
(0.6.0) · M6 outbound email (0.7.0) · M7 CSV import + real migration
(1.0.0 = parity) · M8 client portal (1.1.0) · M9 inbound email (1.2.0).
Portal is sequenced before inbound email (no external-infra dependency; inbound
wants portal contacts to exist for sender matching). M6 subject tokens + M2
`emailMessageId` fields exist from the start so M9 needs no schema rework.

## Import (CSV)
Manager-gated **Upload → Map → Dry-run → Commit**. Ingests a Tickets CSV
(required) and a Labor CSV (optional) from Spiceworks' native Exports (left-nav
→ New Export → Type Tickets/Labor, CSV, scoped by org + All Time). Auto-matches
known headers; unmatched columns get attention-glow dropdowns → {core field /
existing custom attr / create attr / ignore}. Dedupes by `spiceworksId`,
preserves created/updated timestamps.

**History-fidelity caveat:** a Tickets CSV flattens the comment thread. If a
comments column maps, heuristically split on `author (timestamp)` boundaries
into separate `activity` docs (via:`import`, public/private unrecoverable →
default private); otherwise best-effort (description + final state + one
"Imported from Spiceworks #N" history event). Richer fallback = browser-
automation scraping of the live UI (offered, not recommended). Action: pull one
real "All Time / one org" export early to lock the parser to actual headers.

## Outbound email (M6)
Client-side `addDoc(/mail)` (onboarding pattern), no Worker. Triggers: new
public staff comment → contact+CC; new ticket → contact confirmation + staff
notify; assignment change → assignee; status→Closed → contact; portal comment →
assignee. Subjects `[Ticket #N-token]`, replyTo `helpdesk@alerts.umbrellaautomation.com`
from day one so M9 threading works retroactively.

## Open questions (defaults chosen; revisit as needed)
1. Firebase project — join `onboarding-a563d` (chosen) vs new project.
2. Folder name — `tickets` (chosen) vs `helpdesk`.
3. Portal sign-in — onboarding invite + email/password (chosen) vs Google/MS.
4. Status vocabulary — seed Open / Waiting / Closed (chosen, configurable).
5. Inbound address (M9) — `helpdesk@alerts.umbrellaautomation.com` (chosen).
6. Import dedupe default — skip-with-report (chosen) vs overwrite.
7. Optional daily open-ticket digest (Worker cron) — roadmap or skip.
