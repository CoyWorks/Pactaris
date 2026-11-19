# Owner-only workspace and basic tasks — 0.8.0-alpha.1

This implements the next everyday slice of #15/#27/#17/#53 from EARLY_VERSION_BASICS.md. A household can be created and used by its creator/technical owner alone. No second account, invitation, relationship or agreement is required for this preparation/self-directed workflow.

## Everyday interface

The workspace opens on Today with the date, open tasks, unread shared work and the current person's real open/overdue/completed counts. Five bottom tabs (Today, Tasks, Routines, Library, Dynamic) replace the earlier row of sections; see [MOBILE_LAYOUT.md](MOBILE_LAYOUT.md). Safety controls and private limits open from the shield in the top bar on every screen; the safety provider stays mounted, so its bounded restrictive connection keeps working while another section is shown.

Owners/admins can edit the household name and IANA timezone. Version-conflicting edits require refresh; a changed name appears through the existing household selector's live summary without persisting names in the manager. Display language remains English via catalogs; formatting locale, household timezone and user-authored content remain separate. Due date/time entry uses the device timezone; stored instants are UTC and displayed in the household timezone. No time is silently interpreted as household-local input. Global profile editing, themes and terminology/categories remain broader #27 work.

Only the active section mounts its membership/relationship forms. Visible online workspace reads occur once per minute plus explicit actions, with bounded deadlines and navigation cancellation. The shared session and safety refreshes remain separate. No authenticated data is cached offline and no mutation is automatically queued or retried. The selector and selected household provide an explicit reload for a failed read. A failed account lookup displays an availability error, while a confirmed signed-out response opens the sign-in view. The reload fetches the session and current household access again.

## Task scope and privacy

This initial task collection is **creator-private preparation and self-directed work**, including against other owners/admins. It is not yet a household-shared assignment board. Each current member can create their own unassigned draft or explicitly assign it to themselves, edit an open task, complete their own self-assigned work, archive and reopen it. Titles/descriptions are original database content, with priority and optional due instant. Overdue display never creates a consequence or ledger entry.

