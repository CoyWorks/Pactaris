# Milestone 2 — explicit household onboarding

Tracking: [#68](https://github.com/CoyWorks/Pactaris/issues/68). Branding: [#67](https://github.com/CoyWorks/Pactaris/issues/67).

## Starting evidence

On 16 November 2026 the operator reported successful deployment of 0.2.0-alpha.1, verified backend TLS, the new Identity discovery issuer, Instance/gateway readiness, www redirection and working browser login/local logout on the new product domains. This is operator-observed evidence, not an independently executed SSH/browser test. The old proxies were removed by the operator. Existing accounts/databases were retained; no historical Site data was imported.

## Outcome

A signed-in account can explicitly create a private household, invite another person, review/accept or decline and select that household through the canonical app origin. Members can leave. Instances remain private. Pair and four-person dynamics do not impose residence, marriage, a global Dom/sub field or implied consent.

## Work order

| Order | Issues | Deliverable and boundary |
| --- | --- | --- |
| 1 | #57, #58, #55 | Explicit operator registration of the known co-located pilot Instance; later placement uses this registry. Remote single-use enrollment, credential rotation, fleet dashboard and MFA remain parent scope. |
| 2 | #9, #5, #12 | Technical permission matrix, private-resource policy and transactional audit. Dynamic labels and payment never grant authority. |
| 3 | #8, #4, #53 | Durable idempotent household creation/placement, invite reservations and explicit acceptance/decline/revocation. The gateway stores routing metadata, not household names or agreements. |
| 4 | #26 | Local immediate leave/removal, last-owner transfer or closure, and revocation reconciliation. Do not publish joining without a safe exit. |
| 5 | #10, #11, #35 | Exact-version individual consent, pause/stop and scoped relationship controls before any tasks/protocol execution. |
| Throughout | #44, #13, #62, #67 | English catalogs, real database/isolation/failure tests and reproducible Identity branding. |

Email-bound acceptance additionally requires #6 verified email assertions. The initial login stored issuer/subject/name only; 0.3.1 adds the bounded assertion foundation below. Do not infer a verified email from a username, display name or an unverified IdP claim. Google/Apple credentials and email delivery remain separate work.

## First implementation checkpoint — 0.2.1-alpha.1

- Started #57 with a root-only co-located pilot registration command. It loads protected installed configs, checks private literal HTTPS destinations, shared CA identity and live verified TLS/readiness, then atomically registers immutable Instance metadata plus a minimal registry audit event. Reapplication is idempotent. Conflicting or disabled entries are refused, not overwritten or re-enabled. Ordinary gateway runtime credentials remain read-only for registry data.
- Started #9 with a deny-by-default technical permission/resource-visibility module. The existing Instance summary path now uses its active-membership check. Owner/admin cannot read another member's personal-private content merely through technical authority. Self consent/pause/leave permissions are independent of paid/dynamic roles; no new safety/leave endpoints are claimed.
- Added a component-specific additive gateway migration for registry audit metadata; original migration checksums are unchanged.
- Added four-member privacy/participant tests, cross-household/unknown-role denial and native concurrent registry/idempotency/audit/conflict/runtime-role tests alongside the existing two-Instance TLS/RLS suite.

The complete household creation/invite/leave UI and private mutation protocol have not shipped. No placeholder household is created by registering an Instance. Branding is scoped in #67 and not applied by this checkpoint.

## Private write checkpoint — 0.2.3-alpha.1

The Instance-side mutation protocol is now implemented for create/self-leave. It uses separate body-bound write JWTs, one-time transport IDs, immutable operation receipts, narrow transactional database functions and atomic domain/audit/outbox writes. Four-member departure pauses an ownerless group without evicting others or assigning technical ownership; the final departure closes it. Existing summary authorization immediately rejects departed members. See [PRIVATE_COMMANDS.md](PRIVATE_COMMANDS.md) for trust, retry, RLS, entitlement, audit and availability limits.

This starts the domain-mutation part of #12/#8/#26. It does not expose a public creation/invitation/leave API or form. Central reservations, placement finalization and durable reconciliation must ship before that browser workflow; #53 quota reservations and #6 verified-email assertions remain invitation gates. Outbox delivery/activity UI/retention, full safety/consent, exports/deletion and owner recovery remain open. #67 branding is still scoped.

The operator has also reported successful one-command update of gateway/Instance to 0.2.2-alpha.1 and a second no-op health-only execution, with Identity left unchanged/healthy. This is live update-path evidence, not proof of every recovery/private-source/brand/onboarding scenario.

## Household creation and invitation contract

Update: the create/placement/self-leave and receipt-recovery part below is now implemented in **0.3.0-alpha.1**; see [HOUSEHOLD_ONBOARDING.md](HOUSEHOLD_ONBOARDING.md). The gateway reserves one active registered Instance, enforces a configurable account creation budget (pending operations count), publishes placement/hints atomically after local proof and recovers lost acknowledgments through a bounded receipt worker. The mobile form uses explicit CSRF-protected actions and no plaintext name is stored centrally. Default all-component updates register the known co-located shared-CA Instance idempotently. Invitations, general outbox synchronization, member quotas, voluntary owner recovery and verified-recipient assertions remain open; the milestone is not complete.

1. Authenticate the central account and require exact Origin plus session CSRF for each mutation. Rate-limit creation/invites and use a stable operation UUID.
2. Reserve an active eligible Instance in a durable gateway operation. Pin placement/version; never accept a caller-supplied backend URL. Persist request identity so the same operation cannot be retried with different household parameters.
3. Send a short-lived, replay-protected private command bound to method, path, Instance, account, household, operation and body digest. A summary delegation cannot authorize a write.
4. Instance transaction creates the household, initial technical membership, explicit free-plan snapshot, local operation receipt and audit/outbox together. Owner status does not accept any relationship agreement. Enforce creation quotas/reservations under locks.
5. Commit central placement and visibility hints only after durable local acknowledgment; reconcile response loss from the operation receipt. Do not expose a silently active orphan or delete data as failure recovery. Reconcile revoked/left hints through a durable outbox.
6. Invitation preview/acceptance uses opaque high-entropy single-use hashed tokens, expiry/revocation, verified recipient binding, proposed technical role and exact relevant agreement version. Never consume or accept a token on GET/login/preview. Redact tokens from logs/referrers; no household content in push/email previews.
7. Accept/decline/expire/revoke races lock invitation, usage reservation and membership in one Instance transaction. A duplicate acceptance returns the existing operation result; wrong-account, changed agreement or exhausted reservation fails closed. Entitlements cannot restrict basic consent/exit or encode relationship form.
8. Keep membership technical roles separate from relationship roles. Render names as user-authored DB content. A four-person household does not create an all-to-all relationship graph.

## Acceptance before calling this milestone complete

### Invitation prerequisites — 0.3.1-alpha.1

[#69](https://github.com/CoyWorks/Pactaris/issues/69) adds verified-email assertions extracted only from validated signed ID tokens and refreshed/cleared at login. An additive gateway migration preserves accounts and sessions. Account identity remains issuer + subject; same-email accounts are never merged, and email is absent from browser/Instance payloads. See [VERIFIED_EMAIL.md](VERIFIED_EMAIL.md) for provider requirements, bounded address format, migration tests and freshness limits.

This does not enable invitation acceptance. [#70](https://github.com/CoyWorks/Pactaris/issues/70) first fences history/commands/central hints to an exact membership, so a delayed old leave cannot remove a newly joined membership. #8 must additionally implement a recent proof tied to the accepting session, explicit preview/accept/decline/revoke and atomic member quota reservations. Cached account email alone cannot authorize joining. Broad parents remain open.

Real PostgreSQL checks must cover two independent stores, pair/four-person membership, wrong account/household/Instance, changed/expired/revoked invitations, simultaneous accept/revoke, crash after local commit, stale hints, owner transfer/closure and immediate leave. Browser checks must show one public app origin, truthful offline/error states and no private endpoint disclosure. Real IdP branding/MFA/recovery and operator rollout remain separate acceptance evidence.

Billing, task execution, uploads, public onboarding, automatic remote fleet enrollment and the complete minimal-input installer are not implied by this milestone. Broad parent issues stay open until their full acceptance criteria pass.


## Membership identity checkpoint — 0.3.2-alpha.1

#70 now binds command receipts, private self-leave and central operation/hint finalization to the exact membership UUID. Historical records are retained; reactivation is rejected and only one current membership is allowed. Tests use synthetic rejoin to prove old roles/consent and delayed commands cannot affect the new membership. Public invitation/rejoin is still the next #8/#53 block. See [MEMBERSHIP_LIFECYCLE.md](MEMBERSHIP_LIFECYCLE.md) and the approved [first six P0 blocks](ALPHA_P0.md).


## Participant invitations checkpoint — 0.4.0-alpha.1

#8/#53 now have a connected participant invitation create/list/review/accept/decline/revoke workflow, session-bound recent email assertion, 48-hour reservations under household locks and an explicit four-member operational pilot snapshot. Lost acceptance acknowledgements recover through durable gateway operations and private receipts; rejoining creates a fresh membership and old receipts cannot affect it. See [INVITATIONS.md](INVITATIONS.md).

No automatic email, role/consent acceptance, member removal/owner transfer, commercial task/storage quotas or whole-parent completion is claimed. Real IdP ownership verification, mobile/browser acceptance and the release/privacy/backup gates remain required. The next P0 block is #26.
