# Revocation journal

Foundation for #26 and #29. Restoring an older Instance backup must not bring back access or content that was revoked or deleted after that backup. Each Instance therefore records revocations and deletions in a content-free journal, and the gateway keeps a copy outside the Instance database. A restored Instance starts fenced and the gateway replays the copy before the Instance serves traffic again.

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
| `exchange.withdrawn` | Request, proposal, journal entry or breach record is withdrawn | exchangeId |
| `authority.ended` | Dom link ended or invitation declined | linkId |
| `delegation.revoked` | Delegation revoked | delegationId |
| `habit.break` | A scheduled habit break is added | habitId |

Subjects contain identifiers, versions and fixed status codes only. They never contain names, titles, text, limits or other household-authored content. Clearing a pause or resuming a household is not recorded: those are not revocations, and replay stays conservative. The migration backfills entries for state that was already ended, revoked, paused or deleted.

## Transfer to the gateway

The gateway worker calls each active registered Instance over the existing private, CA-verified HTTPS path:

- `POST /internal/journal/journalPending` with `{operationId, limit}` returns up to 50 unexported entries for that Instance's households.
- `POST /internal/journal/journalAck` with `{operationId, entryIds}` marks entries exported.

Both use a distinct `pactaris-journal+jwt` delegation: Ed25519, at most 30 seconds, bound to the Instance audience and subject, the exact action and path, the operation and the SHA-256 of the body. The Instance records the JWT ID for replay rejection. A journal token cannot authorize a household summary or command, and household tokens cannot read the journal.

The gateway stores entries in `pactaris.revocation_journal` before it acknowledges them. A lost acknowledgement re-sends the same entries; the `(instance_id, entry_id)` key keeps the copy idempotent. Entries without a durable central copy stay pending on the Instance. The gateway runtime can only read and insert journal rows. The Instance runtime has no direct journal table access and can only execute the two export functions. Backups include both tables through the existing read-only backup roles.

A failed transfer logs `journal.sync_deferred` with a count of affected Instances and retries on the next worker tick. It does not affect other worker tasks.

## Restore fence and replay

Every Instance checkpoint written by the deployer ends with a statement that sets `pactaris.restore_fence` to fenced. Restoring that dump therefore always produces a fenced database, even if the operator forgets a step. A database restored from another source must be fenced explicitly before its services start:

```sql
UPDATE pactaris.restore_fence SET fenced=true,fenced_at=now(),released_at=NULL;
```

While fenced:

- Every `/internal/households/...` request returns 503 `restore_fenced`. The gateway shows the affected households as unavailable, never empty.
- The Instance worker runs no scheduler, reminder or other jobs, and its heartbeat reports `unavailable`.
- Only the journal routes work.

On its next tick the gateway worker sees `fenced: true` in the pending export. It first copies any entries the snapshot still had pending, then sends its complete central copy for that Instance in batches of 50 through `journalReplay`. The Instance skips each entry it already holds and each entry for a household that does not exist in the snapshot. Every other entry is applied and then stored locally with its original ID, so the same copy never applies twice. The last batch releases the fence and removes short-lived restrictive safety grants from before the backup. The gateway logs `journal.restore_released` with the Instance ID and the number of applied entries.

Replay only moves state towards ended, paused, revoked or deleted:

| Kind | Replay effect |
| --- | --- |
| `membership.ended` | Ends the exact membership; existing departure hooks run |
| `member.paused` | Sets the personal pause and advances the member epoch |
| `household.stopped` | Closes, or pauses an active household and advances its safety version |
| `relationship.paused` | Sets that participant's hold and advances its epoch |
| `relationship.ended` | Ends the relationship |
| `agreement.revoked`, `consent.withdrawn` | Revokes the version or records the decline/withdrawal |
| `taskAuthority.revoked` | Revokes the policy with a `restoreReplay` policy event |
| `document.deleted` | Removes the note's saved text, acknowledgements and assignments |
| `attachment.deleted` | Removes the draft attachment bytes |
| `checkin.withdrawn` | Clears the check-in title and response |
| `exchange.withdrawn` | Withdraws the exchange and clears its title, text and reply |
| `authority.ended` | Ends the link and removes the backing authority |
| `delegation.revoked` | Revokes the delegation and removes the backing authority |

Replay is deliberately conservative. A pause or stop that happened after the backup and was cleared again is applied again; members clear it themselves through the normal controls. Replay never resumes, accepts or restores anything.

## Limits

- Gateway and Instance currently share one host. If the whole host is lost, the copy is only as recent as the latest off-host gateway backup. Off-host backups are step 3 of the #26/#29 plan.
- Entries exported before a restored snapshot was taken return as pending after the restore and are re-sent. That is safe because the copy is idempotent.
- Each replay sends the complete central copy for the Instance. That is fine at alpha scale; a per-Instance watermark can bound it later.
- Checkpoints from before migration 0033 contain no fence statement. Fence those restores manually.
- Households created after the backup do not exist in the restored database. Their gateway placements remain and report the household as unavailable; reconciling them is operator work.
- Exported entries are retained on the Instance. Retention and cleanup are part of the deletion policy work in #26.

Migrations `instance/0032_revocation_journal`, `instance/0033_restore_fence` and `gateway/0018_revocation_journal` are additive and need no new configuration. The normal updater applies them.

A `habit.break` replay conservatively pauses the matching assigned habit when the break was added after the backup. The journal contains only the habit ID, not break dates. The habit remains paused until resumed after review. Migration 0055 redeclares `journal_apply` from 0044 with this additional restrictive branch.
