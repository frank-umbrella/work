// T2, the Portal API intake (PLAN section 6). NOT BUILT.
//
// Boundary: everything Portal-API-shaped lives in this file. Until PLAN D1
// (the Portal plan) is answered and the shop is on the Unlimited plan with an
// approved API application, POST /portal/webhook answers 501 and nothing
// here reads or writes anything.
//
// What T2 will need, from docs.portal.io (2026-10-23 research, rechecked
// 2026-10-29):
//   - Secrets: PORTAL_APP_ID, PORTAL_USER_KEY (wrangler secret put), and
//     PORTAL_BASE_URL (production base URL is not published; the sandbox is
//     https://sandbox.api.portal.io/).
//   - Every API request is HMAC-SHA256 signed with these headers:
//       X-MSS-API-APPID      the application id
//       X-MSS-API-USERKEY    the user key
//       X-MSS-CUSTOM-DATE    the request date that the signature covers
//       X-MSS-SIGNATURE      the HMAC-SHA256 signature
//     The exact string-to-sign is in Portal's API reference; build it from
//     there, not from memory.
//   - The webhook event to subscribe to is proposal.status_changed. Portal
//     says webhooks are signed and retried; the signature header name for
//     webhook deliveries is not in the public docs yet, so verifying a
//     delivery is the first thing to confirm with Portal.
//   - On Accepted: GET the proposal, then hand it to parseProposal() and
//     buildImport() in zapier.js with importSource "api". Those already
//     produce the same ids as the CSV and Zapier paths.
//   - Status notes back to Portal: POST /public/proposals/{id}/internalnotes
//     replaces the field, so read, append the block, write. Accepted and
//     Completed proposals may answer 409; then the app's Copy for Portal
//     button stays the way.

export function portalConfigured(env) {
  return Boolean(env.PORTAL_APP_ID && env.PORTAL_USER_KEY && env.PORTAL_BASE_URL);
}

export function handlePortalWebhook(request, env) {
  const error = portalConfigured(env)
    ? 'Portal API intake is not built yet'
    : 'Portal API intake is not configured (needs the Unlimited plan and PORTAL_* secrets)';
  return new Response(JSON.stringify({ ok: false, error }), {
    status: 501,
    headers: { 'Content-Type': 'application/json' },
  });
}
