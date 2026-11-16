# First household registration — 0.3.0-alpha.1

Scoped #8/#26/#53/#58 implementation under milestone #68. A signed-in account can create a private dynamic, select it and explicitly leave through the public app origin. Invitations, participant management, tasks, agreements and relationship-role assignment are not included in this checkpoint.

## Operator rollout

Use the existing one-command updater as root:

```bash
bash /opt/pactaris-source/update.sh
```

It applies the separate gateway/Instance migrations and health gates, then idempotently registers the known co-located Instance when both installed configurations have gateway delegation and the same internal CA. Local root-owned configuration is the pilot identity attestation; this is not remote fleet enrollment. Different-CA profiles retain existing registry data and require explicit operator enrollment. Conflicting/disabled entries are refused, never overwritten or re-enabled. A component-only update does not perform cross-component registration.

No new CloudPanel vhost, public Instance endpoint, DNS record, OIDC client, secret rotation or domain change is needed. The updater preserves the existing Identity deployment and Brand settings. The form requires a prepared 0.2 deployment; it is not an empty-server installer or a bypass for failed migration/backup prerequisites.

## Browser acceptance

1. Sign in at the configured public origin and submit **Create a dynamic** with a user-authored name.
2. Verify the new dynamic opens and is listed on the start page. No Instance selector, private endpoint, token or role assignment should be visible.
3. Refresh and sign out/in; the same household remains available.
4. Open the dynamic, choose **Leave dynamic**, review the explanation and confirm. Access ends, and returning to its detail URL is denied. This does not delete the IdP account or shared records.
5. If an operation is unconfirmed, retry the same operation/name. A reconnect is not proof of success or failure. The UI keeps the operation ID while open; after reload, the pending operation is discovered from the account's metadata and the original name must be entered again if creation was never dispatched.

The UI uses English message catalog keys and labelled native form controls. It does not persist household names, sessions or drafts in localStorage. Existing account/list checks remain approximately 60 seconds while visible; explicit submit/retry is an immediate user action. Remaining browser/mobile accessibility and live rollout acceptance must be recorded separately from HTTP integration tests.

## Public API and authorization

- `POST /api/households` accepts exactly `{operationId,name}`.
- `POST /api/households/{id}/leave` accepts exactly `{operationId}`.
- `GET /api/households/operations` returns only the signed-in account's pending operation IDs, household IDs, actions and status.

Mutations require an active database-backed session, exact configured Origin and the session CSRF header. The caller cannot supply an account, technical/dynamic role, plan, Instance or upstream address. Input is bounded uncompressed JSON. Creation has a per-account request throttle; self-leave is independent of that creation throttle and quota. No GET/login/preview accepts an invitation or agreement.

Responses are `201` for completed creation, `200` for completed leave and `202` when the outcome remains pending. A pending response is not successful onboarding or confirmed departure. Errors use stable keyed messages, not raw SQL, OIDC or upstream details. Only the safe operation view crosses the browser boundary; actual household names come from a current-membership-authorized Instance summary.

## Durable placement and recovery

The gateway reserves a household UUID and one active registered Instance under an account-scoped transaction lock. It records action, account/household/Instance IDs, placement version, request fingerprint and lifecycle metadata. Names stay in the Instance database; the central fingerprint binds account/operation/name without storing plaintext content. Existing placements are immutable through the runtime API; moving or editing a placement during an operation requires future fencing/relocation control-plane work.

A private command commits local household/membership/audit/outbox/receipt state. The gateway only publishes the placement and account visibility hint after a matching verified local result. The central placement/hint/operation/control-plane event commit together. Failed central commits retain the reservation. Never free capacity, pick a new Instance or delete the original household just because a connection timed out.

The private `receipt` command has its own signed purpose/path/body binding. It returns only `created`, `left` or `missing` plus the matching IDs. It cannot create a household. It checks actor/target/Instance ownership before exposing an existing receipt. Receipt inspection uses one-time transport IDs but does not create another domain mutation/audit event/outbox message.

A bounded gateway worker claims up to five pending operations with SKIP LOCKED and a 60-second retry interval, probes receipts and finalizes central metadata. It can recover after a process restart without having the household name. `missing` leaves the reservation pending; if the original private request never reached the Instance, the user must explicitly resubmit the same name/operation. It never fabricates successful setup or automatically creates from an unknown payload. Reconciliation deferrals emit only a structured count, no names/tokens/endpoints.

Self-leave first revokes membership locally, then removes the account's central visibility hint and releases its own creation reservation. A stale hint cannot defeat the Instance's current membership/RLS checks. Concurrent leave requests share the pending operation; an acknowledged retry does not re-add membership. Receipt inspection can recognize that a creator has already left and releases a late creation result rather than rejoining them.

The existing outbox remains a durable domain record, but general outbox delivery/acknowledgment and external membership/invitation synchronization are still separate work. This worker reconciles operations initiated by this gateway; it does not claim to discover every future change or mark the Instance outbox delivered. Local-session/manager-outage availability, individual safety workflows and voluntary owner recovery/transfer remain open. Ownerless groups retain members and pause; the final member's departure closes the household.

## Pilot creation budget

`onboarding.maxOwnedHouseholds` defaults to **1** when absent, with an operator-configurable range of 1–20. This is an initial installation abuse/capacity budget, not a finalized price or paid-plan feature matrix. A pending creation consumes the same budget as a completed owned registration. Confirmed self-leave releases that account's creation reservation. Joining another person's household is not charged against this creation budget; joining/invitation quotas have not shipped yet.

The default is loaded in code without rewriting installed configuration. If changing it, use the protected gateway config and normal component restart/update procedure. Do not advertise larger groups or paid upgrades based on this setting. Invitations must add atomic member/reservation enforcement and verified recipient binding before being exposed; role expression, consent and exit are never quota-gated.

## Pending-operation limits

Do not delete pending rows or reset the creation budget to resolve an unknown result. The Instance may already contain committed data. A disabled/unreachable Instance is not an excuse to fail over. Operator recovery must inspect the pinned receipt/placement with protected credentials and retain an audit trail. Automatic pending cancellation/expiry, request-body recovery before dispatch, relocation and a general fleet repair UI are not implemented. Users who reload before dispatch must re-enter the original name; a changed name is rejected for that operation. A future rejoin/ownership-transfer flow must introduce membership-generation fencing before reusing historic leave operations.

## Verification

Unit checks cover session-bound identity, Origin/CSRF, malformed/oversized bodies, injected account/backend/role fields, creation-throttle-independent departure, pilot limit validation and local-registry behavior. Native PostgreSQL/HTTPS tests cover the public registration/detail/leave route, idempotent retries, request conflicts, concurrent different operation IDs under one quota, local departure before central acknowledgment, worker restart after a lost command response, pre-dispatch crash/retry, suspended accounts and central metadata without plaintext names. These extend the private command/two-Instance/RLS tests; they do not replace real IdP/browser/mobile acceptance.
