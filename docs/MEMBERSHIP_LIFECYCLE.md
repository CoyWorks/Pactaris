# Membership identity and delayed-operation fencing

Update: 0.5.0-alpha.1 adds [member administration, voluntary ownership proposals and local departure cleanup](MEMBER_ADMINISTRATION.md). The 0.3.2 prerequisite contract below remains the generation-fencing foundation; public participant invitation/rejoin shipped separately in 0.4.0.

Implemented prerequisite of #70/#8/#26 in 0.3.2-alpha.1. This release does not expose invitation acceptance, member removal or public rejoin.

## Identity and history

A membership identifies one participation period. An account can have historical left/revoked rows in the same household and at most one current invited/active row. Rejoining requires a new UUID and an explicitly chosen technical role. A database trigger forbids reactivating departed/revoked rows or changing their account/household/identity. Relationship participants, contextual roles and consent foreign keys continue to reference the historical UUID; none becomes authority for a new membership.

The additive Instance migration replaces the old whole-history account/household unique constraint with a partial current-membership unique index. Before removing the old constraint it binds existing command receipts to the single proven membership. Missing membership evidence aborts migration for investigation; no row is guessed or deleted. Existing SQL migration files and checksums remain immutable.

## Commands and routing

Private summaries include the verified actor's current membership UUID. The public gateway still projects only household ID/name. A new self-leave reservation obtains that proof over the existing private, CA-verified, audience-bound HTTPS path and stores it with the operation. The browser cannot select a membership. The command JWT signs the exact body including that UUID; the Instance only updates that current active membership.

Fresh commands, semantic retries and receipt probes are separate. A completed departure retry returns its original result even after the account rejoins. A new departure command targeting the old membership is denied. The legacy body without membership UUID is accepted only when one historical membership exists, or for the exact already-completed receipt; after rejoin it cannot choose the newer row.

Creation retries and receipt probes reference the membership originally created, rather than any active membership for that account. A creator who left and later rejoined does not regain ownership or validate an old creation receipt.

Gateway hints and durable operations carry nullable membership IDs. Legacy central state stays unknown until a private proof/receipt supplies the ID; the gateway never queries an Instance database to infer it. Finalization deletes only the matching/unknown legacy hint and releases only the matching legacy/create reservation. It cannot remove a newer bound hint. A delayed create acknowledgement cannot replace a different membership hint. All hint publication/finalization and future invitation acceptance must use the existing per-account onboarding lock.

A private summary may become stale immediately after it returns. The subsequent mutation still checks the exact membership inside the Instance transaction. A hint is never an authorization grant; every displayed household requires live membership checks.

## Deployment

Use the existing root updater:

```bash
bash /opt/pactaris-source/update.sh
```

The default component order updates Instance before gateway. Separate-host operators update all relevant Instances to this contract before updating their gateway. A newer gateway refuses command acknowledgements without membership evidence; an older Instance therefore leaves an operation pending rather than letting the gateway guess. Identity, credentials, Brand/TLS and user data are not bootstrapped or changed by these migrations.

The previous application can read the additive fields and use the constrained legacy departure function, but **do not enable public rejoin/invitations while an old gateway is serving traffic**: it lacks generation-aware central finalization. Future invite rollout must gate the required gateway/Instance contract. Database history is not rolled back by an application fallback.

The gateway's new reservation proof requires private connectivity, as does the existing public workflow. This release does not add manager-outage local-session safety endpoints, which remain #11/#26/#62.

## Verification and remaining scope

Native PostgreSQL/HTTPS tests cover populated old-Instance receipt backfill, preserved gateway accounts/sessions, repeat migrations, four-person exit, old legacy/body-bound requests, duplicate current membership, denied old-row reactivation, unchanged role/consent foreign keys, owner-to-participant rejoin, delayed first-create acknowledgements, old leave finalization preserving a newer hint, and permission denial for runtime/backup roles. Rejoin itself is a privileged synthetic fixture here, not a production endpoint.

#8/#53 must implement explicit invitation preview/accept/decline/revoke, recent session-bound recipient proof, expiring capacity reservations and recoverable publication of the accepted membership. #26 retains removal/owner transfer, deletion and revocation cleanup scope. No relationship agreement is accepted by joining.

## Account-wide deletion contract

Account deletion is separate from leaving a household or removing one membership. A future request must use the current browser session, exact Origin/CSRF and recent provider authentication, with a clear irreversible-action confirmation. The existing account identity is the authority. The browser must not nominate a subject, account ID, membership ID or destination. Treat an account with a current sole-owner membership as blocked until the member transfers ownership voluntarily or explicitly closes that household.

| Data owner | Deletion work and evidence |
| --- | --- |
| Gateway | Record the durable request under an account fence. Reject new sessions and provisioning for that account. Revoke sessions, device push, pending invitations and outstanding grants. Reconcile in-flight creation, acceptance and departure before finalizing the inventory. Remove the account presentation and verified-email data after the necessary Instance acknowledgements. |
| Instances | Resolve current and ended memberships using the verified account ID and the authenticated Instance route. Remove private documents, draft bytes, personal check-ins and other private content. For shared records, apply the approved per-resource redaction or pseudonymisation policy. Retire access, queued effects and file grants, including work already claimed by a worker. Record the deletion receipt only after the local transaction commits. |
| Identity | Revoke provider sessions and apply the approved provider-side account action after reviewing any shared use of the identity. A successful local request must not claim the external Identity account was removed. Preserve only the reviewed minimum replay-prevention record keyed to the verified issuer and subject. |
| Restore and relocation | Maintain a trustworthy deletion and revocation history outside the recovered snapshot. Apply it before publishing routes or starting workers. Reconcile moved placements and offline Instances against that history. Expire retained copies according to the approved backup policy. |

The Gateway's active placement hints alone do not identify all stores that could retain historical memberships. Establish that inventory before execution. Keep a durable operation ID and per-Instance state so an unavailable Instance leaves a visible pending request, and so a retry cannot revive a deleted account or target a later membership. Operator progress reports should display counts and result codes without household-authored data.

Verify with two synthetic Instances. Include a historical membership absent from the active placement list, an unavailable Instance, a last owner, a lost acknowledgement, a concurrent sign-in and a stale restore. Verify cross-account request rejection, replay-safe cleanup and truthful completion before exposing a destructive endpoint. The current personal export preview and membership departure receipt do not satisfy this contract. The implementation and its limits are described in [ACCOUNT_DELETION.md](ACCOUNT_DELETION.md).
