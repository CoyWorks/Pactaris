# Explicit invitations and alpha member reservations

Implemented slice of #8/#53 in 0.4.0-alpha.1, following #69/#70. This is an invited-pilot workflow; the broad parents remain open for complete lifecycle/provider/entitlement acceptance.

## User flow

An active owner/admin opens a dynamic and creates a participant invitation for an email address. The browser generates a random 256-bit token and retains it only in memory. The resulting link stays at the configured public app origin: /join with invitation ID and secret in its fragment. Share it privately with the intended recipient. No automatic email is sent; transactional delivery remains #24.

The recipient signs in, then reopens the original link and explicitly chooses Review invitation. If the session is already signed in, review is immediately available. The fragment is removed from the address bar after the page captures it; it is never sent as a URL/query/referrer to the API. There is no localStorage, sessionStorage, server plaintext-token store or automatic acceptance during GET/login/preview.

Preview shows the dynamic's name, proposed technical role participant and expiry, with a notice that joining accepts no relationship, contextual role or agreement. Accept and Decline are separate CSRF-protected actions. Successful acceptance opens the household through the public gateway. Owners/admins can list their latest 50 invitations and revoke a pending invitation. Lists show IDs/status/expiry rather than exposing recipient identities.

The link secret cannot be recovered after a reload. During an uncertain creation response, retry the same browser draft/operation/token/email. After losing the draft, review pending invitations and revoke an unwanted reservation before creating a replacement. A new invitation uses a new token. Revoked/expired/handled invitations cannot be resurrected by replaying their creation request.

## Verified recipient proof

Only the validated signed ID-token email assertion from the login callback can populate a session proof. The gateway snapshots the current account assertion into that new session, separate from public session data. Old sessions start without proof. A proof must be less than five minutes old, match the current account email and its exact assertion timestamp, and belong to an active unexpired session. Logging in elsewhere does not refresh the old session's proof; a changed/removed/replaced account assertion invalidates it.

The email remains keyed to issuer + subject, never used to merge accounts. Matching preserves local-part case, dots, plus tags and Apple relay aliases; only DNS case folds. The configured IdP must actually verify email ownership and clear verification on change before it asserts boolean true. A hardcoded true mapping or an editable unverified profile email is not acceptable. This release does not rewrite working IdP scopes/flows, set verification flags, send verification mail or claim real provider acceptance.

The five-minute bound is a recent provider-assertion bound, not a claim that a password/MFA or mailbox challenge happened within five minutes. The gateway sees provider email changes at the next login; there is no immediate IdP event feed. Fresh MFA/reauthentication for exports/deletion remains #7/#25/#26. Real authentik verification/recovery and Google/Apple flows remain #6.

An invitation binds to its intended verified email plus secret. Distinct accounts with the same verified mailbox are not merged: the first successful explicit acceptance binds the invitation to that account and membership. Another subject cannot reuse it afterward.

## Instance authority and capacity

The home Instance stores token/recipient hashes, the creator's exact membership, invitation terms/safety version, expiry, status and accepted membership. It receives neither the bearer secret nor the recipient's raw verified email. Gateway routing records contain only opaque IDs, placement/version, creator membership and request hashes.

Every private call has a short-lived Ed25519 command JWT bound to purpose/action, account, Instance, household, operation, method/path and exact body digest. Summary/create/leave purposes cannot authorize invitations. Transport IDs reject replay. Runtime stays non-owner/non-BYPASSRLS with no direct invitation-table read/write authority; the reviewed SECURITY DEFINER function enforces membership/role and performs atomic writes with audit/outbox/receipt records.

Creation and acceptance share the same household advisory lock as departure. Active/invited members plus unexpired valid pending invitations count when reserving a new place. A departed/demoted creator, changed safety version, expiry, decline or revocation invalidates a pending reservation. Expiry is enforced by database time; a running cleanup worker is not required to release capacity.

The explicit operational alpha limit is four members, stored as members.active.max in each versioned free snapshot. Existing free snapshots missing that key receive it with a version increment; existing/custom caps are preserved. New households receive it explicitly. This is a pilot capacity policy, not finalized paid pricing. A missing/invalid cap fails closed for new invitations.

Acceptance rechecks the active member count against the current cap. A downgrade never evicts a member, deletes content or prevents self-leave; excess pending reservations may need revocation or may expire. Tasks/storage/automation quotas, billing and authenticated commercial snapshot distribution remain #53/#61.

Invitation acceptance currently proposes participant only. Owner/admin invitations, voluntary owner transfer, member removal and full privacy cleanup remain #26/#9. Role labels and payment grant no permission or consent.

## Races, retries and recovery

A stable operation ID plus semantic request hash makes create/accept/decline/revoke retries conditional and idempotent. Preview/list are read-only domain operations, although their transport replay markers are recorded. Acceptance and revocation cannot both win the pending-invitation race. Expired/revoked/changed invitations fail closed.

A new acceptance always inserts a fresh membership UUID. It never reactivates a departed row or copies previous roles/consent. A consumed invitation cannot rejoin a former member; a new invitation is required. Replaying an old accepted receipt after a later rejoin reports the old membership left and cannot remove the new routing hint.

Before acceptance dispatch, the gateway records a durable operation. Lost responses are recovered by bounded private receipt checks in the gateway worker. The worker can confirm an existing operation but never accepts an invitation without the original explicit request. A crash before dispatch requires an explicit browser retry with the secret. Pending responses do not claim completed membership publication.

Central hint publication uses the shared account lock and a current private membership proof. Delayed old acknowledgements cannot overwrite/delete a newer generation. Gateway hints still grant no authority: each household read uses live Instance membership. General outbox delivery/acknowledgement, data-retention cleanup and owner recovery are not added by this slice.

## Rollout and acceptance

Run the existing root updater:

```bash
bash /opt/pactaris-source/update.sh
```

Instance updates precede gateway updates. Split-host operators must update every participating Instance before enabling this gateway contract. Migrations are additive and checksummed; existing accounts, sessions, memberships and configuration are retained. A gateway with this contract must serve all invitation acceptance traffic; old gateway binaries do not provide session proof or acceptance recovery. Application fallback does not roll back schemas.

Identity's running configuration, client secret, issuer, Brand/web certificate and SMTP/provider credentials are preserved. Sign in again to acquire a session-bound assertion. Before admitting real testers, verify actual IdP ownership proof and test the flow with separate recipient/owner accounts on the real mobile browsers. No source update or signed-token fixture constitutes that live acceptance.

CI covers real public API/private HTTPS/PostgreSQL create/retry, atomic reservation races, strict input/CSRF, wrong/unverified/stale/replaced recipient proof, explicit preview with no membership change, accept/decline/revoke/expiry, participant permissions, downgrade/exit, rejoin fencing, lost-response worker recovery, accept-versus-revoke and absence of plaintext email/tokens in routing/Instance metadata. Existing two-Instance, migration/backup and tenant-isolation regression tests remain required. Browser visual/clipboard/device acceptance is an operator gate; no visual acceptance is implied by compilation.