Unassigned tasks cannot be completed until the creator explicitly self-assigns. Other people, relationships, reviewers, consent records or arbitrary assignee UUIDs cannot be injected into these commands. Reopening a completed/archived task produces an unassigned draft; it does not silently resume execution or grant a duplicate reward. There are no proof uploads, partner assignment/review/dispute, recurring task generation, task notifications or points side effects in this slice. Rules/protocols (#16) and notes (#66) are the next basic modules, not phantom tabs or prerequisites for task drafts.

## Appropriate self-directed safety policy

Preparing an unassigned draft, editing descriptive fields, removing one's own assignment, archiving and changing authorized household settings do not require partner consent. A self-assignment or completion requires active household/current exact membership, no personal pause, no structured private `task` block, and the observed household/member safety epochs. These checks run inside the same lifecycle-locked transaction as the task change. Old pre-pause requests cannot become valid after pause/resume (ABA). Paused/over-capacity users retain permitted reads and archiving; they can still use the independent pause/stop/leave controls.

Existing two-party activity_guard is not weakened or given a fabricated partner. Partner-directed task actions will need a separate reviewed resource/participation policy and activity_guard integration before they are enabled. Choosing a task for oneself is an explicit own action, not standing consent for another person to direct it. Relationship-specific restrictions continue to apply to relationship-scoped future work, not to an unrelated personal draft.

## Quota, lifecycle and transactions

The versioned entitlement key `tasks.active.max` bounds all open tasks in a household, including unassigned drafts. The initial pilot value is 25 where the key was absent, preserving any existing operator value and other capabilities. This is not a finalized commercial tier/pricing decision. New households receive the same default through an entitlement-insert hook. Missing/malformed limits fail closed. Creation/reopening and usage checks share the household lock, so concurrent creators cannot overbook. Editing/completing/archiving existing tasks does not require additional capacity; downgrade removes no records or members. Public counts concern only the requesting creator's tasks, not other people's private inventory.

Departure/removal archives that exact membership's open tasks and clears their assignee atomically, releasing active capacity without handing private drafts to other administrators. Historical tasks stay tied to the ended UUID; a fresh membership inherits no tasks or receipt access. Full retention/deletion/personal export is still #25/#26 and must not be claimed by archiving.

Narrow SECURITY DEFINER commands and FORCE RLS protect task/receipt/outbox tables; runtime has no direct SELECT/write grants. Backup is separately protected/read-only. Exact membership, Instance, signature purpose/method/path/body, replay, request shape and optimistic versions are enforced. Mutations, audit, receipt, outbox and replay marker commit or roll back together. Minimal receipts confirm historical operations without returning private bodies; repeated IDs with changed requests conflict. General outbox delivery and retention remain open.

## API

- `GET /api/households/:householdId/workspace?filter=open|done|archived&after=UUID` returns settings, own counts and up to ten own task summaries. Descriptions are not returned in the list.
- `POST .../workspace/settingsUpdate`: operationId, version, name, timeZone.
- `POST .../workspace/taskRead`: operationId, taskId; own detail only.
- `POST .../workspace/taskCreate`: operationId, fields, epoch, memberEpoch.
- `POST .../workspace/taskUpdate`: the creation fields plus taskId and version.
- `POST .../workspace/taskComplete`: operationId, taskId, version, epoch, memberEpoch.
- `POST .../workspace/taskArchive` or `taskReopen`: operationId, taskId, version.

Task fields have exactly title, description, priority (`low`/`normal`/`high`), dueAt (UTC ISO instant or null), assignment (`unassigned`/`self`). All mutations require gateway session, CSRF and exact configured Origin. The manager resolves live placement/membership, stores no task content and never exposes backend destinations. Invalid/unavailable responses are redacted and keyed. Unknown outcomes retain only an in-memory exact retry draft; abandoning it does not cancel an in-flight request. Refresh after acknowledgement for current state.

## Verification and rollout limits

Input/render checks cover solo setup, multiline description, strict partner/authority rejection and default navigation with collapsed safety. Real two-Instance PostgreSQL/HTTPS acceptance covers a fresh sole owner, settings/reload, task draft/detail/edit/self-completion/archive/reopen, retries/conflicts, pause/epoch/category guards, stop/re-entry and concurrent completion/pause, bounded pagination, privacy against another admin, tenant/Instance/CSRF boundaries, atomic cross-creator capacity, downgrade, failed final outbox rollback/replay, runtime/backup restrictions and departure/rejoin fencing. CI success is separate from live operator/mobile visual acceptance; no live server deployment is performed by a source push.

Migration `instance/0009_workspace_tasks` is additive, preserving previous checksums and existing configuration/secrets/data/Identity issuer/client/Brand/web certificate/TLS/proxy settings. The normal updater activates Instance before gateway and retains mandatory backups/separate migration/backup credentials. Application fallback does not undo schema changes or restore ended memberships/consent. Trusted off-host restore revocation/deletion replay remains an open launch gate. No new infrastructure or operator configuration is required for the default pilot workspace.


## Personal date and time settings

On the **Profile** page (avatar in the top bar), open **Date and time settings** to set the formatting locale and personal IANA time zone. The gateway stores these preferences on the account and applies them in other signed-in browsers after they refresh their session. Use app defaults to clear them. English remains the interface language. Household work keeps its household time zone and schedule rules. Personal timestamps such as session and invitation times use the selected personal time zone.

The gateway validates both values, checks the active session and origin/CSRF proof, and records the account and time of each actual change in the same transaction. Household/Instance requests do not receive the saved personal settings.

The Profile page also offers a preferred display name. The Gateway stores it separately from the sign-in provider profile. Clearing it restores the latest available provider name. The setting applies to the account view and personal export. Names used inside each dynamic are managed through that dynamic's membership alias. Account and membership identifiers stay stable. The settings audit stores the account ID and change time, without the previous or new name.
