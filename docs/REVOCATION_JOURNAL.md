# Revocation journal

Foundation for #26 and #29. Restoring an older Instance backup must not bring back access or content that was revoked or deleted after that backup. Each Instance therefore records revocations and deletions in a content-free journal, and the gateway keeps a copy outside the Instance database. A later restore step replays the copy before the restored Instance serves traffic. Replay is not implemented by this change.

## What is recorded

Database triggers on the Instance append one entry when one of these transitions commits. The entry commits or rolls back with the change that caused it.

| Kind | Trigger | Subject fields |
| --- | --- | --- |
| `membership.ended` | Membership becomes left or revoked | membershipId, accountId, status |
| `member.paused` | Personal pause is set | membershipId, epoch |
| `household.stopped` | Household becomes paused or closed | status, safetyVersion |
| `relationship.paused` | A participant's relationship hold is set | relationshipId, membershipId, epoch |
| `relationship.ended` | Relationship ends | relationshipId, reason |
| `agreement.revoked` | Agreement version is revoked | agreementId, version |
| `consent.withdrawn` | Agreement decision becomes declined or withdrawn | agreementId, version, membershipId, decision |
| `taskAuthority.revoked` | Standing task authority is revoked | policyId |
| `document.deleted` | Note text is deleted | documentId |
| `attachment.deleted` | Draft attachment bytes are removed | documentId, version |
| `checkin.withdrawn` | Shared check-in is withdrawn | checkinId |

Subjects contain identifiers, versions and fixed status codes only. They never contain names, titles, text, limits or other household-authored content. Clearing a pause or resuming a household is not recorded: those are not revocations, and replay stays conservative. The migration backfills entries for state that was already ended, revoked, paused or deleted.

## Transfer to the gateway

The gateway worker calls each active registered Instance over the existing private, CA-verified HTTPS path:

- `POST /internal/journal/journalPending` with `{operationId, limit}` returns up to 50 unexported entries for that Instance's households.
- `POST /internal/journal/journalAck` with `{operationId, entryIds}` marks entries exported.

Both use a distinct `pactaris-journal+jwt` delegation: Ed25519, at most 30 seconds, bound to the Instance audience and subject, the exact action and path, the operation and the SHA-256 of the body. The Instance records the JWT ID for replay rejection. A journal token cannot authorize a household summary or command, and household tokens cannot read the journal.

The gateway stores entries in `pactaris.revocation_journal` before it acknowledges them. A lost acknowledgement re-sends the same entries; the `(instance_id, entry_id)` key keeps the copy idempotent. Entries without a durable central copy stay pending on the Instance. The gateway runtime can only read and insert journal rows. The Instance runtime has no direct journal table access and can only execute the two export functions. Backups include both tables through the existing read-only backup roles.

A failed transfer logs `journal.sync_deferred` with a count of affected Instances and retries on the next worker tick. It does not affect other worker tasks.

## Limits

- Gateway and Instance currently share one host. If the whole host is lost, the copy is only as recent as the latest off-host gateway backup. Off-host backups are step 3 of the #26/#29 plan.
- Entries exported before a restored snapshot was taken return as pending after the restore and are re-sent. That is safe because the copy is idempotent.
- Exported entries are retained on the Instance. Retention and cleanup are part of the deletion policy work in #26.
- Replay after restore, the fenced restore start and account deletion are follow-up steps.

Migrations `instance/0032_revocation_journal` and `gateway/0018_revocation_journal` are additive and need no new configuration. The normal updater applies them.
