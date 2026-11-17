# Member administration and voluntary ownership

Implemented slice of #26/#9 in 0.5.0-alpha.1. This is not completion of account-wide deletion, export, restore or privacy retention work.

## Public workflow

Current members can open the member list and choose an optional name for this dynamic. The name stays in the home Instance and is shared only with current members of that dynamic. It is not copied from global Identity, a relationship role or another household. An empty name displays the membership UUID. Names are user-authored database values; interface labels use English catalogs and dates use the configured formatting locale/timezone.

The list exposes current membership IDs, aliases, technical roles and permitted actions. It does not expose platform account UUIDs, provider subjects/emails, private notes, consent content or other household memberships. Pagination returns at most 20 members; ownership proposals are visible only to their sender and recipient, with a bounded recent/pending list. Visible-app checks run every 60 seconds, with explicit refresh and honest unavailable/pending states.

| Action | Participant | Administrator | Owner |
| --- | --- | --- | --- |
| View current members / edit own alias | Yes | Yes | Yes |
| Leave own membership | Yes | Yes | Yes |
| Remove another participant | No | Yes | Yes |
| Remove another administrator | No | No | Yes |
| Remove an owner or self through removal | No | No | No |
| Offer own ownership to an active non-owner | No | No | Yes |
| Accept/decline an offer addressed to own exact membership | Yes | Yes | Yes, subject to current offer validation |
| Cancel own pending offer | Yes | Yes | Yes |

Stable permission identifiers and target-specific checks separate these technical rights from Dom/sub/top/bottom labels, relationship agreements, payment and private-resource visibility. No general role editor or administrator promotion endpoint is added.

Removal and ownership acceptance have explicit confirmation screens. Removing a member targets that precise UUID and revokes local access before central hint cleanup. Self-removal uses the independent leave action; an owner cannot forcibly remove another owner. No action automatically assigns ownership to somebody else.

## Ownership proposals

An owner offers ownership to an existing active non-owner. The proposal expires after 24 hours. The recipient explicitly accepts or declines; the sender can cancel. Reading, refreshing or signing in never accepts it.

Acceptance atomically makes the recipient an owner and the sender a participant. Other owners remain owners. The proposal binds both membership UUIDs, their technical-role versions and the household safety version. A leave/rejoin, intervening role change, expiry, removal or safety-version change invalidates stale acceptance. Role version checks also reject an intervening change away from and back to the same role.

Ownership transfer does not resume a paused household, clear another person's pause, accept a relationship agreement, change intimate roles, move billing sponsorship or reassign the pilot registration budget. The budget tracks the original registration operation until that membership departs; it is not a general cap on accepting technical ownership of existing households.

The sender can still leave without waiting for acceptance. If acceptance wins the race, the recipient remains owner after that departure. If departure wins, the offer becomes invalid and an ownerless group pauses. Final departure closes the dynamic as before. Ownerless recovery remains a separate operator/consent design; no fallback owner is silently selected.

New removal, ownership-offer and ownership-accept requests require a Pactaris session created within the previous 15 minutes, as well as active-session, exact Origin and CSRF checks. This is a recent gateway sign-in bound, not proof of a fresh password/MFA challenge at the provider. Re-login returns through the normal portal. Read-only receipt confirmation, decline/cancel, own alias and independent leave do not acquire that additional freshness requirement. Provider step-up/MFA remains #7.

## Local cleanup and history

Database hooks apply to both the new removal command and the existing leave path. Ending a membership clears its alias, records its end time and inserts a unique local ending marker. It revokes pending invitations created by that membership and invalidates pending ownership proposals involving it. Role changes invalidate proposals; losing invitation-management authority revokes pending invitations. All these changes roll back together if the domain/audit/receipt/outbox transaction fails.

Historical membership IDs and relationship/consent references remain intact. A historical acceptance record is not current permission after departure. Rejoin inserts a new membership and does not restore old names, technical rights or consent. Migration backfill leaves an old end time unknown when it was never recorded; recorded_at identifies when the ending marker was captured.

Ending markers are deliberately minimal Instance-local UUID/status/timestamp records, not a new central content database. They are a foundation for revocation reconciliation, not a claim that restoring an older backup replays all subsequent deletions. A trusted off-host deletion/revocation journal and restore gate are still required by #26/#29/#62.

Only existing workflows are cleaned up here: invitations, ownership offers, member visibility and the original creation reservation. Jobs, files, device subscriptions and feeds must add current-membership/permission checks and revocation cleanup when those modules ship. Personal/shared content erasure, retention periods, pseudonymisation policy, account/household deletion and export remain #25/#26; this release does not erase shared agreements or claim those data rights complete.

## Private commands and recovery

The private contract uses distinct memberList/memberAlias/memberRemove/ownerOffer/ownerAccept/ownerDecline/ownerCancel/memberReceipt purposes. Existing signed Instance/household/actor/method/path/body/operation binding and transport replay rejection apply. Ordinary runtime and backup credentials cannot directly mutate membership/offer/ending/receipt tables; reviewed SECURITY DEFINER functions enforce the matrix inside the home Instance.

The gateway records minimal operation metadata before dispatch, including the exact actor membership and pinned placement/version. Alias text is not stored centrally. Unknown outcomes remain pending. The worker checks up to five existing receipts per batch and never executes an unconfirmed proposal or mutation. Known denials are rejected rather than repeatedly dispatched. Matching retries cannot change the original action, actor, target, offer or alias.

Removal receipts supply the exact departed membership for central cleanup. Account locks are acquired in sorted order, and cleanup deletes only that generation's hint and releases only its matching registration reservation. A removed person can rejoin through a new invitation before the old acknowledgement arrives; later reconciliation cannot delete the new hint. Public responses expose only the caller's operation status, not private endpoint/account metadata.

The new workflow still requires the public gateway/private connectivity. It does not implement local-session safety during a central-manager outage, a complete fleet event feed or general outbox delivery/acknowledgement.

## Update and acceptance

Run the existing root updater:

```bash
bash /opt/pactaris-source/update.sh
```

The default order updates Instance before gateway. Split-host operators update participating Instances before the gateway. Component schemas, backups, migration credentials and runtime credentials remain separate. Existing accounts, sessions, memberships, Identity issuer/client/Brand/TLS, domain configuration and secrets are preserved; migrations are additive and checksummed. Application fallback does not roll back database state.

Native PostgreSQL/HTTPS tests exercise four members, permission ranks, aliases, identity redaction, stale login and changed-role rejection, explicit decline/cancel/expiry, ownership while paused, removal cleanup, invitation rejoin, delayed old acknowledgements, accept/cancel and accept/leave races, runtime/backup denial, and transactional rollback of cleanup/audit/receipt/outbox/replay followed by retry of the same signed packet. Live mobile/accessibility/provider and real-host update acceptance remain distinct from CI evidence.
