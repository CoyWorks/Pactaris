# Account deletion

Implements the account-wide deletion contract in [MEMBERSHIP_LIFECYCLE.md](MEMBERSHIP_LIFECYCLE.md#account-wide-deletion-contract) for #26. Deleting an account is separate from leaving one dynamic or removing one member.

## User flow

On the Profile page, **Delete account** explains the consequences and requires a confirmation checkbox. The request needs the current session, the exact Origin, the CSRF token and a provider authentication from the last five minutes (the same `/auth/reauth` path as personal export). Requests are throttled per account.

- If the account is the only owner of a dynamic that still has other active members, the request is refused with `account_delete_blocked` and the affected household IDs. Ownership must be transferred first. A sole owner who is also the only member does not block: leaving closes that dynamic.
- Otherwise the gateway fences the account (`deleting`), revokes every Pactaris session (push devices and task push scopes cascade) and signs the browser out. The account can no longer sign in or create sessions.

Deletion is free and not affected by plan or quota. The provider account in Identity is not deleted; the user removes it there if wanted.

## Erasure on each Instance

Placement hints do not list historical memberships, so the gateway worker asks every active registered Instance. Each call uses a separate `pactaris-account+jwt` delegation bound to the account, that Instance, the action, the operation and the body digest, with replay rejection. It cannot be used as a household, journal or summary token.

`account_erasure` on the Instance first repeats the owner check. It then leaves every active membership through the normal departure command, so existing hooks end relationships, revoke task authority, cancel work and close or pause dynamics exactly as a normal leave does. Afterwards, in every household where the account ever had a membership:

| Content | Result |
| --- | --- |
| Membership | Marked `account_erased_at`; alias cleared. Other members see the existing former-participant label. |
| Private tasks, private limits, delivery preferences, local safety grants | Deleted or reset |
| Notes, rules and protocols the person authored | Text versions, acknowledgements, assignments and attachments removed; document marked deleted |
| Private habits, rituals, check-in history, reward catalog drafts, personal schedules | User-authored text blanked |
| Shared check-ins the person wrote | Withdrawn; title and response removed |
| Requests, proposals, journal entries and breach records the person wrote | Withdrawn; title, text and reply removed |
| Replies the person gave on exchanges they received | Reply text removed |
| Dom link names and point-change reasons the person wrote | Text removed |
| Shared records: partner tasks and series they created, their task notes, agreement terms they proposed, relationship names/scope they proposed, their contextual role context, reward terms they issued | The records stay for the other participants; only this person's own text is blanked |

Text is blanked by `erase_text`, which empties user-authored string fields in JSON content while keeping structure, states, dates, numbers and identifiers. The Instance records one `account.erased` journal entry per household. If an older backup is restored, the [revocation journal](REVOCATION_JOURNAL.md) replays the erasure before the Instance serves traffic again. A fenced Instance refuses direct erasure calls until replay has released it.

## Completion

The gateway records an acknowledgement per Instance. Unavailable Instances are retried with backoff up to one hour, and the worker logs `account.deletion_deferred` with a count. When every active Instance has acknowledged, the gateway removes remaining sessions and household hints and reduces the account row to an unlinkable marker: status `deleted`, subject `deleted:<account id>`, and no name, email or presentation settings. The worker logs `account.deletion_completed`. Signing in again with the same provider identity creates a new, empty account.

## Limits

- Audit, receipt and outbox rows keep their opaque account and membership IDs without content. Backups keep older copies until they expire under the backup retention; restored copies replay the erasure through the journal.
- An Instance disabled in the registry is not contacted. Re-enabling it before completion includes it again; erasure of a permanently retired Instance's backups is an operator task.
- Pending invitation routes and onboarding records created by the account remain as opaque operational metadata.
- The operator console does not yet show pending deletions; use the `account.deletion_deferred` log and `pactaris.account_deletions` table.

Migrations `instance/0034_account_erasure` and `gateway/0019_account_deletion` are additive. No new configuration is needed.
