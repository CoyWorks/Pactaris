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
